import { describe, expect, it } from "vitest";
import { normalizeIncomingRequestId, runWithRequestContext, getRequestContext, updateRequestContext } from "./request-context";
import { normalizeMetricRoute, resolveMetricRoute } from "./http-middleware";
import { safeErrorFields } from "./logger";

describe("request observability", () => {
  it("keeps safe request identifiers and replaces unsafe values", () => {
    expect(normalizeIncomingRequestId("request-1234")).toBe("request-1234");
    expect(normalizeIncomingRequestId("bad value")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("updates bounded request context inside AsyncLocalStorage", () => {
    runWithRequestContext({ requestId: "request-1234", method: "GET", route: "/api/test" }, () => {
      updateRequestContext({ userId: 12, runtime: "jiuwenswarm" });
      expect(getRequestContext()).toMatchObject({ userId: 12, runtime: "jiuwenswarm" });
    });
  });

  it("normalizes high-cardinality metric routes", () => {
    expect(normalizeMetricRoute({ baseUrl: "", path: "/api/trpc/claw.me,claw.listSkills" })).toBe("/api/trpc");
    expect(normalizeMetricRoute({ baseUrl: "", path: "/api/knowledge/kb-abcdefgh12345678/doc-abcdefgh12345678" }))
      .toBe("/api/knowledge/:id/:id");
    expect(normalizeMetricRoute({ baseUrl: "", path: "/assets/Home-a1b2.js" })).toBe("/assets/:asset");
    expect(normalizeMetricRoute({ baseUrl: "/api", path: "/users/12345", route: { path: "/users/:id" } }))
      .toBe("/api/users/:id");
    expect(resolveMetricRoute({ baseUrl: "", path: "/random-attacker-path" }, 404))
      .toBe("/__unmatched__");
  });

  it("redacts credentials and personal data from error messages", () => {
    const fields = safeErrorFields(new Error("Bearer abcdefghijklmnopqrstuvwxyz123456 user@example.com"));
    expect(fields.errorMessage).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(fields.errorMessage).not.toContain("user@example.com");
  });
});
