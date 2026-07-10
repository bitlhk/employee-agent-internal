/**
 * 岗位智能体协作 V2 - Coop Session 数据层
 * 
 * 设计：一个 coop session = N 条 claw_collab_requests（以 sessionId 串起来）
 * - 老 1:1 协作（collab_requests.sessionId IS NULL）零影响
 * - 新 N 人协作（sessionId 存在）走这里
 */
import { and, eq, desc, sql, inArray, ne } from 'drizzle-orm';
import {
  lxCoopSessions,
  lxCoopEvents,
  clawCollabRequests,
  clawAdoptions,
  users,
  lxGroups,
  lxCollabUserProfiles,
} from "../../drizzle/schema";
import { getDb } from "./connection";
import { canCollaborate, canViewCoopSession, requireActiveCoopProfile } from "./coop-identity";

function genShortId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export type CreateCoopSessionParams = {
  creatorUserId: number;
  creatorAdoptId: string;
  title: string;
  originMessage: string;
  consolidationPromptPreset?: string | null;
  members: Array<{
    userId: number;
    targetAdoptId: string;
    subtask: string;
    taskType?: string;
  }>;
};

/**
 * 创建一个 coop session + N 条 claw_collab_requests。
 * 群聊式协作里，真实用户的 pending 表示“已入群但未回复”，不再表示待批准。
 */
export async function createCoopSession(params: CreateCoopSessionParams) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const creatorProfile = await requireActiveCoopProfile(params.creatorUserId);
  if (!creatorProfile.ok || !creatorProfile.value.spaceId) {
    const reason = !creatorProfile.ok ? creatorProfile.error.kind : "space_missing";
    throw new Error(`forbidden: creator collaboration profile is not active (${reason})`);
  }

  for (const member of params.members) {
    const isAuto = await isAutoAgentUser(member.userId);
    if (isAuto) continue;
    const allowed = await canCollaborate(params.creatorUserId, member.userId);
    if (!allowed.ok) {
      throw new Error(`forbidden: user ${member.userId} cannot collaborate with ${params.creatorUserId} (${allowed.error.kind})`);
    }
  }

  const sessionId = "cs-" + genShortId();

  // 1) 父 session
  await db.insert(lxCoopSessions).values({
    id: sessionId,
    creatorUserId: params.creatorUserId,
    spaceId: creatorProfile.value.spaceId,
    creatorAdoptId: params.creatorAdoptId,
    title: params.title,
    originMessage: params.originMessage,
    consolidationPromptPreset: params.consolidationPromptPreset?.trim() || null,
    status: "running",
    memberCount: params.members.length,
  });

  // 2) session_created event
  await db.insert(lxCoopEvents).values({
    sessionId,
    eventType: "session_created",
    actorUserId: params.creatorUserId,
    actorAdoptId: params.creatorAdoptId,
    payload: JSON.stringify({
      title: params.title,
      memberCount: params.members.length,
    }),
  });

  // 3) 每个成员一条 request + member_invited 事件
  //    auto-mode (email @lingxia.local) 直接 approved
  const requestIds: number[] = [];
  const autoApprovedReqIds: number[] = [];
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    const isAuto = await isAutoAgentUser(m.userId);
    const initialStatus = isAuto ? "approved" : "pending";
    const inserted = await db.insert(clawCollabRequests).values({
      sessionId,
      subtaskIndex: i,
      requesterAdoptId: params.creatorAdoptId,
      targetAdoptId: m.targetAdoptId,
      requesterUserId: params.creatorUserId,
      targetUserId: m.userId,
      taskType: m.taskType || "general",
      taskSummary: m.subtask,
      status: initialStatus,
      approvalMode: isAuto ? "auto" : "manual",
      approvedAt: isAuto ? new Date() : null,
      approvedBy: isAuto ? m.userId : null,
      riskLevel: "low",
    });
    const reqId = Number((inserted as any)[0]?.insertId ?? (inserted as any).insertId ?? 0);
    requestIds.push(reqId);
    if (isAuto) autoApprovedReqIds.push(reqId);

    await db.insert(lxCoopEvents).values({
      sessionId,
      eventType: "member_invited",
      actorUserId: params.creatorUserId,
      actorAdoptId: params.creatorAdoptId,
      requestId: reqId,
      payload: JSON.stringify({
        targetUserId: m.userId,
        targetAdoptId: m.targetAdoptId,
        subtaskIndex: i,
        subtask: m.subtask,
        isAuto,
      }),
    });

    if (isAuto) {
      await db.insert(lxCoopEvents).values({
        sessionId,
        eventType: "member_agreed",
        actorUserId: m.userId,
        actorAdoptId: m.targetAdoptId,
        requestId: reqId,
        payload: JSON.stringify({ auto: true }),
      });
    }
  }

  // 4) 如果有 auto-approved 成员，父 session 立刻进 running 状态
  if (autoApprovedReqIds.length > 0) {
    await db.update(lxCoopSessions).set({ status: "running" }).where(eq(lxCoopSessions.id, sessionId));
    await db.insert(lxCoopEvents).values({
      sessionId,
      eventType: "session_started",
      actorUserId: params.creatorUserId,
      payload: JSON.stringify({ autoStartedCount: autoApprovedReqIds.length }),
    });
    // 异步触发执行，不阻塞 return
    for (const rid of autoApprovedReqIds) {
      startCoopExecution(rid).catch((e) => console.error("[coop-exec] startup failed:", e));
    }
  }

  return { sessionId, requestIds };
}

/**
 * 查 session 详情（含成员、事件、权限）
 * 返回 null 表示不存在或无权限（上层抛 NOT_FOUND 即可）
 */
export async function getCoopSession(sessionId: string, viewerUserId: number) {
  const db = await getDb();
  if (!db) return null;

  const access = await canViewCoopSession(viewerUserId, sessionId);
  if (!access.ok) return null;

  const sessionRows = await db
    .select()
    .from(lxCoopSessions)
    .where(eq(lxCoopSessions.id, sessionId))
    .limit(1);
  const session = sessionRows[0];
  if (!session) return null;

  const creatorRows = await db
    .select({
      creatorUserName: sql<string | null>`COALESCE(${lxCollabUserProfiles.realName}, ${users.name}, ${users.email})`,
      creatorEmail: users.email,
    })
    .from(users)
    .leftJoin(lxCollabUserProfiles, eq(lxCollabUserProfiles.userId, users.id))
    .where(eq(users.id, session.creatorUserId))
    .limit(1);
  const creator = creatorRows[0] || null;

  const members = await db
    .select({
      requestId: clawCollabRequests.id,
      subtaskIndex: clawCollabRequests.subtaskIndex,
      targetUserId: clawCollabRequests.targetUserId,
      targetAdoptId: clawCollabRequests.targetAdoptId,
      taskSummary: clawCollabRequests.taskSummary,
      status: clawCollabRequests.status,
      resultSummary: clawCollabRequests.resultSummary,
      resultVisibleToAll: clawCollabRequests.resultVisibleToAll,
      completedAt: clawCollabRequests.completedAt,
      targetUserName: sql<string | null>`COALESCE(${lxCollabUserProfiles.realName}, ${users.name}, ${users.email})`,
      targetEmail: users.email,
      targetGroupId: users.groupId,
      targetGroupName: lxGroups.name,
      targetOrgName: sql<string | null>`COALESCE(${lxCollabUserProfiles.organizationName}, ${users.organization})`,
      targetDepartmentName: lxCollabUserProfiles.departmentName,
      targetTeamName: lxCollabUserProfiles.teamName,
      targetRoleTemplate: sql<string | null>`NULL`,
    })
    .from(clawCollabRequests)
    .leftJoin(users, eq(users.id, clawCollabRequests.targetUserId))
    .leftJoin(lxCollabUserProfiles, eq(lxCollabUserProfiles.userId, clawCollabRequests.targetUserId))
    .leftJoin(lxGroups, eq(lxGroups.id, users.groupId))
    .where(eq(clawCollabRequests.sessionId, sessionId))
    .orderBy(clawCollabRequests.subtaskIndex);

  const isCreator = session.creatorUserId === viewerUserId;
  const isMember = members.some((m) => m.targetUserId === viewerUserId);

  const events = await db
    .select()
    .from(lxCoopEvents)
    .where(eq(lxCoopEvents.sessionId, sessionId))
    .orderBy(desc(lxCoopEvents.createdAt))
    .limit(200);

  return {
    session,
    creator: {
      userId: session.creatorUserId,
      name: creator?.creatorUserName || creator?.creatorEmail || null,
      email: creator?.creatorEmail || null,
    },
    members,
    events: events.reverse(),
    viewerRole: access.value.role as "creator" | "member" | "admin",
    viewerUserId: viewerUserId,
    viewerIsCreator: isCreator,
    viewerIsMember: isMember,
  };
}

/**
 * 侧栏红点：需要我处理的 coop 数量
 * - pendingMyApproval: 我被邀请且未响应
 * - awaitingMyConsolidation: 我发起的 session 且有成员已提交待汇总
 */
export async function countPendingCoop(userId: number) {
  const db = await getDb();
  if (!db) return { pendingMyApproval: 0, awaitingMyConsolidation: 0 };

  try {
    // 2026-04-17: pendingCount 也要过滤掉 deleted_at + 我隐藏的，否则红点跟列表不一致
    const [pendingApproval] = await db
      .select({ c: sql<number>`count(*)` })
      .from(clawCollabRequests)
      .innerJoin(lxCoopSessions, eq(lxCoopSessions.id, clawCollabRequests.sessionId))
      .where(
        and(
          eq(clawCollabRequests.targetUserId, userId),
          eq(clawCollabRequests.status, "pending"),
          sql`${clawCollabRequests.sessionId} IS NOT NULL`,
          sql`lx_coop_sessions.deleted_at IS NULL`,
          sql`NOT EXISTS (SELECT 1 FROM lx_coop_user_hidden h WHERE h.user_id = ${userId} AND h.session_id = lx_coop_sessions.id)`
        )
      );

    const [awaitingCons] = await db
      .select({ c: sql<number>`count(distinct ${lxCoopSessions.id})` })
      .from(lxCoopSessions)
      .innerJoin(clawCollabRequests, eq(clawCollabRequests.sessionId, lxCoopSessions.id))
      .where(
        and(
          eq(lxCoopSessions.creatorUserId, userId),
          inArray(lxCoopSessions.status, ["running", "consolidating"]),
          eq(clawCollabRequests.status, "completed"),
          sql`lx_coop_sessions.deleted_at IS NULL`,
          sql`NOT EXISTS (SELECT 1 FROM lx_coop_user_hidden h WHERE h.user_id = ${userId} AND h.session_id = lx_coop_sessions.id)`
        )
      );

    return {
      pendingMyApproval: Number(pendingApproval?.c || 0),
      awaitingMyConsolidation: Number(awaitingCons?.c || 0),
    };
  } catch (err) {
    console.error("[coop] countPendingCoop failed:", err);
    return { pendingMyApproval: 0, awaitingMyConsolidation: 0 };
  }
}

/**
 * @user mention 候选池
 * - 仅返回 lx_collab_user_profiles.status = 'active' 的用户
 * - 通过 collaboration space 过滤跨 space / null space
 * - 带活跃 adoption 的会返回 adoptId，没活跃 adoption 的 adoptId 为 null
 * - 旧 users.groupId 仅作为展示字段，不再参与权限判断
 */
export async function listMentionCandidates(params: {
  viewerUserId: number;
  keyword?: string;
  groupId?: number;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  try {
    const viewerProfile = await requireActiveCoopProfile(params.viewerUserId);
    if (!viewerProfile.ok || !viewerProfile.value.spaceId) return [];

    let rows = await db
      .select({
        userId: users.id,
        userEmail: users.email,
        groupId: users.groupId,
        groupName: lxGroups.name,
        orgName: sql<string | null>`COALESCE(${lxCollabUserProfiles.organizationName}, ${users.organization})`,
        departmentName: lxCollabUserProfiles.departmentName,
        teamName: lxCollabUserProfiles.teamName,
        userName: sql<string | null>`COALESCE(${lxCollabUserProfiles.realName}, ${users.name}, ${users.email})`,
        adoptId: clawAdoptions.adoptId,
        agentRoleTemplate: clawAdoptions.roleTemplate,
        adoptionId: clawAdoptions.id,
        adoptionStatus: clawAdoptions.status,
      })
      .from(users)
      .leftJoin(lxGroups, eq(lxGroups.id, users.groupId))
      .innerJoin(
        lxCollabUserProfiles,
        and(
          eq(lxCollabUserProfiles.userId, users.id),
          eq(lxCollabUserProfiles.status, 'active'),
          eq(lxCollabUserProfiles.spaceId, viewerProfile.value.spaceId),
        )
      )
      .leftJoin(
        clawAdoptions,
        and(
          eq(clawAdoptions.userId, users.id),
          inArray(clawAdoptions.status, ['creating', 'active', 'expiring']),
          sql`${clawAdoptions.adoptId} LIKE 'lgj-%'`
        )
      )
      .where(ne(users.id, params.viewerUserId))
      .limit(Math.max(limit * 4, 50));

    if (params.keyword?.trim()) {
      const q = params.keyword.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.userName || "").toLowerCase().includes(q) ||
          (r.userEmail || "").toLowerCase().includes(q) ||
          (r.groupName || "").toLowerCase().includes(q) ||
          (r.orgName || "").toLowerCase().includes(q) ||
          (r.departmentName || "").toLowerCase().includes(q) ||
          (r.teamName || "").toLowerCase().includes(q)
      );
    }
    if (params.groupId !== undefined && params.groupId !== null) {
      rows = rows.filter((r) => r.groupId === params.groupId);
    }

    const byUserId = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
      const current = byUserId.get(row.userId);
      if (!current || (!current.adoptId && row.adoptId)) {
        byUserId.set(row.userId, row);
      }
    }

    return Array.from(byUserId.values()).slice(0, limit);
  } catch (err) {
    console.error("[coop] listMentionCandidates failed:", err);
    return [];
  }
}


// ──────────── 邀请响应类 mutation 辅助 ─────────────

/**
 * 通用：追加一条事件
 */
export async function appendCoopEvent(params: {
  sessionId: string;
  eventType: string;
  actorUserId: number;
  actorAdoptId?: string | null;
  requestId?: number | null;
  payload?: any;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(lxCoopEvents).values({
    sessionId: params.sessionId,
    eventType: params.eventType,
    actorUserId: params.actorUserId,
    actorAdoptId: params.actorAdoptId ?? null,
    requestId: params.requestId ?? null,
    payload: params.payload ? JSON.stringify(params.payload) : null,
  });
}

/**
 * 读取单条 request + 其所属 session（权限验证用）
 */
export async function getCoopRequestWithSession(requestId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({
      req: clawCollabRequests,
      session: lxCoopSessions,
    })
    .from(clawCollabRequests)
    .leftJoin(lxCoopSessions, eq(lxCoopSessions.id, clawCollabRequests.sessionId))
    .where(eq(clawCollabRequests.id, requestId))
    .limit(1);
  return rows[0] || null;
}

/**
 * 被邀请者：同意（可带修改后的子任务）
 */
export async function agreeCoopRequest(params: {
  requestId: number;
  userId: number;
  modifiedSubtask?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const r = await getCoopRequestWithSession(params.requestId);
  if (!r || !r.req || !r.session) throw new Error("request or session not found");
  if (r.req.targetUserId !== params.userId) throw new Error("forbidden: not your invitation");
  if (r.req.status !== "pending") throw new Error(`cannot agree on status=${r.req.status}`);

  const patch: any = {
    status: "approved",
    approvedAt: new Date(),
    approvedBy: params.userId,
  };
  if (params.modifiedSubtask && params.modifiedSubtask !== r.req.taskSummary) {
    patch.taskSummary = params.modifiedSubtask;
  }

  await db.update(clawCollabRequests).set(patch).where(eq(clawCollabRequests.id, params.requestId));

  await appendCoopEvent({
    sessionId: r.req.sessionId!,
    eventType: params.modifiedSubtask && params.modifiedSubtask !== r.req.taskSummary ? "member_modified_task" : "member_agreed",
    actorUserId: params.userId,
    actorAdoptId: r.req.targetAdoptId,
    requestId: params.requestId,
    payload: patch.taskSummary ? { modifiedSubtask: patch.taskSummary } : undefined,
  });

  // session 状态流转：全部 approved → running
  const allMembers = await db
    .select({ status: clawCollabRequests.status })
    .from(clawCollabRequests)
    .where(eq(clawCollabRequests.sessionId, r.req.sessionId!));
  const allResponded = allMembers.every((m) => m.status !== "pending");
  const anyApproved = allMembers.some((m) => m.status === "approved" || m.status === "running" || m.status === "completed");
  if (allResponded && anyApproved && r.session.status === "inviting") {
    await db.update(lxCoopSessions).set({ status: "running" }).where(eq(lxCoopSessions.id, r.req.sessionId!));
    await appendCoopEvent({
      sessionId: r.req.sessionId!,
      eventType: "session_started",
      actorUserId: params.userId,
    });
  }

  // Step 4: 同意即开跑（并行，不等其他人）
  // 异步触发，不阻塞 mutation return
  startCoopExecution(params.requestId).catch((e) => console.error("[coop-exec] fire after agree failed:", e));

  return { ok: true, sessionStatusChanged: allResponded && anyApproved };
}

/**
 * 被邀请者：拒绝
 */
export async function rejectCoopRequest(params: {
  requestId: number;
  userId: number;
  reason?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const r = await getCoopRequestWithSession(params.requestId);
  if (!r || !r.req || !r.session) throw new Error("request or session not found");
  if (r.req.targetUserId !== params.userId) throw new Error("forbidden: not your invitation");
  if (r.req.status !== "pending") throw new Error(`cannot reject on status=${r.req.status}`);

  await db.update(clawCollabRequests).set({ status: "rejected", completedAt: new Date() }).where(eq(clawCollabRequests.id, params.requestId));

  await appendCoopEvent({
    sessionId: r.req.sessionId!,
    eventType: "member_rejected",
    actorUserId: params.userId,
    actorAdoptId: r.req.targetAdoptId,
    requestId: params.requestId,
    payload: params.reason ? { reason: params.reason } : undefined,
  });

  // 如果全员拒绝 → session cancel
  const allMembers = await db
    .select({ status: clawCollabRequests.status })
    .from(clawCollabRequests)
    .where(eq(clawCollabRequests.sessionId, r.req.sessionId!));
  const allRejected = allMembers.every((m) => m.status === "rejected");
  if (allRejected && r.session.status === "inviting") {
    await db.update(lxCoopSessions).set({ status: "closed", closedAt: new Date() }).where(eq(lxCoopSessions.id, r.req.sessionId!));
    await appendCoopEvent({
      sessionId: r.req.sessionId!,
      eventType: "session_closed",
      actorUserId: params.userId,
      payload: { reason: "all_members_rejected" },
    });
  }

  return { ok: true };
}

/**
 * 查 session 事件流（用于轮询）
 */
export async function listCoopEventsSince(sessionId: string, sinceId: number = 0, limit: number = 100) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(lxCoopEvents)
    .where(and(eq(lxCoopEvents.sessionId, sessionId), sql`${lxCoopEvents.id} > ${sinceId}`))
    .orderBy(lxCoopEvents.id)
    .limit(Math.min(limit, 500));
  return rows;
}


// ──────────── Step 4: 执行流 ─────────────

// Mock / 自动化 agent 识别：email 后缀白名单
const AUTO_AGENT_EMAIL_SUFFIXES = ["@lingxia.local"];

/**
 * 判断 user 是否是 auto-mode（无须手动同意）
 */
export async function isAutoAgentUser(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const email = rows[0]?.email || "";
  return AUTO_AGENT_EMAIL_SUFFIXES.some((suf) => email.toLowerCase().endsWith(suf));
}

/**
 * 生成 mock agent 的脚本化输出
 * Step 4 MVP：基于 groupName 出模板结果
 * Step 5 将替换为 DeepSeek 真实调用
 */
function generateMockResult(params: {
  targetName: string;
  groupName: string | null;
  subtask: string;
}): string {
  const { targetName, groupName, subtask } = params;
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  
  // 根据 groupName 生成差异化结果
  let detail = "";
  if (groupName?.includes("示例") || groupName?.includes("业务") || groupName?.includes("协作")) {
    detail = `执行结果：
- 已抽取示例业务数据 3562 条
- 识别异常模式 7 组，集中于示例时间窗口
- 数据来源：团队知识库 + 业务数据接口
- 置信度：92%`;
  } else if (groupName?.includes("工具") || groupName?.includes("数据") || groupName?.includes("分析")) {
    detail = `执行结果：
- 完成风险模式分析
- 高风险项 2 条、中风险 5 条
- 建议：加强关键异常项复核
- 生成详细报告 12 页`;
  } else if (groupName?.includes("综合") || groupName?.includes("汇总")) {
    detail = `执行结果：
- 汇总前置成果生成 PPT
- 共 18 页，含 6 个数据图表
- 文件：示例分析报告.pptx
- 样式：标准业务汇报模板`;
  } else {
    detail = `执行结果：
- 已按子任务完成处理
- 产出 1 份分析报告
- 用时约 3.8 秒`;
  }
  
  return `[${targetName}·${groupName || "默认组"}] ${subtask}

${detail}

完成时间：${now}`;
}

/**
 * 启动一个 request 的执行（异步）
 * - 立刻 update status → running + append execution_started event
 * - 5 秒后 update status → completed + fill resultSummary + append execution_completed
 */
export async function startCoopExecution(requestId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const rows = await db
    .select({
      req: clawCollabRequests,
      targetUser: users,
      groupName: lxGroups.name,
    })
    .from(clawCollabRequests)
    .leftJoin(users, eq(users.id, clawCollabRequests.targetUserId))
    .leftJoin(lxGroups, eq(lxGroups.id, users.groupId))
    .where(eq(clawCollabRequests.id, requestId))
    .limit(1);
  const r = rows[0];
  if (!r || !r.req) return;

  // 只对 approved 状态发起执行；已在 running/completed 的跳过
  if (r.req.status !== "approved") {
    console.log(`[coop-exec] skip requestId=${requestId}, status=${r.req.status}`);
    return;
  }

  // 1) 状态转 running + event
  await db.update(clawCollabRequests).set({ status: "running" }).where(eq(clawCollabRequests.id, requestId));
  await appendCoopEvent({
    sessionId: r.req.sessionId!,
    eventType: "execution_started",
    actorUserId: r.req.targetUserId,
    actorAdoptId: r.req.targetAdoptId,
    requestId: requestId,
  });

  // 2026-04-17 手动模式：真人接收方走 CoopChatBox 提交，不自动 mock
  // 仅 @lingxia.local 后缀的 mock user 继续走 5 秒模板自动执行（演示流畅性保留）
  const isAuto = await isAutoAgentUser(r.req.targetUserId);
  if (!isAuto) {
    console.log(`[coop-exec] manual mode: requestId=${requestId} targetUserId=${r.req.targetUserId} 等真人在 CoopChatBox 提交`);
    return; // 不调度 setTimeout mock 跑，等 coop.submitResult endpoint
  }

  // 2) 异步模拟执行（仅 mock user）
  const delayMs = 3000 + Math.floor(Math.random() * 3000); // 3-6s
  setTimeout(async () => {
    try {
      const db2 = await getDb();
      if (!db2) return;
      const result = generateMockResult({
        targetName: r.targetUser?.name || "未知成员",
        groupName: r.groupName,
        subtask: r.req.taskSummary || "",
      });
      await db2
        .update(clawCollabRequests)
        .set({ status: "completed", resultSummary: result, completedAt: new Date() })
        .where(eq(clawCollabRequests.id, requestId));
      await appendCoopEvent({
        sessionId: r.req.sessionId!,
        eventType: "execution_completed",
        actorUserId: r.req.targetUserId,
        actorAdoptId: r.req.targetAdoptId,
        requestId: requestId,
        payload: { durationMs: delayMs, resultPreview: result.slice(0, 120) },
      });
      console.log(`[coop-exec] completed requestId=${requestId} after ${delayMs}ms`);
    } catch (e) {
      console.error(`[coop-exec] simulate execution failed for ${requestId}:`, e);
      const db2 = await getDb();
      if (db2) {
        await db2
          .update(clawCollabRequests)
          .set({ status: "failed" })
          .where(eq(clawCollabRequests.id, requestId));
        await appendCoopEvent({
          sessionId: r.req.sessionId!,
          eventType: "execution_failed",
          actorUserId: r.req.targetUserId,
          requestId: requestId,
          payload: { error: String(e) },
        });
      }
    }
  }, delayMs);
}


// ──────────── Step 5: 整合 + 发布 + 关闭 ─────────────

/**
 * session 是否已可整合（所有成员都已终态且至少一人 completed）
 */
export function isSessionReadyToConsolidate(members: Array<{ status: string }>): boolean {
  const TERMINAL = new Set(["completed", "rejected", "failed", "cancelled"]);
  const allTerminal = members.every((m) => TERMINAL.has(m.status));
  const anyCompleted = members.some((m) => m.status === "completed");
  return allTerminal && anyCompleted;
}

/**
 * 发起人发布最终结果
 * - session.status = published
 * - session.final_summary = ...
 * - 所有成员的 resultVisibleToAll = true
 */
export async function publishCoopSession(params: {
  sessionId: string;
  creatorUserId: number;
  finalSummary: string;
  finalArtifacts?: any[];
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const sessionRows = await db.select().from(lxCoopSessions).where(eq(lxCoopSessions.id, params.sessionId)).limit(1);
  const session = sessionRows[0];
  if (!session) throw new Error("session not found");
  if (session.creatorUserId !== params.creatorUserId) throw new Error("forbidden: only creator can publish");
  if (session.status === "published") throw new Error("already published");
  if (session.status === "closed" || session.status === "dissolved") throw new Error("cannot publish closed session");

  await db
    .update(lxCoopSessions)
    .set({
      status: "published",
      finalSummary: params.finalSummary,
      finalArtifacts: params.finalArtifacts ? JSON.stringify(params.finalArtifacts) : null,
      publishedAt: new Date(),
    })
    .where(eq(lxCoopSessions.id, params.sessionId));

  // 所有成员可见
  await db
    .update(clawCollabRequests)
    .set({ resultVisibleToAll: true })
    .where(eq(clawCollabRequests.sessionId, params.sessionId));

  await appendCoopEvent({
    sessionId: params.sessionId,
    eventType: "published",
    actorUserId: params.creatorUserId,
    payload: { summaryPreview: params.finalSummary.slice(0, 200) },
  });

  return { ok: true };
}

/**
 * 关闭 session（解散 or 保留）
 * - mode: "dissolve" → 视为永久关闭（UI 不再展示在我的协作里）
 * - mode: "keep"     → 正常关闭（保留在列表，下次可以基于同一批人发起）
 */
export async function closeCoopSession(params: {
  sessionId: string;
  creatorUserId: number;
  mode: "dissolve" | "keep";
}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const sessionRows = await db.select().from(lxCoopSessions).where(eq(lxCoopSessions.id, params.sessionId)).limit(1);
  const session = sessionRows[0];
  if (!session) throw new Error("session not found");
  if (session.creatorUserId !== params.creatorUserId) throw new Error("forbidden: only creator can close");

  const nextStatus = params.mode === "dissolve" ? "dissolved" : "closed";
  await db.update(lxCoopSessions).set({ status: nextStatus, closedAt: new Date() }).where(eq(lxCoopSessions.id, params.sessionId));

  await appendCoopEvent({
    sessionId: params.sessionId,
    eventType: nextStatus === "dissolved" ? "session_dissolved" : "session_closed",
    actorUserId: params.creatorUserId,
    payload: { mode: params.mode },
  });

  return { ok: true, nextStatus };
}

/**
 * 构造 Orchestrator 输入（从 DB 查出成员 + 结果）
 */
export async function buildOrchestratorInput(sessionId: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const sessRows = await db.select().from(lxCoopSessions).where(eq(lxCoopSessions.id, sessionId)).limit(1);
  const session = sessRows[0];
  if (!session) throw new Error("session not found");

  const members = await db
    .select({
      req: clawCollabRequests,
      userName: sql<string | null>`COALESCE(${lxCollabUserProfiles.realName}, ${users.name}, ${users.email})`,
      groupName: sql<string | null>`COALESCE(${lxCollabUserProfiles.departmentName}, ${lxCollabUserProfiles.teamName}, ${lxGroups.name})`,
    })
    .from(clawCollabRequests)
    .leftJoin(users, eq(users.id, clawCollabRequests.targetUserId))
    .leftJoin(lxCollabUserProfiles, eq(lxCollabUserProfiles.userId, clawCollabRequests.targetUserId))
    .leftJoin(lxGroups, eq(lxGroups.id, users.groupId))
    .where(eq(clawCollabRequests.sessionId, sessionId))
    .orderBy(clawCollabRequests.subtaskIndex);

  // 2026-04-17: 拉每个 requestId 对应的最新 member_completed event 里的 attachments
  // attachments 来自 CoopChatBox 提交时写入的 coop_events.payload
  const reqIds = members.map((m) => m.req.id);
  const attachmentsByReqId = new Map<number, any[]>();
  if (reqIds.length > 0) {
    try {
      const evs = await db
        .select({ requestId: lxCoopEvents.requestId, payload: lxCoopEvents.payload })
        .from(lxCoopEvents)
        .where(and(eq(lxCoopEvents.sessionId, sessionId), eq(lxCoopEvents.eventType, "member_completed")));
      for (const ev of evs) {
        if (!ev.requestId) continue;
        let p: any = ev.payload;
        if (typeof p === "string") {
          try { p = JSON.parse(p); } catch { continue; }
        }
        if (Array.isArray(p?.attachments) && p.attachments.length > 0) {
          attachmentsByReqId.set(Number(ev.requestId), p.attachments);
        }
      }
    } catch (e) {
      console.error("[buildOrchestratorInput] read attachments failed:", e);
    }
  }

  return {
    session,
    members: members.map((m) => ({
      targetName: m.userName || "未知",
      groupName: m.groupName,
      subtask: m.req.taskSummary || "",
      status: m.req.status,
      result: m.req.resultSummary,
      attachments: attachmentsByReqId.get(m.req.id) || [],
    })),
  };
}


/**
 * 列我参与的所有 coop session（发起 + 被邀请）
 * 附带聚合：总成员数 / 已完成数 / pending 数
 */
export async function listMyCoopSessions(userId: number, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];
  // 用原生 SQL 避免多个 subquery 写得复杂
  const rows = await db.execute(sql`
    SELECT 
      s.id, s.title, s.status, s.creator_user_id, s.member_count,
      s.created_at, s.published_at, s.closed_at,
      COALESCE(cup.real_name, cu.name, cu.email) AS creator_name,
      (SELECT COUNT(*) FROM claw_collab_requests WHERE sessionId = s.id) AS total_members,
      (SELECT COUNT(*) FROM claw_collab_requests WHERE sessionId = s.id AND status = 'completed') AS completed_members,
      (SELECT COUNT(*) FROM claw_collab_requests WHERE sessionId = s.id AND status = 'pending') AS pending_members,
      EXISTS(SELECT 1 FROM claw_collab_requests WHERE sessionId = s.id AND targetUserId = ${userId}) AS i_am_member,
      (s.creator_user_id = ${userId}) AS i_am_creator,
      (SELECT status FROM claw_collab_requests WHERE sessionId = s.id AND targetUserId = ${userId} LIMIT 1) AS my_request_status
    FROM lx_coop_sessions s
    LEFT JOIN users cu ON cu.id = s.creator_user_id
    LEFT JOIN lx_collab_user_profiles cup ON cup.user_id = s.creator_user_id
    WHERE s.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM lx_coop_user_hidden h WHERE h.user_id = ${userId} AND h.session_id = s.id)
      AND (s.creator_user_id = ${userId}
           OR EXISTS(SELECT 1 FROM claw_collab_requests WHERE sessionId = s.id AND targetUserId = ${userId}))
    ORDER BY s.created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);
  // mysql2 返回 [rows, fields]; drizzle sql 包装后 rows 就是 array
  const data = (rows as any)[0] || rows;
  if (!Array.isArray(data)) return [];

  const visibleRows = [];
  for (const row of data) {
    const sessionId = String(row.id || "");
    if (!sessionId) continue;
    const access = await canViewCoopSession(userId, sessionId);
    if (access.ok) visibleRows.push(row);
  }
  return visibleRows;
}
