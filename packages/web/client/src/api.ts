// packages/web/client/src/api.ts
const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

export const sendPrompt = (prompt: string) => post("/api/chat", { prompt });
export const answerConfirm = (id: string, approve: boolean) => post("/api/confirm", { id, approve });
export const abortTurn = () => post("/api/abort");
export const startLogin = () => post("/api/auth/login");
export const getEnv = () => fetch("/api/env").then((r) => r.json() as Promise<{ vars: Record<string, string> }>);
export const putEnv = (vars: Record<string, string>) =>
  fetch("/api/env", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vars }) });
