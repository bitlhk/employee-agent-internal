import type { AddressInfo } from "net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  agents: new Map<string, any>(),
}));

vi.mock("../db/agents", () => ({
  listPersonalBusinessAgents: vi.fn(async (context: any) => [...state.agents.values()].filter((agent) => (
    agent.ownerUserId === context.userId
    && agent.ownerAdoptId === context.adoptId
    && !agent.deletedAt
  ))),
  getPersonalBusinessAgent: vi.fn(async (id: string, context: any) => {
    const agent = state.agents.get(id);
    return agent
      && agent.ownerUserId === context.userId
      && agent.ownerAdoptId === context.adoptId
      && !agent.deletedAt
      ? agent
      : undefined;
  }),
  createPersonalBusinessAgent: vi.fn(async (data: any) => {
    state.agents.set(data.id, {
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
  }),
  updatePersonalBusinessAgent: vi.fn(async (id: string, context: any, patch: any) => {
    const agent = state.agents.get(id);
    if (!agent || agent.ownerUserId !== context.userId || agent.ownerAdoptId !== context.adoptId || agent.deletedAt) {
      return undefined;
    }
    const updated = { ...agent, ...patch, updatedAt: new Date() };
    state.agents.set(id, updated);
    return updated;
  }),
  deletePersonalBusinessAgent: vi.fn(async (id: string, context: any) => {
    const agent = state.agents.get(id);
    if (agent && agent.ownerUserId === context.userId && agent.ownerAdoptId === context.adoptId) {
      state.agents.set(id, {
        ...agent,
        enabled: 0,
        apiUrl: null,
        apiToken: null,
        endpointDigest: null,
        deletedAt: new Date(),
      });
    }
  }),
}));

vi.mock("./helpers", () => ({
  requireClawOwner: vi.fn(async (_req: any, res: any, adoptId: string) => {
    if (!/^lgj-(owner|other)$/.test(adoptId)) {
      res.status(404).json({ error: "NOT_FOUND" });
      return null;
    }
    return { adoptId, userId: adoptId === "lgj-owner" ? 1 : 2 };
  }),
}));

vi.mock("./security", () => ({
  strictLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("./audit-events", () => ({
  auditRequest: () => ({}),
  recordAuditBestEffort: vi.fn(async () => null),
}));

vi.mock("./a2a-expert-client", () => ({
  runA2AExpertTask: vi.fn(async () => ({
    text: "连接成功",
    rawEvents: [{
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        kind: "message",
        messageId: "msg-1",
        role: "agent",
        parts: [{ kind: "text", text: "连接成功" }],
      },
    }],
  })),
}));

import { registerPersonalExpertRoutes } from "./personal-experts";

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

async function startServer(): Promise<string> {
  const app = express();
  app.use(express.json());
  registerPersonalExpertRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function jsonRequest(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  return { response, data: await response.json().catch(() => ({})) as any };
}

beforeEach(() => state.agents.clear());

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("personal expert routes", () => {
  it("tests, creates and isolates a personal expert by owner and adoption", async () => {
    const base = await startServer();
    const payload = {
      adoptId: "lgj-owner",
      name: "合同审查专家",
      description: "审查合同风险",
      endpointUrl: "https://agent.example.com/a2a",
      authType: "bearer",
      credential: "test-token",
    };

    const tested = await jsonRequest(base, "/api/claw/personal-experts/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(tested.response.status).toBe(200);

    const created = await jsonRequest(base, "/api/claw/personal-experts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(created.response.status).toBe(201);
    expect(created.data.item.credentialConfigured).toBe(true);
    expect(created.data.item).not.toHaveProperty("apiToken");
    const expertId = String(created.data.item.id);

    const ownerList = await jsonRequest(base, "/api/claw/personal-experts?adoptId=lgj-owner");
    const otherList = await jsonRequest(base, "/api/claw/personal-experts?adoptId=lgj-other");
    expect(ownerList.data.items.map((item: any) => item.id)).toEqual([expertId]);
    expect(otherList.data.items).toEqual([]);

    const forbiddenUpdate = await jsonRequest(base, `/api/claw/personal-experts/${expertId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, adoptId: "lgj-other" }),
    });
    expect(forbiddenUpdate.response.status).toBe(404);

    const removed = await jsonRequest(base, `/api/claw/personal-experts/${expertId}?adoptId=lgj-owner`, { method: "DELETE" });
    expect(removed.response.status).toBe(200);
    expect(state.agents.get(expertId)).toMatchObject({ apiUrl: null, apiToken: null });
    const empty = await jsonRequest(base, "/api/claw/personal-experts?adoptId=lgj-owner");
    expect(empty.data.items).toEqual([]);
  });
});
