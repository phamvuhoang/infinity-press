"use client";

import { type ReactNode, useEffect, useRef } from "react";

// SePay's checkout takes a form POST, so the hand-off cannot be a redirect. The form submits itself
// once mounted; its children hold a visible button for a browser where that does not happen. The
// inputs are rendered in the order given, because SePay's signature covers that order.
export function AutoSubmitForm({
  action,
  fields,
  children,
}: {
  action: string;
  fields: Array<[string, string]>;
  children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.submit();
  }, []);

  return (
    <form action={action} method="post" ref={form}>
      {fields.map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      {children}
    </form>
  );
}
