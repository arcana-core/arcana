import { pathToFileURL } from 'node:url';
import { startGatewayV2 } from '../src/gateway-v2/index.js';

export { startGatewayV2 };

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const portEnv = process.env.PORT;
  const port = portEnv ? Number(portEnv) : 8787;
  startGatewayV2({ port }).catch((e) => {
    console.error('[arcana:gateway-v2] failed to start:', e?.stack || e);
    process.exit(1);
  });
}

