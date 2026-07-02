import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The canonical .env.example ships in the sre-agent package.
const envExamplePath = fileURLToPath(new URL("../../sre-agent/.env.example", import.meta.url));

// Vars read by the app that MUST be documented in .env.example.
// (Audit found these 5 missing as of 2026-07-02.)
const REQUIRED_DOCUMENTED = [
  "ADO_BOARD_MAP",
  "ADO_CSV_DIR",
  "ADO_CSV_MAX_BYTES",
  "COPILOT_CLI_PATH",
  "WEB_PORT"
];

describe(".env.example completeness", () => {
  const text = readFileSync(envExamplePath, "utf8");
  for (const key of REQUIRED_DOCUMENTED) {
    it(`documents ${key}`, () => {
      expect(text).toMatch(new RegExp(`^\\s*#?\\s*${key}=`, "m"));
    });
  }
});
