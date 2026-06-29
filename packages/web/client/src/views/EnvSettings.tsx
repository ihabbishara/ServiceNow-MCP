// packages/web/client/src/views/EnvSettings.tsx
import { useEffect, useState } from "react";
import { getEnv, putEnv } from "../api.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
export function EnvSettings() {
  const [vars, setVars] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string>();
  useEffect(() => {
    getEnv().then((r) => setVars(r.vars)).catch(() => setIssues("Failed to load .env"));
  }, []);
  const save = async () => {
    const res = await putEnv(vars);
    setIssues(res.ok ? undefined : (await res.json()).issues);
  };
  return (
    <div className="max-w-container mx-auto w-full p-6 space-y-4">
      <h2 className="text-headline-md">Environment (.env)</h2>
      <Card className="p-6 space-y-3">
        {Object.entries(vars).map(([k, v]) => (
          <div key={k} className="flex gap-3 items-center">
            <label htmlFor={`env-${k}`} className="w-64 font-mono text-label-md text-on-surface-variant">{k}</label>
            <input
              id={`env-${k}`}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 border border-outline rounded px-3 py-2 text-body-md focus-visible:border-primary-container"
              value={v}
              onChange={(e) => setVars({ ...vars, [k]: e.target.value })}
            />
          </div>
        ))}
      </Card>
      {issues && (
        <pre role="alert" className="text-label-md text-error whitespace-pre-wrap bg-error-container rounded p-3">{issues}</pre>
      )}
      <Button onClick={save}>Save &amp; restart</Button>
    </div>
  );
}
