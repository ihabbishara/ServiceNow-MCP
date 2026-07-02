import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The canonical .env.example ships in the sre-agent package.
const envExamplePath = fileURLToPath(new URL("../../sre-agent/.env.example", import.meta.url));

// Vars read by the app that MUST be documented in .env.example.
// (Audit 2026-07-02 found the first 5 missing; final review added the last 3.)
const REQUIRED_DOCUMENTED = [
  "ADO_BOARD_MAP",
  "ADO_CSV_DIR",
  "ADO_CSV_MAX_BYTES",
  "COPILOT_CLI_PATH",
  "WEB_PORT",
  "CRAWL_TTL_HOURS",
  "UPLOAD_MAX_BYTES",
  "SHAREPOINT_TIMEOUT_MS"
];

describe(".env.example completeness", () => {
  const text = readFileSync(envExamplePath, "utf8");
  for (const key of REQUIRED_DOCUMENTED) {
    it(`documents ${key}`, () => {
      expect(text).toMatch(new RegExp(`^\\s*#?\\s*${key}=`, "m"));
    });
  }
});
