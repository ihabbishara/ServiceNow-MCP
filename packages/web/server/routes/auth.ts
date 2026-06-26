// packages/web/server/routes/auth.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineHost } from "../engine-host.js";
import { sendJson } from "./util.js";

export const handleAuthStatus = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  await host.authStatus(); // emits auth-status over SSE
  sendJson(res, 200, { ok: true });
};

export const handleLogin = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  void host.login(); // device-code + restart stream over SSE
  sendJson(res, 202, { accepted: true });
};
