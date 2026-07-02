import { z } from "zod";
import { envSchema, buildAppConfig, optional, type AppConfig } from "@sre/core";

const bool = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

// Core owns the shared vars; the agent adds only its own.
const agentSchema = envSchema.extend({
  COPILOT_GITHUB_TOKEN: optional(z.string()),
  COPILOT_HOME: optional(z.string()),
  COPILOT_IGNORE_ENV_TOKEN: bool(true),
  CONFIRM_WRITES: bool(true),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  CRAWL_TTL_HOURS: z.coerce.number().nonnegative().default(24),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10485760)
});

export interface AgentConfig {
  llm: {
    mode: "seat" | "byok";
    model: string;
    provider?: {
      type: "azure" | "anthropic" | "openai";
      baseUrl: string;
      apiKey?: string;
      apiVersion?: string;
    };
  };
  adoAuthMode: "azcli" | "pat";
  confirmWrites: boolean;
  turnTimeoutMs: number;
  knowledgeEnabled: boolean;
  crawlTtlHours: number;
  uploadMaxBytes: number;
  sharePointEnabled: boolean;
  copilot: { githubToken?: string; home?: string; ignoreEnvToken: boolean };
  /** The core AppConfig built from the SAME single parse — pass to createMcpRuntime. */
  app: AppConfig;
}

export const loadAgentConfig = (
  env: Record<string, string | undefined> = process.env
): AgentConfig => {
  const parsed = agentSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const e = parsed.data;
  if (e.LLM_MODE === "byok" && (!e.LLM_PROVIDER || !e.LLM_BASE_URL)) {
    throw new Error("LLM_MODE=byok requires LLM_PROVIDER and LLM_BASE_URL");
  }
  if (e.ADO_AUTH_MODE === "azcli" && (!e.ADO_ORG_URL || !e.ADO_PROJECT)) {
    throw new Error("ADO_AUTH_MODE=azcli requires ADO_ORG_URL and ADO_PROJECT");
  }
  return {
    llm: {
      mode: e.LLM_MODE,
      model: e.LLM_MODEL,
      provider: e.LLM_PROVIDER
        ? {
            type: e.LLM_PROVIDER,
            baseUrl: e.LLM_BASE_URL!,
            apiKey: e.LLM_API_KEY,
            apiVersion: e.AZURE_API_VERSION
          }
        : undefined
    },
    adoAuthMode: e.ADO_AUTH_MODE,
    confirmWrites: e.CONFIRM_WRITES,
    turnTimeoutMs: e.TURN_TIMEOUT_MS,
    knowledgeEnabled: !!(e.CRAWL_SEEDS && String(e.CRAWL_SEEDS).trim()),
    crawlTtlHours: e.CRAWL_TTL_HOURS,
    uploadMaxBytes: e.UPLOAD_MAX_BYTES,
    sharePointEnabled: e.SHAREPOINT_ENABLED,
    copilot: {
      githubToken: e.COPILOT_GITHUB_TOKEN,
      home: e.COPILOT_HOME,
      ignoreEnvToken: e.COPILOT_IGNORE_ENV_TOKEN
    },
    app: buildAppConfig(e)
  };
};
