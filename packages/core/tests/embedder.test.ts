import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy ML lib so tests never load a real model.
// vi.hoisted ensures these are available when vi.mock factory is hoisted to the top.
const { pipe, pipeline, env } = vi.hoisted(() => {
  const pipe = vi.fn(async (_text: string, _opts: unknown) => ({ data: new Float32Array([0.1, 0.2, 0.3]) }));
  const pipeline = vi.fn(async () => pipe);
  const env: any = {};
  return { pipe, pipeline, env };
});
vi.mock("@huggingface/transformers", () => ({ pipeline, env }));

import { LocalEmbedder } from "../src/clients/embedder.js";

beforeEach(() => {
  pipe.mockClear();
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
});
