// Initializes the WebMCP polyfill so document.modelContext exists in any
// current browser, per usewebmcp's own documented quick-start:
//   import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
//   initializeWebMCPPolyfill();
// Called once, at module load, before any useWebMCP() hook registers a tool.
// Safe to import from a client component; this module does nothing in a
// server rendering pass (initializeWebMCPPolyfill no-ops without `window`).
"use client";

import { initializeWebMCPPolyfill } from "@mcp-b/webmcp-polyfill";

if (typeof window !== "undefined") {
  initializeWebMCPPolyfill();
}
