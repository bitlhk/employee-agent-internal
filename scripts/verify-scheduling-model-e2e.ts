import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import * as s from "../drizzle/schema";
import { closeDbConnection } from "../server/db/connection";
import { getCalendarCredentials } from "../server/db/scheduling";
import {
  createCollaborationGoal,
  getCollaborationRun,
} from "../server/db/collaboration-runs";
import { assertCollaborationRuntimeReady } from "../server/_core/collaboration/runtime-readiness";
import { startCoordination } from "../server/_core/scheduling/coordination-service";
import { prepareMeeting } from "../server/_core/scheduling/meeting-service";
import { loadOwnMeeting } from "../server/_core/scheduling/meeting-calendar";
import { readOwnCalendar } from "../server/_core/scheduling/calendar";
import { getCascade } from "../server/db/calendar-cascades";
import { meetingPayloadSchema } from "../shared/scheduling";
import {
  cleanupDemoScenario,
  createDemoAssistants,
  ensureThirdDemoUser,
  localFixtureDatabase,
  ownerRpc,
} from "./scheduling-e2e-fixture";

// Real model + actual managed workers + HTTP owner confirmation + local CalDAV.
// Only setup/owner decisions/assertions/cleanup live here; no executor mocks,
// synthesized assistant replies, direct recovery ticks or forced success states.
async function main() {
  const db = await localFixtureDatabase();
  await assertCollaborationRuntimeReady();
  const c = await ensureThirdDemoUser(db);
  const ownerIds = [2, 3, c];
  const cleanupPrefix = process.argv
    .find(a => a.startsWith("--cleanup-prefix="))
    ?.slice(17);
  if (cleanupPrefix) {
    const adoptions = await db.select().from(s.clawAdoptions);
    await cleanupDemoScenario(
      db,
      cleanupPrefix,
      adoptions
        .filter(a => a.adoptId.startsWith(`lgj-eval-${cleanupPrefix}-`))
        .map(a => a.adoptId),
      ownerIds
    );
    console.log("Controlled scenario cleaned");
    return;
  }
  const prefix = `model-e2e-${randomUUID().slice(0, 8)}`;
  const privateTitle = `${prefix}-PRIVATE-${randomUUID().slice(0, 8)}`;
  const bindings = await db
    .select()
    .from(s.calendarBindings)
    .where(inArray(s.calendarBindings.userId, ownerIds));
  const adoptIds: string[] = [];
  const date = new Date(
    Date.now() + (40 + Math.floor(Math.random() * 100)) * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  const slot = (h: number) => ({
    start: `${date}T${h}:00:00+08:00`,
    end: `${date}T${h}:30:00+08:00`,
  });
  const event = (h: number, suffix: string) => ({
    title: `${privateTitle}-${suffix}`,
    location: "controlled local acceptance",
    time: { type: "timed" as const, ...slot(h) },
  });
  const observed: Array<Record<string, unknown>> = [];
  const log = (value: Record<string, unknown>) => {
    observed.push({ at: new Date().toISOString(), ...value });
    console.log(JSON.stringify(observed.at(-1)));
  };
  let succeeded = false;
  try {
    await db
      .update(s.calendarBindings)
      .set({
        enabled: true,
        discoverable: true,
        autoAvailability: true,
        writeEnabled: true,
        timeZone: "Asia/Shanghai",
      })
      .where(inArray(s.calendarBindings.userId, ownerIds));
    const assistants = await createDemoAssistants(db, ownerIds, prefix);
    adoptIds.push(...assistants.map(a => a.adoptId));
    const meetings: string[] = [];
    for (const hour of [10, 11]) {
      const coordination = await startCoordination(3, {
        requestKey: randomUUID(),
        title: event(hour, String(hour)).title,
        participantIds: [c],
        slots: [slot(hour)],
      });
      assert.deepEqual(coordination.commonIndices, [0]);
      const draft = await prepareMeeting(
        3,
        coordination.id,
        0,
        "controlled local acceptance"
      );
      await ownerRpc(3, "confirmMeeting", { meetingId: draft.meetingId });
      meetings.push(draft.meetingId);
    }
    const credsB = (await getCalendarCredentials(3))!;
    const original = await Promise.all(
      meetings.map(id => loadOwnMeeting(3, credsB, id))
    );
    assert(original.every(Boolean));
    const objective = [
      `本地受控日程验收。请安排我（日程演示用户A）与日程演示用户B在北京时间${date}10:00至10:30的会议，标题必须为${prefix}，地点controlled local acceptance。`,
      `先通过search_collaboration_people按姓名定位B，并发送一次独立scheduling协作，只问${JSON.stringify(slot(10))}当前有无空闲，不要求改期。保存检查点等待答复。`,
      `若B当前忙，再发送第二次独立scheduling协作，请B自行处理冲突：本次受控测试中B本人组织的两场会议占用10:00和11:00，建议10:00那场挪到11:00、11:00那场挪到12:00。B必须自行查询核实自己的会议标识与参与人，先用search_collaboration_people找到日程验收用户C并发独立请求，询问${date}11:00至11:30和12:00至12:30是否可用，然后准备title=${prefix}的两步级联改期方案，等待B本人确认执行完成，再重新查询自己的10:00忙闲并答复你。`,
      "你的第二次请求要把上述协商要求清楚告知B，但summary不要超过500字；B内部找谁和怎么沟通是B自己的事，不要查询其内部进度或索取私人会议细节。每次新提议用新UUID requestKey，不要循环发请求或轮询。用checkpoint_collaboration_goal保存下一步与已发送请求编号并结束等待。",
      "只有B回复10:00实际available后，才用search_scheduling_people找B的userId，coordinate_meeting_times复核这个时段，prepare_meeting_invitation准备本人会议，等待A本人在确认页面确认。实际邀请成功后，finish_collaboration_goal附自己meeting成功回执。不要自己调用任何确认接口，不要把草稿、条件回复或一次沟通结束当作安排完成。",
    ].join("\n");
    const root = await createCollaborationGoal({
      userId: 2,
      adoptId: adoptIds[0],
      requestKey: randomUUID(),
      taskType: "scheduling",
      expectedEffect: "calendar_write",
      sourceSessionId: `e2e-${randomUUID()}`,
      sourceConversationId: null,
      objective,
    });
    log({
      phase: "started",
      prefix,
      root: root.id,
      date,
      model: "configured-runtime-model",
      worker: "backend-managed",
    });
    const deadline = Date.now() + 15 * 60_000;
    let cascadeId: string | undefined;
    let cascadeConfirmed = false;
    let aConfirmed: string | undefined;
    let previous = "";
    while (Date.now() < deadline) {
      const runs = await db
        .select()
        .from(s.collaborationRuns)
        .where(inArray(s.collaborationRuns.adoptId, adoptIds));
      const requests = await db
        .select()
        .from(s.clawCollabRequests)
        .where(inArray(s.clawCollabRequests.requesterAdoptId, adoptIds));
      const plans = await db
        .select()
        .from(s.calendarCascades)
        .where(
          and(
            eq(s.calendarCascades.userId, 3),
            eq(s.calendarCascades.title, prefix)
          )
        );
      const aMeetings = await db
        .select()
        .from(s.calendarMeetings)
        .where(eq(s.calendarMeetings.creatorUserId, 2));
      const ownDraft = aMeetings.find(
        m => meetingPayloadSchema.parse(m.payload).event.title === prefix
      );
      const snapshot = JSON.stringify({
        runs: runs.map(r => ({
          id: r.id,
          owner: r.userId,
          kind: r.kind,
          turn: r.turn,
          status: r.status,
        })),
        requests: requests.map(r => ({
          from: r.requesterUserId,
          to: r.targetUserId,
          status: r.status,
        })),
        cascade: plans.map(p => p.status),
        meeting: ownDraft?.status,
      });
      if (snapshot !== previous) {
        log({ phase: "progress", state: JSON.parse(snapshot) });
        previous = snapshot;
      }
      assert(plans.length <= 1, "Duplicate cascade plan");
      if (plans[0] && !cascadeConfirmed) {
        const plan = (await getCascade(3, plans[0].id))!;
        if (
          plan.status === "pending" &&
          requests.some(
            r =>
              r.requesterUserId === 3 &&
              r.targetUserId === c &&
              r.status === "completed"
          )
        ) {
          cascadeId = plan.id;
          assert.equal(plan.steps.length, 2);
          assert.deepEqual(
            new Set(plan.steps.map(step => step.meetingId)),
            new Set(meetings)
          );
          assert(
            plan.steps.some(step => step.dependsOn.length > 0),
            "Dependency was not inferred"
          );
          assert(
            requests.some(
              r =>
                r.requesterUserId === 3 &&
                r.targetUserId === c &&
                r.status === "completed"
            ),
            "B must negotiate with C through a real completed exchange first"
          );
          await ownerRpc(
            null,
            "confirmCascade",
            { id: plan.id, planHash: plan.planHash },
            true
          );
          await ownerRpc(
            2,
            "confirmCascade",
            { id: plan.id, planHash: plan.planHash },
            true
          );
          await ownerRpc(
            3,
            "confirmCascade",
            { id: plan.id, planHash: "0".repeat(64) },
            true
          );
          log({ phase: "owner-B-review-pending", cascadeId, holdSeconds: 35 });
          // At least one managed scheduling tick: pending drafts must stay inert.
          // Also permits a host restart during acceptance without losing waits.
          await new Promise(resolve => setTimeout(resolve, 35_000));
          assert.equal((await getCascade(3, plan.id))!.status, "pending");
          for (const [i, id] of meetings.entries())
            assert.equal(
              (await loadOwnMeeting(3, credsB, id))!.version,
              original[i]!.version,
              "Unconfirmed plan changed calendar"
            );
          await ownerRpc(3, "confirmCascade", {
            id: plan.id,
            planHash: plan.planHash,
          });
          cascadeConfirmed = true;
          log({ phase: "owner-B-confirmed", cascadeId });
        }
      }
      if (ownDraft?.status === "pending" && !aConfirmed) {
        assert(cascadeConfirmed && cascadeId);
        assert.equal((await getCascade(3, cascadeId))!.status, "completed");
        assert.notEqual(
          (await getCollaborationRun(root.id))!.status,
          "completed",
          "Goal completed before owner's write confirmation"
        );
        await ownerRpc(3, "confirmMeeting", { meetingId: ownDraft.id }, true);
        await ownerRpc(2, "confirmMeeting", { meetingId: ownDraft.id });
        aConfirmed = ownDraft.id;
        log({ phase: "owner-A-confirmed", meetingId: aConfirmed });
      }
      const latest = runs.find(r => r.id === root.id)!;
      if (latest.status === "completed") {
        assert(cascadeConfirmed && cascadeId && aConfirmed);
        assert(
          latest.turn >= 3,
          "Requester did not resume across result and confirmation waits"
        );
        assert.equal((await getCascade(3, cascadeId))!.status, "completed");
        const exchanges = requests.filter(
          r => r.requesterUserId === 2 && r.targetUserId === 3
        );
        assert(
          exchanges.length >= 2 &&
            exchanges.every(r => r.status === "completed"),
          "Separate proposals must remain separate exchanges"
        );
        assert(
          runs.some(r => r.userId === 3 && r.turn >= 2),
          "Recipient did not resume after delegation and owner confirmation"
        );
        assert(
          runs.some(r => r.userId === c && r.status === "completed"),
          "C did not execute a real recipient turn"
        );
        for (const r of runs.filter(r => r.userId === 2)) {
          const publicText = `${r.checkpoint}\n${r.publicMessage}`;
          assert(
            !publicText.includes(privateTitle) &&
              !publicText.includes(adoptIds[2]),
            "Private downstream information leaked to A"
          );
          for (const child of runs.filter(child => child.userId === c))
            assert(!publicText.includes(child.id));
        }
        for (const exchange of exchanges) {
          assert(!String(exchange.resultSummary).includes(privateTitle));
          const conclusion = JSON.parse(exchange.resultSummary!);
          assert.deepEqual(
            Object.keys(conclusion).sort(),
            ["availability", "calendarChanged", "slots", "validUntil"].sort()
          );
        }
        const bEvents = await readOwnCalendar(3, credsB, {
          start: `${date}T09:00:00+08:00`,
          end: `${date}T14:00:00+08:00`,
        });
        for (const [i, id] of meetings.entries()) {
          const moved = (await loadOwnMeeting(3, credsB, id))!;
          assert.equal(
            moved.component.getFirstPropertyValue("uid"),
            original[i]!.component.getFirstPropertyValue("uid")
          );
          assert.notEqual(moved.version, original[i]!.version);
          const e = bEvents.find(
            e => e.title === event(10 + i, String(10 + i)).title
          )!;
          assert.equal(Date.parse(e.start), Date.parse(slot(11 + i).start));
        }
        const beforeRepeat = (await loadOwnMeeting(3, credsB, meetings[0]))!
          .version;
        const plan = (await getCascade(3, cascadeId))!;
        await ownerRpc(3, "confirmCascade", {
          id: plan.id,
          planHash: plan.planHash,
        });
        assert.equal(
          (await loadOwnMeeting(3, credsB, meetings[0]))!.version,
          beforeRepeat
        );
        const [final] = await db
          .select()
          .from(s.calendarMeetings)
          .where(eq(s.calendarMeetings.id, aConfirmed));
        assert.equal(final.status, "invited");
        assert(
          await loadOwnMeeting(
            2,
            (await getCalendarCredentials(2))!,
            aConfirmed
          )
        );
        succeeded = true;
        log({
          phase: "passed",
          turns: runs.map(r => ({ owner: r.userId, turn: r.turn })),
          exchanges: requests.length,
          checks: [
            "real-model-multi-person",
            "independent-proposals",
            "managed-auto-wake",
            "recipient-resume",
            "authenticated-owner-confirmation",
            "inferred-cascade-order",
            "same-UID-new-ETag",
            "idempotent-confirmation",
            "private-conclusions-only",
            "verified-root-write-receipt",
          ],
        });
        break;
      }
      const paused = runs.filter(r =>
        ["failed", "cancelled", "waiting_user"].includes(r.status)
      );
      if (paused.length)
        throw new Error(
          `Unexpected paused run: ${JSON.stringify(paused.map(r => ({ owner: r.userId, status: r.status, message: r.publicMessage })))}`
        );
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    assert(
      succeeded,
      "Real-model scenario deadline reached without verified completion"
    );
  } finally {
    writeFileSync(
      "logs/scheduling-model-e2e-report.json",
      JSON.stringify({ prefix, succeeded, observed }, null, 2)
    );
    try {
      await cleanupDemoScenario(db, prefix, adoptIds, ownerIds);
      log({ phase: "cleaned", prefix });
      writeFileSync(
        "logs/scheduling-model-e2e-report.json",
        JSON.stringify({ prefix, succeeded, cleaned: true, observed }, null, 2)
      );
    } finally {
      for (const binding of bindings)
        await db
          .update(s.calendarBindings)
          .set({
            enabled: binding.enabled,
            discoverable: binding.discoverable,
            writeEnabled: binding.writeEnabled,
            autoAvailability: binding.autoAvailability,
            timeZone: binding.timeZone,
          })
          .where(eq(s.calendarBindings.userId, binding.userId));
    }
  }
}
main()
  .catch(error => {
    console.error(
      error instanceof Error
        ? error.message
        : "Scheduling model acceptance failed"
    );
    process.exitCode = 1;
  })
  .finally(closeDbConnection);
