import { ProxyAgent } from "undici";

// The dispatcher type the global fetch's RequestInit expects (from @types/node's
// bundled undici-types). The installed `undici` package ships its own slightly
// different Dispatcher type, so we cast the ProxyAgent to this once, here.
export type FetchDispatcher = NonNullable<RequestInit["dispatcher"]>;

/**
 * Build an undici dispatcher that routes fetch through the given HTTP proxy,
 * or undefined for a direct connection. Node's global fetch ignores the
 * HTTP(S)_PROXY environment variables, so passing a dispatcher is the only way
 * to send a fetch request through a proxy.
 */
export const proxyDispatcher = (proxyUrl?: string): FetchDispatcher | undefined =>
  proxyUrl ? (new ProxyAgent(proxyUrl) as unknown as FetchDispatcher) : undefined;
