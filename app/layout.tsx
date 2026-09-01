import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vellar x402 — Live API Marketplace for AI Agents",
  description: "WebMCP tools exposing the Vellar x402 payment ecosystem to AI agents.",
};

// Fonts ported from vela-wallet's own app/layout.tsx — same two <link> tags,
// same exact families/weights. Cabinet Grotesk isn't on Google Fonts (it's
// served via Fontshare), so this uses plain <link> tags rather than
// next/font/google, matching the source repo's own approach rather than
// approximating it with a different display face.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link
          href="https://api.fontshare.com/v2/css?f[]=clash-display@700,600,500,400&f[]=cabinet-grotesk@800,700,500&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,500;1,600;1,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="lp min-h-full flex flex-col">{children}</body>
    </html>
  );
}
