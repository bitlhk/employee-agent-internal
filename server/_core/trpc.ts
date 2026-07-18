import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import { appendFile } from "fs/promises";
import { mkdirSync } from "fs";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { adminMfaWriteAccess } from "./admin-mfa-policy";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);


const APP_ROOT = process.env.APP_ROOT || process.cwd();
const AUDIT_LOG = `${APP_ROOT}/logs/admin-audit.log`;
try { mkdirSync(`${APP_ROOT}/logs`, { recursive: true }); } catch {}

const auditAdmin = t.middleware(async opts => {
  const { ctx, next, path, type } = opts;
  const start = Date.now();
  const result = await next();
  const ms = Date.now() - start;
  // 只记录 mutation（查询操作不记）
  if (type === "mutation") {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      userId: ctx.user?.id,
      userName: ctx.user?.name || ctx.user?.email,
      action: path,
      type,
      ok: result.ok,
      durationMs: ms,
    });
    appendFile(AUDIT_LOG, entry + "\n", "utf8").catch(() => {});
  }
  return result;
});

export const adminProcedure = t.procedure.use(auditAdmin).use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    if (opts.type === "mutation") {
      const mfa = await adminMfaWriteAccess(ctx.user);
      if (mfa.required && !mfa.fresh) {
        throw new TRPCError({ code: "FORBIDDEN", message: "管理员二次验证已过期，请在账号管理中重新验证" });
      }
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
