import type { IncomingMessage, ServerResponse } from "node:http";
import { formatOf, extOf } from "@sre/core";
import type { EngineHost } from "../engine-host.js";
import { readJson, sendJson, readBytes } from "./util.js";

export const handleUpload = async (
  req: IncomingMessage,
  res: ServerResponse,
  host: EngineHost,
  maxBytes: number
) => {
  const raw = req.headers["x-filename"];
  if (typeof raw !== "string" || !raw)
    return sendJson(res, 400, { error: "missing X-Filename header" });
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return sendJson(res, 400, { error: "malformed X-Filename header" });
  }
  if (!formatOf(name)) return sendJson(res, 415, { error: `unsupported format: .${extOf(name)}` });
  let bytes: Buffer;
  try {
    bytes = await readBytes(req, maxBytes);
  } catch {
    return sendJson(res, 413, { error: "file exceeds upload size limit" });
  }
  void host.ingestFile(name, bytes).catch(() => {}); // progress + errors surface via ingest-status SSE
  sendJson(res, 202, { accepted: true });
};

export const handleAddUrl = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  let body: { url?: string };
  try {
    body = await readJson<{ url: string }>(req);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  try {
    new URL(body.url ?? "");
  } catch {
    return sendJson(res, 400, { error: "invalid url" });
  }
  void host.ingestUrl(body.url as string).catch(() => {});
  sendJson(res, 202, { accepted: true });
};

export const handleListSources = async (
  _req: IncomingMessage,
  res: ServerResponse,
  host: EngineHost
) => {
  sendJson(res, 200, { sources: await host.listSources() });
};

export const handleDeleteSource = async (
  req: IncomingMessage,
  res: ServerResponse,
  host: EngineHost
) => {
  let body: { url?: string };
  try {
    body = await readJson<{ url: string }>(req);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  if (!body.url || typeof body.url !== "string")
    return sendJson(res, 400, { error: "missing url" });
  await host.deleteSource(body.url);
  sendJson(res, 200, { ok: true });
};
