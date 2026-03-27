---
name: secrets
description: "密钥箱（Secrets）：管理敏感 Secrets。所有 API Key/应用密钥通过内部加密密码箱的 Secrets 绑定（/api/secrets）管理，使用逻辑名称（如 providers/openai/api_key）按名称保存明文值。当其他工具缺少密钥时，可主动弹出密钥箱界面并预填建议 Secret 名称，引导用户完成配置。"

arcana:
  tools:
    - name: secrets
      label: "密钥箱"
      description: "打开密钥箱界面，可预设变量名或 Secret 名称并引导填写。"
      allowNetwork: false
      allowWrite: false

---

# 密钥箱（Secrets）

## 能力概览

密码箱提供 Secrets 绑定：通过逻辑名称（如 `providers/openai/api_key`）写入内部加密密码箱，用于为模型提供 API Key 或为各类服务提供密钥，而不会把明文写入配置文件或日志。

常见场景：

- 设置/更新各类 API Key（如 OpenAI、Anthropic 等）或 provider Secrets：使用 Secrets 绑定逻辑名称（如 `providers/openai/api_key`），而不是在 写入环境变量。
- 设置 WeChat / Feishu 等服务凭据（如 `services/wechat/app_id`、`services/wechat/app_secret` 等）：请使用 Secrets 绑定。

## 触发方式

- 当工具报错指向“缺少密钥/凭据/Secret 绑定”时，代理可调用本 Skill 的 `secrets` 工具并传入建议名称（names），前端将自动弹出密码箱并高亮对应条目。
- 用户主动要求“设置密钥/更换模型/修改工作区/配置 Secrets”等，也可调用本 Skill 打开密码箱。
- 特别提示：当用户询问“修改/配置 API Key、Base URL、模型、Secrets 等环境相关设置”时，助手除了可以调用本 Skill 外，应主动提醒用户可以点击设置面板里的“密码箱”按钮，打开密钥箱界面完成配置。

## 迁移说明

- 旧版基于环境变量的密码箱功能已彻底移除，现版本仅支持 Secrets（加密密钥箱）。

## Secrets（内部加密密码箱）行为

> 新版使用 Arcana 内部加密密码箱：可以在 Web 密钥箱界面中为每个 Secret 直接粘贴明文，点击“保存”按钮，由后端使用 scrypt + AES-256-GCM 将明文加密后写入 `secrets.enc` 文件（全局和代理级）。Arcana 不会在日志中打印明文。

- Secrets 使用独立的加密文件存储明文值，不会以明文形式写入磁盘：
  - 全局：`$ARCANA_HOME/secrets.json`。
  - 代理级：`$ARCANA_HOME/agents/<agentId>/secrets.json`（包含 `inheritGlobal` 标记）。
- 每条 Secret 使用逻辑名称，例如：
  - `providers/openai/api_key`
  - `providers/anthropic/api_key`
  - `services/wechat/app_id`
  - `services/wechat/app_secret`
- 密码箱 Secrets 部分仅通过内部密码箱存储逻辑名称和值（例如 `providers/openai/api_key`），不会在 Arcana 的日志或配置中出现明文。
- 后端对 Secrets 提供 HTTP API：
  - `GET /api/secrets?agentId=<id>`：返回当前全局/代理级绑定以及已知的 WELL_KNOWN_SECRETS 名称。
  - `POST /api/secrets`：更新全局/代理级绑定。提交成功后会广播 `secrets_refresh` 事件，前端会在日志中提示 `[secrets] Secrets 已刷新`。
- Doctor（`/api/doctor` 或 `arcana doctor`）会检查常见 provider 的 Secrets 是否已绑定，并在缺失时提示“Open the Arcana secrets UI and bind providers/<provider>/api_key for your chosen provider.”，此时可以通过本 Skill 打开密码箱 Secrets 面板完成绑定。

## 安全注意事项

- 不要在聊天内容、日志或配置文件中直接粘贴明文密钥或 token。
- **所有 API Key / token / 密码等敏感信息一律通过 Secrets 绑定（/api/secrets）管理，不要写入环境变量。**
- 对于长期使用的密钥，优先通过内部密码箱 Secrets 绑定管理，而不是写入环境变量或硬编码到配置文件中。
- 
