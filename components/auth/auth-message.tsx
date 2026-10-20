import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Dictionary } from "@/lib/i18n/dictionary";

type AuthAlerts = Dictionary["authentication"]["alerts"];

function lookup(entries: Record<string, string>, code?: string) {
  return code && Object.hasOwn(entries, code) ? entries[code] : undefined;
}

export function AuthMessage({
  alerts,
  error,
  message,
}: {
  alerts: AuthAlerts;
  error?: string;
  message?: string;
}) {
  const errorText = lookup(alerts.errors, error);
  const messageText = lookup(alerts.messages, message);

  if (!errorText && !messageText) return null;

  return (
    <Alert variant={errorText ? "destructive" : "default"} role={errorText ? "alert" : "status"}>
      <AlertTitle>{errorText ? alerts.errorTitle : alerts.messageTitle}</AlertTitle>
      <AlertDescription>{errorText ?? messageText}</AlertDescription>
    </Alert>
  );
}
