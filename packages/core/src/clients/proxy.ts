import { ProxyAgent, Dispatcher } from "undici";

// We use undici's own `fetch` (not Node's global fetch) together with this
// ProxyAgent so both come from the same pinned undici package. That decouples
// proxying from whatever undici the Node runtime happens to bundle (Node 18/20
// ship undici 5, 22/23 ship 6, 24 ships 7) — a dispatcher from a different
// undici major than the fetch driving it throws at request setup.
export type FetchDispatcher = Dispatcher;

/**
 * Build an undici dispatcher that routes fetch through the given HTTP proxy,
 * or undefined for a direct connection. Use with undici's `fetch` (see above);
 * Node's global fetch also ignores the HTTP(S)_PROXY environment variables, so
 * a dispatcher is the only way to proxy a fetch request regardless.
 */
export const proxyDispatcher = (proxyUrl?: string): Dispatcher | undefined =>
  proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
