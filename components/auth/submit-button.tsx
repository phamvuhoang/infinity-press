"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

type ButtonProps = ComponentProps<typeof Button>;

export function SubmitButton({
  children,
  pendingLabel,
  className = "min-h-11 w-full",
  size,
  variant,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}) {
  const { pending } = useFormStatus();

  return (
    <Button className={className} disabled={pending} size={size} type="submit" variant={variant}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
