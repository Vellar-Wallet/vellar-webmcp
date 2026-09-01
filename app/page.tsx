// Client component: registers the three WebMCP tools and renders the page
// UI. Must be a client component ('use client') since document.modelContext
// only exists in the browser — the actual payment logic that needs Node's
// crypto APIs lives server-side, in app/api/pay/route.ts, and is called via
// fetch from Tool 2's execute function below.
"use client";

import "./webmcp-init";
import { useWebMCP } from "usewebmcp";
import { formatAtomicUsdc, formatPrice, shortenAddress } from "@/lib/format";
import { BazaarTools } from "@/components/BazaarTools";

const FACILITATOR_URL = "https://vellar-facilitator.onrender.com";
const EXPLORER_URL = "https://vellar-explorer.onrender.com";

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
        const res = await fetch(`${EXPLORER_URL}/payments?payTo=${encodeURIComponent(payToAddress)}&limit=10`, { signal });
        const data = await res.json();
        // NOTE: the live explorer returns { items: [...] }, not
        // { payments: [...] } — confirmed against the real deployed
        // endpoint, not assumed. Each item's seller field is what the spec
        // calls "payTo"; there is no per-item field literally named payTo.
        const items: ExplorerPaymentItem[] = data.items ?? [];
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
    <main className="mx-auto flex max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Vellar x402 — Live API Marketplace for AI Agents</h1>
        <p className="text-sm leading-relaxed text-black/70 dark:text-white/70">
          This page connects AI agents to the Vellar Bazaar — a catalog of paid API endpoints on
          Stellar. The tools below are generated live from real endpoints that have received real
          on-chain payments. Every tool here is purchasable with USDC on Stellar testnet.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Core tools</h2>
        <ul className="flex flex-col gap-4">
          {TOOLS.map((tool) => (
            <li key={tool.name} className="rounded-lg border border-black/10 p-4 dark:border-white/15">
              <p className="font-mono text-sm font-semibold">{tool.name}</p>
              <p className="mt-1 text-sm text-black/70 dark:text-white/70">{tool.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <BazaarTools />

      <p className="rounded-lg bg-black/5 p-4 text-sm dark:bg-white/10">
        Open this page in ChatGPT&apos;s browser or Chrome with WebMCP enabled to use these tools.
      </p>
    </main>
  );
}
