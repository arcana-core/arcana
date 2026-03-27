// Minimal i18n for Arcana web UI
// - Auto-detect locale: localStorage override 'arcanaWeb.lang', else navigator.language
// - Exposes global t(key) and arcanaI18n.setLocale(lang)
(function(){
  const LS_KEY = 'arcanaWeb.lang';

  const dict = {
    'en': {
      'ui.newSession': 'New Session',
      'ui.clearContextTitle': 'Clear internal context (keep history)',
      'ui.welcome': 'Welcome to Arcana. Say something to start.',
      'ui.more': 'More',
      'ui.inputPlaceholder': 'Send a message',
      'ui.stop': 'Stop',
      'ui.send': 'Send',
      'ui.language': 'Language',
      'ui.language.en': 'English',
      'ui.language.zh': 'Chinese (Simplified)',
      'ui.advanced.header': 'Advanced options',
      'ui.advanced.fullshell': 'Allow full command-line access for this session',
      'ui.advanced.fullshellWarning': 'High risk: only enable temporarily in trusted environments; turning off restores restricted mode.',
      'ui.advanced.settingsHeader': 'Settings / Diagnostics',
      'ui.advanced.scope.global': 'Global default',
      'ui.advanced.scope.agent': 'Current agent',
      'ui.thinking': 'Thinking',
      'session.untitled': 'Untitled session',
      'ui.apiTokenPrompt': 'Enter Arcana API Token for /api and /v2 access:',
      'ui.storageQuotaAlert': 'Local storage is full. Please delete unused sessions to free space.',
      'ui.workspacePicker.title': 'Choose workspace',
      'ui.workspacePicker.description': 'The browser can only accept a manually typed absolute workspace path. For a native folder picker, use the desktop app.',
      'ui.workspacePicker.placeholder': 'Absolute path',
      'ui.workspacePicker.cancel': 'Cancel',
      'ui.workspacePicker.ok': 'OK',
      'ui.loading': 'Loading…',
      'agents.listLoadFailed': 'Failed to load agent list. Please check Arcana API Token or server settings.',
      'sessions.deleteTitle': 'Delete session',
      'sessions.deleteConfirm': 'Delete this session? This action cannot be undone.',
      'ui.clearContextConfirm': 'Clear agent internal context?\n\nThis clears tool-call memory for the current session but keeps chat history (prelude).\n\nUseful when changing topics or context is too large.',
      'config.keySet': 'Set',
      'config.keyUnset': 'Not set',
      'skills.noneFound': 'No skills found',
      'skills.loadFailed': 'Failed to load skills list',
      'skills.refreshed': 'Skills refreshed',
      'config.load.globalFailed': 'Failed to load global config',
      'config.load.agentFailed': 'Failed to load agent config',
      'config.load.failed': 'Failed to load config',
      'config.save.globalKeyNeedsProvider': 'Saving global API Key requires selecting a Provider first',
      'config.save.secretsNotReady': 'Secrets vault not ready—initialize/unlock before saving API Key',
      'config.save.importKeyFailedPrefix': 'Failed to save API Key to secrets: ',
      'config.save.importKeyFailed': 'Failed to save API Key to secrets',
      'config.save.globalFailed': 'Failed to save global config',
      'config.save.globalOk': 'Saved global config',
      'config.save.agentKeyNeedsProvider': 'Saving Agent API Key requires selecting a Provider first',
      'config.save.agentFailed': 'Failed to save Agent config',
      'config.save.agentOk': 'Saved Agent config',
      'config.clear.agentFailed': 'Failed to clear Agent config',
      'config.clear.agentOk': 'Cleared Agent config',
      'skills.save.statusOk': 'Saved',
      'skills.save.statusFailed': 'Save failed',
      'skills.save.failed': 'Failed to save skills config',
      'skills.save.ok': 'Saved skills config',
      'doctor.running': 'Running…',
      'doctor.summaryPrefix': 'Result: ok ',
      'doctor.warnLabel': ' warn ',
      'doctor.failLabel': ' fail ',
      'doctor.failed': 'Failed',
      'support.creating': 'Creating…',
      'support.failed': 'Failed',
      'support.donePrefix': 'Done: ',
      'support.downloadTar': 'Download support bundle (tar.gz)',
      'support.downloadFailedHttpPrefix': 'Download failed HTTP ',
      'support.downloadFailed': 'Download failed',
      'sessions.workspaceNotSelected': 'Workspace not selected',
      'chat.noResponse': '[No response]',
      'chat.errorPrefix': '[Error] ',
      'toolStream.onLabel': 'Live tool output: On',
      'toolStream.offLabel': 'Live tool output: Off',
      'secrets.loadingFailedPrefix': 'Load failed: ',
      'secrets.close': 'Close',
      'secrets.title': '🔐 Secrets Vault',
      'secrets.notInitialized.title': '⚠ Secrets vault not initialized',
      'secrets.notInitialized.desc': 'First-time use requires setting a password. It encrypts all secrets—keep it safe.',
      'secrets.password.setPlaceholder': 'Set vault password',
      'secrets.initButton': 'Initialize vault',
      'secrets.locked.title': '🔒 Vault is locked',
      'secrets.locked.desc': 'Enter password to unlock before viewing or managing secrets.',
      'secrets.password.inputPlaceholder': 'Enter vault password',
      'secrets.unlockButton': 'Unlock',
      'secrets.resetButton': 'Reset vault',
      'secrets.unlockedStatusPrefix': 'Unlocked · ',
      'secrets.unlockedStatusSuffix': ' secrets',
      'secrets.savedTitle': 'Saved secrets',
      'secrets.scope.agent': 'Agent',
      'secrets.scope.global': 'Global',
      'secrets.deleteLabel': 'Delete',
      'secrets.batchDelete': 'Delete selected',
      'secrets.empty': 'No secrets yet. Add below.',
      'secrets.addTitle': 'Add secret',
      'secrets.add.namePlaceholder': 'Secret name (e.g., services/aliyun/dashscope_api_key)',
      'secrets.add.valuePlaceholder': 'Secret value',
      'secrets.add.scope.global': 'Global',
      'secrets.add.scope.agent': 'Agent',
      'secrets.add.button': 'Add',
      'secrets.closeButton': 'Close',
      'secrets.enterPassword': 'Please enter password',
      'secrets.initializing': 'Initializing…',
      'secrets.initFailedPrefix': 'Initialize failed: ',
      'secrets.initSuccess': 'Secrets vault initialized',
      'secrets.unknownError': 'Unknown error',
      'secrets.unlocking': 'Unlocking…',
      'secrets.passwordIncorrect': 'Incorrect password',
      'secrets.notInitialized': 'Vault not initialized',
      'secrets.unlockFailedPrefix': 'Unlock failed: ',
      'secrets.unlocked': 'Unlocked',
      'secrets.reset.confirm1': 'Danger: This permanently deletes all secrets and clears the remembered password.\nType RESET (uppercase) to confirm:',
      'secrets.reset.cancelledNoReset': 'Reset cancelled (missing RESET)',
      'secrets.reset.confirm2': 'Confirm again: reset the secrets vault? This action cannot be undone.',
      'secrets.reset.cancelled': 'Reset cancelled',
      'secrets.reset.failed': 'Reset failed',
      'secrets.reset.donePrefix': 'Reset vault (',
      'secrets.reset.globalLabel': 'global: ',
      'secrets.reset.separator': ', ',
      'secrets.reset.agentLabel': 'agent: ',
      'secrets.reset.deleted': 'deleted',
      'secrets.reset.none': 'none',
      'secrets.reset.suffix': ')',
      'secrets.adding': 'Adding…',
      'secrets.locked.mustUnlock': 'Vault locked, unlock first',
      'secrets.add.failedPrefix': 'Add failed: ',
      'secrets.add.addedPrefix': 'Added: ',
      'secrets.add.nameRequired': 'Please enter secret name',
      'secrets.add.valueRequired': 'Please enter secret value',
      'secrets.noneSelected': 'No secrets selected',
      'secrets.deleting': 'Deleting…',
      'secrets.delete.failedPrefix': 'Delete failed: ',
      'secrets.delete.deletedPrefix': 'Deleted ',
    },
    'zh-CN': {
      'ui.newSession': '新会话',
      'ui.clearContextTitle': '清理内部上下文（保留对话历史）',
      'ui.welcome': '欢迎使用 Arcana，对我说点什么吧～',
      'ui.more': '更多',
      'ui.inputPlaceholder': '发送消息',
      'ui.stop': '停止',
      'ui.send': '发送',
      'ui.language': '界面语言',
      'ui.language.en': '英语',
      'ui.language.zh': '简体中文',
      'ui.advanced.header': '高级选项',
      'ui.advanced.fullshell': '允许本次会话完全开放命令行',
      'ui.advanced.fullshellWarning': '高风险：仅在受信环境、确有需要时临时开启。关闭后恢复受限模式。',
      'ui.advanced.settingsHeader': '设置 / 诊断',
      'ui.advanced.scope.global': '全局默认',
      'ui.advanced.scope.agent': '当前 Agent',
      'ui.thinking': '正在思考',
      'session.untitled': '新会话',
      'ui.apiTokenPrompt': '请输入 Arcana API Token，用于访问 /api 和 /v2 接口：',
      'ui.storageQuotaAlert': '本地存储空间已满。请删除不需要的会话来释放空间。',
      'ui.workspacePicker.title': '选择工作区',
      'ui.workspacePicker.description': '建议使用桌面应用获取系统级文件夹选择器。当前在浏览器环境下，仅支持手动输入工作区绝对路径。',
      'ui.workspacePicker.placeholder': '/绝对/路径',
      'ui.workspacePicker.cancel': '取消',
      'ui.workspacePicker.ok': '确定',
      'ui.loading': '加载中…',
      'agents.listLoadFailed': '加载 Agent 列表失败，请检查 Arcana API Token 或服务器设置。',
      'sessions.deleteTitle': '删除会话',
      'sessions.deleteConfirm': '确定删除该会话？此操作不可恢复。',
      'ui.clearContextConfirm': '清理 Agent 内部上下文？\n\n这将清除当前会话中 Agent 的工具调用记忆，\n但保留对话历史（prelude）。\n\n适用于话题转换、上下文过大等情况。',
      'config.keySet': '已设置',
      'config.keyUnset': '未设置',
      'skills.noneFound': '未发现技能',
      'skills.loadFailed': '技能列表加载失败',
      'config.load.globalFailed': '读取全局配置失败',
      'config.load.agentFailed': '读取 Agent 配置失败',
      'config.load.failed': '读取失败',
      'config.save.globalKeyNeedsProvider': '保存全局 API Key 需先选择 Provider',
      'config.save.secretsNotReady': '密钥箱未就绪，请先初始化/解锁后再保存 API Key',
      'config.save.importKeyFailedPrefix': '保存 API Key 到密钥箱失败: ',
      'config.save.importKeyFailed': '保存 API Key 到密钥箱失败',
      'config.save.globalFailed': '保存全局配置失败',
      'config.save.globalOk': '已保存全局配置',
      'config.save.agentKeyNeedsProvider': '保存 Agent API Key 需先选择 Provider',
      'config.save.agentFailed': '保存 Agent 配置失败',
      'config.save.agentOk': '已保存 Agent 配置',
      'config.clear.agentFailed': '清除 Agent 配置失败',
      'config.clear.agentOk': '已清除 Agent 配置',
      'skills.save.statusOk': '已保存',
      'skills.save.statusFailed': '保存失败',
      'skills.save.failed': '保存技能配置失败',
      'skills.save.ok': '已保存技能配置',
      'skills.refreshed': '技能已刷新',
      'doctor.running': '运行中…',
      'doctor.summaryPrefix': '结果：通过 ',
      'doctor.warnLabel': ' 警告 ',
      'doctor.failLabel': ' 失败 ',
      'doctor.failed': '失败',
      'support.creating': '打包中…',
      'support.failed': '失败',
      'support.donePrefix': '完成：',
      'support.downloadTar': '下载支持包（tar.gz）',
      'support.downloadFailedHttpPrefix': '下载失败 HTTP ',
      'support.downloadFailed': '下载失败',
      'sessions.workspaceNotSelected': '未选择工作区',
      'chat.noResponse': '[无回复]',
      'chat.errorPrefix': '[错误] ',
      'toolStream.onLabel': '实时工具输出：开',
      'toolStream.offLabel': '实时工具输出：关',
      'secrets.loadingFailedPrefix': '读取失败: ',
      'secrets.close': '关闭',
      'secrets.title': '🔐 密钥箱',
      'secrets.notInitialized.title': '⚠ 密钥箱未初始化',
      'secrets.notInitialized.desc': '首次使用需要设置口令。口令用于加密所有密钥，请牢记。',
      'secrets.password.setPlaceholder': '设置密钥箱口令',
      'secrets.initButton': '初始化密钥箱',
      'secrets.locked.title': '🔒 密钥箱已锁定',
      'secrets.locked.desc': '输入口令解锁后才能查看或管理密钥。',
      'secrets.password.inputPlaceholder': '输入密钥箱口令',
      'secrets.unlockButton': '解锁',
      'secrets.resetButton': '重置密钥箱',
      'secrets.unlockedStatusPrefix': '已解锁 · ',
      'secrets.unlockedStatusSuffix': ' 个密钥',
      'secrets.savedTitle': '已保存的密钥',
      'secrets.scope.agent': '代理',
      'secrets.scope.global': '全局',
      'secrets.deleteLabel': '删除',
      'secrets.batchDelete': '删除选中',
      'secrets.empty': '暂无密钥，请在下方添加。',
      'secrets.addTitle': '添加密钥',
      'secrets.add.namePlaceholder': '密钥名称（如 services/aliyun/dashscope_api_key）',
      'secrets.add.valuePlaceholder': '密钥值',
      'secrets.add.scope.global': '全局',
      'secrets.add.scope.agent': '代理',
      'secrets.add.button': '添加',
      'secrets.closeButton': '关闭',
      'secrets.enterPassword': '请输入口令',
      'secrets.initializing': '初始化中…',
      'secrets.initFailedPrefix': '初始化失败: ',
      'secrets.initSuccess': '密钥箱初始化成功',
      'secrets.unknownError': '未知错误',
      'secrets.unlocking': '解锁中…',
      'secrets.passwordIncorrect': '口令不正确',
      'secrets.notInitialized': '密钥箱未初始化',
      'secrets.unlockFailedPrefix': '解锁失败: ',
      'secrets.unlocked': '已解锁',
      'secrets.reset.confirm1': '危险操作：将永久删除所有密钥并清空记忆的口令。\n请输入大写 RESET 以确认:',
      'secrets.reset.cancelledNoReset': '已取消重置（未输入 RESET）',
      'secrets.reset.confirm2': '再次确认：是否重置密钥箱？该操作不可撤销。',
      'secrets.reset.cancelled': '已取消重置',
      'secrets.reset.failed': '重置失败',
      'secrets.reset.donePrefix': '已重置密钥箱（',
      'secrets.reset.globalLabel': '全局: ',
      'secrets.reset.separator': '，',
      'secrets.reset.agentLabel': '代理: ',
      'secrets.reset.deleted': '删除',
      'secrets.reset.none': '无',
      'secrets.reset.suffix': '）',
      'secrets.adding': '添加中…',
      'secrets.locked.mustUnlock': '密钥箱已锁定，请先解锁',
      'secrets.add.failedPrefix': '添加失败: ',
      'secrets.add.addedPrefix': '已添加: ',
      'secrets.noneSelected': '未选中任何密钥',
      'secrets.deleting': '删除中…',
      'secrets.delete.failedPrefix': '删除失败: ',
      'secrets.delete.deletedPrefix': '已删除 ',
      'secrets.add.nameRequired': '请输入密钥名称',
      'secrets.add.valueRequired': '请输入密钥值'
    }
  };

  function detectLocale(){
    try{
      const ov = localStorage.getItem(LS_KEY);
      if (ov) return ov;
    } catch{}
    try{
      const nav = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : '';
      const lc = String(nav || '').trim().toLowerCase();
      if (lc.startsWith('zh')) return 'zh-CN';
      return 'en';
    } catch{ return 'en' }
  }

  let current = detectLocale();

  try{
    if (typeof document !== 'undefined' && document.documentElement){
      document.documentElement.lang = current;
    }
  } catch{}

  function t(key){
    try{
      const k = String(key||'');
      const table = dict[current] || dict['en'];
      return table[k] || dict['en'][k] || k;
    } catch { return String(key||'') }
  }

  function applyI18n(){
    try{
      if (typeof document !== 'undefined' && document.documentElement){
        document.documentElement.lang = current;
      }
    } catch{}
    try{
      // textContent replacements
      const nodes = document.querySelectorAll('[data-i18n]');
      nodes.forEach((el)=>{
        const k = el.getAttribute('data-i18n');
        if (!k) return;
        el.textContent = t(k);
      });
      // placeholder replacements
      const placeholders = document.querySelectorAll('[data-i18n-placeholder]');
      placeholders.forEach((el)=>{
        const k = el.getAttribute('data-i18n-placeholder');
        if (!k) return;
        el.setAttribute('placeholder', t(k));
      });
      // title replacements
      const titles = document.querySelectorAll('[data-i18n-title]');
      titles.forEach((el)=>{
        const k = el.getAttribute('data-i18n-title');
        if (!k) return;
        el.setAttribute('title', t(k));
      });
    } catch{}
  }

  function setLocale(lang){
    try{
      const next = String(lang||'').trim();
      if (!next) return;
      current = next;
      try{
        if (typeof document !== 'undefined' && document.documentElement){
          document.documentElement.lang = current;
        }
      } catch{}
      try{ localStorage.setItem(LS_KEY, current); } catch{}
      applyI18n();
    } catch{}
  }

  // Expose globals
  try{ window.t = t; } catch{}
  try{ window.arcanaI18n = { setLocale, get locale(){ return current; } }; } catch{}

  // Apply on DOMContentLoaded
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', applyI18n, { once:true });
  } else {
    applyI18n();
  }
})();
