// Server-side proxy for check_vellar_earnings. vellar-explorer's
// /payments endpoint sends no Access-Control-Allow-Origin header (confirmed
// by direct testing: a plain curl gets a clean 200 with real data, but the
// same request from the browser is blocked by CORS) — so the browser can
// never call it directly, permanently, not just intermittently. Routing
// through this server-side proxy sidesteps CORS entirely, since CORS is a
// browser enforcement mechanism and does not apply to a server's own fetch.
//
// Same shape as app/api/pay/route.ts's own reasoning for existing at all:
// some calls have to happen server-side, not because of secrets here, but
// because the browser's own security model blocks them.

export const runtime = "nodejs";

const EXPLORER_URL = "https://vellar-explorer.onrender.com";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const payTo = searchParams.get("payTo");
  const limit = searchParams.get("limit") ?? "10";

  if (!payTo) {
    return Response.json({ error: "payTo required" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${EXPLORER_URL}/payments?payTo=${encodeURIComponent(payTo)}&limit=${encodeURIComponent(limit)}`, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    console.error("[api/earnings] request to vellar-explorer failed:", err);
    return Response.json({ error: "explorer_unavailable" }, { status: 502 });
  }

  if (!res.ok) {
    console.error(`[api/earnings] vellar-explorer responded with HTTP ${res.status}`);
    return Response.json({ error: "explorer_unavailable" }, { status: 502 });
  }

  const data = await res.json();
  return Response.json(data);
}
