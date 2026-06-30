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
  if (typeof raw !== "string" || !raw) return sendJson(res, 400, { error: "missing X-Filename header" });
  const name = decodeURIComponent(raw);
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
  const { url } = await readJson<{ url: string }>(req);
  try {
    new URL(url);
  } catch {
    return sendJson(res, 400, { error: "invalid url" });
  }
  void host.ingestUrl(url).catch(() => {});
  sendJson(res, 202, { accepted: true });
};

export const handleListSources = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  sendJson(res, 200, { sources: await host.listSources() });
};

export const handleDeleteSource = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { url } = await readJson<{ url: string }>(req);
  await host.deleteSource(url);
  sendJson(res, 200, { ok: true });
};
