import { WELL_KNOWN_SECRETS, providerApiKeyName, agentProviderApiKeyName } from './well-known.js';
import { createSecretsContext } from './context.js';
import store from './store.js';

export {
  WELL_KNOWN_SECRETS,
  providerApiKeyName,
  agentProviderApiKeyName,
  createSecretsContext,
  store as secrets,
};

const api = {
  WELL_KNOWN_SECRETS,
  providerApiKeyName,
  agentProviderApiKeyName,
  createSecretsContext,
  secrets: store,
};

export default api;
