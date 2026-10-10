/** Retry-After header as milliseconds from now; 0 when absent or unparsable. */
export function parseRetryAfterMs(header: string | null, nowMs = Date.now()): number {
  const h = (header ?? "").trim();
  if (!h) return 0;
  const at = /^\d+$/.test(h) ? nowMs + Number(h) * 1000 : Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : 0;
}
