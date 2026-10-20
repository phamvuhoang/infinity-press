// Shared helpers for admin Server Actions. A Server Action is a public POST endpoint, so every value
// is read as untrusted text here and validated by a Zod schema in lib/catalog/schemas.ts.

export type FieldErrors = Record<string, string>;

export type AdminFormState = {
  fieldErrors: FieldErrors;
  formError: string | null;
  // Set on success so the form can show "Saved" and reset its dirty state.
  savedAt: number | null;
};

export const initialAdminFormState: AdminFormState = { fieldErrors: {}, formError: null, savedAt: null };

export function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function readOptionalText(formData: FormData, key: string): string | null {
  const value = readText(formData, key);
  return value === "" ? null : value;
}

export function readInteger(formData: FormData, key: string): number | undefined {
  const value = readText(formData, key);
  return value === "" ? undefined : Number(value);
}

export function readOptionalInteger(formData: FormData, key: string): number | null {
  return readInteger(formData, key) ?? null;
}

export function readBoolean(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}

export function readList(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value !== "");
}

export function fieldErrorsFrom(error: { issues: { path: PropertyKey[]; message: string }[] }): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".");
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

// Key ideas are edited as one idea per line: "Title | optional summary".
export function parseKeyIdeas(text: string): { title: string; summary: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const separator = line.indexOf("|");
      if (separator === -1) return { title: line, summary: "" };
      return { title: line.slice(0, separator).trim(), summary: line.slice(separator + 1).trim() };
    });
}

export function formatKeyIdeas(items: { title: string; summary: string }[]): string {
  return items.map((item) => (item.summary ? `${item.title} | ${item.summary}` : item.title)).join("\n");
}

// FAQ entries are edited as blocks separated by a blank line: "Q: question" then "A: answer".
export function parseFaq(text: string): { question: string; answer: string }[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const question = /^Q:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
      const answer = /^A:\s*([\s\S]+)$/m.exec(block)?.[1]?.trim() ?? "";
      return { question, answer };
    })
    .filter((item) => item.question !== "" && item.answer !== "");
}

export function formatFaq(items: { question: string; answer: string }[]): string {
  return items.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join("\n\n");
}

// Edition credits are edited one per line as "role: name" (translator: Jane Doe).
export function parseContributors(text: string): { role: string; name: string }[] {
  return text
    .split("\n")
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator < 0) return { role: "", name: "" };
      return { role: line.slice(0, separator).trim().toLowerCase(), name: line.slice(separator + 1).trim() };
    })
    .filter((credit) => credit.role !== "" && credit.name !== "");
}

export function formatContributors(credits: { role: string; name: string }[]): string {
  return credits.map((credit) => `${credit.role}: ${credit.name}`).join("\n");
}
