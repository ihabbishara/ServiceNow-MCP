// packages/web/client/src/views/ConfirmDialog.tsx — ING modal: 50% scrim, soft ambient shadow
import { answerConfirm } from "../api.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
export function ConfirmDialog({ confirm }: { confirm: { id: string; summary: string } }) {
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <Card floating className="p-6 max-w-md w-full">
        <h2 id="confirm-dialog-title" className="text-headline-md mb-2">Confirm write</h2>
        <p className="text-body-md text-on-surface-variant mb-6">{confirm.summary}</p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={() => answerConfirm(confirm.id, false)}>Deny</Button>
          <Button onClick={() => answerConfirm(confirm.id, true)}>Approve</Button>
        </div>
      </Card>
    </div>
  );
}
