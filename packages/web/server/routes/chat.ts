// packages/web/server/routes/chat.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineHost } from "../engine-host.js";
import { formatSse } from "../sse.js";
import { readJson, sendJson } from "./util.js";

export const handleStream = (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  res.write(": connected\n\n");
  const detach = host.hub.add(res);
  for (const ev of host.snapshot()) res.write(formatSse(ev));
  req.on("close", detach);
};

export const handleChat = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { prompt } = await readJson<{ prompt: string }>(req);
  // `send` is async, so a thrown BusyError would become a rejected promise a
  // sync try/catch can't see — gate on the sync flag instead, then fire-and-stream.
  if (host.isTurnRunning()) return sendJson(res, 409, { error: "busy" });
  void host.send(prompt).catch(() => {}); // turn errors surface via the SSE turn-error event
  sendJson(res, 202, { accepted: true });
};

export const handleConfirm = async (
  req: IncomingMessage,
  res: ServerResponse,
  host: EngineHost
) => {
  const { id, approve } = await readJson<{ id: string; approve: boolean }>(req);
  host.resolveConfirm(id, approve);
  sendJson(res, 200, { ok: true });
};

export const handleAbort = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  await host.abort();
  sendJson(res, 200, { ok: true });
};
