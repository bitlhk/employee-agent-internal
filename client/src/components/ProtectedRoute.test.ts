import { describe, expect, it } from "vitest";
import { decideRouteAccess } from "./ProtectedRoute";

describe("decideRouteAccess", () => {
  it("waits while authentication is loading", () => {
    expect(decideRouteAccess({
      loading: true,
      authenticated: false,
      adminOnly: false,
      requestedPath: "/admin",
    })).toEqual({ status: "checking" });
  });

  it("preserves the requested path for signed-out users", () => {
    expect(decideRouteAccess({
      loading: false,
      authenticated: false,
      adminOnly: false,
      requestedPath: "/admin?tab=audit",
    })).toEqual({
      status: "redirect",
      destination: "/login?redirect=%2Fadmin%3Ftab%3Daudit",
    });
  });

  it("keeps administrator routes closed to regular users", () => {
    expect(decideRouteAccess({
      loading: false,
      authenticated: true,
      role: "user",
      adminOnly: true,
      requestedPath: "/admin",
    })).toEqual({ status: "redirect", destination: "/" });
  });

  it("grants access when the role requirement is satisfied", () => {
    expect(decideRouteAccess({
      loading: false,
      authenticated: true,
      role: "admin",
      adminOnly: true,
      requestedPath: "/admin",
    })).toEqual({ status: "granted" });
  });
});
