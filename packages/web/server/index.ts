// packages/web/server/index.ts
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serveStatic } from "./static.js";

const clientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");

export const startServer = (opts: { port: number }): Promise<Server> => {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    await serveStatic(res, clientDist, url);
  });
  return new Promise((resolve) =>
    server.listen(opts.port, "127.0.0.1", () => resolve(server))
  );
};
