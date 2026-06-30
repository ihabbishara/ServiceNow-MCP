// packages/web/server/routes/util.ts
import type { IncomingMessage, ServerResponse } from "node:http";

export const readJson = async <T>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as T;
};

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Read a request body as raw bytes, rejecting once it exceeds maxBytes. */
export const readBytes = async (req: IncomingMessage, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error("payload too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
};
