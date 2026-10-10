import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { dirname } from "node:path";

interface OperationalLogDeps {
  append?: (file: string, line: string) => void;
  mkdir?: (directory: string) => void;
  stderr?: (line: string) => void;
  now?: () => number;
  warningIntervalMs?: number;
}

/** Best-effort diagnostics only. Durable lifecycle journals must keep their own fail-closed writes. */
export function createOperationalLogger(deps: OperationalLogDeps = {}) {
  const append = deps.append ?? ((file, line) => appendFileSync(file, line, { mode: 0o600 }));
  const mkdir = deps.mkdir ?? ((directory) => { mkdirSync(directory, { recursive: true, mode: 0o700 }); });
  const stderr = deps.stderr ?? ((line) => { writeSync(2, line); });
  const now = deps.now ?? Date.now;
  const failures = new Map<string, { warnedAt: number; dropped: number }>();
  return (file: string, record: Record<string, unknown>): boolean => {
    try {
      const line = JSON.stringify({ ts: new Date(now()).toISOString(), ...record }, (_, value) => typeof value === "bigint" ? value.toString() : value) + "\n";
      mkdir(dirname(file));
      append(file, line);
      failures.delete(file);
      return true;
    } catch (error) {
      const failure = failures.get(file) ?? { warnedAt: Number.NEGATIVE_INFINITY, dropped: 0 };
      failure.dropped++;
      failures.set(file, failure);
      const at = now();
      if (at - failure.warnedAt >= (deps.warningIntervalMs ?? 30_000)) {
        failure.warnedAt = at;
        // Do not echo failed records, error messages, or paths: diagnostics may carry private data.
        const code = (error as NodeJS.ErrnoException | null)?.code;
        const reason = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "write-or-serialization-error";
        try { stderr(`papertrade: operational log unavailable (${reason}); dropped ${failure.dropped} record(s); will retry on next record\n`); } catch { /* stderr can also be unavailable */ }
      }
      return false;
    }
  };
}

export const logLine = createOperationalLogger();
