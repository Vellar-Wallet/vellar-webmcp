// Shared types + pure helpers for turning a live Vellar Bazaar catalog
// listing into a dynamic WebMCP tool definition. Pulled out of
// components/BazaarTools.tsx so the name-sanitization / collision-guard
// logic is unit-testable without mounting React or a WebMCP runtime.

export interface BazaarCatalogItem {
  resource?: string;
  accepts?: Array<{ amount?: string; asset?: string }>;
  description?: string;
  trust?: { ownershipState?: string };
}

export interface BazaarCatalogResponse {
  items?: BazaarCatalogItem[];
}

export type OwnershipState = "verified" | "proven-unconfirmed" | "unverified" | string;

/** Only these two states have received real, attributable payment activity
 *  per vellar-facilitator's own trust model (src/trust.ts) — "unverified"
 *  listings are excluded from dynamic tool generation entirely, per spec. */
const REGISTRABLE_OWNERSHIP_STATES: ReadonlySet<OwnershipState> = new Set(["verified", "proven-unconfirmed"]);

export function isRegistrableListing(item: BazaarCatalogItem): boolean {
  return REGISTRABLE_OWNERSHIP_STATES.has(item.trust?.ownershipState ?? "");
}

/** A catalog resource URL like ".../inspect/:address" is an unresolved path
 *  template, not a callable URL — hardcoding it as a tool's fetch target
 *  would fail on every single invocation. Detected by a literal "/:" in the
 *  URL string, the same convention the catalog's own routeTemplate field
 *  uses (e.g. "/inspect/:address") — a plain substring check, not a regex
 *  parse of the URL, per the locked decision this was built against. */
export function isPathTemplate(resourceUrl: string): boolean {
  return resourceUrl.includes("/:");
}

/** Only HTTPS resource URLs are callable at all — /api/pay's own validation
 *  already rejects non-HTTPS (see app/api/pay/route.ts's isHttpsUrl), and a
 *  bare "http://localhost:PORT/..." entry (seen live in the catalog, from
 *  local dev seller processes) is never reachable from the deployed server
 *  regardless. Filtering here avoids shipping a tool that is dead on
 *  arrival by the API route's own existing rule. A plain prefix check per
 *  the locked decision this was built against — covers localhost, http://,
 *  and anything else that isn't literally "https://...". */
export function isHttpsResource(resourceUrl: string): boolean {
  return resourceUrl.startsWith("https://");
}

/** WebMCP tool names: alphanumeric, underscore, hyphen, dot only, max 128
 *  chars (per spec). Derives a base name from the resource URL's last path
 *  segment; collision resolution (appending _2, _3, ...) happens in
 *  dedupeToolNames, not here, since it needs to see the whole batch. */
export function deriveToolName(resourceUrl: string): string {
  let lastSegment: string;
  try {
    const path = new URL(resourceUrl).pathname.replace(/\/+$/, "");
    lastSegment = path.split("/").filter(Boolean).pop() ?? "endpoint";
  } catch {
    lastSegment = "endpoint";
  }
  const sanitized = lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = sanitized || "endpoint";
  return `call_${base}`.slice(0, 128);
}

/** Title-cases a resource URL's last path segment for display, e.g.
 *  "weather" -> "Weather", "word-count" -> "Word Count". */
export function deriveToolTitle(resourceUrl: string): string {
  let lastSegment: string;
  try {
    const path = new URL(resourceUrl).pathname.replace(/\/+$/, "");
    lastSegment = path.split("/").filter(Boolean).pop() ?? "Endpoint";
  } catch {
    lastSegment = "Endpoint";
  }
  const words = lastSegment.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Endpoint";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

const MAX_DESCRIPTION_LENGTH = 200;

/** Builds a tool description from real catalog data only — never fabricates
 *  content beyond what the catalog actually returned. Truncated to stay
 *  under MAX_DESCRIPTION_LENGTH regardless of how long the catalog's own
 *  description field is. */
export function deriveToolDescription(resourceUrl: string, priceUsdc: string, catalogDescription: string | undefined): string {
  const base = `Call ${resourceUrl} and pay ${priceUsdc} USDC automatically.`;
  const full = catalogDescription ? `${base} ${catalogDescription}` : base;
  return full.length > MAX_DESCRIPTION_LENGTH ? `${full.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : full;
}

export interface DynamicToolSpec {
  name: string;
  title: string;
  description: string;
  resourceUrl: string;
  priceUsdc: string;
  ownershipState: OwnershipState;
}

/** Given a batch of candidate (name, spec) pairs in catalog order, appends
 *  _2, _3, ... to every name after the first occurrence of a duplicate, so
 *  no two dynamic tools are ever registered under the same name. Does not
 *  mutate its input. */
export function dedupeToolNames<T extends { name: string }>(specs: T[]): T[] {
  const seenCounts = new Map<string, number>();
  return specs.map((spec) => {
    const count = seenCounts.get(spec.name) ?? 0;
    seenCounts.set(spec.name, count + 1);
    if (count === 0) return spec;
    return { ...spec, name: `${spec.name}_${count + 1}`.slice(0, 128) };
  });
}
