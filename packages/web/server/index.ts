import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const clientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");

export const startServer = (opts: { port: number }): Promise<Server> => {
  const server = createServer(async (req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Serve the built client; fall back to index.html (SPA).
    const rel = normalize(req.url === "/" || !req.url ? "/index.html" : req.url).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(clientDist, rel));
      res.writeHead(200);
      res.end(body);
    } catch {
      try {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(await readFile(join(clientDist, "index.html")));
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    }
  });
  return new Promise((resolve) =>
    server.listen(opts.port, "127.0.0.1", () => resolve(server))
  );
};
