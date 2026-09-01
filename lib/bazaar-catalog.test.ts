import { describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES, dedupeToolNames } from "./bazaar-catalog";

describe("dedupeToolNames", () => {
  it("returns names unchanged when there is no collision", () => {
    const specs = [{ name: "call_weather" }, { name: "call_hash" }, { name: "call_uuid" }];

    const result = dedupeToolNames(specs);

    expect(result.map((s) => s.name)).toEqual(["call_weather", "call_hash", "call_uuid"]);
  });

  it("suffixes the second occurrence of a single collision with _2", () => {
    const specs = [{ name: "call_weather" }, { name: "call_weather" }];

    const result = dedupeToolNames(specs);

    expect(result.map((s) => s.name)).toEqual(["call_weather", "call_weather_2"]);
  });

  it("suffixes _2, _3, _4 in sequence for multiple collisions of the same name", () => {
    const specs = [{ name: "call_quote" }, { name: "call_quote" }, { name: "call_quote" }, { name: "call_quote" }];

    const result = dedupeToolNames(specs);

    expect(result.map((s) => s.name)).toEqual(["call_quote", "call_quote_2", "call_quote_3", "call_quote_4"]);
  });

  it("suffixes a dynamic tool whose derived name collides with a core tool name", () => {
    const specs = [{ name: "search_vellar_bazaar" }, { name: "pay_and_call" }, { name: "check_vellar_earnings" }];

    const result = dedupeToolNames(specs);

    // Every entry collides with a reserved core tool name (the default
    // reservedNames), so every one gets suffixed — none can keep the bare
    // core tool name, since that would register a second WebMCP tool under
    // a name already claimed by app/page.tsx's static useWebMCP calls.
    expect(result.map((s) => s.name)).toEqual(["search_vellar_bazaar_2", "pay_and_call_2", "check_vellar_earnings_2"]);
  });

  it("does not mutate its input array or the input objects", () => {
    const specs = [{ name: "call_weather" }, { name: "call_weather" }];
    const specsCopy = specs.map((s) => ({ ...s }));

    dedupeToolNames(specs);

    expect(specs).toEqual(specsCopy);
  });

  it("preserves every other field on each spec, changing only name", () => {
    const specs = [
      { name: "call_quote", title: "Quote", resourceUrl: "https://a.example/quote" },
      { name: "call_quote", title: "Quote", resourceUrl: "https://b.example/quote" },
    ];

    const result = dedupeToolNames(specs);

    expect(result[1]).toEqual({ name: "call_quote_2", title: "Quote", resourceUrl: "https://b.example/quote" });
  });

  it("accepts a custom reservedNames list instead of the default core tool names", () => {
    const specs = [{ name: "custom_reserved" }];

    const result = dedupeToolNames(specs, ["custom_reserved"]);

    expect(result.map((s) => s.name)).toEqual(["custom_reserved_2"]);
  });

  it("exposes exactly the 3 known core tool names as its default reserved list", () => {
    expect(CORE_TOOL_NAMES).toEqual(["search_vellar_bazaar", "pay_and_call", "check_vellar_earnings"]);
  });
});
