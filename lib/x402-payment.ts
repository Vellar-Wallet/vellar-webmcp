// x402 payment execution: GET -> 402 challenge -> sign -> retry with payment
// header. Ported verbatim in behavior from vellar-facilitator's
// examples/buyer-classic.mjs, which is the project's own canonical example of
// "copy this file, not the mechanics underneath it" — built entirely on the
// official @x402/core and @x402/stellar clients rather than hand-parsing the
// challenge or hand-encoding headers.
//
// Deliberately split out from lib/stellar-account.ts: this file only knows
// how to pay a challenge with a signer it's given, it has no idea how that
// signer's account came to hold funds.
//
// Deliberately split into two steps (fetchChallenge, then payChallenge)
// rather than one combined call: app/api/pay/route.ts's security assertion
// (payer !== payTo) must run in the gap between decoding the challenge and
// signing/spending anything, as the final gate before funds move.

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createEd25519Signer } from "@x402/stellar";
import type { PaymentRequired } from "@x402/core/types";
import type { Keypair } from "@stellar/stellar-sdk";

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK = "stellar:testnet";

export class X402PaymentError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "X402PaymentError";
  }
}

export interface PayAndCallResult {
  txHash: string | undefined;
  responseStatus: number;
  responseBody: unknown;
}

export interface X402Challenge {
  /** The decoded PAYMENT-REQUIRED challenge. */
  paymentRequired: PaymentRequired;
  /** The seller address this challenge asks payment to be made to. */
  payTo: string;
}

/**
 * Step 1: GET the target URL (unpaid) and decode its 402 challenge.
 * Does not sign or spend anything — safe to call before any security
 * assertion has run.
 */
export async function fetchChallenge(url: string, method: "GET" | "POST", signal: AbortSignal): Promise<X402Challenge> {
  // A throwaway client with no signer registered is sufficient here — this
  // step only decodes the challenge headers, it never calls
  // createPaymentPayload.
  const http = new x402HTTPClient(new x402Client());

  const unpaid = await fetch(url, { method, signal });
  if (unpaid.status !== 402) {
    throw new X402PaymentError(`expected HTTP 402 from the target endpoint, got ${unpaid.status}`);
  }

  const unpaidBody = await unpaid.json().catch(() => undefined);
  const paymentRequired = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), unpaidBody);

  const requirement = paymentRequired.accepts?.find((a) => a.network === NETWORK && a.scheme === "exact");
  if (!requirement) {
    throw new X402PaymentError(`no ${NETWORK} "exact" scheme payment requirement in the 402 challenge`);
  }

  return { paymentRequired, payTo: requirement.payTo };
}

/**
 * Step 2: sign and send payment for a challenge already fetched via
 * fetchChallenge(), then retry the request with the payment header attached.
 * Callers MUST have already asserted payerKeypair.publicKey() !== the
 * challenge's payTo before calling this — that check happens in
 * app/api/pay/route.ts, not here.
 */
export async function payChallenge(
  url: string,
  method: "GET" | "POST",
  challenge: X402Challenge,
  payerKeypair: Keypair,
  signal: AbortSignal,
): Promise<PayAndCallResult> {
  const signer = createEd25519Signer(payerKeypair.secret(), NETWORK);
  const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer, { url: RPC_URL }));
  const http = new x402HTTPClient(client);

  let payload;
  try {
    payload = await client.createPaymentPayload(challenge.paymentRequired);
  } catch (err) {
    throw new X402PaymentError("failed to build and sign the payment payload", err);
  }

  const paid = await fetch(url, {
    method,
    headers: http.encodePaymentSignatureHeader(payload),
    signal,
  });
  const responseBody = await paid.json().catch(() => undefined);

  if (paid.status !== 200) {
    throw new X402PaymentError(`payment sent but endpoint did not unlock: HTTP ${paid.status}`);
  }

  let txHash: string | undefined;
  try {
    const settleHeader = http.getPaymentSettleResponse((name) => paid.headers.get(name));
    txHash = settleHeader.transaction;
  } catch {
    // No PAYMENT-RESPONSE header present — some sellers may not echo one.
    // Not fatal: the caller already has a 200 response body to return.
    txHash = undefined;
  }

  return { txHash, responseStatus: paid.status, responseBody };
}
