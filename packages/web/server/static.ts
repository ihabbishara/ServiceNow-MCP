// packages/web/server/static.ts
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** Serve `urlPath` from `clientDist` with content-type; fall back to index.html (SPA). */
export const serveStatic = async (
  res: ServerResponse,
  clientDist: string,
  urlPath: string
): Promise<void> => {
  const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = await readFile(join(clientDist, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(await readFile(join(clientDist, "index.html")));
  }
};
