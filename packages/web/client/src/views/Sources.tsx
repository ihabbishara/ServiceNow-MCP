import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import type { ChatState } from "../state.js";
import { uploadDocument, addUrl, listSources, deleteSource, type SourceRow } from "../api.js";
import { validateFile, ACCEPTED_EXTS } from "./sources-validate.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";

const DEFAULT_MAX = 10 * 1048576;

export function Sources({ state }: { state: ChatState }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [url, setUrl] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const maxBytes = state.config?.uploadMaxBytes ?? DEFAULT_MAX;

  const refresh = useCallback(() => listSources().then((r) => setSources(r.sources)).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);
  // When any in-flight ingest reaches a terminal phase, re-pull the list.
  const ingestKey = JSON.stringify(state.ingest);
  useEffect(() => {
    if (Object.values(state.ingest).some((i) => i.phase === "indexed")) refresh();
  }, [ingestKey, refresh]);

  const sendFiles = async (files: FileList | File[]) => {
    const errs: string[] = [];
    for (const f of Array.from(files)) {
      const v = validateFile(f, maxBytes);
      if (!v.ok) { errs.push(`${f.name}: ${v.reason}`); continue; }
      await uploadDocument(f); // uploads are accepted (202) then ingested in the background; the shared ONNX embedder serializes embed calls at the model layer.
    }
    setLocalErrors(errs);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void sendFiles(e.dataTransfer.files);
  };

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    void addUrl(url.trim());
    setUrl("");
  };

  const remove = async (u: string) => { await deleteSource(u); refresh(); };

  // In-flight sources not yet in the persisted list.
  const inFlight = Object.entries(state.ingest).filter(
    ([src, i]) => i.phase !== "indexed" && !sources.some((s) => s.url === src)
  );

  const label = (u: string) => (u.startsWith("upload://") ? u.slice("upload://".length) : u);
  const statusText = (i: { phase: string; detail?: string; reason?: string }) =>
    i.phase === "embedding" ? `embedding ${i.detail ?? ""}…`
      : i.phase === "skipped" ? `skipped: ${i.reason ?? ""}`
      : i.phase === "crawling" ? "crawling…"
      : i.phase === "parsing" ? "parsing…"
      : i.phase;

  return (
    <div className="max-w-container mx-auto w-full p-6 space-y-5 overflow-auto h-full">
      <h2 className="text-headline-md">Sources</h2>

      <Card
        className={"p-8 text-center border-2 border-dashed transition-colors " +
          (dragging ? "border-primary-container bg-primary-container/5" : "border-outline")}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={onDrop}
      >
        <div
          className="space-y-3"
        >
          <p className="text-body-lg text-on-surface">Drag documents here</p>
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wide">
            {ACCEPTED_EXTS.join(" · ")}
          </p>
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
            Browse files
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPTED_EXTS.map((e) => "." + e).join(",")}
            className="hidden"
            onChange={(e) => { if (e.target.files) void sendFiles(e.target.files); e.target.value = ""; }}
          />
        </div>
      </Card>

      <form onSubmit={submitUrl} className="flex gap-3">
        <input
          aria-label="URL to crawl"
          className="flex-1 border border-outline rounded px-3 py-2 text-body-md focus-visible:border-primary-container"
          placeholder="https://internal-wiki/page"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit">Add URL</Button>
      </form>

      {localErrors.length > 0 && (
        <div role="alert" className="text-label-md text-error space-y-1">
          {localErrors.map((e) => <div key={e}>{e}</div>)}
        </div>
      )}

      <Card className="divide-y divide-surface-gray">
        {inFlight.map(([src, i]) => (
          <div key={src} className="flex items-center justify-between px-4 py-3">
            <span className="truncate text-body-md">{label(src)}</span>
            <span className="text-label-sm text-on-surface-variant">{statusText(i)}</span>
          </div>
        ))}
        {sources.map((s) => {
          const live = state.ingest[s.url];
          return (
            <div key={s.url} className="flex items-center justify-between px-4 py-3 gap-3">
              <span className="truncate text-body-md">{label(s.url)}</span>
              <span className="shrink-0 text-label-sm text-on-surface-variant">
                {live && live.phase !== "indexed" ? statusText(live) : `${s.chunkCount} chunks`}
              </span>
              <button
                onClick={() => void remove(s.url)}
                className="shrink-0 text-label-sm text-error hover:underline"
                aria-label={`Remove ${label(s.url)}`}
              >
                Remove
              </button>
            </div>
          );
        })}
        {sources.length === 0 && inFlight.length === 0 && (
          <div className="px-4 py-6 text-center text-on-surface-variant text-body-md">No sources indexed yet.</div>
        )}
      </Card>
    </div>
  );
}
