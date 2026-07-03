/**
 * memory-store.ts - platform-level user preference memory.
 *
 * Storage format:
 *   - § 分隔的条目
 *   - 字符上限（策展式，满了要替换不能无限加）
 *   - 安全扫描（防 prompt injection）
 *
 * 写入位置：runtime workspace 的 memory/ 目录
 *   /root/.openclaw/workspace-lingganclaw/trial_{adoptId}/memory/user-preferences.md
 *
 * Compatible runtimes can index this file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { renameSync } from "fs";
import { OPENCLAW_HOME } from "./helpers";

// ── 配置 ────────────────────────────────────────────────────────────

const WORKSPACE_BASE = join(OPENCLAW_HOME, "workspace-lingganclaw");
const ENTRY_DELIMITER = "\n§\n";
const MEMORY_CHAR_LIMIT = parseInt(process.env.MEMORY_CHAR_LIMIT || "2200", 10);
const USER_CHAR_LIMIT = parseInt(process.env.MEMORY_USER_CHAR_LIMIT || "1375", 10);

// ── 安全扫描 ────────────────────────────────────────────────────────

const THREAT_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, "read_secrets"],
  [/authorized_keys/i, "ssh_backdoor"],
];

function scanContent(content: string): string | null {
  for (const [pattern, id] of THREAT_PATTERNS) {
    if (pattern.test(content)) return `Blocked: threat pattern `;
  }
  return null;
}

// ── 路径解析 ────────────────────────────────────────────────────────

function resolveMemoryFile(adoptId: string): string {
  return join(WORKSPACE_BASE, `trial_${adoptId}`, "memory", "user-preferences.md");
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── 读写 ────────────────────────────────────────────────────────────

function readEntries(filePath: string): { user: string[]; memory: string[] } {
  if (!existsSync(filePath)) return { user: [], memory: [] };
  try {
    const raw = readFileSync(filePath, "utf-8");
    const userMatch = raw.match(/## User Profile\n([\s\S]*?)(?=\n## Platform Memory|$)/);
    const memMatch = raw.match(/## Platform Memory\n([\s\S]*?)$/);

    const parse = (block: string | undefined): string[] => {
      if (!block) return [];
      return block.split(ENTRY_DELIMITER).map(e => e.trim()).filter(Boolean);
    };

    return {
      user: parse(userMatch?.[1]),
      memory: parse(memMatch?.[1]),
    };
  } catch (e: any) {
    console.warn("[MEMORY-STORE] read error:", e?.message?.slice(0, 80));
    return { user: [], memory: [] };
  }
}

function writeEntries(filePath: string, entries: { user: string[]; memory: string[] }): void {
  ensureDir(filePath);
  const parts: string[] = [
    "# User Preferences",
    "_Auto-extracted by Workforce Agent Platform_",
    "",
  ];

  if (entries.user.length > 0) {
    parts.push("## User Profile");
    parts.push(entries.user.join(ENTRY_DELIMITER));
    parts.push("");
  }

  if (entries.memory.length > 0) {
    parts.push("## Platform Memory");
    parts.push(entries.memory.join(ENTRY_DELIMITER));
    parts.push("");
  }

  // 原子写入：tmpfile + rename
  const tmp = filePath + `.tmp.${Date.now()}`;
  try {
    writeFileSync(tmp, parts.join("\n"), "utf-8");
    renameSync(tmp, filePath);
  } catch (e: any) {
    try { require("fs").unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ── 公开 API ────────────────────────────────────────────────────────

export function charLimit(target: string): number {
  return target === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

export function getCharUsage(entries: string[]): number {
  if (entries.length === 0) return 0;
  return entries.join(ENTRY_DELIMITER).length;
}

export function readUserMemories(adoptId: string): { user: string[]; memory: string[] } {
  return readEntries(resolveMemoryFile(adoptId));
}

export function addMemory(
  adoptId: string, target: string, content: string,
): { success: boolean; error?: string } {
  content = content.trim();
  if (!content) return { success: false, error: "empty" };

  const scanErr = scanContent(content);
  if (scanErr) return { success: false, error: scanErr };

  const filePath = resolveMemoryFile(adoptId);
  const entries = readEntries(filePath);
  const list = target === "user" ? entries.user : entries.memory;
  const limit = charLimit(target);

  // 重复检查
  if (list.includes(content)) return { success: true };

  // 字符上限
  const newTotal = getCharUsage([...list, content]);
  if (newTotal > limit) {
    return { success: false, error: `at limit (${getCharUsage(list)}/${limit})` };
  }

  list.push(content);
  writeEntries(filePath, entries);
  console.log(`[MEMORY-STORE] add: ${target} "${content.slice(0, 40)}"`);
  return { success: true };
}

export function replaceMemory(
  adoptId: string, target: string, oldText: string, newContent: string,
): { success: boolean; error?: string } {
  oldText = oldText.trim();
  newContent = newContent.trim();
  if (!oldText || !newContent) return { success: false, error: "empty" };

  const scanErr = scanContent(newContent);
  if (scanErr) return { success: false, error: scanErr };

  const filePath = resolveMemoryFile(adoptId);
  const entries = readEntries(filePath);
  const list = target === "user" ? entries.user : entries.memory;

  const idx = list.findIndex(e => e.includes(oldText));
  if (idx === -1) return { success: false, error: `no match for "${oldText.slice(0, 30)}"` };

  list[idx] = newContent;
  writeEntries(filePath, entries);
  console.log(`[MEMORY-STORE] replace: ${target}`);
  return { success: true };
}

export function removeMemory(
  adoptId: string, target: string, oldText: string,
): { success: boolean; error?: string } {
  const filePath = resolveMemoryFile(adoptId);
  const entries = readEntries(filePath);
  const list = target === "user" ? entries.user : entries.memory;

  const idx = list.findIndex(e => e.includes(oldText.trim()));
  if (idx === -1) return { success: false, error: "no match" };

  list.splice(idx, 1);
  writeEntries(filePath, entries);
  console.log(`[MEMORY-STORE] remove: ${target}`);
  return { success: true };
}

/**
 * 构建 system prompt 注入块（供业务 Agent 用）
 * 构建和渲染层解耦的记忆注入块。
 */
export function buildMemoryBlock(adoptId: string): string {
  const entries = readEntries(resolveMemoryFile(adoptId));
  if (entries.user.length === 0 && entries.memory.length === 0) return "";

  const parts: string[] = [];
  const sep = "═".repeat(46);

  if (entries.user.length > 0) {
    const content = entries.user.join(ENTRY_DELIMITER);
    const pct = Math.min(100, Math.round((content.length / USER_CHAR_LIMIT) * 100));
    parts.push(sep);
    parts.push(`USER PROFILE (who the user is) [${pct}% — ${content.length}/${USER_CHAR_LIMIT} chars]`);
    parts.push(sep);
    parts.push(content);
  }

  if (entries.memory.length > 0) {
    const content = entries.memory.join(ENTRY_DELIMITER);
    const pct = Math.min(100, Math.round((content.length / MEMORY_CHAR_LIMIT) * 100));
    parts.push(sep);
    parts.push(`MEMORY (platform notes) [${pct}% — ${content.length}/${MEMORY_CHAR_LIMIT} chars]`);
    parts.push(sep);
    parts.push(content);
  }

  return "\n\n" + parts.join("\n");
}
