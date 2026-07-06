import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

export const boolString = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
export const trueBoolString = z
  .enum(["true", "false"])
  .default("true")
  .transform((v) => v === "true");
// Empty string → undefined, then validate as an http(s) URL only when present.
const optionalUrl = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL")
    .optional()
);
// Empty string → undefined before validating. Without this, a `KEY=` line in
// .env parses to "" — which is "present but invalid" for `.min(1)`/`.url()`, so
// the optional field wrongly rejects (e.g. `ADO_PAT=` failed on startup).
export const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

export const envSchema = z.object({
  SERVICENOW_BASE_URL: z.string({ error: "SERVICENOW_BASE_URL is required" }).url(),
  SERVICENOW_USERNAME: z.string({ error: "SERVICENOW_USERNAME is required" }).min(1),
  SERVICENOW_PASSWORD: z.string({ error: "SERVICENOW_PASSWORD is required" }).min(1),
  SERVICENOW_PROXY: optionalUrl,
  ADO_ENABLED: boolString,
  ADO_AUTH_MODE: z.enum(["azcli", "pat"]).default("azcli"),
  AZ_PATH: z.string().default("az"),
  ADO_ORG_URL: optional(z.string().url()),
  ADO_PROXY: optionalUrl,
  ADO_PROJECT: optional(z.string().min(1)),
  ADO_PAT: optional(z.string().min(1)),
  ADO_AREA_PATH: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  ADO_ITERATION_PATH: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  ADO_ASSIGNED_TEAM: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  ADO_BOARD_MAP: z.string().optional(),
  ADO_CSV_DIR: optional(z.string().min(1)),
  ADO_CSV_MAX_BYTES: z.coerce.number().int().positive().default(5242880),
  ADO_CREATE_BUG_ENABLED: trueBoolString,
  STALE_P1_MIN: z.coerce.number().int().positive().default(30),
  STALE_P2_MIN: z.coerce.number().int().positive().default(120),
  STALE_P3_MIN: z.coerce.number().int().positive().default(1440),
  STALE_P4_MIN: z.coerce.number().int().positive().default(4320),
  CORRELATION_HOURS_BEFORE: z.coerce.number().positive().default(24),
  CORRELATION_HOURS_AFTER: z.coerce.number().positive().default(4),
  KNOWLEDGE_DB_PATH: z.string().optional(),
  CRAWL_SEEDS: z.string().optional(),
  CRAWL_ALLOW_DOMAINS: z.string().optional(),
  CRAWL_MAX_PAGES: z.coerce.number().int().positive().default(200),
  CRAWL_MAX_DEPTH: z.coerce.number().int().nonnegative().default(3),
  CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  CRAWL_RATE_MS: z.coerce.number().int().nonnegative().default(500),
  CRAWL_MAX_BYTES: z.coerce.number().int().positive().default(2097152),
  CRAWL_PROXY: optionalUrl,
  CRAWL_RESPECT_ROBOTS: trueBoolString,
  CRAWL_TOPIC: optional(z.string().min(1)),
  EMBED_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),
  EMBED_MODEL_PATH: optional(z.string().min(1)),
  // Verdict chat reuses the agent's LLM_* env (byok → provider HTTP; seat → heuristic).
  LLM_MODE: z.enum(["seat", "byok"]).default("seat"),
  LLM_PROVIDER: optional(z.enum(["azure", "anthropic", "openai"])),
  LLM_BASE_URL: optional(z.string().url()),
  LLM_API_KEY: optional(z.string().min(1)),
  LLM_MODEL: z.string().default("gpt-5"),
  AZURE_API_VERSION: z.string().default("2024-10-21"),
  SHAREPOINT_ENABLED: boolString,
  SHAREPOINT_SITE_URL: optional(z.string().url()),
  SHAREPOINT_INCIDENT_ROOT: z
    .string()
    .optional()
    .transform((v) => (v ?? "").replace(/^\/+|\/+$/g, "")),
  SHAREPOINT_DOCS_SUBFOLDER: z.string().default("Docs"),
  SHAREPOINT_PROXY: optionalUrl,
  SHAREPOINT_MAX_DOC_TOKENS: z.coerce.number().int().positive().default(50000),
  SHAREPOINT_MAX_FILES: z.coerce.number().int().positive().default(50),
  SHAREPOINT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10485760),
  SHAREPOINT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  GIT_WORKSPACE_DIR: optional(z.string().min(1))
});

export interface ServiceNowConfig {
  enabled: boolean; // always true; kept because index.ts logs it
  baseUrl: string;
  username: string;
  password: string;
  proxyUrl?: string; // HTTP proxy for ServiceNow calls (SERVICENOW_PROXY)
}

export interface AdoConfig {
  enabled: boolean;
  authMode?: "azcli" | "pat";
  azPath?: string;
  createBugEnabled?: boolean;
  orgUrl?: string;
  project?: string;
  pat?: string;
  defaultAreaPath?: string;
  defaultIterationPath?: string;
  defaultAssignedTeam?: string;
  proxyUrl?: string; // HTTP proxy for Azure DevOps calls (ADO_PROXY)
  boardMap?: Record<string, string>;
  csvDir?: string;
  csvMaxBytes: number;
  /** Root dir for incident-analysis repo checkouts (GIT_WORKSPACE_DIR); default under os.tmpdir(). */
  gitWorkspaceDir?: string;
}

export interface KnowledgeConfig {
  dbPath: string;
  seeds: string[];
  allowDomains: string[];
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  rateMs: number;
  maxBytes: number;
  proxyUrl?: string;
  respectRobots: boolean;
  topic?: string;
  embedModel: string;
  embedModelPath?: string;
  chat?: {
    type: "openai" | "azure" | "anthropic";
    baseUrl: string;
    model: string;
    apiKey?: string;
    apiVersion?: string;
  };
}

export interface SharePointConfig {
  enabled: boolean;
  siteUrl: string;
  incidentRoot: string;
  docsSubfolder: string;
  authMode: "azcli";
  azPath: string;
  proxyUrl?: string;
  maxDocTokens: number;
  maxFiles: number;
  maxFileBytes: number;
  timeoutMs: number;
}

export interface AppConfig {
  serviceNow: ServiceNowConfig;
  azureDevOps: AdoConfig;
  knowledge: KnowledgeConfig;
  sharePoint: SharePointConfig;
  features: { createAdoBug: boolean };
  thresholds: {
    staleByPriorityMinutes: Record<string, number>;
    relatedChangeWindow: { beforeHours: number; afterHours: number };
  };
}

const csv = (v?: string): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const hostOf = (u: string): string | undefined => {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
};

const parseBoardMap = (raw?: string): Record<string, string> => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          ([, val]) => typeof val === "string"
        ) as [string, string][]
      );
    }
  } catch {
    // ponytail: invalid board map JSON is ignored, not fatal — never block startup
  }
  return {};
};

export const buildAppConfig = (e: z.infer<typeof envSchema>): AppConfig => {
  if (e.ADO_ENABLED) {
    if (!e.ADO_ORG_URL || !e.ADO_PROJECT) {
      throw new Error("ADO_ENABLED=true requires ADO_ORG_URL and ADO_PROJECT");
    }
    // PAT is only needed in pat mode; azcli authenticates via the `az` CLI session.
    if (e.ADO_AUTH_MODE === "pat" && !e.ADO_PAT) {
      throw new Error("ADO_ENABLED=true with ADO_AUTH_MODE=pat requires ADO_PAT");
    }
  }
  if (e.SHAREPOINT_ENABLED && !e.SHAREPOINT_SITE_URL) {
    throw new Error("SHAREPOINT_ENABLED=true requires SHAREPOINT_SITE_URL");
  }
  const seeds = csv(e.CRAWL_SEEDS);
  const allowDomains =
    csv(e.CRAWL_ALLOW_DOMAINS).length > 0
      ? csv(e.CRAWL_ALLOW_DOMAINS)
      : [...new Set(seeds.map(hostOf).filter((h): h is string => !!h))];
  const knowledge: KnowledgeConfig = {
    dbPath: e.KNOWLEDGE_DB_PATH || join(homedir(), ".sre-agent", "knowledge.db"),
    seeds,
    allowDomains,
    maxPages: e.CRAWL_MAX_PAGES,
    maxDepth: e.CRAWL_MAX_DEPTH,
    concurrency: e.CRAWL_CONCURRENCY,
    rateMs: e.CRAWL_RATE_MS,
    maxBytes: e.CRAWL_MAX_BYTES,
    proxyUrl: e.CRAWL_PROXY,
    respectRobots: e.CRAWL_RESPECT_ROBOTS,
    topic: e.CRAWL_TOPIC,
    embedModel: e.EMBED_MODEL,
    embedModelPath: e.EMBED_MODEL_PATH,
    chat:
      e.LLM_MODE === "byok" && e.LLM_PROVIDER && e.LLM_BASE_URL
        ? {
            type: e.LLM_PROVIDER,
            baseUrl: e.LLM_BASE_URL,
            apiKey: e.LLM_API_KEY,
            model: e.LLM_MODEL,
            apiVersion: e.AZURE_API_VERSION
          }
        : undefined
  };
  return {
    serviceNow: {
      enabled: true,
      baseUrl: e.SERVICENOW_BASE_URL.replace(/\/+$/, ""),
      username: e.SERVICENOW_USERNAME,
      password: e.SERVICENOW_PASSWORD,
      proxyUrl: e.SERVICENOW_PROXY
    },
    knowledge,
    azureDevOps: {
      enabled: e.ADO_ENABLED,
      authMode: e.ADO_AUTH_MODE,
      azPath: e.AZ_PATH,
      createBugEnabled: e.ADO_CREATE_BUG_ENABLED,
      orgUrl: e.ADO_ORG_URL?.replace(/\/+$/, ""),
      project: e.ADO_PROJECT,
      pat: e.ADO_PAT,
      defaultAreaPath: e.ADO_AREA_PATH ?? e.ADO_PROJECT,
      defaultIterationPath: e.ADO_ITERATION_PATH ?? e.ADO_PROJECT,
      defaultAssignedTeam: e.ADO_ASSIGNED_TEAM,
      proxyUrl: e.ADO_PROXY,
      boardMap: parseBoardMap(e.ADO_BOARD_MAP),
      csvDir: e.ADO_CSV_DIR,
      csvMaxBytes: e.ADO_CSV_MAX_BYTES,
      gitWorkspaceDir: e.GIT_WORKSPACE_DIR
    },
    sharePoint: {
      enabled: e.SHAREPOINT_ENABLED,
      siteUrl: e.SHAREPOINT_SITE_URL?.replace(/\/+$/, "") ?? "",
      incidentRoot: e.SHAREPOINT_INCIDENT_ROOT,
      docsSubfolder: e.SHAREPOINT_DOCS_SUBFOLDER,
      authMode: "azcli",
      azPath: e.AZ_PATH,
      proxyUrl: e.SHAREPOINT_PROXY,
      maxDocTokens: e.SHAREPOINT_MAX_DOC_TOKENS,
      maxFiles: e.SHAREPOINT_MAX_FILES,
      maxFileBytes: e.SHAREPOINT_MAX_FILE_BYTES,
      timeoutMs: e.SHAREPOINT_TIMEOUT_MS
    },
    features: { createAdoBug: e.ADO_CREATE_BUG_ENABLED },
    thresholds: {
      staleByPriorityMinutes: {
        "1": e.STALE_P1_MIN,
        "2": e.STALE_P2_MIN,
        "3": e.STALE_P3_MIN,
        "4": e.STALE_P4_MIN
      },
      relatedChangeWindow: {
        beforeHours: e.CORRELATION_HOURS_BEFORE,
        afterHours: e.CORRELATION_HOURS_AFTER
      }
    }
  };
};

export const loadConfig = (env: Record<string, string | undefined> = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return buildAppConfig(parsed.data);
};
