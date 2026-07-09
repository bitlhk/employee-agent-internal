import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock the database functions
vi.mock("./db", () => ({
  createRegistration: vi.fn(),
  getRegistrationByEmail: vi.fn(),
  getAllRegistrations: vi.fn(),
  recordVisit: vi.fn(),
  getAllVisitStats: vi.fn(),
  getVisitStatsByScenario: vi.fn(),
  verifyEmailCode: vi.fn(),
}));

import { createRegistration, getRegistrationByEmail, getAllRegistrations, recordVisit, verifyEmailCode } from "./db";

function createMockContext(opts?: { admin?: boolean }): TrpcContext {
  const user: any = opts?.admin
    ? { id: 1, role: "admin", name: "admin", email: "admin@test.com" }
    : null;
  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

describe("registration.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new registration successfully", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    vi.mocked(verifyEmailCode).mockResolvedValue(true);
    vi.mocked(getRegistrationByEmail).mockResolvedValue(undefined);
    vi.mocked(createRegistration).mockResolvedValue(1);

    const result = await caller.registration.create({
      name: "张三",
      company: "测试公司",
      email: "test@example.com",
      verificationCode: "123456",
    });

    expect(result).toEqual({
      success: true,
      registrationId: 1,
      isExisting: false,
    });
    expect(createRegistration).toHaveBeenCalledWith({
      name: "张三",
      company: "测试公司",
      email: "test@example.com",
    });
  });

  it("returns existing registration if email already exists", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    vi.mocked(verifyEmailCode).mockResolvedValue(true);
    vi.mocked(getRegistrationByEmail).mockResolvedValue({
      id: 5,
      name: "张三",
      company: "测试公司",
      email: "test@example.com",
      createdAt: new Date(),
    });

    const result = await caller.registration.create({
      name: "张三",
      company: "测试公司",
      email: "test@example.com",
      verificationCode: "123456",
    });

    expect(result).toEqual({
      success: true,
      registrationId: 5,
      isExisting: true,
    });
    expect(createRegistration).not.toHaveBeenCalled();
  });

  it("validates email format", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.registration.create({
        name: "张三",
        company: "测试公司",
        email: "invalid-email",
      })
    ).rejects.toThrow();
  });

  it("validates required fields", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.registration.create({
        name: "",
        company: "测试公司",
        email: "test@example.com",
      })
    ).rejects.toThrow();
  });
});

describe("visitStats.record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a visit successfully", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    vi.mocked(recordVisit).mockResolvedValue(1);

    const result = await caller.visitStats.record({
      registrationId: 1,
      scenarioId: "acquisition",
      experienceId: "demo-assistant",
      experienceTitle: "岗位助手演示",
    });

    expect(result).toEqual({
      success: true,
      visitId: 1,
    });
    expect(recordVisit).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: 1,
        scenarioId: "acquisition",
        experienceId: "demo-assistant",
        experienceTitle: "岗位助手演示",
      })
    );
  });
});

describe("registration.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all registrations", async () => {
    const ctx = createMockContext({ admin: true });
    const caller = appRouter.createCaller(ctx);

    const mockRegistrations = [
      { id: 1, name: "张三", company: "公司A", email: "a@test.com", createdAt: new Date() },
      { id: 2, name: "李四", company: "公司B", email: "b@test.com", createdAt: new Date() },
    ];

    vi.mocked(getAllRegistrations).mockResolvedValue(mockRegistrations);

    const result = await caller.registration.list();

    expect(result).toEqual(mockRegistrations);
    expect(getAllRegistrations).toHaveBeenCalled();
  });
});
