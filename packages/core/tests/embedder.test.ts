import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy ML lib so tests never load a real model.
// vi.hoisted ensures these are available when vi.mock factory is hoisted to the top.
const { pipe, pipeline, env } = vi.hoisted(() => {
  const pipe: any = vi.fn(async (_text: string, _opts: unknown) => ({ data: new Float32Array([0.1, 0.2, 0.3]) }));
  pipe.dispose = vi.fn(async () => {});
  const pipeline = vi.fn(async () => pipe);
  const env: any = {};
  return { pipe, pipeline, env };
});
vi.mock("@huggingface/transformers", () => ({ pipeline, env }));

import { LocalEmbedder } from "../src/clients/embedder.js";

beforeEach(() => {
  pipe.mockClear();
  pipe.dispose.mockClear();
  pipeline.mockClear();
  delete env.allowRemoteModels;
  delete env.localModelPath;
});

describe("LocalEmbedder", () => {
  it("loads the pipeline once and captures dim", async () => {
    const e = new LocalEmbedder("Xenova/bge-small-en-v1.5");
    await e.ready();
    await e.ready(); // idempotent
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(e.dim).toBe(3);
    expect(e.model).toBe("Xenova/bge-small-en-v1.5");
  });

  it("embed returns a plain number[] (mean+normalize opts passed)", async () => {
    const e = new LocalEmbedder("m");
    const v = await e.embed("hello");
    expect(v).toEqual([
      expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)
    ]);
    expect(Array.isArray(v)).toBe(true);
    expect(pipe).toHaveBeenCalledWith("hello", { pooling: "mean", normalize: true });
  });

  it("offline mode: modelPath sets env.localModelPath + disables remote", () => {
    new LocalEmbedder("m", "/opt/models/bge");
    expect(env.allowRemoteModels).toBe(false);
    expect(env.localModelPath).toBe("/opt/models/bge");
  });

  it("dispose releases the pipe's native session and resets dim", async () => {
    const e = new LocalEmbedder("m");
    await e.ready();
    expect(e.dim).toBe(3);
    await e.dispose();
    expect(pipe.dispose).toHaveBeenCalledTimes(1);
    expect(e.dim).toBe(0);
  });

  it("ready() after dispose() reloads the pipeline", async () => {
    const e = new LocalEmbedder("m");
    await e.ready();
    await e.dispose();
    await e.ready();
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(e.dim).toBe(3);
  });

  it("ready() is memoized — concurrent first calls share one pipeline build", async () => {
    const e = new LocalEmbedder("m");
    await Promise.all([e.ready(), e.ready(), e.ready()]);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("ready() clears its memo on failure so a later call can retry", async () => {
    pipeline.mockRejectedValueOnce(new Error("model load failed"));
    const e = new LocalEmbedder("m");
    await expect(e.ready()).rejects.toThrow("model load failed");
    // second attempt must rebuild, not replay the cached rejection
    await e.ready();
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(e.dim).toBe(3);
  });
});

describe("LocalEmbedder serialization", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Inject a fake pipe onto the instance so embed() runs without ready(); lets us
  // observe how many embed calls overlap.
  const withFakePipe = (impl: (text: string) => Promise<{ data: Float32Array }>) => {
    const e = new LocalEmbedder("fake");
    (e as unknown as { pipe: unknown }).pipe = (text: string) => impl(text);
    return e;
  };

  it("never runs two embed() calls concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const e = withFakePipe(async (text) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return { data: new Float32Array([text.length, 0, 0]) };
    });
    const results = await Promise.all([e.embed("a"), e.embed("bb"), e.embed("ccc")]);
    expect(maxActive).toBe(1); // serialized, not overlapped
    expect(results).toEqual([[1, 0, 0], [2, 0, 0], [3, 0, 0]]);
  });

  it("keeps the queue alive after one embed rejects", async () => {
    const e = withFakePipe(async (text) => {
      if (text === "boom") throw new Error("nope");
      return { data: new Float32Array([text.length, 0, 0]) };
    });
    await expect(e.embed("boom")).rejects.toThrow("nope");
    await expect(e.embed("ok")).resolves.toEqual([2, 0, 0]);
  });
});
