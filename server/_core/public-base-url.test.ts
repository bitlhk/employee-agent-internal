import { describe, expect, it } from "vitest";
import { resolvePublicBaseUrl } from "./public-base-url";

describe("public base URL resolution", () => {
  it("prefers the canonical Workforce URL over compatibility variables", () => {
    expect(resolvePublicBaseUrl({
      WORKFORCE_AGENT_PUBLIC_BASE_URL: "https://agent.example.com/",
      LINGXIA_PUBLIC_BASE_URL: "https://legacy.example.com",
      PUBLIC_BASE_URL: "https://public.example.com",
      FRONTEND_URL: "https://frontend.example.com",
    })).toBe("https://agent.example.com");
  });

  it("uses legacy, public, and frontend values in compatibility order", () => {
    expect(resolvePublicBaseUrl({ LINGXIA_PUBLIC_BASE_URL: "https://legacy.example.com/" }))
      .toBe("https://legacy.example.com");
    expect(resolvePublicBaseUrl({ PUBLIC_BASE_URL: "https://public.example.com/" }))
      .toBe("https://public.example.com");
    expect(resolvePublicBaseUrl({ FRONTEND_URL: "https://frontend.example.com/" }))
      .toBe("https://frontend.example.com");
  });

  it("ignores empty values and falls back to localhost", () => {
    expect(resolvePublicBaseUrl({ WORKFORCE_AGENT_PUBLIC_BASE_URL: "  " }))
      .toBe("http://localhost:5180");
  });
});
