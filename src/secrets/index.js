import { WELL_KNOWN_SECRETS, providerApiKeyName } from './well-known.js';
import { createSecretsContext } from './context.js';
import store from './store.js';

export {
  WELL_KNOWN_SECRETS,
  providerApiKeyName,
  createSecretsContext,
  store as secrets,
};

const api = {
  WELL_KNOWN_SECRETS,
  providerApiKeyName,
  createSecretsContext,
  secrets: store,
};

export default api;
