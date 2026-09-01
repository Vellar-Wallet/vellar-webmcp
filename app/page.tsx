// Client component: registers the three WebMCP tools and renders the page
// UI. Must be a client component ('use client') since document.modelContext
// only exists in the browser — the actual payment logic that needs Node's
// crypto APIs lives server-side, in app/api/pay/route.ts, and is called via
// fetch from Tool 2's execute function below.
"use client";

import "./webmcp-init";
import Image from "next/image";
import Link from "next/link";
import { useWebMCP } from "usewebmcp";
import { formatAtomicUsdc, formatPrice, shortenAddress } from "@/lib/format";
import { BazaarTools } from "@/components/BazaarTools";

const FACILITATOR_URL = "https://vellar-facilitator.onrender.com";

// Tool 1 and Tool 3 are read-only lookups against external services this app
// doesn't control — a slow or hung upstream must not hang an agent's tool
// call forever. usewebmcp's execute has no built-in AbortSignal parameter
// (confirmed against its shipped .d.ts), so each fetch wraps its own
// AbortController + timeout rather than relying on one being passed in.
function withTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural language search, e.g. 'weather API' or 'text hash conversion'",
    },
  },
  required: ["query"],
} as const;

const PAY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Full HTTPS URL of the x402 endpoint to pay and call",
    },
    method: {
      type: "string",
      enum: ["GET", "POST"],
      description: "HTTP method, defaults to GET",
    },
  },
  required: ["url"],
} as const;

const EARNINGS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    payToAddress: {
      type: "string",
      description: "Stellar G-address of the seller to check earnings for",
    },
  },
  required: ["payToAddress"],
} as const;

interface BazaarSearchResource {
  resource?: string;
  url?: string;
  endpoint?: string;
  accepts?: Array<{ amount?: string; asset?: string }>;
  trust?: { ownershipState?: string };
  description?: string;
}

interface ExplorerPaymentItem {
  amount?: string;
  buyer?: string;
  closedAt?: string;
  txHash?: string;
}

const TOOLS = [
  {
    name: "search_vellar_bazaar",
    title: "Search Vellar Bazaar",
    description:
      "Search the Vellar Bazaar catalog for discoverable x402 paid API endpoints on Stellar. Returns matching endpoints with their URLs, prices in USDC, and verification status.",
  },
  {
    name: "pay_and_call",
    title: "Pay and Call Endpoint",
    description:
      "Pay an x402-protected API endpoint using a throwaway Stellar testnet wallet and return its response. Makes a real on-chain USDC payment on Stellar testnet. Use after search_vellar_bazaar to actually call a paid endpoint.",
  },
  {
    name: "check_vellar_earnings",
    title: "Check Vellar Earnings",
    description:
      "Check recent settlements and USDC earnings for a Vellar seller address. Returns the last 10 settlements with amounts, timestamps, and transaction hashes linking to Stellar Expert.",
  },
] as const;

export default function Home() {
  // NOTE: usewebmcp's WebMCPConfig has no `title` field (confirmed against
  // its shipped .d.ts) — only name/description/inputSchema/outputSchema/
  // annotations/execute/enabled. Each tool's display title still appears in
  // the human-readable UI list below via the TOOLS constant.

  // TOOL 1 — search_vellar_bazaar
  useWebMCP({
    name: "search_vellar_bazaar",
    description:
      "Search the Vellar Bazaar catalog for discoverable x402 paid API endpoints on Stellar. Returns matching endpoints with their URLs, prices in USDC, and verification status.",
    inputSchema: SEARCH_INPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    execute: async ({ query }) => {
      const { signal, clear } = withTimeoutSignal(15_000);
      try {
        const res = await fetch(`${FACILITATOR_URL}/discovery/search?query=${encodeURIComponent(query)}`, { signal });
        const data = await res.json().catch(() => ({}));

        // Logged so a real failure mode is visible in the console rather
        // than only inferred from a downstream "Cannot read properties of
        // undefined" error — e.g. a missing `query` param returns
        // { error: "invalid_query", detail: "..." } with no resources key
        // at all (confirmed live), and any future change to the
        // facilitator's response shape shows up here immediately.
        console.log("[search_vellar_bazaar] raw response:", JSON.stringify(data));

        // The facilitator's own /discovery/search key is `resources`
        // (confirmed live), but this stays defensive against alternate
        // shapes (`results`/`items`/`data`) and, on a 400 like
        // invalid_query, there is no results key at all — resources then
        // falls through every ?? to the final [], never undefined.
        const resources = data?.resources ?? data?.results ?? data?.items ?? data?.data ?? [];

        const mapped = Array.isArray(resources)
          ? (resources as BazaarSearchResource[]).map((r) => ({
              url: r?.resource ?? r?.url ?? r?.endpoint ?? "unknown",
              price: formatPrice(r?.accepts?.[0]),
              status: r?.trust?.ownershipState ?? "unknown",
              description: r?.description ?? "",
            }))
          : [];

        return JSON.stringify(mapped);
      } finally {
        clear();
      }
    },
  });

  // TOOL 2 — pay_and_call
  useWebMCP({
    name: "pay_and_call",
    description:
      "Pay an x402-protected API endpoint using a throwaway Stellar testnet wallet and return its response. Makes a real on-chain USDC payment on Stellar testnet. Use after search_vellar_bazaar to actually call a paid endpoint.",
    inputSchema: PAY_INPUT_SCHEMA,
    annotations: { readOnlyHint: false },
    execute: async ({ url, method = "GET" }) => {
      // The server route has its own 120s ceiling; this client-side timeout
      // is set to 130s to give it room to finish and respond before the
      // browser gives up on the fetch itself.
      const { signal, clear } = withTimeoutSignal(130_000);
      try {
        const res = await fetch("/api/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, method }),
          signal,
        });
        const data = await res.json();
        return JSON.stringify(data);
      } finally {
        clear();
      }
    },
  });

  // TOOL 3 — check_vellar_earnings
  useWebMCP({
    name: "check_vellar_earnings",
    description:
      "Check recent settlements and USDC earnings for a Vellar seller address. Returns the last 10 settlements with amounts, timestamps, and transaction hashes linking to Stellar Expert.",
    inputSchema: EARNINGS_INPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    execute: async ({ payToAddress }) => {
      const { signal, clear } = withTimeoutSignal(15_000);
      try {
        // Routed through /api/earnings rather than calling vellar-explorer
        // directly — confirmed live that vellar-explorer sends no
        // Access-Control-Allow-Origin header, so a direct browser fetch is
        // permanently blocked by CORS (works fine server-side, since CORS
        // is a browser-only enforcement). /api/earnings does that same
        // fetch server-side and hands the JSON back same-origin.
        const res = await fetch(`/api/earnings?payTo=${encodeURIComponent(payToAddress)}&limit=10`, { signal });
        const data = await res.json().catch(() => ({}));
        // NOTE: the live explorer returns { items: [...] }, not
        // { payments: [...] } — confirmed against the real deployed
        // endpoint, not assumed. Each item's seller field is what the spec
        // calls "payTo"; there is no per-item field literally named payTo.
        const items: ExplorerPaymentItem[] = Array.isArray(data?.items) ? data.items : [];
        return JSON.stringify(
          items.map((p) => ({
            amount: `${formatAtomicUsdc(p.amount)} USDC`,
            payer: shortenAddress(p.buyer),
            time: p.closedAt ? new Date(p.closedAt).toLocaleString() : "unknown",
            txHash: p.txHash,
            explorerUrl: p.txHash ? `https://stellar.expert/explorer/testnet/tx/${p.txHash}` : undefined,
          })),
        );
      } finally {
        clear();
      }
    },
  });

  return (
    <>
      <div className="sticky top-0 z-40 border-b" style={{ background: "var(--lp-paper)", borderColor: "var(--lp-line)" }}>
        <div className="mx-auto flex h-[72px] max-w-[var(--lp-container)] items-center px-[var(--lp-gutter)]">
          <Link href="/" className="lp-brand">
            <Image src="/logo-mark.png" alt="Vellar" width={1400} height={540} priority style={{ height: 40, width: "auto" }} />
          </Link>
        </div>
      </div>

      <main className="mx-auto flex w-full max-w-[var(--lp-container)] flex-1 flex-col gap-[var(--lp-sp-xl)] px-[var(--lp-gutter)] py-[var(--lp-sp-lg)]">
        <header className="flex flex-col gap-[var(--lp-sp-4)]">
          <span className="lp-eyebrow">
            <span aria-hidden style={{ color: "var(--lp-mint)" }}>
              ●
            </span>
            x402 on Stellar
          </span>
          <h1 style={{ fontSize: "var(--lp-fs-hero)" }}>
            Live API marketplace <em>for AI agents</em>
          </h1>
          <p className="max-w-[62ch]" style={{ fontSize: "var(--lp-fs-lead)", color: "var(--lp-ink-soft)" }}>
            This page connects AI agents to the Vellar Bazaar — a catalog of paid API endpoints on
            Stellar. The tools below are generated live from real endpoints that have received real
            on-chain payments. Every tool here is purchasable with USDC on Stellar testnet.
          </p>
        </header>

        <section className="flex flex-col gap-[var(--lp-sp-6)]">
          <h2 style={{ fontSize: "var(--lp-fs-h3)" }}>Core tools</h2>
          <div className="grid grid-cols-1 gap-[var(--lp-sp-6)] sm:grid-cols-3">
            {TOOLS.map((tool) => (
              <article key={tool.name} className="lp-card">
                <p className="font-mono text-sm font-semibold" style={{ color: "var(--lp-forest)" }}>
                  {tool.name}
                </p>
                <p className="text-sm" style={{ color: "var(--lp-ink-soft)" }}>
                  {tool.description}
                </p>
              </article>
            ))}
          </div>
        </section>

        <BazaarTools />

        <div className="lp-invert lp-card lp-card--dark">
          <p className="text-sm">
            Open this page in ChatGPT&apos;s browser or Chrome with WebMCP enabled to use these tools.
          </p>
        </div>
      </main>
    </>
  );
}
