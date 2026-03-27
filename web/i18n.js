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
      'config.load.globalFailed': 'Failed to load global config',
      'config.load.agentFailed': 'Failed to load agent config',
      'config.load.failed': 'Failed to load config',
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
