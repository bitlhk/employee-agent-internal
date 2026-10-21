import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRun } from "../../../drizzle/schema";
const grants = vi.hoisted(() => ({
  authority: vi.fn(),
  consent: vi.fn(),
  owner: vi.fn(),
  request: vi.fn(),
  ready: vi.fn(),
  resources: vi.fn(),
  lease: vi.fn(),
}));
vi.mock("../../db", () => ({
  getClawByAdoptId: grants.owner,
  getCollabRequest: grants.request,
}));
vi.mock("./authority", () => ({
  assertCollaborationAuthority: grants.authority,
  CollaborationAuthorityRevoked: class extends Error {},
}));
vi.mock("./consent", () => ({
  assertAutomaticCollaborationConsent: grants.consent,
}));
vi.mock("./resources", () => ({
  assertCollaborationReadyToAnswer: grants.ready,
  collaborationWaitingResources: grants.resources,
}));
vi.mock("../../db/collaboration-runs", () => ({
  runSessionId: (id: string, turn: number) => `ea_collab_${id}_${turn}`,
  validateCollaborationLease: grants.lease,
}));
import {
  collaborationScopeTools,
  validateScopedTool,
  scopedCollaborationForRequest,
} from "./scope";
const run = {
  id: "11111111-1111-4111-8111-111111111111",
  turn: 1,
  userId: 1,
  adoptId: "a",
  taskType: "scheduling",
  kind: "recipient",
  requestId: 42,
} as CollaborationRun;
it("keeps automatic reply continuations from sending new requests or preparing calendar changes", async () => {
  const reply = { ...run, kind: "goal", requestId: null, requestKey: "reply:42" } as CollaborationRun;
  for (const name of ["send_collaboration_request", "prepare_personal_schedule_write", "cancel_collaboration_request"])
    await expect(validateScopedTool(reply, name, {})).rejects.toThrow("仅用于回告");
  await expect(validateScopedTool(reply, "finish_collaboration_goal", {})).resolves.toBeUndefined();
});
beforeEach(() => {
  vi.resetAllMocks();
  grants.owner.mockResolvedValue({
    userId: 1,
    id: 7,
    status: "active",
    permissionProfile: "plus",
  });
  grants.request.mockResolvedValue({
    id: 42,
    targetAdoptId: "a",
    targetUserId: 1,
    status: "approved",
  });
  grants.resources.mockResolvedValue([]);
  grants.lease.mockResolvedValue(run);
});
describe("collaboration capability boundaries", () => {
  it("keeps ordinary calls unchanged and rejects reserved sessions without capabilities", async () => {
    expect(
      await scopedCollaborationForRequest({ headers: {} } as never)
    ).toBeNull();
    await expect(
      scopedCollaborationForRequest({
        headers: { "x-linggan-session-id": `ea_collab_${run.id}` },
      } as never)
    ).rejects.toThrow("凭据");
  });
  it("binds a live lease to the exact session and assistant identity", async () => {
    const headers = {
      "x-ea-collaboration-run-id": run.id,
      "x-linggan-session-id": `ea_collab_${run.id}_1`,
      "x-ea-collaboration-capability": "nonce",
      "x-jiuwen-channel-id": "a",
    };
    expect(await scopedCollaborationForRequest({ headers } as never)).toBe(run);
    await expect(
      scopedCollaborationForRequest({
        headers: { ...headers, "x-jiuwen-channel-id": "b" },
      } as never)
    ).rejects.toThrow("主体");
    await expect(
      scopedCollaborationForRequest({
        headers: { ...headers, "x-linggan-session-id": "other" },
      } as never)
    ).rejects.toThrow("会话");
  });
  it("never permits native commands, memory or other business systems", async () => {
    for (const name of [
      "execute_command",
      "read_file",
      "search_memory",
      "get_customer_profile",
      "coordinate_meeting_times",
      "list_meeting_coordinations",
    ])
      await expect(validateScopedTool(run, name, {})).rejects.toThrow("未授权");
    expect(collaborationScopeTools("general").has("query_own_schedules")).toBe(
      false
    );
  });
  it("rechecks ownership, approval and automatic consent on each call", async () => {
    await validateScopedTool(run, "query_own_schedules", {});
    expect(grants.consent).toHaveBeenCalled();
    grants.owner.mockResolvedValue({ userId: 2 });
    await expect(
      validateScopedTool(run, "query_own_schedules", {})
    ).rejects.toThrow("主体");
    grants.owner.mockResolvedValue({
      userId: 1,
      status: "active",
      permissionProfile: "plus",
    });
    grants.request.mockResolvedValue({
      targetAdoptId: "a",
      targetUserId: 1,
      status: "cancelled",
    });
    await expect(
      validateScopedTool(run, "query_own_schedules", {})
    ).rejects.toThrow("撤销");
  });
  it("cannot answer other exchanges, expand downstream task types or finish the requester's goal", async () => {
    await expect(
      validateScopedTool(run, "reply_collaboration_request", { requestId: 43 })
    ).rejects.toThrow("当前");
    await expect(
      validateScopedTool(run, "send_collaboration_request", { taskType: "crm" })
    ).rejects.toThrow("范围");
    await expect(
      validateScopedTool(run, "finish_collaboration_goal", {})
    ).rejects.toThrow("接收方");
  });
  it("withholds final answers while child work waits and blocks duplicate writes with uncertain receipts", async () => {
    grants.ready.mockRejectedValue(new Error("still waiting"));
    await expect(
      validateScopedTool(run, "reply_collaboration_request", { requestId: 42 })
    ).rejects.toThrow("waiting");
    grants.resources.mockResolvedValue([{ state: "verify_required" }]);
    await expect(
      validateScopedTool(run, "prepare_personal_schedule_write", {})
    ).rejects.toThrow("核实");
    await expect(
      validateScopedTool(run, "checkpoint_collaboration_goal", {})
    ).resolves.toBeUndefined();
  });
});
