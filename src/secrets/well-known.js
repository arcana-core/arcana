// Well-known logical secret names and helpers for provider API keys.

export const WELL_KNOWN_SECRETS = [
  // Provider API keys
  { name: 'providers/openai/api_key', provider: 'openai', kind: 'api_key' },
  { name: 'providers/openai-compatible/api_key', provider: 'openai-compatible', kind: 'api_key' },
  { name: 'providers/azure-openai-responses/api_key', provider: 'azure-openai-responses', kind: 'api_key' },
  { name: 'providers/anthropic/api_key', provider: 'anthropic', kind: 'api_key' },
  { name: 'providers/google/api_key', provider: 'google', kind: 'api_key' },
  { name: 'providers/google-vertex/api_key', provider: 'google-vertex', kind: 'api_key' },
  { name: 'providers/mistral/api_key', provider: 'mistral', kind: 'api_key' },
  { name: 'providers/groq/api_key', provider: 'groq', kind: 'api_key' },
  { name: 'providers/cerebras/api_key', provider: 'cerebras', kind: 'api_key' },
  { name: 'providers/xai/api_key', provider: 'xai', kind: 'api_key' },
  { name: 'providers/openrouter/api_key', provider: 'openrouter', kind: 'api_key' },
  { name: 'providers/vercel-ai-gateway/api_key', provider: 'vercel-ai-gateway', kind: 'api_key' },
  { name: 'providers/minimax/api_key', provider: 'minimax', kind: 'api_key' },
  { name: 'providers/moonshot/api_key', provider: 'moonshot', kind: 'api_key' },
  // Generic provider wiring for custom endpoints
  { name: 'providers/generic/api_key', provider: 'generic', kind: 'api_key' },

  // Service secrets commonly used by skills
  { name: 'services/feishu/app_id', service: 'feishu', kind: 'app_id' },
  { name: 'services/feishu/app_secret', service: 'feishu', kind: 'app_secret' },
  { name: 'services/wechat/app_id', service: 'wechat', kind: 'app_id' },
  { name: 'services/wechat/app_secret', service: 'wechat', kind: 'app_secret' },
  { name: 'services/elevenlabs/api_key', service: 'elevenlabs', kind: 'api_key' },
  { name: 'services/aliyun/dashscope_api_key', service: 'aliyun', kind: 'api_key' },
  { name: 'services/volcengine/api_key', service: 'volcengine', kind: 'api_key' },
  { name: 'services/nano_banana/proxy_key', service: 'nano_banana', kind: 'api_key' },
];

/**
 * Map a provider id (e.g. "openai") to the logical
 * secret name used for its API key.
 */
export function providerApiKeyName(provider){
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return '';
  return `providers/${p}/api_key`;
}

export default { WELL_KNOWN_SECRETS, providerApiKeyName };
