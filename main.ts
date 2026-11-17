// main.ts — the forge entrypoint. One process, one store, one server.
//
// Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register it with
// the environment, serve the suite, and exit 0 once the environment reports
// the trial done. Local mode (no MAKEFUN_ENV_URL): serve forever on PORT, or
// on an ephemeral port when PORT is unset, so the forge can be driven by curl
// and the real git CLI by hand.
//
// The bearer token comes from MAKEFUN_SHOP_TOKEN; with no token configured,
// any Authorization header is accepted as the viewer and a missing one is a
// 401, which is how the local harness exercises the auth surface.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store();
  const server = createApp(store, token);

  const trial = envUrl !== undefined && envUrl !== '';
  const port = trial ? 0 : Number(process.env.PORT ?? 0) || 0;

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : 0;

  if (!trial) {
    console.log(`github-core-clone-forge listening on http://127.0.0.1:${boundPort}`);
    // Local mode: serve forever. The promise never resolves, so the process
    // stays up until it is killed.
    await new Promise<void>(() => {});
    return 0;
  }

  const base = envUrl!.replace(/\/$/, '');
  const register = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: boundPort }),
  });
  if (!register.ok) {
    console.error(`register failed: HTTP ${register.status}`);
    return 1;
  }

  // Long-poll /done until the environment ends the trial.
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      const data = (await response.json().catch(() => ({}))) as { done?: unknown };
      if (data.done === true) break;
    } catch {
      // The environment may not be ready yet; keep polling.
    }
    await sleep(250);
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return 0;
}

const code = await main();
process.exit(code);
