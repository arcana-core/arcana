# Arcana src/ 与 web/ 问题分析报告（2026-06-11）

范围：`src/`（重点 gateway-v2 消息管道）与 `web/app.js`。子项目（playground/、packages/ 等）未纳入。

---

## 一、气泡叠加 & 重复输出 —— 根因（已逐行核实）

### 根本设计缺陷：事件协议没有"消息身份"

整条流式管道里，`assistant_text` 事件**只有 sessionId/agentId，没有 messageId、turnId、序号**：

- 服务端：`chat-runtime.js:2347` / `2370` —— `emit({ type: 'assistant_text', text: cleanText })`，发送的是**整条消息的累计快照**（非增量），无任何消息标识。
- 客户端：`web/app.js:9` 只有一个全局指针 `let activeAssistant = null`，收到 `assistant_text` 时（`app.js:6012-6017`）：没有泡泡就建一个，有就**整体替换** `textContent`。`activeAssistant` 只在 `turn_end`（`app.js:5600`）和切换会话时置空。

客户端因此**无法**区分"这是上一条消息的更新"还是"新消息开始了"。所有叠加/重复现象都是这个缺陷的不同表现。

### 表现 1：一个 turn 多条 assistant 消息 → 挤进同一个泡泡

Agent 输出"文本A → 工具调用 → 文本B"时：

1. 服务端每条消息独立累计（`assistantRawText` 在 `chat-runtime.js:2429` 于每个 `message_end` 后重置），所以文本B的 `assistant_text` 快照**不包含**文本A；
2. 客户端 `activeAssistant` 在整个 turn 内不变，文本B到达时直接**覆盖**同一泡泡里的文本A —— 文本A 从界面上消失/闪变，工具卡片穿插后视觉上就是"多段输出叠在一个泡泡里"。
3. 历史持久化却是两条记录（`chat-runtime.js:2374` 每个 `message_end` 各 `ssAppend` 一条），**重新打开会话看到的和直播时看到的不一致**。

### 表现 2：turn 结束后补发 → 重复气泡 + 历史重复（最典型的重复源）

`runPromptSync` 在 turn 完成后调用兜底函数 `ensureAssistantTextDelivered`（`chat-runtime.js:3586`），判重逻辑（`chat-runtime.js:2482`）是字符串全等比较，但**两边的文本来源不同**：

- 流式路径记录的 `record.__arcana_lastAssistantTextEmitted` 是**媒体提取后的 cleanText**（`chat-runtime.js:2346/2369`，经 `extractMediaFromAssistantText` 剥离 MEDIA 引用）；
- 兜底传入的 `result.text` 是 `runPromptWithSteer` 里 `mergeStreamingText` 累计的**原始文本**（`chat-runtime.js:2827`），未做媒体剥离，且换行规范化路径也不同。

只要消息含媒体引用、或两条累计路径产生任何字节差异，全等判断必然失败 →

1. **再次 emit 同样内容的 `assistant_text`**。而此时客户端已收到流转发的 `turn_end`（`chat-runtime.js:2175`）并把 `activeAssistant` 置空（`app.js:5600`）→ 补发的文本**创建一个新泡泡** → 界面上同一段话出现两个气泡。
2. **历史也写重**：`chat-runtime.js:2490` 再 `ssAppend` 一条。`sessionAlreadyHasAssistantText` 的查重同样因 raw/clean 文本不一致而失效 → 会话文件里存两条近似相同的消息，刷新后依旧重复。
3. `ensureTurnEndDelivered` 以 `force: true` 调用（`chat-runtime.js:3593-3600`），`2515` 行的去重检查被 force 跳过 → **客户端收到第二个 `turn_end`**，触发重复的列表刷新等副作用。

### 表现 3：mergeStreamingText 启发式造成段内重复/丢字

`src/streaming-text.js` 用启发式区分"快照流"和"增量流"：

- `streaming-text.js:80-87`：重叠检测上限 `maxOverlap=256`。若真实重叠超过 256 字符且不满足快照判定 → `merged = a + b.slice(0)`，**重叠段被拼接两遍**（文本内部重复）。
- `streaming-text.js:90-92`：`overlap<8 && b.length>=256 && b.length>=a.length/2` 时直接返回 `b`，**丢掉前文 a**（丢段）。
- `streaming-text.js:66-77`：LCP≥0.85 判为快照。两条以相似开头的连续输出（如列表项）可能被误判成快照而互相覆盖。

对快照式上游这些路径不常触发，但一旦模型/SDK 行为变化（真增量流、长重叠），就是随机性的重复或丢字。

### 修复方向（按层次）

1. **协议补字段（治本）**：所有流事件带 `messageId` + `turnId` + 单调 `seq`；客户端按 `messageId` 建/找泡泡，按 `seq` 去重。这是唯一能同时解决叠加、重复、乱序的方案。
2. **统一文本规范化（治标，见效快）**：让 `ensureAssistantTextDelivered` 与流式路径用同一个 `extractMediaFromAssistantText` 后的 cleanText 比较；`ensureTurnEndDelivered` 去掉 `force: true`。这两处改完，最常见的"重复气泡 + 历史重复"即可消失。
3. 客户端在 `message_start`（或检测到新消息）时另起泡泡，而不是复用全局 `activeAssistant`。
4. 上游若可获得真实增量 delta，废弃 `mergeStreamingText` 启发式拼接，改为服务端透传 delta + 客户端追加。

---

## 二、web/app.js 全量刷新卡顿 —— 根因

### P0：renderMessages 全量推倒重建

`app.js:4609-4663`：每次都 `messages.innerHTML = ''` 然后逐条 `appendMessage`，无 DocumentFragment、无按 id 复用。打开会话、群聊事件追加（`app.js:5132`）都走这条路 —— **每次全量 O(N) DOM 重建**，逐条 append 还触发增量回流。千条消息级别必卡。

### P1：历史接口无分页

`src/sessions-store.js:196-213` `loadSession` 整文件 `readFileSync + JSON.parse`，HTTP 返回全量 `messages[]`，前端一次渲染全部。无 limit/offset。会话越久越卡，且服务端内存尖峰。

### P2：流式更新每个事件强制布局

`app.js:6050`：每个 `assistant_text` 都执行 `messages.scrollTop = messages.scrollHeight`（强制 layout），且 `app.js:6026-6027` 每条媒体引用都 `querySelectorAll('img')` 重建 Set。高频流式下每秒几十次强制重排。

### P3：无虚拟化

所有历史消息 DOM 常驻树中，长会话滚动时样式计算成本持续上升。

### 修复优先级

1. `renderMessages` 改增量：按消息 id diff，新增用 DocumentFragment 批量插入（收益最大，约 80-90%）。
2. 历史接口加 `limit/offset`，前端首屏只取最近 50 条 + 上滑加载。
3. 流式更新用 `requestAnimationFrame` 合并：一帧内多个 `assistant_text` 只做一次 DOM 写 + 一次 scroll。
4. 超长会话再考虑虚拟滚动（可后置）。

另外 `web/app.js.broken` 是遗留备份，建议删除；`app.js` 已近 6800 行，建议按"会话列表 / 消息渲染 / 事件处理 / 群聊"拆模块。

---

## 三、src/ 其他重要问题（已核实的优先）

### P0

1. **会话锁同步自旋阻塞事件循环**（`sessions-store.js:54-73`）：`acquireSessionLock` 用 `Atomics.wait` 做**同步 sleep** 轮询锁文件，最长阻塞到超时——期间整个 Node 事件循环冻结，所有 WS 推流、HTTP 请求全部停摆。应改为异步等待或 proper 文件锁。
2. **chatSessions 缓存可能永不释放**（`chat-runtime.js:909-924`）：`releaseChatSessionRecord` 在 `sess.isStreaming` 为 true 时直接返回，若流异常未收尾，记录永久滞留；Map 无 TTL/LRU。
3. **事件存储无界增长**（`gateway-v2/event-store.js`）：JSONL 只追加不轮换，`readEventsSince` 全文件扫描。需要按大小/日期轮换 + 保留期清理。
4. **异步 turn 错误兜底不完整**（`gateway-v2/index.js:1113-1152`）：`setImmediate` 包裹的 `runChatMessage` 链路若 `emitAsyncTurnFailure` 自身抛错则静默丢失；建议顶层 try-catch + 统一错误日志。

### P1

5. **WS 广播无背压**（`ws-hub.js:255-296`）：`ws.send` 不检查 `bufferedAmount`，慢客户端会让消息在内核缓冲堆积直至内存耗尽。
6. **静态文件路径校验**（`gateway-v2/index.js:518-544`）：`resolved.startsWith(WEB_ROOT)` 前缀检查未处理符号链接，建议补 `realpath` 校验。
7. **工具流缓冲无上限**（`tool-output-store.js:111-161`）：`state.buf` 累积无大小限制，长输出工具可堆 MB 级内存。
8. **大量 `catch {}` 静默吞错**：chat-runtime.js / ws-hub.js 中遍布空 catch，线上排障基本无迹可循。建议至少接入分级日志。

### P2

9. **测试覆盖**：`chat-runtime.js`（3692 行）只有 664 行测试；`gateway-v2/index.js`（3093 行）、`runtime/engine.js`（714 行）无专属测试。本报告第一节的协议类 bug 恰恰需要事件序列级的回归测试来锁住。
10. **上帝文件**：`chat-runtime.js`、`gateway-v2/index.js`、`web/app.js` 三个文件合计约 1.35 万行，事件 emit 散落各处。建议先抽出"事件发射层"（统一定义事件 schema + 发射函数），既是重构第一步，也是给事件补 messageId/turnId 的落点。

---

## 四、建议的动手顺序

| 顺序 | 事项 | 预期效果 |
|---|---|---|
| 1 | 统一 cleanText 比较 + 去掉 turn_end 的 force | 消除最常见的重复气泡/历史重复（小改动） |
| 2 | 事件协议加 messageId/turnId/seq，客户端按 id 管泡泡 | 根治叠加与重复 |
| 3 | renderMessages 增量化 + 流式 rAF 合并 | 解决全量刷新卡顿主因 |
| 4 | 历史接口分页 | 长会话首屏速度 + 服务端内存 |
| 5 | 会话锁异步化、event-store 轮换、WS 背压 | 长期运行稳定性 |
