import type { ServerResponse } from "node:http";
import type { ServerEvent } from "../shared/events.js";

export const formatSse = (event: ServerEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/** Fans ServerEvents out to connected SSE responses. */
export class SseHub {
  private clients = new Set<Pick<ServerResponse, "write">>();

  add(res: Pick<ServerResponse, "write">): () => void {
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  broadcast(event: ServerEvent): void {
    const frame = formatSse(event);
    for (const res of this.clients) res.write(frame);
  }

  count(): number {
    return this.clients.size;
  }
}
