import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestSizeLimiter } from "./security";
import {
  DEFAULT_JSON_LIMIT_BYTES,
  defaultJsonParser,
  defaultUrlencodedParser,
  isLargeJsonUploadRequest,
  largeUploadJsonParser,
  requestEnvelopeLimit,
  sanitizeServerErrorResponses,
} from "./http-boundaries";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl = "";

beforeEach(async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("x-request-id", "request-boundary-test");
    next();
  });
  app.use(sanitizeServerErrorResponses);
  app.use(requestSizeLimiter(requestEnvelopeLimit));
  app.use(largeUploadJsonParser);
  app.use(defaultJsonParser);
  app.use(defaultUrlencodedParser);
  app.post("/api/claw/files/upload", (req, res) => res.json({ length: String(req.body.contentBase64 || "").length }));
  app.post("/api/ordinary", (req, res) => res.json({ length: String(req.body.value || "").length }));
  app.get("/failure", (_req, res) => res.status(500).json({ error: "mysql://secret-host/private", stack: "secret" }));
  app.get("/bad-request", (_req, res) => res.status(400).json({ error: "invalid field" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("HTTP request and error boundaries", () => {
  it("only grants the large JSON budget to explicit upload routes", () => {
    expect(isLargeJsonUploadRequest({ path: "/api/claw/files/upload", originalUrl: "" } as never)).toBe(true);
    expect(isLargeJsonUploadRequest({ path: "/api/ordinary", originalUrl: "" } as never)).toBe(false);
    expect(requestEnvelopeLimit({ path: "/api/ordinary", originalUrl: "" } as never)).toBe(DEFAULT_JSON_LIMIT_BYTES);
  });

  it("accepts a large upload body but rejects the same body on an ordinary API", async () => {
    const body = JSON.stringify({ contentBase64: "a".repeat(DEFAULT_JSON_LIMIT_BYTES + 1024) });
    const upload = await fetch(`${baseUrl}/api/claw/files/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(upload.status).toBe(200);

    const ordinary = await fetch(`${baseUrl}/api/ordinary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "a".repeat(DEFAULT_JSON_LIMIT_BYTES + 1024) }),
    });
    expect(ordinary.status).toBe(413);
  });

  it("replaces every JSON 5xx body with a generic error and request id", async () => {
    const response = await fetch(`${baseUrl}/failure`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "内部服务器错误",
      code: "INTERNAL_ERROR",
      requestId: "request-boundary-test",
    });
    const badRequest = await fetch(`${baseUrl}/bad-request`);
    expect(await badRequest.json()).toEqual({ error: "invalid field" });
  });
});

