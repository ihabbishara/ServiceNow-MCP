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

export interface SourceRow { url: string; title?: string; crawledAt: number; indexed: boolean; chunkCount: number }

export const uploadDocument = (file: File) =>
  fetch("/api/knowledge/upload", {
    method: "POST",
    headers: { "x-filename": encodeURIComponent(file.name), "content-type": "application/octet-stream" },
    body: file
  });

export const addUrl = (url: string) => post("/api/knowledge/url", { url });

export const listSources = () =>
  fetch("/api/knowledge/sources").then((r) => r.json() as Promise<{ sources: SourceRow[] }>);

export const deleteSource = (url: string) =>
  fetch("/api/knowledge/sources", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  });
