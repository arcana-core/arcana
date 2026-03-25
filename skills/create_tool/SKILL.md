---
name: create_tool
description: "在 <skill>/tools/<tool> 下生成受约束的工具（默认 isolated 沙箱执行）。默认属于当前 Agent 的 $ARCANA_HOME/agents/<agentId>/skills；仅在显式使用 --shared-skill 时写入项目 ./skills。工具可见性通过 Skill frontmatter 声明。"
---

# Create Tool（Skill 归属 + SafeOps）

本 Skill 的脚手架用于在“某个 Skill 名下”生成工具代码（工具与 Skill 一一归属），满足以下约束：
- 可见性：工具只在该 Skill 被激活或当轮被提及时对模型可见（门控由插件控制）。
- 执行安全：默认 isolated 子进程沙箱执行；通过 ctx.safeOps 提供受限 FS/HTTP（默认允许 http/https；写入仅限工作区；可按 Skill frontmatter 白名单收紧）。
- 物理位置：`<skill>/tools/<tool>/`（默认位于 Agent Home 的 `$ARCANA_HOME/agents/<agentId>/skills/<skill>/tools/<tool>/`；如使用 `--shared-skill`，则位于工作区 `./skills/<skill>/tools/<tool>/`）。
- 不生成全局插件/不注册全局工具。

## 快速开始

1) 选择 Skill 名与工具名（小写短横线，对应 Skill 目录名和 tools 子目录名）。
2) 运行脚手架（在工作区根目录）：
   - `node skills/create_tool/scripts/create-tool.mjs <skill> <tool> [--desc "描述"] [--label "名称"] [--shared-skill] [--init-skill]`
   - `--init-skill`：如果目标 Skill 目录不存在，则创建 `<agent-home>/skills/<skill>/`（或在 `--shared-skill` 时创建工作区 `./skills/<skill>/`），并在其中生成带有 `arcana.tools` 条目的 `SKILL.md` 模板；如果 `SKILL.md` 已存在，仅输出提醒信息，由你手工维护 frontmatter。
3) 在生成的 `tool.js` 中实现 `execute(callId, args, signal, onUpdate, ctx)`：
   - 通过 `ctx.safeOps` 访问受限 FS/HTTP；默认：联网允许；写入限于工作区；可在 Skill 的 frontmatter 进一步白名单。
4) 在该 Skill 的 `SKILL.md` frontmatter 中声明工具映射（`arcana.tools`）。

## 生成结构

```text
<skill>/
  tools/
    <tool>/
      tool.js     # 默认导出 async 工厂，内部动态加载 wrapArcanaTool 并注入 ctx.safeOps
      .gitignore  # 可忽略本地设置等（默认内容为空，仅作占位）
```

## frontmatter（工具可见性与安全）

在对应 Skill 的 `SKILL.md` 顶部加入：

```yaml
---
name: <skill>
description: ...
arcana:
  tools:
    - name: <tool>
      label: "<名称>"
      description: "<用途>"
      # 可选：进一步收紧（默认已可联网/可写入工作区）
      # allowedHosts: ["example.com:443"]
      # allowedWritePaths:
      #   - "relative/path/inside/workspace"
---
```

## SafeOps 说明（默认）
- FS：
  - 读：工作区内读（workspace-guard）
  - 写：允许；仅限工作区；如配置 allowedWritePaths，再按白名单细化
- HTTP：
  - 仅 http/https；默认 10s 超时 + 响应大小上限；如配置 allowedHosts，仅放行所列主机:端口

## 脚本

脚本见：`skills/create_tool/scripts/create-tool.mjs`（生成 SafeOps + Skill 归属模板）。
