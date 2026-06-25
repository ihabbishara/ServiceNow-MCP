import { describe, it, expect } from "vitest";
import { formatSse, SseHub } from "../server/sse.js";

describe("formatSse", () => {
  it("serializes an event as a single data frame", () => {
    expect(formatSse({ type: "delta", text: "hi" })).toBe(`data: {"type":"delta","text":"hi"}\n\n`);
  });
});

describe("SseHub", () => {
  it("broadcasts to every connection and stops after removal", () => {
    const hub = new SseHub();
    const writes: string[] = [];
    const fakeRes = { write: (s: string) => writes.push(s) } as never;
    const remove = hub.add(fakeRes);
    expect(hub.count()).toBe(1);
    hub.broadcast({ type: "turn-end" });
    expect(writes).toEqual([`data: {"type":"turn-end"}\n\n`]);
    remove();
    expect(hub.count()).toBe(0);
    hub.broadcast({ type: "turn-end" });
    expect(writes.length).toBe(1);
  });
});
