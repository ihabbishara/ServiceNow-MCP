/**
 * Minimal robots.txt evaluator for `User-agent: *` Disallow rules. Good enough
 * for internal sites; not a full RFC 9309 implementation (no Allow-precedence,
 * no wildcards). Returns true (allowed) when no matching disallow rule exists.
 */
export const isAllowed = (robotsTxt: string, path: string): boolean => {
  if (!robotsTxt.trim()) return true;
  let appliesToAll = false;
  const disallows: string[] = [];
  for (const raw of robotsTxt.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = field.trim().toLowerCase();
    if (key === "user-agent") appliesToAll = value === "*";
    else if (key === "disallow" && appliesToAll && value) disallows.push(value);
  }
  return !disallows.some((d) => path.startsWith(d));
};
