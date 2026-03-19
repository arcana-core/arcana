import { pathToFileURL } from 'node:url';

async function loadStartGatewayV2() {
  const mod = await import('../src/gateway-v2/index.js');
  const fn =
    mod.startGatewayV2 ||
    (mod.default && (mod.default.startGatewayV2 || mod.default));

  if (typeof fn !== 'function') {
    throw new Error('[arcana:gateway-v2] Unable to resolve startGatewayV2 export from ../src/gateway-v2/index.js');
  }

  return fn;
}

export async function startGatewayV2(options) {
  const impl = await loadStartGatewayV2();
  return impl(options);
}

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
