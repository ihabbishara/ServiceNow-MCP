import { z } from "zod";

const boolString = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const trueBoolString = z.enum(["true", "false"]).default("true").transform((v) => v === "true");
// Empty string → undefined, then validate as an http(s) URL only when present.
const optionalUrl = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().url().refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL").optional()
);

const envSchema = z.object({
  SERVICENOW_BASE_URL: z.string({ required_error: "SERVICENOW_BASE_URL is required" }).url(),
  SERVICENOW_USERNAME: z.string({ required_error: "SERVICENOW_USERNAME is required" }).min(1),
  SERVICENOW_PASSWORD: z.string({ required_error: "SERVICENOW_PASSWORD is required" }).min(1),
  SERVICENOW_PROXY: optionalUrl,
  ADO_ENABLED: boolString,
  ADO_ORG_URL: z.string().url().optional(),
  ADO_PROXY: optionalUrl,
  ADO_PROJECT: z.string().min(1).optional(),
  ADO_PAT: z.string().min(1).optional(),
  ADO_AREA_PATH: z.string().optional().transform((v) => v || undefined),
  ADO_ITERATION_PATH: z.string().optional().transform((v) => v || undefined),
  ADO_ASSIGNED_TEAM: z.string().optional().transform((v) => v || undefined),
  ADO_CREATE_BUG_ENABLED: trueBoolString,
  STALE_P1_MIN: z.coerce.number().int().positive().default(30),
  STALE_P2_MIN: z.coerce.number().int().positive().default(120),
  STALE_P3_MIN: z.coerce.number().int().positive().default(1440),
  STALE_P4_MIN: z.coerce.number().int().positive().default(4320),
  CORRELATION_HOURS_BEFORE: z.coerce.number().positive().default(24),
  CORRELATION_HOURS_AFTER: z.coerce.number().positive().default(4)
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
  orgUrl?: string;
  project?: string;
  pat?: string;
  defaultAreaPath?: string;
  defaultIterationPath?: string;
  defaultAssignedTeam?: string;
  proxyUrl?: string; // HTTP proxy for Azure DevOps calls (ADO_PROXY)
}

export interface AppConfig {
  serviceNow: ServiceNowConfig;
  azureDevOps: AdoConfig;
  features: { createAdoBug: boolean };
  thresholds: {
    staleByPriorityMinutes: Record<string, number>;
    relatedChangeWindow: { beforeHours: number; afterHours: number };
  };
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const e = parsed.data;
  if (e.ADO_ENABLED && (!e.ADO_ORG_URL || !e.ADO_PROJECT || !e.ADO_PAT)) {
    throw new Error("ADO_ENABLED=true requires ADO_ORG_URL, ADO_PROJECT, and ADO_PAT");
  }
  return {
    serviceNow: {
      enabled: true,
      baseUrl: e.SERVICENOW_BASE_URL.replace(/\/+$/, ""),
      username: e.SERVICENOW_USERNAME,
      password: e.SERVICENOW_PASSWORD,
      proxyUrl: e.SERVICENOW_PROXY
    },
    azureDevOps: {
      enabled: e.ADO_ENABLED,
      orgUrl: e.ADO_ORG_URL?.replace(/\/+$/, ""),
      project: e.ADO_PROJECT,
      pat: e.ADO_PAT,
      defaultAreaPath: e.ADO_AREA_PATH ?? e.ADO_PROJECT,
      defaultIterationPath: e.ADO_ITERATION_PATH ?? e.ADO_PROJECT,
      defaultAssignedTeam: e.ADO_ASSIGNED_TEAM,
      proxyUrl: e.ADO_PROXY
    },
    features: { createAdoBug: e.ADO_CREATE_BUG_ENABLED },
    thresholds: {
      staleByPriorityMinutes: { "1": e.STALE_P1_MIN, "2": e.STALE_P2_MIN, "3": e.STALE_P3_MIN, "4": e.STALE_P4_MIN },
      relatedChangeWindow: { beforeHours: e.CORRELATION_HOURS_BEFORE, afterHours: e.CORRELATION_HOURS_AFTER }
    }
  };
};
