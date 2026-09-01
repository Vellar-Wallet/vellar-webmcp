// Server-side handler for Tool 2 (pay_and_call). Runs entirely in Node.js —
// this is why the payment logic cannot live in app/page.tsx's client
// component: it needs Node's crypto APIs (via @stellar/stellar-sdk /
// @x402/stellar's signer) and must never expose a throwaway private key to
// the browser.
//
// SECURITY (non-negotiable, per project spec):
//   - The throwaway keypair is generated, used, and discarded entirely within
//     this request's scope. It is never logged, never returned to the
//     client, never persisted anywhere.
//   - The payer address (throwaway) must not equal the 402 challenge's payTo
//     address — asserted below, BEFORE any funds move (before funding,
//     before the trustline, before the DEX buy, before the payment itself).
//   - All external calls use HTTPS only.
//   - Errors returned to the client are generic. Full error details
//     (including stack traces) go to the server console only.

import { NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { provisionThrowawayPayer, StellarAccountError } from "@/lib/stellar-account";
import { fetchChallenge, payChallenge, X402PaymentError } from "@/lib/x402-payment";

export const runtime = "nodejs";

// Generous but bounded — matches the client's own 130s AbortController so the
// server has room to finish before the client gives up. Cold-start account
// provisioning (friendbot + trustline + DEX buy) plus the actual payment can
// realistically take 30-90s+ on testnet; this is an accepted, honest tradeoff
// of the "fresh throwaway wallet per call" design (no server-side wallet
// pooling — see SECURITY above).
const ROUTE_TIMEOUT_MS = 120_000;

interface PayRequestBody {
  url?: string;
  method?: "GET" | "POST";
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Bounds `promise` to `signal`'s abort, so the HTTP response is always
 *  returned within ROUTE_TIMEOUT_MS even though the underlying Stellar
 *  account-provisioning calls (friendbot polling, DEX retries) are not all
 *  individually threaded with the AbortSignal — they are plain network
 *  calls, not held resources, so letting them finish in the background after
 *  the response times out leaks nothing beyond a delayed friendbot/DEX call. */
function withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("request timed out"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function POST(request: Request) {
  const routeController = new AbortController();
  const routeTimeout = setTimeout(() => routeController.abort(), ROUTE_TIMEOUT_MS);

  try {
    const body: PayRequestBody = await request.json().catch(() => ({}));
    const { url, method = "GET" } = body;

    if (!url || typeof url !== "string" || !isHttpsUrl(url)) {
      return NextResponse.json({ success: false, error: "A valid https:// url is required." }, { status: 400 });
    }
    if (method !== "GET" && method !== "POST") {
      return NextResponse.json({ success: false, error: 'method must be "GET" or "POST".' }, { status: 400 });
    }

    // Step 1: decode the 402 challenge WITHOUT spending or signing anything.
    const challenge = await fetchChallenge(url, method, routeController.signal);

    // Step 2 (SECURITY GATE — the final check before any funds move): the
    // throwaway payer must not be the same address as the challenge's payTo.
    // A fresh Keypair.random() colliding with a real seller address is
    // effectively impossible, but this assertion exists as defense in depth
    // against a misconfigured or malicious target endpoint, and it must run
    // here — after the challenge is known, before the payer is even funded.
    const payerKeypair = Keypair.random();
    if (payerKeypair.publicKey() === challenge.payTo) {
      throw new Error("payer address must not equal payTo address");
    }

    // Step 3: now, and only now, provision the throwaway payer (friendbot,
    // trustline, DEX buy) and execute the payment. Bounded to the route's
    // overall timeout via withTimeout — see its own comment for why this is
    // a response-level bound rather than true call-level cancellation.
    await withTimeout(provisionThrowawayPayer(payerKeypair), routeController.signal);
    const result = await withTimeout(payChallenge(url, method, challenge, payerKeypair, routeController.signal), routeController.signal);

    return NextResponse.json({
      success: true,
      txHash: result.txHash,
      explorerUrl: result.txHash ? `https://stellar.expert/explorer/testnet/tx/${result.txHash}` : undefined,
      responseStatus: result.responseStatus,
      responseBody: result.responseBody,
    });
  } catch (err) {
    // Full detail server-side only — never echoed to the client.
    console.error("[api/pay] request failed:", err);

    const status = err instanceof X402PaymentError || err instanceof StellarAccountError ? 502 : 500;
    return NextResponse.json({ success: false, error: "Payment could not be completed. See server logs for details." }, { status });
  } finally {
    clearTimeout(routeTimeout);
  }
}
