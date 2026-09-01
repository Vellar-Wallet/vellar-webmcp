# vellar-webmcp

A Next.js app that registers [WebMCP](https://github.com/webmachinelearning/webmcp-types) tools
exposing the Vellar x402 payment ecosystem on Stellar to AI agents. WebMCP lets a web page expose
callable tools directly to an AI agent browsing it — no separate MCP server, no API keys handed out
in advance. This page *is* the integration surface.

## What it is

A single page (`app/page.tsx`) that, when loaded in a WebMCP-capable browser, registers:

- **3 core tools**, always present, that let an agent discover paid API endpoints on the Vellar
  Bazaar, pay for and call one with a real (testnet) on-chain USDC payment, and check a seller's
  recent earnings — all without a human setting up credentials.
- **A dynamic tool per live, payment-proven Bazaar listing**, fetched and registered on page load —
  see "Dynamic tool generation" below. This is the project's core differentiator: rather than one
  generic "call any x402 URL" tool, an agent sees a dedicated, named, pre-priced tool per real
  endpoint the Bazaar actually knows about.

## The three core tools

- **`search_vellar_bazaar`** — Searches the Vellar Bazaar catalog (`vellar-facilitator`'s
  `/discovery/search`) for x402-protected API endpoints matching a natural-language query. Returns
  each match's URL, price in USDC, verification status, and description. Read-only.

- **`pay_and_call`** — Pays an x402-protected endpoint using a freshly generated, single-use Stellar
  testnet wallet, then returns that endpoint's response. This makes a **real on-chain USDC payment
  on Stellar testnet** — funded via friendbot, DEX-bought USDC, no mainnet funds are ever involved.
  Runs server-side (`app/api/pay/route.ts`) since it needs Node's crypto APIs and must never expose
  a private key to the browser. Not read-only.

- **`check_vellar_earnings`** — Looks up the last 10 settlements for a given Stellar seller address
  via `vellar-explorer`'s `/payments` endpoint, returning amounts, payer addresses, timestamps, and
  Stellar Expert links. Read-only.

## Dynamic tool generation

On mount, `components/BazaarTools.tsx` fetches `vellar-facilitator`'s
`GET /discovery/resources` catalog and registers one WebMCP tool per listing whose
`trust.ownershipState` is `"verified"` or `"proven-unconfirmed"` — i.e. has actually received
payment activity, per the facilitator's own trust model. `"unverified"` listings are excluded
entirely.

Each dynamic tool is named `call_{sanitized_last_path_segment}` (e.g.
`https://vellar-seller-demo.onrender.com/uuid` → `call_uuid`), with a title-cased title and a
description built only from real catalog data (price + the catalog's own `description` field,
truncated under 200 characters, never fabricated). Calling it hits `/api/pay` with that endpoint's
URL hardcoded at generation time — the same server-side flow and the same `payer !== payTo` security
gate as the `pay_and_call` core tool, unchanged.

Two listing shapes are filtered out **before** a tool is ever registered for them, logged to the
browser console with counts, rather than shipped as a tool that's guaranteed to fail every call:

- **Path-templated resources** — a catalog URL containing `/:` (e.g. `.../inspect/:address`) is an
  unresolved template, not a callable URL.
- **Non-HTTPS resources** — a `http://` or `localhost` catalog entry (seen live, from local dev
  seller processes) is either insecure or unreachable from the deployed server; `/api/pay`'s own
  validation would reject it anyway.

Because `useWebMCP` is a real React hook (`useState`/`useRef`/`useEffect` internally), it cannot be
called inside a loop over a dynamic-length array — `components/BazaarTools.tsx` instead renders one
dedicated `<BazaarTool>` child component per registered listing, each calling the hook exactly once;
mounting/unmounting whole components is what varies as the live catalog changes, never the number of
hook calls within one component.

If the catalog fetch fails, the page shows "Could not load live Bazaar tools — showing core tools
only" and the 3 core tools continue to work regardless.

## Architecture

```
app/page.tsx             — client component; registers the 3 core tools, renders page UI
app/webmcp-init.ts        — initializes the WebMCP polyfill so document.modelContext exists in any
                             current browser (see "Runtime" below)
app/api/pay/route.ts     — server-side route handling the actual payment logic (core + dynamic tools)
components/BazaarTools.tsx — fetches the live catalog and registers a dynamic tool per listing
lib/bazaar-catalog.ts     — pure helpers: filtering, name/title/description derivation, dedup
lib/stellar-account.ts   — throwaway keypair funding: friendbot, USDC trustline, DEX buy
lib/x402-payment.ts      — the x402 protocol flow itself: 402 challenge fetch, payload signing, retry
lib/format.ts             — shared display formatting (atomic USDC -> decimal, address shortening)
```

`lib/stellar-account.ts` and `lib/x402-payment.ts` are deliberately separate modules: one knows how
a throwaway account gets funded, the other knows how to pay a decoded challenge with a signer it's
handed. Neither depends on the other, and each is independently testable.

The payment logic is ported from `vellar-facilitator`'s `examples/buyer-classic.mjs` (the official
`@x402/core` / `@x402/stellar` client flow: GET → 402 → `createPaymentPayload()` → retry with the
`PAYMENT-SIGNATURE` header) and `scripts/run-load-test.js` (friendbot funding, trustline setup, DEX
buying). It is a port of proven mechanics, not new protocol logic.

## Runtime: the WebMCP polyfill

`usewebmcp`'s hook requires `document.modelContext` to already exist — via native browser support,
or a polyfill, initialized *before* any tool registers. This app uses
[`@mcp-b/webmcp-polyfill`](https://www.npmjs.com/package/@mcp-b/webmcp-polyfill) (`app/webmcp-init.ts`,
imported at the top of `app/page.tsx`) so the tools work in any current Chrome, not only a
future/flagged native implementation. The polyfill no-ops if native `document.modelContext` support
is already present, so it does not interfere with native WebMCP or with ChatGPT's browser.

## How to test

1. Run the app locally:

   ```bash
   npm install
   npm run dev
   ```

2. Open [http://localhost:3000](http://localhost:3000) in **any current Chrome** (the polyfill means
   no experimental flag is required), or in ChatGPT's browser, or in Chrome with the native WebMCP
   flag enabled (`chrome://flags`, if/when available) — the polyfill defers to native support when
   present.

3. Open the DevTools console and run:

   ```js
   document.modelContext.getTools().then((t) => {
     console.log("total tools:", t.length);
     t.forEach((tool) => console.log(tool.name));
   });
   ```

   This must return the 3 core tools (`search_vellar_bazaar`, `pay_and_call`,
   `check_vellar_earnings`) **plus** one `call_*` tool per verified/proven-unconfirmed live catalog
   listing. The `[BazaarTools]` console log printed on page load reports exactly how many listings
   were fetched, how many were filtered out (and why), and how many tools were registered — the two
   counts should agree.

4. From an agent (or by calling `execute` directly via the tool's registration), try:
   - `search_vellar_bazaar({ query: "weather API" })`
   - `pay_and_call({ url: "<a discovered endpoint>" })` — expect **30–90+ seconds**: this cold-starts
     a brand-new testnet wallet (friendbot funding, trustline, DEX purchase) before making the actual
     payment. This latency is an accepted tradeoff of never persisting or pooling the throwaway
     payer key — see Security below.
   - `check_vellar_earnings({ payToAddress: "<a seller G-address>" })`

## Security

- The throwaway payer keypair is generated inside a single `/api/pay` request, used, and discarded.
  It is **never logged, never returned to the client, never persisted** anywhere (no disk, no cache,
  no pool of pre-funded wallets).
- Before any funds move, the route asserts the throwaway payer's address does not equal the 402
  challenge's `payTo` address — the final gate, run after the challenge is decoded and before the
  account is even funded.
- All external calls (facilitator, explorer, friendbot, Horizon, RPC, the target x402 endpoint) use
  HTTPS only.
- Errors returned to the client are generic (`"Payment could not be completed."`); full error detail
  goes to the server console only.

## Deployment

Deploys to [Render](https://render.com) via `render.yaml` (free plan, Node environment). Connect the
repo in the Render dashboard and it picks up `render.yaml` automatically.

Build: `npm install && npm run build`. Start: `npm start`.

## License

MIT — see [LICENSE](./LICENSE).
