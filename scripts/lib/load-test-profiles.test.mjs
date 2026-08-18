import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserMutationHeaders,
  loadTestProfiles,
  normalizeLoadTestProfiles,
  trpcKnowledgeSearchPath,
} from "./load-test-profiles.mjs";

test("normalizes multiple isolated profiles", () => {
  assert.deepEqual(normalizeLoadTestProfiles([
    { adoptId: "lgj-alpha1", cookie: "session=a", knowledgeBaseId: "kb_enterprise1" },
    { adoptId: "lgj-beta2", cookie: "session=b" },
  ]), [
    { adoptId: "lgj-alpha1", cookie: "session=a", knowledgeBaseId: "kb_enterprise1" },
    { adoptId: "lgj-beta2", cookie: "session=b" },
  ]);
});

test("rejects duplicate identities and malformed credentials", () => {
  assert.throws(() => normalizeLoadTestProfiles([
    { adoptId: "lgj-same1", cookie: "a" },
    { adoptId: "lgj-same1", cookie: "b" },
  ]), /unique/);
  assert.throws(() => normalizeLoadTestProfiles([
    { adoptId: "../owner", cookie: "session" },
  ]), /invalid adoptId/);
  assert.throws(() => normalizeLoadTestProfiles([
    { adoptId: "lgj-valid1", cookie: "" },
  ]), /invalid cookie/);
});

test("accepts a 150-user training cohort and rejects oversized cohorts", () => {
  const profiles = Array.from({ length: 150 }, (_, index) => ({
    adoptId: `lgj-training${String(index + 1).padStart(3, "0")}`,
    cookie: `session=${index + 1}`,
  }));
  assert.equal(normalizeLoadTestProfiles(profiles).length, 150);
  assert.throws(
    () => normalizeLoadTestProfiles(Array.from({ length: 201 }, (_, index) => ({
      adoptId: `lgj-oversized${String(index + 1).padStart(3, "0")}`,
      cookie: `session=${index + 1}`,
    }))),
    /more than 200/,
  );
});

test("preserves a safe role template label for mixed-role reports", () => {
  const [profile] = normalizeLoadTestProfiles([{
    adoptId: "lgj-role0001",
    cookie: "session=test",
    roleTemplate: "insurance-advisor",
  }]);
  assert.equal(profile.roleTemplate, "insurance-advisor");
  assert.throws(() => normalizeLoadTestProfiles([{
    adoptId: "lgj-role0002",
    cookie: "session=test",
    roleTemplate: "insurance advisor",
  }]), /invalid roleTemplate/);
});

test("requires a private credential file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ea-load-profiles-"));
  try {
    const file = path.join(root, "profiles.json");
    await writeFile(file, JSON.stringify([{ adoptId: "lgj-valid1", cookie: "session=a" }]));
    await chmod(file, 0o644);
    await assert.rejects(loadTestProfiles({ profileFile: file }), /chmod 600/);
    await chmod(file, 0o600);
    await assert.doesNotReject(loadTestProfiles({ profileFile: file }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds a bounded tRPC knowledge-search request", () => {
  const requestPath = trpcKnowledgeSearchPath({
    adoptId: "lgj-valid1",
    cookie: "session=a",
    knowledgeBaseId: "kb_enterprise1",
  }, "风险制度", 8);
  const input = JSON.parse(decodeURIComponent(new URL(`http://local${requestPath}`).searchParams.get("input")));
  assert.deepEqual(input, {
    json: {
      adoptId: "lgj-valid1",
      knowledgeBaseId: "kb_enterprise1",
      query: "风险制度",
      limit: 8,
    },
  });
  assert.equal(trpcKnowledgeSearchPath({ adoptId: "lgj-valid1", cookie: "session=a" }), "");
});

test("builds browser-equivalent mutation headers without retaining URL paths", () => {
  assert.deepEqual(browserMutationHeaders("session=a"), {
    "content-type": "application/json",
    cookie: "session=a",
    "sec-fetch-site": "same-origin",
  });
  assert.deepEqual(browserMutationHeaders("session=a", "https://work.example.com/chat"), {
    "content-type": "application/json",
    cookie: "session=a",
    "sec-fetch-site": "same-origin",
    origin: "https://work.example.com",
  });
  assert.throws(
    () => browserMutationHeaders("session=a", "file:///tmp/test"),
    /must use http or https/,
  );
});
