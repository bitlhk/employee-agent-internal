import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRevocationStore } from "./session-revocations";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("session revocation store", () => {
  it("revokes a jti until its JWT expiry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ea-revocations-"));
    roots.push(root);
    const store = new SessionRevocationStore(path.join(root, "revoked.json"));
    store.revoke("jti-1", 2000, 1000);
    expect(store.isRevoked("jti-1", 1500)).toBe(true);
    expect(store.isRevoked("jti-1", 2001)).toBe(false);
  });
});
