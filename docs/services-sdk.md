# Arcana Service Platform SDK（ctx.sdk）

服务在 `start(ctx)` 里通过 `ctx.sdk` 访问 Arcana 平台能力。这是**唯一受契约保护的访问面**——直接 `import '../src/*'` 内部模块没有稳定性承诺，且在进程隔离模式下部分能力（vault）不可用。

同一套 API 在两种运行模式下行为一致：

- **in-process**（默认）：直接调用 Arcana 模块；
- **process 隔离**（`services.config.json` 或 `ARCANA_SERVICE_ISOLATION=process`）：密钥经 IPC 由网关进程代理（vault 派生密钥不出网关），其余能力走文件/HTTP，天然跨进程。

## 快速开始

```js
// services/my-app.mjs
export async function start(ctx) {
  const { sdk } = ctx;

  // 1. 密钥（需在 services.config.json 声明，见下文）
  const apiKey = await sdk.secrets.get('MY_PROVIDER_KEY');

  // 2. 调 Agent：异步 turn + WS 流
  const turn = await sdk.agent.turnAsync({
    agentId: 'my-agent',
    sessionKey: 'my-app:proj1:client1',
    text: '帮我处理…',
  });
  const wsUrl = sdk.agent.streamUrl({ sessionKey: 'my-app:proj1:client1' });

  // 3. 会话历史
  const history = sdk.sessions.load(turn.sessionId, { agentId: 'my-agent' });

  await sdk.log('info', 'my-app started');
  return { async stop() { /* 清理 */ } };
}
```

## 密钥声明（services/services.config.json）

```json
{
  "my-app": {
    "isolation": "process",
    "memoryLimitMB": 512,
    "secrets": ["MY_PROVIDER_KEY", "ANOTHER_KEY"]
  }
}
```

- 未声明的服务密钥白名单为空（**默认拒绝**）；`"secrets": "*"` 表示全部允许（仅建议自有可信服务）。
- 隔离模式下白名单在**网关侧二次校验**（子进程侧的检查只是快速失败），vault 派生密钥永不进入子进程。
- vault 未解锁时 `secrets.get` 抛 `VAULT_LOCKED`，服务应自行重试或延迟初始化。

## API 一览

| 能力 | 说明 |
|---|---|
| `sdk.version` | SDK 契约版本（当前 1） |
| `sdk.agent.turn(payload)` | `POST /v2/turn-sync`（带 token 鉴权） |
| `sdk.agent.turnAsync(payload)` | `POST /v2/turn-async` |
| `sdk.agent.call(path, body, {method})` | 任意网关端点（自动鉴权 + JSON） |
| `sdk.agent.streamUrl(params)` | 构造 `/v2/stream` 的 ws(s) URL（含 token） |
| `sdk.agent.gatewayUrl` / `getApiToken()` | 解析自 `ARCANA_URL`（默认 `http://127.0.0.1:8787`）/ `ARCANA_API_TOKEN` 或 token 文件 |
| `sdk.secrets.get(name, {agentId})` | 白名单校验 → in-process 直读 / child 走 IPC broker |
| `sdk.secrets.list()` | 返回声明的白名单（契约，不读 vault） |
| `sdk.sessions.load/list/append` | 会话存储（文件型，双模式直通） |
| `sdk.sessions.idForKey/resolveIdForKey` | sessionKey → sessionId 映射 |
| `sdk.agents.normalizeId(raw)` / `homeRoot(agentId)` | agent id 规范化 / agent home 路径 |
| `sdk.log(level, message)` | 写入 `<logDir>/sdk.log` |

## 错误码

| code | 含义 |
|---|---|
| `SECRET_NOT_ALLOWED` | 密钥未在该服务的白名单中声明 |
| `VAULT_LOCKED` | 网关侧 vault 尚未解锁 |
| `GATEWAY_HTTP_<status>` | 网关调用失败（`err.status`/`err.body` 可用） |
| `SDK_RPC_TIMEOUT` | 隔离模式 IPC 超时（30s） |

## 迁移指引

把对 `../src/*` 的直接 import 替换为 `ctx.sdk` 对应能力：

| 旧（直接 import） | 新（ctx.sdk） |
|---|---|
| `secrets.getText(name, home)` | `await sdk.secrets.get(name, {agentId})` |
| `fetch(ARCANA_URL + '/v2/turn-async', …)` 手写鉴权 | `sdk.agent.turnAsync(payload)` |
| `loadSession / listSessions / appendMessage` | `sdk.sessions.*` |
| `getSessionIdForKey` | `sdk.sessions.idForKey` |
| `resolveAgentHomeRoot()` | `sdk.agents.homeRoot(agentId)` |
| `loadOrCreateApiToken()` | `sdk.agent.getApiToken()` |

`configureLongRunningHttpServer` 这类纯工具暂不在 SDK 内，直接 import 仍可用（无状态、无进程耦合）。
