---
name: create_skill
description: "默认在当前 Agent 的 ~/.arcana/agents/<agentId>/skills 下初始化一个 Skill（含 SKILL.md）；仅在显式使用 --shared 时写入项目 ./skills。工具代码应放在 <skill>/tools 下并通过 frontmatter 声明可见性。"
---

# Create Skill

This skill scaffolds a new skill for the active agent under `~/.arcana/agents/<agentId>/skills` by default, with an opt-in shared mode that writes into the current workspace `./skills` directory. Arcana discovers skills from agent home, workspace, and package layers via `src/skills.js`. Keep the skill lean and follow progressive disclosure.

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

## When This Skill Owns Tools（与工具绑定）

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