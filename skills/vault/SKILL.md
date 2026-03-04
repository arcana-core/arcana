---
name: vault
description: "密码箱（Vault）：快速设置/清除环境变量，并默认持久化到本地保险箱文件（~/.arcana/vault.json），支持可选加密存储。当其他工具缺少密钥时，可主动弹出密码箱界面并预填建议变量名，指导用户完成配置。"

arcana:
  tools:
    - name: vault
      label: "密码箱"
      description: "打开密码箱界面，可预设变量名并引导填写。"
      allowNetwork: false
      allowWrite: false

---

# 密码箱（Vault）

用途：在不重启服务的情况下，快速为当前会话设置环境变量，并将其保存到本地保险箱文件（默认 ~/.arcana/vault.json，可由 ARCANA_HOME 覆盖），下次启动可自动加载。常见场景：
- 设置/更新各类 API Key（如 OPENAI_API_KEY、ANTHROPIC_API_KEY…）
- 设置 WeChat 公众号凭据（WECHAT_APP_ID、WECHAT_APP_SECRET）
- 切换 Arcana 运行参数（ARCANA_PROVIDER、ARCANA_MODEL、ARCANA_WORKSPACE…）

如何被触发：
- 当工具报错指向“缺少密钥/凭据/环境变量”时，代理可调用本 Skill 的 `vault` 工具并传入建议变量名（names），前端将自动弹出密码箱并高亮对应变量。
- 用户主动要求“设置密钥/更换模型/修改工作区”等，也可调用本 Skill 打开密码箱。

注意：
- 密码箱对变量名设有白名单及规则：允许 `ARCANA_*`、`*_API_KEY`，以及特定允许项（如 WECHAT_APP_ID/WECHAT_APP_SECRET 等）。
- 通过密码箱设置的变量立刻生效，会广播 `env_refresh`，并刷新可见工具/技能等信息。

存储与加密：
- 持久化文件默认保存在 `~/.arcana/vault.json`；如果设置了 `ARCANA_HOME`，则使用 `$ARCANA_HOME/vault.json`（由 Arcana Home 解析器统一解析）。
- 在“密码箱”界面填写“保险箱口令”后保存时，vault 文件会使用 AES-256-GCM 加密；不填写口令则以明文 JSON 形式保存。
- 当 vault 文件已加密时，后续保存必须提供正确口令，或通过环境变量 `ARCANA_VAULT_PASSPHRASE` 预先注入口令；否则服务会返回 423（已加密且锁定，需要口令）或 403（口令不正确），前端日志会分别提示“已加密且锁定：请输入口令再保存/解锁”和“口令不正确”。
- 建议在常用环境中设置 `ARCANA_VAULT_PASSPHRASE`，以便重启 Arcana 后自动解锁保险箱并加载其中的环境变量。
