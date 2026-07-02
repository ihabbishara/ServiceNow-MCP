// packages/web/client/src/views/EnvSettings.tsx
import { useEffect, useState } from "react";
import { getEnv, putEnv } from "../api.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
import { CollapsibleSection } from "./ui/CollapsibleSection.js";
import { Tooltip } from "./ui/Tooltip.js";
import { ENV_GROUPS, describe, groupOf, isSecret, labelOf } from "./env-fields.js";

function SecretEye({ revealed, onToggle }: { revealed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={revealed ? "Hide value" : "Show value"}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-primary-container"
    >
      <svg
        viewBox="0 0 20 20"
        className="h-4 w-4"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {revealed ? (
          <>
            <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" />
            <circle cx="10" cy="10" r="2.2" />
          </>
        ) : (
          <>
            <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" />
            <path d="M3.5 3.5l13 13" />
          </>
        )}
      </svg>
    </button>
  );
}

function FieldRow({
  k,
  value,
  comment,
  onChange
}: {
  k: string;
  value: string;
  comment?: string;
  onChange: (v: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const secret = isSecret(k);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,16rem)_1fr] gap-x-4 gap-y-1 items-center">
      <div className="flex items-center gap-1.5 min-w-0">
        <label htmlFor={`env-${k}`} className="min-w-0">
          <span className="block text-body-md text-on-surface truncate">{labelOf(k)}</span>
          <span className="block font-mono text-label-sm text-on-surface-variant truncate">
            {k}
          </span>
        </label>
        <Tooltip text={describe(k, comment)} />
      </div>
      <div className="relative">
        <input
          id={`env-${k}`}
          type={secret && !revealed ? "password" : "text"}
          spellCheck={false}
          autoComplete="off"
          className={
            "w-full border border-outline rounded px-3 py-2 text-body-md focus-visible:border-primary-container " +
            (secret ? "pr-10 font-mono" : "")
          }
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {secret && <SecretEye revealed={revealed} onToggle={() => setRevealed((r) => !r)} />}
      </div>
    </div>
  );
}

export function EnvSettings() {
  const [vars, setVars] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getEnv()
      .then((r) => {
        setVars(r.vars);
        setComments(r.comments ?? {});
      })
      .catch(() => setIssues("Failed to load .env"));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await putEnv(vars);
      setIssues(res.ok ? undefined : (await res.json()).issues);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col max-w-container mx-auto w-full">
      <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-4 border-b border-surface-gray">
        <div>
          <h2 className="text-headline-md text-on-surface">Settings</h2>
          <p className="text-label-md text-on-surface-variant">
            Environment (.env) — saving restarts the agent.
          </p>
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save & restart"}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {issues && (
          <pre
            role="alert"
            className="text-label-md text-error whitespace-pre-wrap bg-error-container rounded p-3"
          >
            {issues}
          </pre>
        )}
        {ENV_GROUPS.map((group) => {
          const keys = Object.keys(vars).filter((k) => groupOf(k) === group);
          if (keys.length === 0) return null;
          return (
            <CollapsibleSection key={group} title={group}>
              <Card className="p-4 space-y-3.5">
                {keys.map((k) => (
                  <FieldRow
                    key={k}
                    k={k}
                    value={vars[k]}
                    comment={comments[k]}
                    onChange={(v) => setVars((prev) => ({ ...prev, [k]: v }))}
                  />
                ))}
              </Card>
            </CollapsibleSection>
          );
        })}
      </div>
    </div>
  );
}
