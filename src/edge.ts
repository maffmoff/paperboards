// Tells a Cloudflare refusal (rate limit, challenge, block) apart from the API's own answer, so the
// summary sampler can back off instead of hammering. Pure functions; nothing here sends anything.

export type EdgeKind = "none" | "origin" | "edge-rate-limited" | "edge-challenge" | "edge-blocked";

export interface EdgeVerdict {
  kind: EdgeKind;
  ray: string | null;
  /** Cloudflare error code from an HTML error page (1015 = rate limited, 1006–1012 = banned, 1020 = firewall). */
  cloudflareCode: number | null;
  detail: string;
}

export interface HeaderReader { get(name: string): string | null }

const CF_CODE_RE = /error code:?\s*(10\d\d)\b/i;
const CF_HTML_RE = /cloudflare|just a moment|attention required|access denied|ray id/i;

function isJsonType(contentType: string | null): boolean {
  return /^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType ?? "");
}

export function classifyEdge(status: number, headers: HeaderReader, bodyText?: string | null): EdgeVerdict {
  const ray = headers.get("cf-ray");
  const mitigated = (headers.get("cf-mitigated") ?? "").toLowerCase();
  const server = (headers.get("server") ?? "").toLowerCase();
  const contentType = headers.get("content-type");
  const text = bodyText ?? "";
  const codeMatch = text.match(CF_CODE_RE);
  const cloudflareCode = codeMatch ? Number(codeMatch[1]) : null;
  const where = (what: string) => `${what}${cloudflareCode ? ` (error ${cloudflareCode})` : ""}${ray ? `, cf-ray ${ray}` : ""}`;
  if (status >= 200 && status < 300) return { kind: "none", ray, cloudflareCode: null, detail: "" };
  if (mitigated.includes("challenge")) return { kind: "edge-challenge", ray, cloudflareCode, detail: where("Cloudflare challenge") };
  const cloudflareHtml = server.includes("cloudflare") && !isJsonType(contentType) && (text === "" || CF_HTML_RE.test(text) || cloudflareCode !== null);
  if (status === 429 && (cloudflareCode === 1015 || cloudflareHtml)) return { kind: "edge-rate-limited", ray, cloudflareCode, detail: where("Cloudflare rate limit") };
  if (cloudflareCode !== null && cloudflareCode !== 1015) return { kind: "edge-blocked", ray, cloudflareCode, detail: where("blocked at the Cloudflare edge") };
  if ((status === 403 || status === 503 || status === 401) && cloudflareHtml && text !== "") return { kind: "edge-blocked", ray, cloudflareCode, detail: where("blocked at the Cloudflare edge") };
  if (isJsonType(contentType)) return { kind: "origin", ray, cloudflareCode: null, detail: ray ? `api answer, cf-ray ${ray}` : "api answer" };
  return { kind: "none", ray, cloudflareCode: null, detail: ray ? `cf-ray ${ray}` : "" };
}

export function isEdgeRefusal(v: EdgeVerdict): boolean {
  return v.kind === "edge-rate-limited" || v.kind === "edge-challenge" || v.kind === "edge-blocked";
}
