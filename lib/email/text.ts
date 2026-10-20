// The three primitives every email template needs, in one place because getting any of them
// slightly different per template is how one message ends up escaping and another does not.

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}

// One pass over the template, so a value that itself looks like `{name}` or contains `$&` is
// inserted literally rather than expanded.
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

// A subject line is a header, and a header ends at the first CR or LF. Collapsing them is what
// keeps a value that reached the subject from starting a header of the attacker's choosing.
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}
