import { pipeline, env } from "@huggingface/transformers";
import type { Embedder } from "../services/knowledge/types.js";

/**
 * In-process embeddings via transformers.js (ONNX, CPU). No external service —
 * this is what makes the crawler work regardless of the agent's LLM mode and
 * with zero Ollama dependency. When `modelPath` is set the model loads from a
 * local directory with remote downloads disabled (offline / locked-down nets).
 */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  dim = 0;
  private pipe?: (text: string, opts: unknown) => Promise<{ data: Float32Array }>;

  constructor(model: string, modelPath?: string) {
    this.model = model;
    if (modelPath) {
      env.allowRemoteModels = false;
      env.localModelPath = modelPath;
    }
  }

  async ready(): Promise<void> {
    if (this.pipe) return;
    this.pipe = (await pipeline("feature-extraction", this.model)) as typeof this.pipe;
    const probe = await this.pipe!("x", { pooling: "mean", normalize: true });
    this.dim = probe.data.length;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.pipe) await this.ready();
    const out = await this.pipe!(text, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  }
}
