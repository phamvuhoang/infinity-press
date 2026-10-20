import type { AdminFormState } from "@/lib/catalog/form";

export function FieldError({ message, id }: { message?: string; id?: string }) {
  if (!message) return null;
  return (
    <p className="text-[0.8125rem] text-error" id={id} role="alert">
      {message}
    </p>
  );
}

export function FormStatus({ state }: { state: AdminFormState }) {
  if (state.formError) {
    return (
      <p className="text-[0.8125rem] text-error" role="alert">
        {state.formError}
      </p>
    );
  }
  if (state.savedAt) {
    return (
      <p className="text-[0.8125rem] text-success" data-testid="form-saved" key={state.savedAt} role="status">
        Saved.
      </p>
    );
  }
  return null;
}
