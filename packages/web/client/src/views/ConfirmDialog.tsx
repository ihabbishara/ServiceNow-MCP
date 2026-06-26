// packages/web/client/src/views/ConfirmDialog.tsx — ING modal: 50% scrim, soft ambient shadow
import { answerConfirm } from "../api.js";
export function ConfirmDialog({ confirm }: { confirm: { id: string; summary: string } }) {
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <div className="bg-surface-container-lowest rounded-lg shadow-ambient p-6 max-w-md w-full">
        <h2 id="confirm-dialog-title" className="text-headline-md mb-2">Confirm write</h2>
        <p className="text-body-md text-on-surface-variant mb-6">{confirm.summary}</p>
        <div className="flex gap-3 justify-end">
          <button
            className="px-4 py-2 rounded border border-primary-container text-primary-container text-label-md"
            onClick={() => answerConfirm(confirm.id, false)}
          >
            Deny
          </button>
          <button
            className="px-4 py-2 rounded bg-primary-container text-on-primary text-label-md"
            onClick={() => answerConfirm(confirm.id, true)}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
