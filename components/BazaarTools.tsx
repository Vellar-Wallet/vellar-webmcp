// Dynamic tool generation — the hackathon differentiator. On mount, fetches
// the live Vellar Bazaar catalog and registers one WebMCP tool per verified
// or proven-unconfirmed listing, so an agent gets a dedicated callable tool
// per real, payment-proven endpoint rather than only the generic
// pay_and_call(url) tool.
//
// IMPORTANT REACT CONSTRAINT: useWebMCP is a real hook (useState, useRef,
// useEffect internally — confirmed by reading usewebmcp's shipped source),
// so it cannot be called inside a .map() loop over a dynamic-length array —
// that violates the Rules of Hooks (hook call count must be stable across
// renders). The fix: one dedicated child component per dynamic tool
// (BazaarTool below), each calling useWebMCP exactly once. The parent
// varies how many *components* it renders, not how many times a hook is
// called within one component — that part is React-sanctioned.
"use client";

import { useEffect, useState } from "react";
import { useWebMCP } from "usewebmcp";
import { formatPrice } from "@/lib/format";
import {
  dedupeToolNames,
  deriveToolDescription,
  deriveToolName,
  deriveToolTitle,
  isHttpsResource,
  isPathTemplate,
  isRegistrableListing,
  type BazaarCatalogItem,
  type BazaarCatalogResponse,
  type DynamicToolSpec,
} from "@/lib/bazaar-catalog";

const FACILITATOR_URL = "https://vellar-facilitator.onrender.com";
const CATALOG_FETCH_TIMEOUT_MS = 15_000;
const CATALOG_FETCH_MAX_RETRIES = 3;
const CATALOG_FETCH_RETRY_DELAY_MS = 3_000;

const DYNAMIC_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    body: {
      type: "string",
      description: "Optional JSON body for POST requests",
    },
  },
} as const;

type LoadState = "loading" | "loaded" | "error";

/**
 * Fetches the catalog with a bounded retry-with-backoff, to ride out
 * vellar-facilitator's own cold start on Render's free tier (the first
 * request after a period of inactivity can time out or fail outright before
 * the instance is fully warm).
 *
 * Retries ONLY on a genuine failure — a thrown fetch (network error,
 * timeout via the per-attempt AbortSignal), a non-OK HTTP status, or
 * unparseable JSON. Deliberately does NOT retry a successful response that
 * simply contains zero listings — a facilitator that responds 200 with an
 * empty (or all-unregistrable) catalog is a valid, real state (e.g. no
 * verified/proven-unconfirmed listings exist right now), not a cold-start
 * symptom, and treating it as failure would make this function unable to
 * ever correctly report "0 tools" without wasting a full retry cycle first.
 */
async function fetchCatalogWithRetry(
  url: string,
  outerSignal: AbortSignal,
  retries = CATALOG_FETCH_MAX_RETRIES,
  delayMs = CATALOG_FETCH_RETRY_DELAY_MS,
): Promise<BazaarCatalogResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (outerSignal.aborted) throw new DOMException("aborted", "AbortError");

    const attemptController = new AbortController();
    const onOuterAbort = () => attemptController.abort();
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    const attemptTimeout = setTimeout(() => attemptController.abort(), CATALOG_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: attemptController.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as BazaarCatalogResponse;
    } catch (err) {
      lastError = err;
      if (outerSignal.aborted) throw err; // unmounted mid-attempt — stop retrying
      console.warn(`[BazaarTools] catalog fetch attempt ${attempt}/${retries} failed:`, err);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } finally {
      clearTimeout(attemptTimeout);
      outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastError;
}

/** Builds the full set of dynamic tool specs from a raw catalog response:
 *  filters to registrable, HTTPS, non-templated listings, then deduplicates
 *  names. Pure and independent of React so it's easy to reason about /
 *  reuse in a test. Returns both the specs and a breakdown of why anything
 *  was filtered, for the console visibility this was built to have. */
function buildDynamicToolSpecs(items: BazaarCatalogItem[]): {
  specs: DynamicToolSpec[];
  skippedNonRegistrable: number;
  skippedTemplate: number;
  skippedNonHttps: number;
} {
  let skippedNonRegistrable = 0;
  let skippedTemplate = 0;
  let skippedNonHttps = 0;

  const candidates: DynamicToolSpec[] = [];
  for (const item of items) {
    const resourceUrl = item.resource;
    if (!resourceUrl) continue;

    if (!isRegistrableListing(item)) {
      skippedNonRegistrable++;
      continue;
    }
    if (isPathTemplate(resourceUrl)) {
      skippedTemplate++;
      continue;
    }
    if (!isHttpsResource(resourceUrl)) {
      skippedNonHttps++;
      continue;
    }

    const priceUsdc = formatPrice(item.accepts?.[0]);
    candidates.push({
      name: deriveToolName(resourceUrl),
      title: deriveToolTitle(resourceUrl),
      description: deriveToolDescription(resourceUrl, priceUsdc, item.description),
      resourceUrl,
      priceUsdc,
      ownershipState: item.trust?.ownershipState ?? "unknown",
    });
  }

  return { specs: dedupeToolNames(candidates), skippedNonRegistrable, skippedTemplate, skippedNonHttps };
}

/** One dynamic tool's registration. A dedicated component per spec, keyed by
 *  final (post-dedupe) name, so mounting/unmounting whole components is what
 *  varies the number of live useWebMCP registrations — never a loop calling
 *  the hook a variable number of times within one component. */
function BazaarTool({ spec }: { spec: DynamicToolSpec }) {
  useWebMCP({
    name: spec.name,
    description: spec.description,
    inputSchema: DYNAMIC_TOOL_INPUT_SCHEMA,
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input: { body?: string }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 130_000);
      try {
        const res = await fetch("/api/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: spec.resourceUrl, // hardcoded at generation time, not user-supplied
            method: "GET",
            body: input.body,
          }),
          signal: controller.signal,
        });
        const data = await res.json();
        return JSON.stringify(data);
      } finally {
        clearTimeout(timeout);
      }
    },
  });

  return (
    <li className="rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-sm font-semibold">{spec.name}</p>
        <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
          {spec.priceUsdc}
        </span>
      </div>
      <p className="mt-1 text-sm text-black/70 dark:text-white/70">{spec.description}</p>
      <p className="mt-1 text-xs text-black/40 dark:text-white/40">{spec.ownershipState}</p>
    </li>
  );
}

export function BazaarTools() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [specs, setSpecs] = useState<DynamicToolSpec[]>([]);
  // Tracks a manual "Refresh tools" click separately from the initial-mount
  // load — reuses the same loadCatalog function, but the button's own label
  // needs to know it's mid-refresh even if loadState is still "loaded" from
  // the previous successful fetch (we don't want to blank the existing tool
  // list away to a bare loading message on every manual refresh).
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Bumping this re-runs the load effect below — the "Refresh tools" button
  // re-triggers the catalog fetch + tool re-registration without a full page
  // reload, per spec.
  const [refreshNonce, setRefreshNonce] = useState(0);

  function handleRefresh() {
    setIsRefreshing(true);
    setRefreshNonce((n) => n + 1);
  }

  useEffect(() => {
    const controller = new AbortController();

    async function loadCatalog() {
      setLoadState((prev) => (prev === "loaded" ? prev : "loading"));
      try {
        const data = await fetchCatalogWithRetry(`${FACILITATOR_URL}/discovery/resources`, controller.signal);
        const items = data.items ?? [];
        const built = buildDynamicToolSpecs(items);

        if (controller.signal.aborted) return;

        // Visibility during testing, per spec — logged regardless of
        // outcome, without affecting the user-facing UI.
        console.log(
          `[BazaarTools] fetched ${items.length} catalog listing(s); ` +
            `skipped ${built.skippedNonRegistrable} (not verified/proven-unconfirmed), ` +
            `${built.skippedTemplate} (path template), ` +
            `${built.skippedNonHttps} (non-HTTPS); ` +
            `registered ${built.specs.length} dynamic tool(s): ${built.specs.map((s) => s.name).join(", ") || "(none)"}`,
        );

        setSpecs(built.specs);
        setLoadState("loaded");
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("[BazaarTools] failed to load the live Bazaar catalog after retries:", err);
        setLoadState("error");
      } finally {
        if (!controller.signal.aborted) setIsRefreshing(false);
      }
    }

    void loadCatalog();

    return () => controller.abort();
    // Re-runs whenever a manual refresh is requested — see handleRefresh.
  }, [refreshNonce]);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">Live Bazaar tools</h2>

      {loadState === "loading" && <p className="text-sm text-black/60 dark:text-white/60">Loading live Bazaar tools…</p>}

      {loadState === "error" && (
        <p className="rounded-lg bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
          Could not load live Bazaar tools — showing core tools only.
        </p>
      )}

      {loadState === "loaded" && specs.length === 0 && (
        <p className="text-sm text-black/60 dark:text-white/60">
          No verified or proven-unconfirmed Bazaar listings are currently available.
        </p>
      )}

      {loadState === "loaded" && specs.length > 0 && (
        <ul className="flex flex-col gap-4">
          {specs.map((spec) => (
            <BazaarTool key={spec.name} spec={spec} />
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={handleRefresh}
        disabled={isRefreshing || loadState === "loading"}
        className="self-start rounded-lg border border-black/10 px-3 py-1.5 text-sm text-black/70 transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-white/70 dark:hover:bg-white/10"
      >
        {isRefreshing || loadState === "loading" ? "Refreshing…" : "Refresh tools"}
      </button>
    </section>
  );
}
