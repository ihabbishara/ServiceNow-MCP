import { pipeline, env } from "@huggingface/transformers";
import type { Embedder } from "../services/knowledge/types.js";

/**
 * In-process embeddings via transformers.js (ONNX, CPU). No external service —
 * this is what makes the crawler work regardless of the agent's LLM mode and
 * with zero Ollama dependency. When `modelPath` is set the model loads from a
 * local directory with remote downloads disabled (offline / locked-down nets).
 */
type EmbedPipe = (text: string, opts: unknown) => Promise<{ data: Float32Array }>;
type DisposablePipe = EmbedPipe & { dispose?: () => Promise<void> };

export class LocalEmbedder implements Embedder {
  readonly model: string;
  dim = 0;
  private pipe?: EmbedPipe;
  // Memoize the in-flight init so concurrent first calls share one pipeline()
  // build (avoids a double ONNX init + a leaked session under parallel ingest).
  private readyPromise?: Promise<void>;
  // Serialize embed() calls: the single ONNX session has one intra-op thread
  // pool, so overlapping pipe() calls from concurrent ingest/search/crawl must
  // not run at once. Each embed chains off the previous (tail-promise queue).
  private tail: Promise<unknown> = Promise.resolve();

  constructor(model: string, modelPath?: string) {
    this.model = model;
    if (modelPath) {
      env.allowRemoteModels = false;
      env.localModelPath = modelPath;
    }
  }

  ready(): Promise<void> {
    return (this.readyPromise ??= (async () => {
      this.pipe = (await pipeline("feature-extraction", this.model)) as unknown as EmbedPipe;
      const probe = await this.pipe("x", { pooling: "mean", normalize: true });
      this.dim = probe.data.length;
    })());
  }

  async embed(text: string): Promise<number[]> {
    const run = this.tail.then(async () => {
      if (!this.pipe) await this.ready();
      const out = await this.pipe!(text, { pooling: "mean", normalize: true });
      return Array.from(out.data);
    });
    // Keep the queue alive even if one embed rejects, so later calls still run.
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Release the native ONNX session/threadpool. Must be called before the
   * process exits, otherwise onnxruntime-node aborts during teardown
   * (libc++abi: mutex lock failed) and the process SIGABRTs.
   */
  async dispose(): Promise<void> {
    if (this.pipe) {
      await (this.pipe as DisposablePipe).dispose?.();
      this.pipe = undefined;
      this.dim = 0;
      this.readyPromise = undefined; // allow a fresh init after dispose
    }
  }
}
