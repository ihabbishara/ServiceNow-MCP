// Curated metadata for the .env settings page: friendly label, help text (shown
// in the (i) tooltip), whether the field holds a secret, and which group it
// belongs to. Keys not listed here fall to the "Other" group, use their inline
// .env comment as help text, and are treated as secret if the name looks like one.

export type EnvGroup =
  | "ServiceNow"
  | "Azure DevOps"
  | "LLM & Copilot"
  | "Knowledge & Crawl"
  | "SharePoint"
  | "Other";

export const ENV_GROUPS: EnvGroup[] = [
  "ServiceNow",
  "Azure DevOps",
  "LLM & Copilot",
  "Knowledge & Crawl",
  "SharePoint",
  "Other"
];

export interface EnvFieldMeta {
  label?: string;
  description: string;
  secret?: boolean;
  group: EnvGroup;
}

export const ENV_FIELDS: Record<string, EnvFieldMeta> = {
  // ServiceNow
  SERVICENOW_BASE_URL: { label: "Instance URL", description: "ServiceNow instance base URL (https://<instance>.service-now.com).", group: "ServiceNow" },
  SERVICENOW_USERNAME: { label: "Username", description: "ServiceNow API username (often a non-personal/service account).", group: "ServiceNow" },
  SERVICENOW_PASSWORD: { label: "Password", description: "ServiceNow API password.", secret: true, group: "ServiceNow" },
  SERVICENOW_PROXY: { label: "Proxy", description: "Optional HTTP(S) proxy for ServiceNow calls. Leave blank for none.", group: "ServiceNow" },

  // Azure DevOps
  ADO_AUTH_MODE: { label: "Auth mode", description: "How ADO authenticates: 'azcli' (no PAT, uses `az login`) or 'pat'.", group: "Azure DevOps" },
  AZ_PATH: { label: "Azure CLI path", description: "Path to the Azure CLI binary (default: az).", group: "Azure DevOps" },
  ADO_ORG_URL: { label: "Organization URL", description: "Azure DevOps org URL, e.g. https://dev.azure.com/<org>. Required in azcli mode.", group: "Azure DevOps" },
  ADO_PROJECT: { label: "Project", description: "Azure DevOps project name. Required in azcli mode.", group: "Azure DevOps" },
  ADO_PAT: { label: "Personal access token", description: "ADO personal access token. Used only in 'pat' auth mode.", secret: true, group: "Azure DevOps" },
  ADO_PROXY: { label: "Proxy", description: "Optional HTTP(S) proxy for ADO PAT-mode calls.", group: "Azure DevOps" },
  ADO_ENABLED: { label: "ADO enabled", description: "Core PAT path toggle; true requires ORG_URL + PROJECT + PAT.", group: "Azure DevOps" },
  ADO_AREA_PATH: { label: "Default area path", description: "Default area path for created bugs (default: the project).", group: "Azure DevOps" },
  ADO_ITERATION_PATH: { label: "Default iteration path", description: "Default iteration path for created bugs (default: the project).", group: "Azure DevOps" },
  ADO_ASSIGNED_TEAM: { label: "Default assigned team", description: "Default assigned team for created bugs.", group: "Azure DevOps" },
  ADO_CREATE_BUG_ENABLED: { label: "Create-bug enabled", description: "Feature flag for the create-bug write tool.", group: "Azure DevOps" },

  // LLM & Copilot
  LLM_MODE: { label: "LLM mode", description: "'seat' (GitHub Copilot seat auth) or 'byok' (bring your own provider key).", group: "LLM & Copilot" },
  LLM_MODEL: { label: "Model", description: "Model id to use, e.g. gpt-5.", group: "LLM & Copilot" },
  LLM_PROVIDER: { label: "Provider", description: "BYOK provider: azure, anthropic, or openai. Only used when LLM_MODE=byok.", group: "LLM & Copilot" },
  LLM_BASE_URL: { label: "Provider base URL", description: "BYOK provider API base URL. Required when LLM_MODE=byok.", group: "LLM & Copilot" },
  LLM_API_KEY: { label: "Provider API key", description: "BYOK provider API key.", secret: true, group: "LLM & Copilot" },
  AZURE_API_VERSION: { label: "Azure API version", description: "API version for the Azure OpenAI provider.", group: "LLM & Copilot" },
  COPILOT_GITHUB_TOKEN: { label: "Copilot GitHub token", description: "Explicit Copilot-enabled GitHub token (gho_/ghu_/github_pat_). Bypasses env-token auto-detect.", secret: true, group: "LLM & Copilot" },
  COPILOT_HOME: { label: "Copilot home", description: "Directory of the Copilot CLI credential store (default ~/.copilot).", group: "LLM & Copilot" },
  COPILOT_IGNORE_ENV_TOKEN: { label: "Ignore ambient GitHub token", description: "Strip ambient GH_TOKEN/GITHUB_TOKEN so the runtime uses the stored Copilot OAuth (avoids 403s).", group: "LLM & Copilot" },

  // Knowledge & Crawl
  KNOWLEDGE_DB_PATH: { label: "Index DB path", description: "SQLite path for the knowledge index (default ~/.sre-agent/knowledge.db).", group: "Knowledge & Crawl" },
  CRAWL_SEEDS: { label: "Crawl seeds", description: "Comma-separated seed URLs to crawl into the knowledge index.", group: "Knowledge & Crawl" },
  CRAWL_ALLOW_DOMAINS: { label: "Allowed domains", description: "Comma-separated hosts the crawler may follow. Defaults to the seed hosts.", group: "Knowledge & Crawl" },
  CRAWL_MAX_PAGES: { label: "Max pages", description: "Maximum pages per crawl (default 200).", group: "Knowledge & Crawl" },
  CRAWL_MAX_DEPTH: { label: "Max depth", description: "Maximum link depth from a seed (default 3).", group: "Knowledge & Crawl" },
  CRAWL_CONCURRENCY: { label: "Concurrency", description: "Crawl concurrency (default 4).", group: "Knowledge & Crawl" },
  CRAWL_RATE_MS: { label: "Rate (ms)", description: "Delay between fetches in ms, for politeness (default 500).", group: "Knowledge & Crawl" },
  CRAWL_MAX_BYTES: { label: "Max page bytes", description: "Max bytes downloaded per page (default 2 MB).", group: "Knowledge & Crawl" },
  CRAWL_PROXY: { label: "Crawl proxy", description: "Optional HTTP(S) proxy for crawler fetches.", group: "Knowledge & Crawl" },
  CRAWL_RESPECT_ROBOTS: { label: "Respect robots.txt", description: "Whether the crawler honors robots.txt (default true).", group: "Knowledge & Crawl" },
  CRAWL_TOPIC: { label: "Crawl topic", description: "Optional topic to steer the LLM relevance verdict (byok mode).", group: "Knowledge & Crawl" },
  CRAWL_TTL_HOURS: { label: "Boot-crawl TTL (hours)", description: "Skip the auto-crawl-on-boot if the index was crawled within this many hours (0 = always).", group: "Knowledge & Crawl" },
  UPLOAD_MAX_BYTES: { label: "Max upload bytes", description: "Max size for a single UI document upload (default 10 MB).", group: "Knowledge & Crawl" },
  EMBED_MODEL: { label: "Embedding model", description: "Local embedding model id (default Xenova/bge-small-en-v1.5).", group: "Knowledge & Crawl" },
  EMBED_MODEL_PATH: { label: "Embedding model path", description: "Local directory to load the embedding model from (offline / locked-down nets).", group: "Knowledge & Crawl" },

  // SharePoint
  SHAREPOINT_ENABLED: { label: "SharePoint enabled", description: "Enable the SharePoint incident-docs integration.", group: "SharePoint" },
  SHAREPOINT_SITE_URL: { label: "Site URL", description: "SharePoint site URL. Required when SharePoint is enabled.", group: "SharePoint" },
  SHAREPOINT_INCIDENT_ROOT: { label: "Incident root", description: "Folder path under the site where incident folders live.", group: "SharePoint" },
  SHAREPOINT_DOCS_SUBFOLDER: { label: "Docs subfolder", description: "Subfolder within an incident folder holding the docs (default: Docs).", group: "SharePoint" },
  SHAREPOINT_PROXY: { label: "Proxy", description: "Optional HTTP(S) proxy for SharePoint/Graph calls.", group: "SharePoint" },

  // Other / behavior / thresholds
  CONFIRM_WRITES: { label: "Confirm writes", description: "Require confirmation before any write tool runs (default true).", group: "Other" },
  TURN_TIMEOUT_MS: { label: "Turn timeout (ms)", description: "Max ms to wait for a turn before the SDK times out (default 300000).", group: "Other" },
  STALE_P1_MIN: { label: "Stale P1 (min)", description: "Minutes after which a P1 incident is considered stale (default 30).", group: "Other" },
  STALE_P2_MIN: { label: "Stale P2 (min)", description: "Minutes after which a P2 incident is considered stale (default 120).", group: "Other" },
  STALE_P3_MIN: { label: "Stale P3 (min)", description: "Minutes after which a P3 incident is considered stale (default 1440).", group: "Other" },
  STALE_P4_MIN: { label: "Stale P4 (min)", description: "Minutes after which a P4 incident is considered stale (default 4320).", group: "Other" },
  CORRELATION_HOURS_BEFORE: { label: "Correlation window before (h)", description: "Hours before an incident to look for related changes (default 24).", group: "Other" },
  CORRELATION_HOURS_AFTER: { label: "Correlation window after (h)", description: "Hours after an incident to look for related changes (default 4).", group: "Other" }
};

const SECRET_SEGMENTS = new Set(["PASSWORD", "SECRET", "TOKEN", "PAT", "KEY"]);

export const groupOf = (key: string): EnvGroup => ENV_FIELDS[key]?.group ?? "Other";

/** Registry secret flag, else a name heuristic (per underscore-segment, so AZ_PATH ≠ secret). */
export const isSecret = (key: string): boolean =>
  ENV_FIELDS[key]?.secret ?? key.toUpperCase().split("_").some((seg) => SECRET_SEGMENTS.has(seg));

export const labelOf = (key: string): string => ENV_FIELDS[key]?.label ?? key;

/** Help text: registry description, else the inline .env comment, else empty. */
export const describe = (key: string, comment?: string): string =>
  ENV_FIELDS[key]?.description ?? comment ?? "";
