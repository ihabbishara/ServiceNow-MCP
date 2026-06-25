// packages/web/server/index.ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEngineHost, type EngineHost } from "./engine-host.js";
import { serveStatic } from "./static.js";
import { handleStream, handleChat, handleConfirm, handleAbort } from "./routes/chat.js";
import { handleAuthStatus, handleLogin } from "./routes/auth.js";
import { handleGetEnv, handlePutEnv } from "./routes/env.js";
import { sendJson } from "./routes/util.js";

const clientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");

export const createApp =
  (host: EngineHost) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? "/").split("?")[0];
    const m = `${req.method} ${url}`;
    try {
      if (m === "GET /api/health") return sendJson(res, 200, { ok: true });
      if (m === "GET /api/stream") return void handleStream(req, res, host);
      if (m === "POST /api/chat") return void (await handleChat(req, res, host));
      if (m === "POST /api/confirm") return void (await handleConfirm(req, res, host));
      if (m === "POST /api/abort") return void (await handleAbort(req, res, host));
      if (m === "GET /api/auth/status") return void (await handleAuthStatus(req, res, host));
      if (m === "POST /api/auth/login") return void (await handleLogin(req, res, host));
      if (m === "GET /api/env") return void (await handleGetEnv(req, res, host));
      if (m === "PUT /api/env") return void (await handlePutEnv(req, res, host));
      await serveStatic(res, clientDist, url); // content-type + SPA fallback (Task 4 helper)
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

export const startServer = async (opts: { port: number; host?: EngineHost }): Promise<Server> => {
  const host =
    opts.host ??
    (await (async () => {
      // Real bootstrap path is exercised by `npm start`, not unit tests.
      const { loadAgentConfig, loadDotenv, buildTools } = await import("@sre/sre-agent");
      const { createMcpRuntime } = await import("@sre/core");
      loadDotenv();
      const runtime = createMcpRuntime();
      const h = createEngineHost({ config: loadAgentConfig(), tools: buildTools(runtime) as import("@github/copilot-sdk").Tool<unknown>[], runtimeFactory: () => runtime });
      await h.start();
      return h;
    })());
  const server = createServer(createApp(host));
  return new Promise((resolve) => server.listen(opts.port, "127.0.0.1", () => resolve(server)));
};

// Entrypoint: `npm start` runs the built dist/server/index.js directly.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.WEB_PORT ?? 4317);
  startServer({ port }).then(() => console.log(`SRE Agent UI on http://127.0.0.1:${port}`));
}
