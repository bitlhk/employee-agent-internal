import { and, eq, inArray } from "drizzle-orm";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import { clawAdoptions, clawCollabRequests, lxCoopFiles } from "../../drizzle/schema";
import { resolveRuntimeWorkspace } from "../_core/helpers";
import { canViewCoopSession } from "./coop-identity";
import { getDb } from "./connection";

const APP_ROOT = process.env.APP_ROOT || process.cwd();
export const COOP_FILES_DIR = path.join(APP_ROOT, "data", "coop-files");
const MAX_COOP_FILE_BYTES = 50 * 1024 * 1024;

export type CoopFileSourceType = "upload" | "agent_workspace" | "final_artifact";

export type CoopFileView = {
  id: number;
  sessionId: string;
  requestId: number | null;
  ownerUserId: number;
  sourceAdoptId: string | null;
  sourcePath: string | null;
  name: string;
  size: number;
  mime: string | null;
  sourceType: CoopFileSourceType;
  url: string;
  createdAt: Date | null;
};

export type CoopAttachmentInput = {
  name: string;
  url: string;
  source?: "chat" | "task" | "agent_workspace";
  size?: number;
  adoptId?: string;
  path?: string;
  fileId?: number;
};

function safeSessionId(input: string): string {
  const value = String(input || "").trim().slice(0, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("invalid sessionId");
  return value;
}

export function safeCoopFilename(input: string): string {
  return (
    String(input || "file")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\.\.+/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 200)
      .trim() || "file"
  );
}

function requestDir(sessionId: string, requestId?: number | null): string {
  return requestId && requestId > 0
    ? path.join(COOP_FILES_DIR, sessionId, "requests", String(requestId))
    : path.join(COOP_FILES_DIR, sessionId, "shared");
}

function fileUrl(fileId: number): string {
  return `/api/coop/files/${encodeURIComponent(String(fileId))}`;
}

function toView(row: typeof lxCoopFiles.$inferSelect): CoopFileView {
  return {
    id: Number(row.id),
    sessionId: row.sessionId,
    requestId: row.requestId == null ? null : Number(row.requestId),
    ownerUserId: row.ownerUserId,
    sourceAdoptId: row.sourceAdoptId ?? null,
    sourcePath: row.sourcePath ?? null,
    name: row.name,
    size: Number(row.size || 0),
    mime: row.mime ?? null,
    sourceType: row.sourceType as CoopFileSourceType,
    url: fileUrl(Number(row.id)),
    createdAt: row.createdAt ?? null,
  };
}

export async function requireCoopFileAccess(userId: number, sessionId: string) {
  const access = await canViewCoopSession(userId, sessionId);
  return access.ok;
}

export async function validateRequestInSession(sessionId: string, requestId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select({ sessionId: clawCollabRequests.sessionId })
    .from(clawCollabRequests)
    .where(eq(clawCollabRequests.id, requestId))
    .limit(1);
  return rows[0]?.sessionId === sessionId;
}

export async function createCoopFileFromBuffer(args: {
  sessionId: string;
  requestId?: number | null;
  ownerUserId: number;
  name: string;
  content: Buffer;
  mime?: string | null;
  sourceType?: CoopFileSourceType;
  sourceAdoptId?: string | null;
  sourcePath?: string | null;
}): Promise<CoopFileView> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const sessionId = safeSessionId(args.sessionId);
  if (args.content.length <= 0 || args.content.length > MAX_COOP_FILE_BYTES) {
    throw new Error(`file size must be 1B-${MAX_COOP_FILE_BYTES / 1024 / 1024}MB`);
  }
  const safeName = safeCoopFilename(args.name);
  const dir = requestDir(sessionId, args.requestId);
  mkdirSync(dir, { recursive: true });
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const abs = path.join(dir, storedName);
  writeFileSync(abs, args.content);
  const rel = path.relative(COOP_FILES_DIR, abs).replace(/\\/g, "/");
  const inserted = await db.insert(lxCoopFiles).values({
    sessionId,
    requestId: args.requestId || null,
    ownerUserId: args.ownerUserId,
    sourceAdoptId: args.sourceAdoptId || null,
    sourcePath: args.sourcePath || null,
    storedPath: rel,
    name: safeName,
    size: args.content.length,
    mime: args.mime || null,
    sourceType: args.sourceType || "upload",
  });
  const id = Number((inserted as any)[0]?.insertId ?? (inserted as any).insertId ?? 0);
  const rows = await db.select().from(lxCoopFiles).where(eq(lxCoopFiles.id, id)).limit(1);
  if (!rows[0]) throw new Error("failed to create coop file");
  return toView(rows[0]);
}

export async function createCoopFileFromExistingPath(args: {
  sessionId: string;
  requestId?: number | null;
  ownerUserId: number;
  name: string;
  sourceAbsPath: string;
  sourceType: CoopFileSourceType;
  sourceAdoptId?: string | null;
  sourcePath?: string | null;
}): Promise<CoopFileView> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const sessionId = safeSessionId(args.sessionId);
  const sourceResolved = path.resolve(args.sourceAbsPath);
  if (!existsSync(sourceResolved)) throw new Error("source file not found");
  const st = statSync(sourceResolved);
  if (!st.isFile() || st.size <= 0 || st.size > MAX_COOP_FILE_BYTES) {
    throw new Error(`file size must be 1B-${MAX_COOP_FILE_BYTES / 1024 / 1024}MB`);
  }
  const safeName = safeCoopFilename(args.name);
  const dir = requestDir(sessionId, args.requestId);
  mkdirSync(dir, { recursive: true });
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const abs = path.join(dir, storedName);
  copyFileSync(sourceResolved, abs);
  const rel = path.relative(COOP_FILES_DIR, abs).replace(/\\/g, "/");
  const inserted = await db.insert(lxCoopFiles).values({
    sessionId,
    requestId: args.requestId || null,
    ownerUserId: args.ownerUserId,
    sourceAdoptId: args.sourceAdoptId || null,
    sourcePath: args.sourcePath || null,
    storedPath: rel,
    name: safeName,
    size: st.size,
    mime: null,
    sourceType: args.sourceType,
  });
  const id = Number((inserted as any)[0]?.insertId ?? (inserted as any).insertId ?? 0);
  const rows = await db.select().from(lxCoopFiles).where(eq(lxCoopFiles.id, id)).limit(1);
  if (!rows[0]) throw new Error("failed to create coop file");
  return toView(rows[0]);
}

export async function listCoopFilesForSession(sessionId: string, userId: number): Promise<CoopFileView[]> {
  const db = await getDb();
  if (!db) return [];
  const sid = safeSessionId(sessionId);
  if (!(await requireCoopFileAccess(userId, sid))) return [];
  const rows = await db
    .select()
    .from(lxCoopFiles)
    .where(eq(lxCoopFiles.sessionId, sid))
    .orderBy(lxCoopFiles.createdAt);
  return rows.map(toView);
}

export async function getCoopFileForDownload(fileId: number, userId: number): Promise<{ view: CoopFileView; absPath: string } | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(lxCoopFiles).where(eq(lxCoopFiles.id, fileId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!(await requireCoopFileAccess(userId, row.sessionId))) return null;
  const abs = path.resolve(COOP_FILES_DIR, row.storedPath);
  const root = path.resolve(COOP_FILES_DIR);
  if (!abs.startsWith(root + path.sep) || !existsSync(abs)) return null;
  return { view: toView(row), absPath: abs };
}

function fileIdFromAttachmentUrl(url: string): number | null {
  const match = String(url || "").match(/\/api\/coop\/files\/(\d+)/);
  return match ? Number(match[1]) : null;
}

export async function normalizeCoopAttachments(args: {
  sessionId: string;
  ownerUserId: number;
  requestId?: number | null;
  attachments?: CoopAttachmentInput[] | null;
}): Promise<CoopAttachmentInput[]> {
  const db = await getDb();
  const out: CoopAttachmentInput[] = [];
  const attachments = args.attachments || [];
  for (const attachment of attachments) {
    const existingId = Number(attachment.fileId || fileIdFromAttachmentUrl(attachment.url) || 0);
    if (existingId && db) {
      const rows = await db
        .select()
        .from(lxCoopFiles)
        .where(and(eq(lxCoopFiles.id, existingId), eq(lxCoopFiles.sessionId, args.sessionId)))
        .limit(1);
      if (rows[0]) {
        const view = toView(rows[0]);
        out.push({ ...attachment, fileId: view.id, name: view.name, url: view.url, size: view.size });
        continue;
      }
    }

    if (attachment.source === "agent_workspace" && attachment.adoptId && attachment.path) {
      try {
        const clawRows = db
          ? await db
              .select()
              .from(clawAdoptions)
              .where(and(eq(clawAdoptions.adoptId, attachment.adoptId), eq(clawAdoptions.userId, args.ownerUserId)))
              .limit(1)
          : [];
        const claw = clawRows[0];
        if (!claw) {
          out.push(attachment);
          continue;
        }
        const workspace = resolveRuntimeWorkspace(claw as any, attachment.adoptId);
        const rel = String(attachment.path || "").replace(/^\/+/, "");
        const abs = path.resolve(workspace, rel);
        const root = path.resolve(workspace);
        if (!abs.startsWith(root + path.sep)) {
          out.push(attachment);
          continue;
        }
        const view = await createCoopFileFromExistingPath({
          sessionId: args.sessionId,
          requestId: args.requestId,
          ownerUserId: args.ownerUserId,
          name: attachment.name,
          sourceAbsPath: abs,
          sourceType: "agent_workspace",
          sourceAdoptId: attachment.adoptId,
          sourcePath: attachment.path,
        });
        out.push({ ...attachment, fileId: view.id, name: view.name, url: view.url, size: view.size });
        continue;
      } catch (error) {
        console.error("[coop-files] materialize agent workspace attachment failed:", error);
      }
    }

    out.push(attachment);
  }
  return out;
}
