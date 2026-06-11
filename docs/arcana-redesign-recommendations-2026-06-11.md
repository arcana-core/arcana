# Arcana 改造建议 —— 参考 Codex 与 Claude Code 的设计（2026-06-11）

参考对象：
- **Codex**（`~/projects/arcana/codex`，Rust）：事件协议在独立 `protocol` crate；TUI 增量渲染；rollout JSONL 持久化。
- **Claude Code**（`~/projects/arcana/claude-code`，TypeScript）：消息全员 UUID；content block 粒度产出消息；JSONL append-only + 惰性刷盘；React 按 uuid 键控渲染。

结论先行：**Arcana 的三个核心病灶（气泡叠加、重复输出、全量渲染卡顿），在这两个系统里都被同一组设计决策从结构上消除了**——事件带身份（id + 序号）、流式与最终消息职责分离、输出项为渲染单元、存储只追加不重写。下面按主题给出对照和落地方案。

---

## 1. 事件协议：给每个事件"身份"，这是一切的根

### 两个参考系统怎么做

**Codex**（`codex-rs/protocol/src/protocol.rs:407-414`）：
```rust
pub struct Event {
    pub id: String,    // 关联到发起这次 turn 的 submission id
    pub msg: EventMsg, // AgentMessageDelta / AgentMessage / ExecCommandBegin...
}
```
- 每个输出项（消息、推理、命令执行）在 `ResponseItem`（`models.rs:44-120`）层面都有自己的 `id`/`call_id`；Begin/End 事件靠 `call_id` 配对。
- **Delta 与 Final 分离且职责明确**：流式期间发 `AgentMessageDelta`，结束发完整 `AgentMessage`；TUI 的 `StreamController` 有状态地消费 delta，**对同一流的 Final 不再重复渲染**——客户端有明确规则知道哪个事件该忽略。

**Claude Code**（`src/services/api/claude.ts:1980-2248`）：
- 每条消息必有 `uuid + parentUuid + timestamp`（`src/utils/messages.ts`）。
- 消费 Anthropic 流时按 `content_block` 索引累积，**在 `content_block_stop` 时才产出一条带新 uuid 的独立 AssistantMessage**——一个 turn 里"文本→工具→文本"天然就是三条消息、三个气泡。
- `message_delta`（usage/stop_reason 等元数据）**不产生新消息**，而是原地修改最后一条已产出的消息——从机制上根绝"流式+最终重复"。

### Arcana 的差距

`assistant_text` 只有 sessionId，无 messageId/turnId/seq；发的是整条消息累计快照；turn 结束后还有一条用字符串全等判重的"兜底补发"（`chat-runtime.js:2477`），判重两边文本来源不一致必然失败。

### 建议方案：item 生命周期协议

定义统一事件信封，所有流事件改造为三段式生命周期：

```js
// 信封：每个事件必带
{ seq, sessionId, turnId, itemId, type, payload }

// item 生命周期（itemId = 每个输出单元的 uuid）
{ type: 'item_started',   itemId, itemType: 'assistant_text' | 'tool_call' | 'thinking' }
{ type: 'item_delta',     itemId, delta: '...' }          // 真增量，非快照
{ type: 'item_completed', itemId, payload: { text, mediaRefs } }  // 完整最终内容
// turn 生命周期
{ type: 'turn_started',   turnId }
{ type: 'turn_completed', turnId, lastItemId }            // 借鉴 codex TaskCompleteEvent.last_agent_message
```

客户端规则（简单且无歧义）：
- `item_started` → 按 itemId 建泡泡（`Map<itemId, element>`，废弃全局 `activeAssistant`）；
- `item_delta` → 追加到对应泡泡；
- `item_completed` → **幂等地**把该泡泡内容替换为最终文本（已是最终内容则无操作）。

这样 Arcana 现有的兜底逻辑 `ensureAssistantTextDelivered` 可以保留意图（保证送达），但改发 `item_completed`——**因为按 itemId 幂等，重发多少次都不会出现重复气泡**。`ensureTurnEndDelivered` 改发带 turnId 的 `turn_completed`，客户端按 turnId 去重，`force: true` 不再有副作用。

`seq`（会话内单调递增）同时解决 WS 重连：客户端带 `since seq` 重连，`ws-hub.js` 从 event-store 回放且不重复——这是现在 replay 机制做不到的。

### 落点

- 新建 `src/gateway-v2/events.js`：事件 schema 定义 + 唯一的发射入口（构造信封、分配 seq）。这同时是拆解 `chat-runtime.js` 上帝文件的第一刀——目前 emit 散落 40+ 处。
- `chat-runtime.js` 的 subscribe 处理器：在 `message_start`（assistant）处生成 itemId 并发 `item_started`；`message_update` 发 delta；`message_end` 发 `item_completed`。
- 兼容期：旧 `assistant_text` 事件可与新事件并行发送一个版本，web 客户端切换后移除。

---

## 2. 废弃文本启发式拼接（mergeStreamingText）

Codex 和 Claude Code **都没有"猜重叠"的逻辑**——它们消费结构化增量（`content_block_delta` 带块索引；`AgentMessageDelta` 是纯增量），不存在需要启发式去重的场景。Arcana 的 `streaming-text.js`（LCP≥0.85 判快照、256 字符重叠上限、b≥a/2 时丢弃前文）是对"上游发快照还是增量不确定"的补偿，本身就是随机重复/丢字的来源。

建议：在 SDK 边界一次性归一化，下游全部消费真增量：

```js
// chat-runtime subscribe 内，按当前消息维护 prevText
if (snapshot.startsWith(prevText)) {
  delta = snapshot.slice(prevText.length);   // 快照流 → 转增量
} else {
  // 内容回退/重写：发 item_replaced（罕见路径，显式处理而非猜测）
}
prevText = snapshot;
```

`message_start` 重置 `prevText`。归一化只在这一处做，`mergeStreamingText` 从 emit 路径移除（可保留给确实需要拼接的遗留场景）。

---

## 3. Web UI：按 id 键控 + 静态/活动分区 + 增量提交

### 参考设计

- **Claude Code**：`key={message.uuid}`，已完成消息进入 Ink `<Static>` 区（提交后永不重渲染），只有正在流式的那一条在动态区更新；组件自己订阅状态避免 props 级联重渲染（`src/components/Messages.tsx`，注释明确提到 2800 条消息会话下避免 150K writes/frame）。
- **Codex**：`StreamController`（`tui/src/streaming/controller.rs:54-110`）做**换行门控**——delta 累积到完整行才向历史区提交一个 cell（`InsertHistoryCell`），历史区只追加、不重建。

### Arcana 落地（对应上次报告的 P0 卡顿）

1. **泡泡注册表**：`Map<itemId, bubbleEl>` 替代全局 `activeAssistant`；`renderMessages` 改为按消息 uuid diff（只增删差异项，DocumentFragment 批量插入），不再 `innerHTML = ''`。
2. **静态/活动分区**：`item_completed` 后该泡泡 DOM 视为已提交，之后任何事件都不再触碰它（等价于 `<Static>`）；只有活动 item 的元素被更新。
3. **提交节流**：delta 应用用 `requestAnimationFrame` 合并（一帧最多一次 DOM 写 + 一次 scroll），可选叠加 codex 的换行门控让长文本输出更平滑。
4. 历史接口分页（上次报告方案不变），超长会话再上虚拟滚动。

---

## 4. 持久化：JSONL append-only，彻底告别整文件重写和自旋锁

### 参考设计

- **Claude Code**（`src/utils/sessionStorage.ts`）：transcript 是 `{sessionId}.jsonl`，**只 append 不覆盖**；写入走队列、100ms 惰性刷盘；**resume 时按 uuid 去重**；progress/流式中间消息被 `isTranscriptMessage()` 明确排除在持久化之外。压缩不重写历史，而是追加 `compact_boundary` 系统消息，resume 只加载 boundary 之后的内容。
- **Codex**（`codex-rs/core/src/rollout/recorder.rs:175-192`）：rollout JSONL，经 mpsc 通道**异步**写入（不阻塞主流程）；持久化前过策略筛选（敏感内容不落盘）；长对话以 `Compacted` 项收缩。

### Arcana 的差距与方案

现状：`sessions-store.js` 每条消息**整文件 JSON 重写**，配同步自旋锁（`Atomics.wait`，等锁期间冻结整个事件循环）；历史判重靠文本比较（失效 → 历史重复）。

改造：

1. **格式**：`{sessionId}.jsonl`，每行 `{uuid, parentUuid, turnId, role, ts, text, mediaRefs}`。消息 uuid 在产生处分配（与第 1 节的 itemId 同源），**持久化判重 = uuid 判重**，`sessionAlreadyHasAssistantText` 那种文本比较判重直接删除。
2. **写入**：进程内单写者队列（async 队列即可，等价于 codex 的 mpsc / claude-code 的 write queue），append-only 之后**锁可以整个移除**——事件循环阻塞问题随之消失。
3. **压缩**：现有 `context-manager.js` 的摘要结果以 `compact_boundary` 行追加，不重写文件；`loadSession` 从最后一个 boundary 读起，天然解决"长会话全量加载"的一半问题（另一半靠分页）。
4. **流式中间态不落盘**：明确"哪些事件进 transcript"白名单（user/assistant final/tool result），等价 claude-code 的 `isTranscriptMessage()`——杜绝中间快照混入历史。
5. `event-store.js`（事件回放日志）与 transcript 职责分开：按大小/日期轮换 + 保留期，回放只服务 `since seq` 的 WS 重连。

---

## 5. 通道与背压

Codex 的取舍值得照搬（`codex-rs/core/src/codex.rs:173-174`）：**入向有界、出向无界**——用户提交通道 bounded(64)（防恶意/失控请求堆积），核心→UI 事件通道 unbounded（核心不被慢 UI 拖住）。

Arcana 对应：
- `ws-hub.js` 发送前检查 `ws.bufferedAmount`，超阈值（如 4MB）对该客户端降级：丢弃 delta、只保送 `item_completed`/`turn_completed`（有了协议分层，"哪些事件可丢"第一次变得可定义——delta 可丢，生命周期事件不可丢）。
- HTTP 入向（发消息接口）按 session 排队限并发，替代现在隐式的锁竞争。

---

## 6. 分阶段实施路线

| 阶段 | 内容 | 工作量 | 解决 |
|---|---|---|---|
| **0（即刻）** | 兜底判重统一用 cleanText 比较；去掉 `ensureTurnEndDelivered` 的 force | 半天 | 最常见的重复气泡/历史重复立刻消失 |
| **1** | 事件信封（seq/turnId/itemId）+ `events.js` 发射层；item 三段式生命周期；客户端泡泡注册表 | 3-5 天 | 气泡叠加、重复输出根治；WS 重连去重 |
| **2** | sessions-store 改 JSONL append-only + uuid 判重 + 写队列，移除自旋锁；event-store 轮换 | 3-5 天 | 历史重复、事件循环冻结、文件无界增长 |
| **3** | web 渲染增量化（uuid diff + 静态/活动分区 + rAF）+ 历史分页 | 1 周 | 全量刷新卡顿 |
| **4** | SDK 边界 delta 归一化，下线 mergeStreamingText；WS 背压分级 | 2-3 天 | 段内重复/丢字；慢客户端内存 |

阶段 0/1 与 2/3 可并行。每阶段都应配事件序列级回归测试（给定上游事件序列 → 断言下游事件流/最终 DOM 结构），这正是两个参考项目测试覆盖的重点形态。

---

## 7. 三系统对照速查

| 关注点 | Codex | Claude Code | Arcana 现状 | 建议 |
|---|---|---|---|---|
| 事件身份 | submission id + item id/call_id | 每消息 uuid + parentUuid | 仅 sessionId | 信封 seq/turnId/itemId |
| 流式 vs 最终 | Delta 与 Final 分事件，UI 有状态去重 | block_stop 产出消息，message_delta 原地改 | 累计快照 + 兜底重发 | item 三段式，completed 幂等 |
| 渲染单元 | 每输出项一个 history cell，只追加 | key=uuid，Static 区不重渲染 | 全局单泡泡指针 + 全量重建 | 泡泡注册表 + 静态/活动分区 |
| 持久化 | rollout JSONL 异步追加 + Compacted | JSONL append + uuid 去重 + boundary | 整文件重写 + 自旋锁 + 文本判重 | JSONL + 写队列 + uuid 判重 |
| 文本拼接 | 无需猜测（结构化 delta） | 无需猜测（block 索引） | mergeStreamingText 启发式 | 边界归一化为真增量 |
| 背压 | 入向 bounded(64)，出向 unbounded | 写队列惰性刷盘 | 无 | bufferedAmount 分级降级 |
