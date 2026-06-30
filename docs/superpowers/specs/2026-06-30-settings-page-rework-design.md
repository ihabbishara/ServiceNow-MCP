# Settings (Environment) Page Rework — Design

Date: 2026-06-30
Status: Approved (design decisions), pending spec review

## Problems (from the live page)

1. **Inline `.env` comments leak into the value field.** `parseEnv`
   (`packages/web/server/dotenv-file.ts:11`) keeps everything after `=` and only
   strips quotes when the *last* character is a quote — so a line like
   `SERVICENOW_PASSWORD="secret" # ... (SECRET)` lands the whole
   `"secret" # ... (SECRET)` in the value box.
2. **Secrets shown in plaintext** (password, future PAT/token/key fields).
3. **No scrolling.** `EnvSettings`'s root has no scroll container and `App.tsx`'s
   `<main className="flex-1 overflow-hidden">` clips it, so fields past the
   viewport are unreachable.
4. **Save is destructive.** `serializeEnv` rewrites the whole file from the value
   map — dropping every comment and reordering keys.
5. **Looks unstructured** — flat list, raw `KEY` labels, no explanation of fields.

## Decisions (confirmed)

- Tooltip help text comes from a **curated code registry** (key → label,
  description, secret flag, group). Unknown keys fall back to their inline `.env`
  comment.
- Secret fields use a **masked input + eye toggle** (real value loaded, hidden by
  default, revealable).
- Fields are laid out in **collapsible groups by integration**.

## Approach

### 1. Server: parser fix + structured read

- **Fix `parseEnv`** to strip inline comments while respecting quotes:
  - Quoted value (`"..."` / `'...'`): take through the matching closing quote;
    discard the remainder (the ` # comment`). A `#` inside the quotes is part of
    the value.
  - Unquoted value: cut at the first `#` (treating it as a comment start), then
    trim.
- **Capture the inline comment** per key so the UI can show it as a fallback
  description. Add `parseEnvWithComments(text): Record<string, { value: string;
  comment: string }>` (or extend the existing parse). `readEnvFile` keeps
  returning clean `Record<string,string>` for existing callers; a new
  `readEnvFields` returns value+comment.
- `EngineHost.readEnv()` returns `{ vars: Record<string,string>; comments:
  Record<string,string> }`; the env route returns both.

### 2. Server: non-destructive save

- New `updateEnvText(originalText: string, vars: Record<string,string>): string`:
  walk the original lines; for each `KEY=...` line whose KEY is in `vars`, replace
  only the value portion (re-applying the existing quoting rules) and **keep the
  trailing inline comment**; leave blank lines, comment-only lines, and key order
  untouched; append any keys in `vars` not already present at the end.
- `EngineHost.applyEnv` reads the current file text and writes
  `updateEnvText(text, vars)` instead of `serializeEnv(vars)`. `serializeEnv`
  stays as the fallback when no file exists yet.
- Validation flow is unchanged (`loadConfig` validates before writing; restart
  after).

### 3. Client: field registry

`packages/web/client/src/views/env-fields.ts`:
```ts
export type EnvGroup = "ServiceNow" | "Azure DevOps" | "LLM & Copilot"
  | "Knowledge & Crawl" | "SharePoint" | "Other";
export const ENV_GROUPS: EnvGroup[] = [ ...in display order... ];
export interface EnvFieldMeta { label?: string; description: string; secret?: boolean; group: EnvGroup }
export const ENV_FIELDS: Record<string, EnvFieldMeta>; // curated, lifted from .env comments + config schemas
export const groupOf = (key: string): EnvGroup;        // registry group, else "Other"
export const isSecret = (key: string): boolean;        // registry flag OR /PASSWORD|SECRET|TOKEN|PAT|API_KEY|_KEY/ heuristic
export const describe = (key: string, comment?: string): string; // registry description, else the .env comment, else ""
export const labelOf = (key: string): string;          // friendly label, else the raw key
```
Secret heuristic also guards unknown future keys.

### 4. Client: Tooltip primitive

`packages/web/client/src/views/ui/Tooltip.tsx` — an info `(i)` icon button with an
accessible popover: shows on hover AND focus, `aria-describedby` linking the icon
to the tooltip text, dismissible, no dependency. Inline SVG icon, CSS/state-driven
visibility (motion respects the global reduced-motion rule).

### 5. Client: EnvSettings redesign

- Root: `h-full overflow-auto` + padding (fixes scroll).
- Fields grouped via `groupOf` into `CollapsibleSection` cards, in `ENV_GROUPS`
  order; empty groups omitted.
- Each field row: friendly label + mono key, the value input, and a `Tooltip`
  with the description. Secret fields render `type="password"` with an eye toggle
  switching to `type="text"`.
- `Save & restart` action; `issues` error block unchanged.
- Reads `{ vars, comments }` from the new `getEnv`; sends `{ vars }` to `putEnv`
  (unchanged write contract).

## Files

New:
- `packages/web/client/src/views/env-fields.ts`
- `packages/web/client/src/views/ui/Tooltip.tsx`
- `packages/web/tests/env-fields.test.ts`

Modified:
- `packages/web/server/dotenv-file.ts` — `parseEnv` comment-strip; `parseEnvWithComments`; `updateEnvText`
- `packages/web/server/engine-host.ts` — `readEnv` returns `{vars,comments}`; `applyEnv` non-destructive
- `packages/web/server/routes/env.ts` — `getEnv` returns `{vars,comments}`
- `packages/web/client/src/api.ts` — `getEnv` return type
- `packages/web/client/src/views/EnvSettings.tsx` — redesign
- `packages/web/tests/dotenv-file.test.ts` — parser + updateEnvText cases

## Testing

- **Server (`dotenv-file.test.ts`)**: parseEnv strips a trailing `# comment` after
  a quoted value; cuts an unquoted value at `#`; preserves a `#` *inside* quotes;
  `parseEnvWithComments` returns the captured comment; `updateEnvText` changes
  only listed values, preserves comments/order/blank lines, and appends new keys.
- **Client (`env-fields.test.ts`)**: `groupOf`/`isSecret`/`describe`/`labelOf` —
  known key from registry, unknown key falls to Other + heuristic secret +
  comment fallback.
- No React DOM harness in the repo → the redesigned component is verified by
  typecheck, `vite build`, and a manual browser smoke (scroll works; password
  masked + revealable; tooltip on hover; groups collapse; save round-trips and
  preserves file comments).

## Scope boundary (YAGNI)

Not in scope: editing/adding arbitrary new keys from the UI, per-field validation
hints beyond the existing whole-config validation, secret strength meters, or a
diff/confirm-before-restart step.
