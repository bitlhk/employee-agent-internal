import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createContext: vi.fn(),
  getClawByAdoptId: vi.fn(),
}));

vi.mock("./context", () => ({ createContext: mocks.createContext }));
vi.mock("../db", () => ({ getClawByAdoptId: mocks.getClawByAdoptId }));

import { invalidateClawOwnerLookup, requireClawOwner } from "./helpers";

function response(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

const request = { path: "/api/claw/test" } as Request;

describe("claw owner lookup cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createContext.mockResolvedValue({ user: { id: 7 } });
  });

  it("reuses an adoption lookup while checking the requester on every call", async () => {
    const adoptId = "lgj-owner-cache-hit";
    invalidateClawOwnerLookup(adoptId);
    mocks.getClawByAdoptId.mockResolvedValue({ adoptId, userId: 7 });

    await expect(requireClawOwner(request, response(), adoptId)).resolves.toMatchObject({ userId: 7 });
    await expect(requireClawOwner(request, response(), adoptId)).resolves.toMatchObject({ userId: 7 });
    expect(mocks.createContext).toHaveBeenCalledTimes(2);
    expect(mocks.getClawByAdoptId).toHaveBeenCalledTimes(1);

    mocks.createContext.mockResolvedValue({ user: { id: 8 } });
    const forbidden = response();
    await expect(requireClawOwner(request, forbidden, adoptId)).resolves.toBeNull();
    expect(forbidden.status).toHaveBeenCalledWith(403);
    expect(mocks.getClawByAdoptId).toHaveBeenCalledTimes(1);
  });

  it("reloads after invalidation and does not cache missing adoptions", async () => {
    const adoptId = "lgj-owner-cache-invalidate";
    invalidateClawOwnerLookup(adoptId);
    mocks.getClawByAdoptId
      .mockResolvedValueOnce({ adoptId, userId: 7 })
      .mockResolvedValueOnce({ adoptId, userId: 8 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ adoptId: `${adoptId}-new`, userId: 8 });

    await expect(requireClawOwner(request, response(), adoptId)).resolves.toMatchObject({ userId: 7 });
    invalidateClawOwnerLookup(adoptId);
    mocks.createContext.mockResolvedValue({ user: { id: 8 } });
    await expect(requireClawOwner(request, response(), adoptId)).resolves.toMatchObject({ userId: 8 });

    const missingId = `${adoptId}-new`;
    await expect(requireClawOwner(request, response(), missingId)).resolves.toBeNull();
    await expect(requireClawOwner(request, response(), missingId)).resolves.toMatchObject({ userId: 8 });
    expect(mocks.getClawByAdoptId).toHaveBeenCalledTimes(4);
  });
});
