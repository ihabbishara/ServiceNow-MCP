import type { AzRunner } from "../ado/az.js";

interface AzToken {
  accessToken: string;
  expiresOn?: string; // local time "YYYY-MM-DD HH:MM:SS.ffffff"
  expires_on?: number; // unix seconds (newer az)
}

const GRAPH_RESOURCE = "https://graph.microsoft.com";

/** Delegated Microsoft Graph token from the Azure CLI, cached until just before expiry. */
export class GraphTokenProvider {
  private cached?: { token: string; expiresAtMs: number };
  private readonly az: AzRunner;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly resource: string;

  constructor(opts: { az: AzRunner; now?: () => number; skewMs?: number; resource?: string }) {
    this.az = opts.az;
    this.now = opts.now ?? Date.now;
    this.skewMs = opts.skewMs ?? 120_000;
    this.resource = opts.resource ?? GRAPH_RESOURCE;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs - this.skewMs) {
      return this.cached.token;
    }
    const t = await this.az.json<AzToken>([
      "account",
      "get-access-token",
      "--resource",
      this.resource
    ]);
    if (!t?.accessToken) throw new Error("az returned no accessToken for Microsoft Graph");
    const expiresAtMs =
      typeof t.expires_on === "number"
        ? t.expires_on * 1000
        : t.expiresOn
          ? Date.parse(t.expiresOn.replace(" ", "T"))
          : this.now() + 3_600_000;
    this.cached = {
      token: t.accessToken,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 3_600_000
    };
    return this.cached.token;
  }
}
