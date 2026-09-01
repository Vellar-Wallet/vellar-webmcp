// Shared formatting helpers used by more than one WebMCP tool in
// app/page.tsx. Pulled out here rather than duplicated inline per your DRY
// preference — both search_vellar_bazaar and check_vellar_earnings format
// atomic USDC amounts, and both need a defensive fallback for malformed
// upstream data (these are external services this app doesn't control).

/** USDC on Stellar uses 7 decimal places, same constant used throughout
 *  vellar-facilitator's own tooling (run-load-test.js, provision-testnet). */
const USDC_DECIMALS = 7;

/** Formats an atomic USDC amount (a string of integer stroops-like units) as
 *  a human-readable decimal string, e.g. "10000000" -> "1". Returns the raw
 *  input string, unmodified, if it isn't parseable — never throws, since
 *  this only ever renders data from an external service into tool output. */
export function formatAtomicUsdc(atomic: string | number | undefined | null): string {
  if (atomic === undefined || atomic === null) return "0";
  const asString = String(atomic);
  if (!/^\d+$/.test(asString)) return asString;
  const padded = asString.padStart(USDC_DECIMALS + 1, "0");
  const whole = padded.slice(0, -USDC_DECIMALS).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Formats a Vellar Bazaar discovery "accepts" payment requirement into a
 *  short human price string, e.g. "0.1 USDC". Defensive against a missing or
 *  malformed entry (the discovery catalog is external data). */
export function formatPrice(accept: { amount?: string; asset?: string } | undefined): string {
  if (!accept?.amount) return "unknown";
  return `${formatAtomicUsdc(accept.amount)} USDC`;
}

/** Shortens a Stellar address to "GABC…WXYZ" form for compact display. */
export function shortenAddress(address: string | undefined | null): string {
  if (!address || address.length <= 10) return address ?? "unknown";
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
