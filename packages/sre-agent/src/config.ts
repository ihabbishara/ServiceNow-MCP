import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

// An env var written as `KEY=` in a .env file parses to "" (empty string), which
// is NOT undefined — so a plain `.optional()` on an enum/url would reject it as
// "present but invalid". Treat empty strings as unset, like core's config does.
const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  // ServiceNow (reused by core)
  SERVICENOW_BASE_URL: z.string().url(),
  SERVICENOW_USERNAME: z.string().min(1),
  SERVICENOW_PASSWORD: z.string().min(1),
  SERVICENOW_PROXY: optional(z.string()),
  // ADO
  ADO_AUTH_MODE: z.enum(["azcli", "pat"]).default("azcli"),
  ADO_ORG_URL: optional(z.string().url()),
  ADO_PROJECT: optional(z.string().min(1)),
  ADO_PAT: optional(z.string()),
  ADO_AREA_PATH: optional(z.string()),
  ADO_ITERATION_PATH: optional(z.string()),
  ADO_CREATE_BUG_ENABLED: bool(true),
  AZ_PATH: z.string().default("az"),
  // LLM
  LLM_MODE: z.enum(["seat", "byok"]).default("seat"),
  LLM_MODEL: z.string().default("gpt-5"),
  LLM_PROVIDER: optional(z.enum(["azure", "anthropic", "openai"])),
  LLM_BASE_URL: optional(z.string().url()),
  LLM_API_KEY: optional(z.string()),
  AZURE_API_VERSION: z.string().default("2024-10-21"),
  // Copilot seat auth (LLM_MODE=seat). Both optional:
  //  • COPILOT_GITHUB_TOKEN — explicit token handed to the SDK as `gitHubToken`.
  //    Highest-priority SDK auth; bypasses env-token auto-detect entirely (which
  //    is what lets a stray GH_TOKEN/GITHUB_TOKEN poison the connection → 403).
  //  • COPILOT_HOME — points the SDK's bundled runtime at the same credential
  //    store the standalone `copilot` CLI logged into (default ~/.copilot).
  COPILOT_GITHUB_TOKEN: optional(z.string()),
  COPILOT_HOME: optional(z.string()),
  //  • COPILOT_IGNORE_ENV_TOKEN (default true) — strip ambient GH_TOKEN/
  //    GITHUB_TOKEN/COPILOT_GITHUB_TOKEN from the env handed to the Copilot
  //    runtime when no explicit token is set, so it uses the stored `copilot
  //    login` OAuth instead of an ambient (usually non-Copilot) token that 403s.
  COPILOT_IGNORE_ENV_TOKEN: bool(true),
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
  /** Copilot seat auth knobs; only consulted in seat mode. */
  copilot: {
    /** Explicit token → SDK `gitHubToken` (priority auth, no env-token poisoning). */
    githubToken?: string;
    /** COPILOT_HOME → SDK `baseDirectory` so the runtime reads the CLI's store. */
    home?: string;
    /** Strip ambient GitHub env tokens so the runtime uses the stored OAuth. */
    ignoreEnvToken: boolean;
  };
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
    copilot: {
      githubToken: e.COPILOT_GITHUB_TOKEN,
      home: e.COPILOT_HOME,
      ignoreEnvToken: e.COPILOT_IGNORE_ENV_TOKEN
    },
    raw: e
  };
};
