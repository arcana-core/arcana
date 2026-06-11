# 部署 Arcana 网关

Arcana 作为 Agent PaaS 服务端：托管 agent 能力 + 你的 services，自带运营后台。本文覆盖云上部署的关键配置。

## 快速开始（Docker）

```bash
docker build -t arcana .
docker run -d --name arcana \
  -p 8787:8787 \
  -v arcana-data:/data \
  arcana
```

state（会话、vault、令牌）持久化在容器内 `/data`，务必挂卷。

## 关键环境变量

| 变量 | 说明 | 建议（生产） |
|---|---|---|
| `ARCANA_HOME` | state 根目录 | `/data/.arcana`（已在镜像内设） |
| `ARCANA_BIND_HOST` | 监听地址 | `0.0.0.0`（容器内） |
| `PORT` | 端口 | `8787` |
| `ARCANA_REQUIRE_AUTH` | `1` 时**关闭环回鉴权绕过**——反代/sidecar 转发到 127.0.0.1 时必开 | `1` |
| `ARCANA_SERVICE_ISOLATION` | `process` 时所有 service 默认进程隔离（崩溃不连累网关） | `process` |
| `ARCANA_API_TOKEN` | 客户端令牌；不设则自动生成到 `~/.arcana/api_token` | 显式注入 |
| `ARCANA_ADMIN_TOKEN` | 运营后台令牌（独立于 API 令牌，无环回绕过）；不设则生成到 `~/.arcana/admin_token` | 显式注入 |
| `ARCANA_RATE_LIMIT_RPM` | >0 时启用 per-客户端限流（令牌桶，按 IP/XFF） | 视流量 |
| `ARCANA_TLS_CERT` / `ARCANA_TLS_KEY` / `ARCANA_TLS_CA` | 进程内终止 TLS 的证书路径 | 通常用反代终止，留空 |
| `ARCANA_WS_BUFFER_SOFT_LIMIT` / `..._HARD_LIMIT` | WS 背压阈值（字节） | 默认 1MB/16MB |

## TLS 两种方式

1. **反向代理终止 TLS（推荐）**：nginx/Caddy/ALB 在前面处理证书，转发到网关的 HTTP。此时务必 `ARCANA_REQUIRE_AUTH=1`，否则环回转发会跳过鉴权。
2. **进程内 TLS**：设 `ARCANA_TLS_CERT` + `ARCANA_TLS_KEY`，网关直接起 HTTPS（WSS 同端口）。

## 运营后台

- 访问 `/admin.html`，输入 admin 令牌（启动日志会打印令牌文件路径）。
- 功能：服务状态/启停/重启/日志、概览（运行时长/内存/WS 连接/各状态服务数）、agents 列表。
- `GET /admin/metrics` 是 Prometheus 文本格式抓取点（同样需要 admin 令牌）：
  ```
  arcana_uptime_seconds, arcana_memory_rss_bytes, arcana_ws_clients,
  arcana_services_total, arcana_services_status{status="running|crashed|..."},
  arcana_requests_rate_limited_total
  ```

## 健康检查

`GET /v2/health` → `{ ok: true }`（需 API 令牌，除非环回绕过）。容器探针示例：

```yaml
livenessProbe:
  httpGet: { path: /v2/health, port: 8787, httpHeaders: [{ name: Authorization, value: "Bearer <token>" }] }
```

## services 隔离与密钥（详见 docs/services-sdk.md）

`services/services.config.json` 按 service 配置隔离与密钥作用域：

```json
{
  "cutpilot": { "isolation": "process", "memoryLimitMB": 512, "secrets": ["DOUBAO_API_KEY"] }
}
```

隔离 service 中 `ctx.sdk.secrets.get()` 经 IPC 由网关解析（vault 派生密钥不出网关），且解析过的密钥值会自动从对外事件流中 redact。

## 优雅关闭

网关与 service manager 都挂了 SIGTERM/SIGINT 钩子；容器用 tini（镜像已含）转发信号，在途请求会被排空、隔离 service 收到 stop 后清理退出。

## 单实例提醒

当前 state 是 `ARCANA_HOME` 下的文件存储，**面向单网关实例**。多实例水平扩展需要把 sessions/event-store 外移到共享存储（路线图 D/未来项），暂不要在多副本后端跑同一 `ARCANA_HOME`。
