// Stellar testnet account mechanics for a throwaway payer keypair: fund via
// friendbot, open a USDC trustline, then buy USDC on the DEX. Ported from
// vellar-facilitator's scripts/run-load-test.js (setup() + acquireUsdcOnDex +
// fundAndWait + submit), which proves these exact steps against real testnet
// infrastructure. Deliberately split out from the x402 payment logic
// (lib/x402-payment.ts) so each concern is unit-testable in isolation.
//
// SECURITY: every function here operates on a Keypair passed in by the
// caller. Nothing in this file persists a secret key anywhere (no disk, no
// log line prints kp.secret()) — the caller (app/api/pay/route.ts) owns the
// keypair's lifetime and it must never outlive that single request.

import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

// Canonical testnet USDC — same issuer vellar-facilitator's own tooling uses
// (permissionless, auth_required=false, no faucet; must be bought on the DEX).
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const usdcAsset = new Asset("USDC", USDC_ISSUER);

// One payment's worth of headroom. 1 USDC bought, ~10x a typical small x402
// payment, leaves room for fees/rounding without waiting on a large XLM->USDC
// conversion (friendbot grants ~10,000 XLM, so 50 XLM ceiling is generous).
const USDC_ACQUIRE_UNITS = "1";
const USDC_MAX_XLM = "50";

const rpcServer = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class StellarAccountError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StellarAccountError";
  }
}

/** Same retry shape as run-load-test.js's own `retry` — the public testnet
 *  RPC is load-balanced across nodes whose ledger states drift, so a read
 *  that succeeds on one node can fail on the very next call. */
async function retry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) {
        throw new StellarAccountError(`${label}: gave up after ${attempts} attempts`, err);
      }
      await sleep(3000 * attempt);
    }
  }
}

/** Fund via friendbot, then wait until the account is actually visible to
 *  Soroban RPC — friendbot returning 200 does not mean that yet. */
export async function fundAndWait(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new StellarAccountError(`friendbot funding failed: HTTP ${res.status}`);
  }
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    try {
      await rpcServer.getAccount(publicKey);
      if (++streak >= 3) return;
    } catch {
      streak = 0;
    }
    await sleep(2000);
  }
  throw new StellarAccountError("account funded but never became visible to the RPC");
}

/** Build, sign, submit one classic-account operation set, waiting for
 *  confirmation. */
async function submit(label: string, kp: Keypair, ops: ReturnType<typeof Operation.changeTrust>[]): Promise<string> {
  return retry(label, async () => {
    const account = await rpcServer.getAccount(kp.publicKey());
    let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE });
    for (const op of ops) tx = tx.addOperation(op);
    const built = tx.setTimeout(120).build();
    built.sign(kp);
    const sent = await rpcServer.sendTransaction(built);
    if (sent.status === "ERROR") {
      throw new StellarAccountError(`transaction rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`);
    }
    for (let i = 0; i < 45; i++) {
      await sleep(1500);
      const got = await rpcServer.getTransaction(sent.hash);
      if (got.status === "SUCCESS") return sent.hash;
      if (got.status === "FAILED") throw new StellarAccountError(`transaction FAILED (${sent.hash})`);
    }
    throw new StellarAccountError(`timed out awaiting confirmation of ${sent.hash}`);
  });
}

/** Open a USDC trustline for the given keypair. Required before it can hold
 *  or transact in USDC — the account existing is not sufficient. */
export async function openUsdcTrustline(kp: Keypair): Promise<void> {
  await submit(`trustline-${kp.publicKey().slice(0, 6)}`, kp, [Operation.changeTrust({ asset: usdcAsset })]);
}

/** Buy `destAmount` of USDC on the DEX, paying in XLM. There is no mint
 *  authority for canonical testnet USDC — the open market is the only way to
 *  acquire a balance. */
export async function buyUsdcOnDex(kp: Keypair, destAmount: string = USDC_ACQUIRE_UNITS): Promise<void> {
  const paths = await retry(`usdc-path-${kp.publicKey().slice(0, 6)}`, async () => {
    const res = await horizon.strictReceivePaths([Asset.native()], usdcAsset, destAmount).call();
    if (!res.records.length) throw new StellarAccountError("no XLM->USDC DEX path available");
    return res.records;
  });
  const best = paths[0];
  await submit(`acquire-usdc-${kp.publicKey().slice(0, 6)}`, kp, [
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: USDC_MAX_XLM,
      destination: kp.publicKey(),
      destAsset: usdcAsset,
      destAmount,
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!))),
    }),
  ]);
}

/**
 * Full cold-start provisioning of an already-generated throwaway payer: fund
 * via friendbot, open a USDC trustline, buy USDC on the DEX.
 *
 * Takes the Keypair as a parameter rather than generating one itself so the
 * caller (app/api/pay/route.ts) can run its payer !== payTo security
 * assertion on the address BEFORE any funds move — provisioning is the first
 * step that actually touches the network on the payer's behalf.
 */
export async function provisionThrowawayPayer(kp: Keypair): Promise<void> {
  await fundAndWait(kp.publicKey());
  await openUsdcTrustline(kp);
  await buyUsdcOnDex(kp);
}
