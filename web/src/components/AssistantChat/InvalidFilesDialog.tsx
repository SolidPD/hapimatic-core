// SPDX-License-Identifier: AGPL-3.0-only
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { type Attachment } from "@/lib/attachment-store";

type InvalidFilesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachments: Attachment[];
};

/**
 * The "Message not sent" dialog listing unsupported attachments that block a
 * send. Extracted verbatim from HappyComposer (#3517) so that file stays under
 * its max-lines cap once the prompt pop-out was added — pure presentational.
 */
export function InvalidFilesDialog({
  open,
  onOpenChange,
  attachments,
}: InvalidFilesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-red-500">Message not sent</DialogTitle>
        </DialogHeader>
        <DialogDescription className="mt-2 text-sm text-[var(--app-fg)]/80">
          Remove or replace unsupported files before sending.
        </DialogDescription>
        <ul className="mt-2 space-y-1">
          {attachments
            .filter(a => !a.isValid)
            .map(a => (
              <li
                key={a.id}
                className="flex items-center gap-2 text-sm text-red-400"
              >
                <span className="text-red-500">✕</span>
                <span className="truncate">{a.name}</span>
              </li>
            ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            variant="accent"
            onClick={() => onOpenChange(false)}
            className="rounded-lg text-[var(--app-bg)] transition-colors hover:opacity-100 hover:brightness-110"
          >
            OK
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
