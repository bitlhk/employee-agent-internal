/**
 * intent-executor.ts — Intent Executor（意图执行器）
 * 
 * 接收已分类的 intent + StreamWriter，执行具体操作。
 * 不做分类（分类在 intent-agent.ts），不关心传输协议（StreamWriter 抽象）。
 */
import path from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import type { StreamWriter } from "./stream-writer";
import { INTERNAL_API_KEY as INTERNAL_KEY } from "./constants";
import type { ChannelId } from "@shared/types/cron";
import type { SkillSource } from "@shared/types/skill";
import { getBoundChannelsForAdopt, type BoundChannel } from "./cron/channel-binding-query";
import { getChannelProvider, normalizeChannelId } from "./cron/channel-provider-registry";
import { normalizeScheduleToolArgs } from "./cron/schedule-intent";
import { INTERNAL_BASE_URL as BASE, sanitizeRelPath } from "./helpers";
import { skillRegistry } from "./skills/skill-registry";
import { parseSkillSourceFiles, sanitizeSkillId, type SkillSourceFile } from "./skills/skill-source";
import { skillStoreGeneratedDir } from "./skills/skill-store";

function channelName(channelId: string): string {
  if (channelId === "wechat" || channelId === "weixin") return "微信";
  if (channelId === "feishu") return "飞书";
  if (channelId === "wecom") return "企业微信";
  return channelId;
}

function findBoundChannel(channels: BoundChannel[], channelId: ChannelId): BoundChannel | undefined {
  return channels.find((channel) => channel.channelId === channelId);
}

async function resolveAdoptUserId(adoptId: string): Promise<number> {
  try {
    const { getClawByAdoptId } = await import("../db");
    const claw = await getClawByAdoptId(adoptId);
    return Number((claw as any)?.userId || 0);
  } catch {
    return 0;
  }
}

function normalizeGeneratedFiles(files: any[]): SkillSourceFile[] {
  const raw = (Array.isArray(files) ? files : [])
    .map((file) => ({
      path: sanitizeRelPath(String(file?.path || "")) || "",
      content: String(file?.content || ""),
    }))
    .filter((file) => file.path && file.content.length > 0);
  const skillMdPaths = raw.map((file) => file.path).filter((p) => p.toLowerCase().endsWith("skill.md"));
  if (skillMdPaths.length !== 1 || skillMdPaths[0].toLowerCase() === "skill.md") return raw;
  const prefix = path.posix.dirname(skillMdPaths[0]);
  return raw
    .filter((file) => file.path === prefix || file.path.startsWith(prefix + "/"))
    .map((file) => ({ path: file.path.slice(prefix.length).replace(/^\/+/, "") || file.path, content: file.content }));
}

async function makeUniqueGeneratedSkillId(adoptId: string, base: string): Promise<string> {
  const rows = await skillRegistry.listSkills(adoptId);
  const existing = new Set(rows.ok ? rows.value.map((skill) => skill.id) : []);
  let id = sanitizeSkillId(base);
  if (!existing.has(id)) return id;
  const suffix = Date.now().toString(36).slice(-6);
  id = sanitizeSkillId(`${id}-${suffix}`);
  let i = 2;
  while (existing.has(id)) id = sanitizeSkillId(`${base}-${suffix}-${i++}`);
  return id;
}

function writeGeneratedSkillSource(sourceDir: string, files: SkillSourceFile[]): void {
  mkdirSync(sourceDir, { recursive: true });
  for (const file of files) {
    const rel = sanitizeRelPath(file.path);
    if (!rel) throw new Error(`非法文件路径: ${file.path}`);
    const target = path.join(sourceDir, rel);
    if (!target.startsWith(sourceDir + path.sep) && target !== sourceDir) {
      throw new Error(`文件路径越界: ${file.path}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, String(file.content || ""), "utf-8");
  }
}

export async function executePlatformIntent(
  adoptId: string,
  intent: any,
  writer: StreamWriter,
): Promise<void> {

  // ── 生成技能 ──
  if (intent.type === "skill_create") {
    const name = String(intent.name || "").trim();
    const description = String(intent.description || "").trim();
    const files = normalizeGeneratedFiles(intent.files || []);
    if (!name || name.length < 2) {
      writer.writeText("⚠️ 技能名称至少需要 2 个字。你想把这个技能叫做什么？\n");
      writer.writeEnd();
      return;
    }
    if (files.length === 0) {
      writer.writeError("技能生成失败：没有生成任何文件");
      return;
    }
    if (!files.some((file) => file.path.toLowerCase() === "skill.md")) {
      writer.writeError("技能生成失败：缺少 SKILL.md");
      return;
    }

    const skillId = await makeUniqueGeneratedSkillId(adoptId, name);
    const sourceDir = skillStoreGeneratedDir(adoptId, skillId);
    try {
      const parsed = parseSkillSourceFiles(files, skillId);
      writeGeneratedSkillSource(sourceDir, files);
      const source: SkillSource = {
        kind: "generated",
        skillId,
        displayName: name,
        description: description || parsed.description,
        sourcePath: sourceDir,
        version: String(parsed.manifest?.version || ""),
      };
      const installed = await skillRegistry.install(adoptId, source);
      if (!installed.ok) {
        rmSync(sourceDir, { recursive: true, force: true });
        writer.writeError(`技能生成失败：${installed.error.detail}`);
        return;
      }
      await skillRegistry.updateScan(adoptId, skillId, {
        warnings: parsed.warnings,
        scannedAt: new Date().toISOString(),
      });
      const reconciled = await skillRegistry.reconcile(adoptId, { skillId });
      if (!reconciled.ok || reconciled.value.failed > 0) {
        writer.writeText(`⚠️ 技能「${name}」已生成，但同步到运行环境失败。已暂存在工作空间，可在「技能」页点击「重新同步」。\n`);
        writer.writeEnd();
        return;
      }
      writer.writeText(`✅ 技能「${name}」已生成并同步，可以直接在对话里使用。\n`);
      if (description || parsed.description) writer.writeText(`\n> ${description || parsed.description}\n`);
      if (parsed.warnings.length > 0) {
        writer.writeText(`\n> 静态扫描提示：${parsed.warnings.slice(0, 3).join("；")}\n`);
      }
      writer.writeEnd();
      return;
    } catch (e: any) {
      rmSync(sourceDir, { recursive: true, force: true });
      writer.writeError(`技能生成失败：${e?.message || String(e)}`);
      return;
    }
  }

  // ── 创建定时任务 ──
  if (intent.type === "schedule_create") {
    const channels = await getBoundChannelsForAdopt(adoptId);
    const scheduleIntent = {
      ...intent,
      channel: intent.channel || (channels.length === 1 ? channels[0].channelId : undefined),
    };
    const normalized = normalizeScheduleToolArgs(scheduleIntent, channels.map((channel) => channel.channelId));
    if (!normalized.ok) {
      writer.writeText(`⚠️ ${normalized.question}\n`);
      writer.writeEnd();
      return;
    }
    const bound = findBoundChannel(channels, normalized.value.channel);
    const job = {
      name: normalized.value.name,
      description: normalized.value.prompt.slice(0, 100),
      enabled: true,
      schedule: normalized.value.schedule,
      prompt: normalized.value.prompt,
      delivery: {
        targets: normalized.value.delivery.targets.map((target) => ({
          ...target,
          targetLabel: bound?.targetLabel || target.targetLabel,
        })),
      },
      meta: { sessionTarget: "isolated" },
    };
    try {
      const resp = await fetch(`${BASE}/api/claw/cron/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": INTERNAL_KEY },
        body: JSON.stringify({ adoptId, job }),
      });
      const data = await resp.json() as any;
      if (!resp.ok) { writer.writeError(`创建失败: ${data?.error || resp.status}`); return; }
      writer.writeText(`✅ **定时任务已创建**\n\n`);
      writer.writeText(`| 项目 | 内容 |\n|------|------|\n`);
      writer.writeText(`| 任务名称 | ${job.name} |\n`);
      writer.writeText(`| 执行内容 | ${job.prompt} |\n`);
      writer.writeText(`| 计划 | ${job.schedule.display} |\n`);
      writer.writeText(`| 推送渠道 | ${channelName(normalized.value.channel)} |\n\n`);
      writer.writeText(`> 可在侧边栏「定时任务」页面管理。\n`);
    } catch (e: any) { writer.writeError(e?.message || String(e)); return; }
    writer.writeEnd();
    return;
  }

  // ── 查询定时任务 ──
  if (intent.type === "schedule_list") {
    try {
      const resp = await fetch(`${BASE}/api/claw/cron/list?adoptId=${encodeURIComponent(adoptId)}`, { headers: { "X-Internal-Key": INTERNAL_KEY } });
      const data = await resp.json() as any;
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      if (jobs.length === 0) {
        writer.writeText("📋 当前没有定时任务。\n\n说「每天 9 点查银行股价发微信」就能创建一个。\n");
      } else {
        // 非 conversation 渠道 Gateway delivery 是 "none"，真实渠道在平台侧 cron-delivery 配置里
        // 优先用侧车配置覆盖，保证列表展示的渠道和真正的投递渠道一致
        let getChannel: ((jobId: string, jobName?: string) => string | undefined) | null = null;
        try {
          const mod = await import("./cron-delivery");
          getChannel = mod.getCronDeliveryChannel?.bind(null, adoptId) ?? null;
        } catch {}
        const chLabel = (ch: string) =>
          ch === "weixin" ? "微信" :
          ch === "wechat" ? "微信" :
          ch === "wecom" ? "企业微信" :
          ch === "feishu" ? "飞书" :
          ch === "webhook" ? "Webhook" :
          ch === "conversation" ? "主聊天" : ch;
        writer.writeText(`📋 **你的定时任务（${jobs.length} 个）**\n\n`);
        writer.writeText(`| # | 名称 | 状态 | 计划 | 渠道 |\n|---|------|------|------|------|\n`);
        jobs.forEach((j: any, i: number) => {
          const status = j.enabled ? "✅ 启用" : "⏸ 暂停";
          const sched = j.schedule?.display || j.schedule?.cronExpr || j.schedule?.expr || (j.schedule?.everyMs ? `每${Math.round(j.schedule.everyMs / 60000)}分钟` : "—");
          const sidecar = getChannel ? getChannel(String(j.id || ""), String(j.name || "")) : undefined;
          const raw = sidecar || j.delivery?.targets?.[0]?.channelId || j.delivery?.to || j.delivery?.channel || "—";
          writer.writeText(`| ${i + 1} | ${j.name || "—"} | ${status} | ${sched} | ${chLabel(raw)} |\n`);
        });
        writer.writeText(`\n> 在侧边栏「定时任务」页面可以编辑或删除。\n`);
      }
    } catch (e: any) { writer.writeError(`查询失败: ${e?.message}`); return; }
    writer.writeEnd();
    return;
  }

  // ── 删除定时任务 ──
  if (intent.type === "schedule_delete") {
    const keyword = String(intent.task_name || "").toLowerCase();
    try {
      const resp = await fetch(`${BASE}/api/claw/cron/list?adoptId=${encodeURIComponent(adoptId)}`, { headers: { "X-Internal-Key": INTERNAL_KEY } });
      const data = await resp.json() as any;
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      const match = jobs.find((j: any) =>
        (j.name || "").toLowerCase().includes(keyword) ||
        (j.description || "").toLowerCase().includes(keyword)
      );
      if (!match) {
        writer.writeText(`❌ 没找到包含「${intent.task_name}」的定时任务。\n\n`);
        if (jobs.length > 0) writer.writeText(`当前任务：${jobs.map((j: any) => j.name).join("、")}\n`);
        writer.writeEnd();
        return;
      }
      const delResp = await fetch(`${BASE}/api/claw/cron/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": INTERNAL_KEY },
        body: JSON.stringify({ adoptId, id: match.id }),
      });
      if (!delResp.ok) {
        const d = await delResp.json() as any;
        writer.writeError(`删除失败: ${d?.error || delResp.status}`);
        return;
      }
      // Gateway 删除成功后清理平台侧的侧车投递配置，避免后续同名任务串联旧渠道
      try {
        const { deleteCronDeliveryConfig } = await import("./cron-delivery");
        await deleteCronDeliveryConfig(adoptId, String(match.id));
      } catch {}
      writer.writeText(`✅ 已删除定时任务「${match.name}」\n`);
    } catch (e: any) { writer.writeError(e?.message || String(e)); return; }
    writer.writeEnd();
    return;
  }

  // ── 查询渠道 ──
  if (intent.type === "channels_query") {
    const channels = await getBoundChannelsForAdopt(adoptId);
    writer.writeText(`📡 **你的可用推送渠道**\n\n`);
    if (channels.length === 0) {
      writer.writeText("- 暂无已绑定频道。请先在侧边栏「频道」绑定微信或飞书。\n");
    }
    for (const ch of channels) {
      writer.writeText(`- ${channelName(ch.channelId)}${ch.targetLabel ? `（${ch.targetLabel}）` : ""}\n`);
    }
    writer.writeText(`\n> 在侧边栏「频道」页面可以绑定更多渠道。\n`);
    writer.writeEnd();
    return;
  }

  // ── 立即发送通知 ──
  if (intent.type === "send") {
    const channel = normalizeChannelId(String(intent.channel || "wechat"));
    const content = String(intent.content || "");
    if (!content) { writer.writeError("发送内容不能为空"); return; }
    if (!channel) { writer.writeError("不支持的频道"); return; }
    const channels = await getBoundChannelsForAdopt(adoptId);
    if (!findBoundChannel(channels, channel)) { writer.writeError(`${channelName(channel)} 未绑定`); return; }
    writer.writeText(`📤 正在发送...\n\n`);
    try {
      const provider = getChannelProvider(channel);
      if (!provider) { writer.writeError(`${channelName(channel)}暂不支持发送`); return; }
      const userId = await resolveAdoptUserId(adoptId);
      const result = await provider.send(
        { adoptId, channelId: channel, userId },
        { text: content, format: "text", metadata: { source: "intent_executor" } },
      );
      if (!result.ok) { writer.writeError(`${channelName(channel)}发送失败: ${result.error.detail || result.error.kind}`); return; }
      writer.writeText(`✅ 已发送到${channelName(channel)}\n`);
    } catch (e: any) {
      writer.writeError(e?.message || String(e));
      return;
    }
    writer.writeEnd();
    return;
  }

  writer.writeText("🤔 识别到平台操作意图但暂不支持，试试换个说法？\n");
  writer.writeEnd();
}
