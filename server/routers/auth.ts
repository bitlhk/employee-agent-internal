import { COOKIE_NAME } from "@shared/const";
import { clearSessionCookieVariants, getSessionCookieOptions, setLogoutLockCookieVariants } from "../_core/cookies";
import { SESSION_MAX_AGE_MS, sdk, sessionAuthVersion } from "../_core/sdk";
import { publicProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import bcrypt from "bcryptjs";
import {
  createRegistration,
  getRegistrationByEmail,
  getAllRegistrations,
  getUserByEmail,
  createUser,
  updateUser,
  updateUserPasswordAndRevokeSessions,
  getAllAuthUsers,
  updateUserAccessLevel,
  isEmailInInternalAccessWhitelist,
  createEmailVerificationCode,
  verifyEmailCode,
  createPasswordResetToken,
  verifyPasswordResetToken,
  markPasswordResetTokenAsUsed,
} from "../db";
import { generateVerificationCode, sendVerificationCodeEmail, sendPasswordResetEmail } from "../_core/email";
import { auditActor, auditRequest, recordAuditBestEffort, recordAuditRequired } from "../_core/audit-events";
import { TEST_MODE, checkAndRecordIpAccess } from "./helpers";

const isEmailVerificationRequired = () => process.env.EMAIL_VERIFICATION_REQUIRED !== "false";
const assertVerificationCode = (value: unknown) => {
  const code = String(value || "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("验证码为6位数字");
  return code;
};

export const authRouter = router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      await sdk.revokeRequestSessions(ctx.req);
      await recordAuditBestEffort({
        action: "auth.logout",
        result: "success",
        severity: "low",
        ...auditActor(ctx.user),
        ...auditRequest(ctx.req),
        targetType: "auth_session",
        metadata: { localCacheClearRequested: true },
      });
      clearSessionCookieVariants(ctx.req, ctx.res);
      setLogoutLockCookieVariants(ctx.req, ctx.res);
      return {
        success: true,
      } as const;
    }),

    // 管理员：查看登录用户列表
    listUsers: adminProcedure.query(async () => {
      const rows = await getAllAuthUsers();
      return rows.map((user: any) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accessLevel: user.accessLevel || "public_only",
        loginMethod: user.loginMethod,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
      }));
    }),

    // 管理员：更新用户访问级别
    setUserAccessLevel: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          accessLevel: z.enum(["public_only", "all"]),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await recordAuditRequired({
          action: "admin.user.access_changed.requested",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "user",
          targetId: String(input.userId),
          metadata: { accessLevel: input.accessLevel },
        });
        try {
          await updateUserAccessLevel(input.userId, input.accessLevel);
          await recordAuditRequired({
            action: "admin.user.access_changed.completed",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "user",
            targetId: String(input.userId),
            metadata: { accessLevel: input.accessLevel },
          });
        } catch (error) {
          await recordAuditBestEffort({
            action: "admin.user.access_changed.failed",
            result: "failed",
            severity: "high",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "user",
            targetId: String(input.userId),
            errorCode: "ADMIN_ACCESS_CHANGE_FAILED",
            metadata: { accessLevel: input.accessLevel, error: error instanceof Error ? error.message : String(error) },
          });
          throw error;
        }
        return { success: true };
      }),

    // 管理员：重置登录用户密码
    setUserPassword: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          password: z.string().min(6, "密码至少需要6个字符").max(100, "密码过长"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await recordAuditRequired({
          action: "admin.user.password_reset.requested",
          ...auditActor(ctx.user),
          ...auditRequest(ctx.req),
          targetType: "user",
          targetId: String(input.userId),
        });
        try {
          const hashedPassword = await bcrypt.hash(input.password, 10);
          await updateUserPasswordAndRevokeSessions(input.userId, hashedPassword);
          await recordAuditRequired({
            action: "admin.user.password_reset.completed",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "user",
            targetId: String(input.userId),
          });
        } catch (error) {
          await recordAuditBestEffort({
            action: "admin.user.password_reset.failed",
            result: "failed",
            severity: "high",
            ...auditActor(ctx.user),
            ...auditRequest(ctx.req),
            targetType: "user",
            targetId: String(input.userId),
            errorCode: "ADMIN_PASSWORD_RESET_FAILED",
            metadata: { error: error instanceof Error ? error.message : String(error) },
          });
          throw error;
        }
        return { success: true };
      }),
    // 邮箱密码注册
    register: publicProcedure
      .input(z.object({
        name: z.string().min(1, "姓名不能为空").max(100, "姓名过长").trim(),
        company: z.string().min(1, "公司名不能为空").max(200, "公司名过长").trim(),
        partnerType: z.enum(["financial_institution", "isv_partner"]).optional(),
        email: z.string().email("请输入有效的邮箱地址").toLowerCase().trim(),
        password: z.string().min(6, "密码至少需要6个字符").max(100, "密码过长"),
        verificationCode: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // 测试模式：跳过所有验证和数据库操作，直接返回成功
        if (TEST_MODE) {
          const fakeUserId = Math.floor(Math.random() * 100000);
          const sessionToken = await sdk.signSession({
            userId: fakeUserId,
            name: input.name,
            authVersion: sessionAuthVersion({ id: fakeUserId }),
          });
          const cookieOptions = getSessionCookieOptions(ctx.req);
          clearSessionCookieVariants(ctx.req, ctx.res);
          ctx.res.cookie(COOKIE_NAME, sessionToken, {
            ...cookieOptions,
            maxAge: SESSION_MAX_AGE_MS,
          });
          return {
            success: true,
            user: {
              id: fakeUserId,
              name: input.name,
              email: input.email,
              role: "user" as const,
              accessLevel: "public_only" as const,
            },
          };
        }

        // 检查IP访问限制（未注册用户）
        const ipCheck = await checkAndRecordIpAccess(ctx.req, "register");
        if (!ipCheck.allowed) {
          throw new Error(ipCheck.message || "访问受限");
        }

        // 1. 验证邮箱验证码（独立部署可通过 EMAIL_VERIFICATION_REQUIRED=false 关闭）
        if (isEmailVerificationRequired()) {
          const code = assertVerificationCode(input.verificationCode);
          const isValid = await verifyEmailCode(input.email, code);
          if (!isValid) {
            throw new Error("验证码错误或已过期，请重新获取");
          }
        }

        // 2. 检查邮箱是否在黑名单（免费邮箱禁止注册）
        const freeEmailDomains = [
          "gmail.com", "qq.com", "163.com", "126.com", "sina.com",
          "hotmail.com", "outlook.com", "yahoo.com", "sohu.com",
          "foxmail.com", "139.com", "189.cn", "wo.cn", "139.com"
        ];
        const emailDomain = input.email.split("@")[1]?.toLowerCase();
        if (emailDomain && freeEmailDomains.includes(emailDomain)) {
          throw new Error("暂不支持免费邮箱注册，请使用公司邮箱");
        }

        // 3. 检查邮箱是否已注册
        const existing = await getUserByEmail(input.email);
        if (existing) {
          throw new Error("该邮箱已被注册");
        }

        // 加密密码
        const hashedPassword = await bcrypt.hash(input.password, 10);

        // 根据白名单决定默认访问级别
        const inWhitelist = await isEmailInInternalAccessWhitelist(input.email);

        // 创建用户
        const userId = await createUser({
          name: input.name,
          email: input.email,
          password: hashedPassword,
          loginMethod: "email",
          role: "user",
          accessLevel: inWhitelist ? "all" : "public_only",
        });

        // 同时创建注册记录（用于统计和体验功能）
        try {
          await createRegistration({
            name: input.name,
            company: input.company,
            partnerType: input.partnerType,
            email: input.email,
          });
        } catch (error) {
          // 如果创建注册记录失败，不影响用户注册流程
          console.warn("[Registration] Failed to create registration record:", error);
        }

        // 创建session
        const sessionToken = await sdk.signSession({
          userId,
          name: input.name,
          authVersion: sessionAuthVersion({ id: userId, password: hashedPassword }),
        });

        // 设置cookie
        const cookieOptions = getSessionCookieOptions(ctx.req);
        clearSessionCookieVariants(ctx.req, ctx.res);
        ctx.res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: SESSION_MAX_AGE_MS,
        });

        return {
          success: true,
          user: {
            id: userId,
            name: input.name,
            email: input.email,
            role: "user" as const,
            accessLevel: inWhitelist ? "all" as const : "public_only" as const,
          },
        };
      }),
    // 邮箱密码登录
    login: publicProcedure
      .input(z.object({
        email: z.string().email("请输入有效的邮箱地址").toLowerCase().trim(),
        password: z.string().min(1, "请输入密码").max(100, "密码过长"),
      }))
      .mutation(async ({ input, ctx }) => {
        // 测试模式：跳过所有验证，直接返回成功
        if (TEST_MODE) {
          const fakeUserId = Math.floor(Math.random() * 100000);
          // 测试账号 admin@example.com/admin 直接给管理员权限
          const isAdmin = input.email.toLowerCase() === "admin@example.com";
          const sessionToken = await sdk.signSession({
            userId: fakeUserId,
            name: input.email.split('@')[0],
            authVersion: sessionAuthVersion({ id: fakeUserId }),
          });
          const cookieOptions = getSessionCookieOptions(ctx.req);
          clearSessionCookieVariants(ctx.req, ctx.res);
          ctx.res.cookie(COOKIE_NAME, sessionToken, {
            ...cookieOptions,
            maxAge: SESSION_MAX_AGE_MS,
          });
          return {
            success: true,
            user: {
              id: fakeUserId,
              name: isAdmin ? 'admin' : input.email.split('@')[0],
              email: input.email,
              role: isAdmin ? "admin" as const : "user" as const,
              accessLevel: isAdmin ? "all" as const : "public_only" as const,
            },
          };
        }

        // 检查IP访问限制（未注册用户）
        const ipCheck = await checkAndRecordIpAccess(ctx.req, "login");
        if (!ipCheck.allowed) {
          throw new Error(ipCheck.message || "访问受限");
        }

        // 查找用户
        const user = await getUserByEmail(input.email);
        if (!user || !user.password) {
          await recordAuditBestEffort({
            action: "auth.login.failed",
            result: "failed",
            severity: "medium",
            actorType: "anonymous",
            actorEmail: input.email,
            ...auditRequest(ctx.req),
            errorCode: "AUTH_INVALID_CREDENTIALS",
            metadata: { reason: "user_missing_or_password_unset" },
          });
          throw new Error("邮箱或密码错误");
        }

        // 验证密码
        const isValid = await bcrypt.compare(input.password, user.password);
        if (!isValid) {
          await recordAuditBestEffort({
            action: "auth.login.failed",
            result: "failed",
            severity: "medium",
            actorType: "anonymous",
            actorEmail: input.email,
            targetType: "user",
            targetId: String(user.id),
            ...auditRequest(ctx.req),
            errorCode: "AUTH_INVALID_CREDENTIALS",
            metadata: { reason: "bad_password" },
          });
          throw new Error("邮箱或密码错误");
        }

        // 创建session
        const sessionToken = await sdk.signSession({
          userId: user.id,
          name: user.name || user.email || "",
          authVersion: sessionAuthVersion(user),
        });

        // 设置cookie
        const cookieOptions = getSessionCookieOptions(ctx.req);
        clearSessionCookieVariants(ctx.req, ctx.res);
        ctx.res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: SESSION_MAX_AGE_MS,
        });

        await recordAuditBestEffort({
          action: "auth.login.success",
          ...auditActor(user),
          ...auditRequest(ctx.req),
          targetType: "user",
          targetId: String(user.id),
          metadata: { method: "password" },
        });

        return {
          success: true,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            accessLevel: (user as any).accessLevel || "public_only",
          },
        };
      }),

    // 发送忘记密码验证码（不检查邮箱是否已注册）
    sendForgotPasswordVerificationCode: publicProcedure
      .input(z.object({
        email: z.string().email("请输入有效的邮箱地址").toLowerCase().trim(),
      }))
      .mutation(async ({ input }) => {
        // 生成验证码
        const code = generateVerificationCode();

        // 保存验证码到数据库（有效期10分钟）
        await createEmailVerificationCode(input.email, code, 10);

        // 发送邮件
        await sendVerificationCodeEmail(input.email, code);

        return { success: true };
      }),

    // 请求密码重置（发送重置邮件）
    requestPasswordReset: publicProcedure
      .input(
        z.object({
          email: z.string().email("请输入有效的邮箱地址").toLowerCase().trim(),
          code: z.string().min(6, "验证码为6位数字").max(6, "验证码为6位数字"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { email, code } = input;

        // 1. 验证邮箱验证码
        const isCodeValid = await verifyEmailCode(email, code);
        if (!isCodeValid) {
          throw new Error("验证码错误或已过期");
        }

        // 2. 检查用户是否存在
        const user = await getUserByEmail(email);
        if (!user || !user.password) {
          throw new Error("该邮箱未注册或未设置密码");
        }

        // 3. 生成重置token
        const crypto = await import("crypto");
        const resetToken = crypto.randomBytes(32).toString("hex");

        // 4. 保存token到数据库（30分钟有效）
        await createPasswordResetToken(email, resetToken, 30);

        // 5. 从请求头获取前端URL（优先使用 Origin，其次 Referer）
        const requestOrigin = ctx.req.headers.origin || ctx.req.headers.referer?.replace(/\/[^/]*$/, '');

        // 6. 发送重置邮件
        await sendPasswordResetEmail(email, resetToken, requestOrigin);

        await recordAuditBestEffort({
          action: "auth.password_reset.requested",
          ...auditActor(user),
          ...auditRequest(ctx.req),
          targetType: "user",
          targetId: String(user.id),
          metadata: { delivery: "email" },
        });

        return { success: true };
      }),

    // 重置密码
    resetPassword: publicProcedure
      .input(
        z.object({
          token: z.string().min(1, "重置token不能为空"),
          newPassword: z.string().min(6, "密码至少需要6个字符").max(100, "密码过长"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { token, newPassword } = input;

        // 1. 验证token
        const resetToken = await verifyPasswordResetToken(token);
        if (!resetToken) {
          throw new Error("重置链接无效或已过期");
        }

        // 2. 查找用户
        const user = await getUserByEmail(resetToken.email);
        if (!user) {
          throw new Error("用户不存在");
        }

        // 3. 加密新密码
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // 4. 更新密码
        await updateUserPasswordAndRevokeSessions(user.id, hashedPassword);

        // 5. 标记token为已使用
        await markPasswordResetTokenAsUsed(token);

        await recordAuditBestEffort({
          action: "auth.password_reset.completed",
          ...auditActor(user),
          ...auditRequest(ctx.req),
          targetType: "user",
          targetId: String(user.id),
        });

        return { success: true };
      }),
});

export const registrationRouter = router({
    // 发送邮箱验证码
    sendVerificationCode: publicProcedure
      .input(z.object({
        email: z.string().email("请输入有效的邮箱地址").toLowerCase().trim(),
      }))
      .mutation(async ({ input }) => {
        // 检查邮箱是否已注册
        const existing = await getRegistrationByEmail(input.email);
        if (existing) {
          throw new Error("该邮箱已被注册");
        }

        // 生成验证码
        const code = generateVerificationCode();

        // 保存验证码到数据库（有效期10分钟）
        await createEmailVerificationCode(input.email, code, 10);

        // 发送邮件
        await sendVerificationCodeEmail(input.email, code);

        return { success: true };
      }),

    // 创建新注册（需要验证码）
    create: publicProcedure
      .input(z.object({
        name: z.string().min(1, "姓名不能为空").max(100, "姓名过长").trim(),
        company: z.string().min(1, "公司不能为空").max(200, "公司名过长").trim(),
        email: z.string().email("请输入有效的邮箱地址").toLowerCase().trim(),
        verificationCode: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        // 验证验证码
        if (isEmailVerificationRequired()) {
          const code = assertVerificationCode(input.verificationCode);
          const isValid = await verifyEmailCode(input.email, code);
          if (!isValid) {
            throw new Error("验证码错误或已过期，请重新获取");
          }
        }

        // 检查邮箱是否已注册
        const existing = await getRegistrationByEmail(input.email);
        if (existing) {
          // 如果已存在，返回现有记录的ID
          return {
            success: true,
            registrationId: existing.id,
            isExisting: true
          };
        }

        // 创建新注册
        const registrationId = await createRegistration({
          name: input.name,
          company: input.company,
          email: input.email,
        });

        return {
          success: true,
          registrationId,
          isExisting: false
        };
      }),

    // 公开接口只返回是否存在，避免枚举邮箱时泄露姓名、公司、创建时间等注册资料。
    getByEmail: publicProcedure
      .input(z.string().email("请输入有效的邮箱地址").toLowerCase().trim())
      .query(async ({ input }) => {
        const registration = await getRegistrationByEmail(input);
        return { exists: !!registration };
      }),

    // 获取所有注册记录（管理员用）
    list: adminProcedure.query(async () => {
      return await getAllRegistrations();
    }),
});
