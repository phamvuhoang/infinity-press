import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Deliberately held transactions for concurrency regressions. Like the other SQL fixtures, these
// refuse cloud URLs. Statements/values come only from test fixtures, never browser input.
export function openSqlSession() {
  const connection = process.env.E2E_DATABASE_URL;
  if (!connection || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(connection).hostname)) {
    throw new Error("Concurrency tests require a local E2E_DATABASE_URL.");
  }
  const child = spawn("psql", [connection, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { stdio: "pipe" });
  let errors = "";
  let sequence = 0;
  let pending: { marker: string; lines: string[]; resolve: (value: string) => void; reject: (error: Error) => void } | null = null;
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!pending) return;
    if (line === pending.marker) {
      const current = pending;
      pending = null;
      current.resolve(current.lines.join("\n"));
    } else pending.lines.push(line);
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      pending?.reject(new Error(errors || "SQL connection closed before statement completed."));
      pending = null;
      resolve();
    });
  });
  child.on("error", (error) => pending?.reject(error));
  return {
    query(sql: string): Promise<string> {
      if (pending) throw new Error("A statement is already running on this SQL connection.");
      return new Promise((resolve, reject) => {
        const marker = `done_${++sequence}`;
        pending = { marker, resolve, reject, lines: [] };
        child.stdin.write(`${sql};\nselect '${marker}';\n`);
      });
    },
    async close() {
      child.kill("SIGTERM"); // Disconnect rolls back any held transaction, including on assertion failure.
      await closed;
    },
  };
}
