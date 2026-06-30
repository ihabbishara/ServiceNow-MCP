// packages/web/server/routes/env.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineHost } from "../engine-host.js";
import { readJson, sendJson } from "./util.js";

export const handleGetEnv = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  sendJson(res, 200, await host.readEnv()); // { vars, comments }
};

export const handlePutEnv = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { vars } = await readJson<{ vars: Record<string, string> }>(req);
  const result = await host.applyEnv(vars);
  if (result.ok) return sendJson(res, 200, { ok: true });
  sendJson(res, 400, { error: "invalid config", issues: result.issues });
};
