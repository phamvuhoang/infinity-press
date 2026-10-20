"use client";

import { useActionState } from "react";

import { FormStatus } from "@/components/admin/form-feedback";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminFeedbackDTO } from "@/lib/data/edition-feedback";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

export function FeedbackRow({ item, action }: { item: AdminFeedbackDTO; action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, initialAdminFormState);
  const progression = typeof item.locator?.progression === "number" ? `${Math.round(item.locator.progression * 100)}%` : null;
  return (
    <tr className="border-b border-sand align-top">
      <th className="py-3 pr-3 font-normal" scope="row">
        <a
          className="font-medium text-forest underline decoration-sand underline-offset-4"
          href={`/admin/books/${item.bookId}/editions/${item.editionId}`}
        >
          {item.bookTitle} ({item.languageCode})
        </a>
        <p className="mt-1 text-xs text-sage-text">
          {new Date(item.createdAt).toISOString().slice(0, 10)}
          {progression ? ` · ${progression}` : ""}
          {item.locator?.href ? ` · ${item.locator.href}` : ""}
        </p>
      </th>
      <td className="py-3 pr-3 whitespace-pre-line">{item.message}</td>
      <td className="py-3">
        <form action={formAction} className="space-y-2">
          <Textarea aria-label="Note" defaultValue={item.adminNote ?? ""} name="note" rows={2} />
          <div className="flex flex-wrap gap-2">
            {item.status !== "resolved" ? <Button disabled={pending} name="status" type="submit" value="resolved">Resolve</Button> : null}
            {item.status !== "dismissed" ? <Button disabled={pending} name="status" type="submit" value="dismissed" variant="outline">Dismiss</Button> : null}
            {item.status !== "new" ? <Button disabled={pending} name="status" type="submit" value="new" variant="outline">Reopen</Button> : null}
          </div>
          <FormStatus state={state} />
        </form>
      </td>
    </tr>
  );
}
