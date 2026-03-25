---
name: create_skill
description: "默认在当前 Agent 的 $ARCANA_HOME/agents/<agentId>/skills 下初始化一个 Skill（含 SKILL.md）；仅在显式使用 --shared 时写入项目 ./skills。工具代码应放在 <skill>/tools 下并通过 frontmatter 声明可见性。"
---

# Create Skill

This skill scaffolds a new skill for the active agent under `$ARCANA_HOME/agents/<agentId>/skills` by default (ARCANA_HOME defaults to `~/.arcana`), with an opt-in shared mode that writes into the current workspace `./skills` directory. Arcana discovers skills from agent home, workspace, and package layers via `src/skills.js`. Keep the skill lean and follow progressive disclosure.

## Quick Steps

1. Pick a short, hyphen-case name (letters, digits, hyphens).
2. Run the init script (from your workspace root):
   - `node skills/create_skill/scripts/init-skill.mjs <skill-name> [--resources scripts,references,assets] [--examples]`
   - Add `--shared` (or `--workspace`) to create a cross-agent shared skill under `./skills/<skill-name>`.
3. Edit the generated `SKILL.md` and add any needed `scripts/`, `references/`, or `assets/` files.
4. (Optional) If the skill bundles runnable scripts, prefer invoking them rather than pasting large code into chat.

## Conventions

- Name/description live only in YAML frontmatter.
- Avoid extra docs (README/CHANGELOG). Place details in `references/` and executable code in `scripts/`.
- Keep SKILL.md concise; link to reference files when details are long.

## Secrets bindings

- New skills **must not** read `process.env` directly for API keys or other secrets.
- Use `ctx.secrets.getText('<logical-name>')` from within tools to read secrets via Arcana's bindings system.
- Prefer logical names that follow the shared conventions, for example:
  - `providers/openai/api_key`
  - `providers/google/api_key`
  - `services/feishu/app_id`
  - `services/wechat/app_secret`
- When a required secret is missing, use the `vault` tool with `names: ['<logical-name>']` to open the Secrets UI for the user.
- The Arcana server also exposes a secrets management API at `/api/secrets`; the Secrets UI is backed by this endpoint and should be the primary way users manage bound secrets.

## When This Skill Owns Tools（与工具绑定）

### Execution model（默认：isolated 沙箱）

- **用户自定义 Skill/Tool：默认永远以 isolated 方式执行**（每次调用在独立 Node 子进程中运行）。
  - 优点：代码改动后下次调用立刻生效（避免 ESM 缓存问题）；每次调用都有独立权限沙箱。
  - 你的工具代码无需理解 tool-daemon；只要按约定放在 `<skill>/tools/<tool>/tool.js` 并在 frontmatter 暴露即可。
- **tool-daemon 属于高级用法**：仅当你需要“跨调用持久会话/重资源复用”（例如 Playwright 浏览器会话、bash 宿主级取消/超时治理）时才考虑。
  - 多数情况下更推荐把长生命周期工作做成 `services/` 后台服务，tool 只做控制面。


- 工具位置：`<skill>/tools/<tool>/`（无论该 Skill 位于 Agent Home 还是工作区 ./skills，下游加载器都会自动发现）。
- 可见性：在本 Skill 的 `SKILL.md` 顶部使用 `arcana.tools` 声明（示例）：

```yaml
---
name: <skill>
description: ...
arcana:
  tools:
    - name: <tool>
      label: "<名称>"
      description: "<用途>"
      # 可选：进一步收紧默认安全（默认：允许联网；写入仅限工作区）
      # allowedHosts: ["example.com:443"]
      # allowedWritePaths:
      #   - "relative/path/inside/workspace"
---
```

工具实现可通过 `ctx.safeOps` 使用受限 FS/HTTP：
- FS：读受 workspace-guard 限制；写仅限工作区；如配置 allowedWritePaths，再细化白名单。
- HTTP：仅 http/https；默认超时与大小上限；如配置 allowedHosts，仅放行白名单主机:端口。

## Script

See `skills/create_skill/scripts/init-skill.mjs` for the deterministic scaffolder used by this skill.
