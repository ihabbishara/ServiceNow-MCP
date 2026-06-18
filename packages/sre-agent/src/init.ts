import * as readline from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageEnvPath } from "./config/env.js";

/** A value needs quoting if it could confuse the `.env` parser (spaces, #, =, quotes) or is empty. */
const needsQuote = (v: string): boolean => v === "" || /[\s#"'=]/.test(v);
const quote = (v: string): string => (needsQuote(v) ? `"${v.replace(/"/g, '\\"')}"` : v);

/**
 * Render a `.env` from the committed `.env.example` template plus interactive
 * answers, preserving the template's inline documentation for everything the
 * user didn't set. For answered keys the value is replaced and the inline
 * comment dropped (so a `#` in a password can't be read as a comment); values
 * with special characters are quoted. Keys absent from the template are
 * appended at the end.
 */
export const buildEnvFile = (template: string, answers: Record<string, string>): string => {
  const keys = new Set(Object.keys(answers));
  const seen = new Set<string>();
  const lines = template.split("\n").map((line) => {
    const m = line.match(/^(\s*)([A-Z][A-Z0-9_]*)=/);
    if (!m || !keys.has(m[2])) return line;
    seen.add(m[2]);
    return `${m[1]}${m[2]}=${quote(answers[m[2]])}`;
  });
  const missing = [...keys].filter((k) => !seen.has(k));
  if (missing.length > 0) {
    lines.push("", "# Added by `sre-agent init`:", ...missing.map((k) => `${k}=${quote(answers[k])}`));
  }
  return lines.join("\n");
};

interface Prompt {
  key: string;
  label: string;
  default?: string;
  secret?: boolean;
}

/** Minimal required config for a working seat-mode, azcli-ADO setup. */
const PROMPTS: Prompt[] = [
  { key: "SERVICENOW_BASE_URL", label: "ServiceNow base URL (https://<instance>.service-now.com)" },
  { key: "SERVICENOW_USERNAME", label: "ServiceNow username" },
  { key: "SERVICENOW_PASSWORD", label: "ServiceNow password", secret: true },
  { key: "ADO_ORG_URL", label: "Azure DevOps org URL", default: "https://dev.azure.com/INGCDaaS" },
  { key: "ADO_PROJECT", label: "Azure DevOps project", default: "IngOne" },
  { key: "LLM_MODE", label: "LLM mode (seat = Copilot seat, byok = your own key)", default: "seat" }
];

/** The committed `.env.example` shipped at the package root (dist/init.js → up one dir). */
const examplePath = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", ".env.example");

/**
 * Interactive first-run config: prompt for the required vars and write a
 * `.env` next to the package, using `.env.example` as the documented template.
 * Refuses to clobber an existing `.env` unless confirmed.
 */
export const runInit = async (): Promise<void> => {
  const target = packageEnvPath();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (existsSync(target)) {
      const ans = (await rl.question(`${target} already exists. Overwrite? [y/N] `)).trim().toLowerCase();
      if (ans !== "y" && ans !== "yes") {
        stdout.write("Keeping the existing .env. Nothing changed.\n");
        return;
      }
    }
    stdout.write(
      "Configuring the SRE agent. Press Enter to accept a [default].\n" +
        "Note: the password is typed in clear text and stored in .env (chmod 600).\n\n"
    );
    const answers: Record<string, string> = {};
    for (const p of PROMPTS) {
      const suffix = p.default ? ` [${p.default}]` : "";
      const reply = (await rl.question(`${p.label}${suffix}: `)).trim();
      answers[p.key] = reply || p.default || "";
    }
    const template = readFileSync(examplePath(), "utf8");
    writeFileSync(target, buildEnvFile(template, answers), { mode: 0o600 });
    stdout.write(
      `\nWrote ${target}\n` +
        "Next steps:\n" +
        "  • az login            (if ADO_AUTH_MODE=azcli)\n" +
        "  • npm start           (the agent runs the Copilot device-flow /login if needed)\n" +
        "  • npm start -- doctor (check all prerequisites)\n"
    );
  } finally {
    rl.close();
  }
};
