export interface CodeSignals {
  detected: boolean;
  /** Up to 3 trimmed matched snippets, for the agent to quote when offering analysis. */
  signals: string[];
}

// Known source-code extensions. The allowlist is what excludes IP:port
// (10.0.0.1:443), semver (v1.2.3), and timestamps (12:30:45) from matching.
const CODE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|java|py|cs|go|rb|php|kt|kts|scala|swift|cpp|cc|c|h|hpp|rs|sql";

const PATTERNS: RegExp[] = [
  // Stack frame: at fn (path/file.ext:line[:col])
  new RegExp(
    `\\bat\\s+[\\w$.<>\\[\\]]+\\s*\\([^()]*\\.(?:${CODE_EXTENSIONS}):\\d+(?::\\d+)?\\)`,
    "g"
  ),
  // Bare file:line with a code extension
  new RegExp(`\\b[\\w./\\\\-]+\\.(?:${CODE_EXTENSIONS}):\\d+\\b`, "g"),
  // Exception/error class names followed by ':' or '(' — bare Error:/Exception: filtered below
  /\b[A-Za-z]\w*(?:Exception|Error)\b\s*[:(]/g,
  /Traceback \(most recent call last\)/g
];

// "Error: timeout" is an infra message, not a code signal — require a class-name prefix.
const BARE_ERROR = /^(?:Error|Exception)\s*[:(]/;

/**
 * Deterministic detector for code-referencing error text (stack traces,
 * file:line references, exception class names). Pure function, no I/O;
 * undefined fields are skipped.
 */
export const detectCodeSignals = (texts: (string | undefined)[]): CodeSignals => {
  const text = texts.filter(Boolean).join("\n");
  const signals: string[] = [];
  // Character spans already claimed by an accepted match. A later pattern must
  // not re-report a substring of an earlier one (e.g. the bare "x.ts:1" that
  // lives inside a full stack frame "at f (x.ts:1)") — that is not a distinct signal.
  const claimed: Array<[number, number]> = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (BARE_ERROR.test(match[0])) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      const snippet = match[0].replace(/\s+/g, " ").trim().slice(0, 120);
      if (!signals.includes(snippet)) signals.push(snippet);
      if (signals.length >= 3) return { detected: true, signals };
    }
  }
  return { detected: signals.length > 0, signals };
};
