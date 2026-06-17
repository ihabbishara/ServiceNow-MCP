import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

const schema = z.object({
  // ServiceNow (reused by core)
  SERVICENOW_BASE_URL: z.string().url(),
  SERVICENOW_USERNAME: z.string().min(1),
  SERVICENOW_PASSWORD: z.string().min(1),
  SERVICENOW_PROXY: z.string().optional(),
  // ADO
  ADO_AUTH_MODE: z.enum(["azcli", "pat"]).default("azcli"),
  ADO_ORG_URL: z.string().url().optional(),
  ADO_PROJECT: z.string().min(1).optional(),
  ADO_PAT: z.string().optional(),
  ADO_AREA_PATH: z.string().optional(),
  ADO_ITERATION_PATH: z.string().optional(),
  ADO_CREATE_BUG_ENABLED: bool(true),
  AZ_PATH: z.string().default("az"),
  // LLM
  LLM_MODE: z.enum(["seat", "byok"]).default("seat"),
  LLM_MODEL: z.string().default("gpt-5"),
  LLM_PROVIDER: z.enum(["azure", "anthropic", "openai"]).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  AZURE_API_VERSION: z.string().default("2024-10-21"),
  // behavior
  CONFIRM_WRITES: bool(true),
  // thresholds (passed through to core)
  STALE_P1_MIN: z.coerce.number().int().positive().default(30),
  STALE_P2_MIN: z.coerce.number().int().positive().default(120),
  STALE_P3_MIN: z.coerce.number().int().positive().default(1440),
  STALE_P4_MIN: z.coerce.number().int().positive().default(4320),
  CORRELATION_HOURS_BEFORE: z.coerce.number().positive().default(24),
  CORRELATION_HOURS_AFTER: z.coerce.number().positive().default(4)
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
  raw: z.infer<typeof schema>; // hand the rest to core's loadConfig
}

export const loadAgentConfig = (
  env: Record<string, string | undefined> = process.env
): AgentConfig => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
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
    raw: e
  };
};
