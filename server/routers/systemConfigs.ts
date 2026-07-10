import { publicProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import {
  getSystemConfigNumber,
  upsertSystemConfig,
} from "../db";

export const systemConfigsRouter = router({
    // 获取所有系统配置
    list: adminProcedure.query(async () => {
      const { getAllSystemConfigs } = await import("../db");
      return await getAllSystemConfigs();
    }),

    // 获取单个系统配置
    get: adminProcedure
      .input(z.object({ key: z.string() }))
      .query(async ({ input }) => {
        const { getSystemConfig, getSystemConfigValue, getSystemConfigNumber } = await import("../db");
        const config = await getSystemConfig(input.key);
        if (!config) {
          return null;
        }

        // 尝试解析为JSON，如果失败则返回字符串
        try {
          const parsed = JSON.parse(config.value);
          return {
            ...config,
            parsedValue: parsed,
          };
        } catch {
          return {
            ...config,
            parsedValue: config.value,
          };
        }
      }),

    // 更新或创建系统配置
    upsert: adminProcedure
      .input(
        z.object({
          key: z.string().min(1).max(100),
          value: z.string().min(1), // 值可以是JSON字符串或普通字符串
          description: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id;
        await upsertSystemConfig(
          {
            key: input.key,
            value: input.value,
            description: input.description || null,
          },
          userId
        );
        return { success: true };
      }),

    // 获取未注册用户每日访问限制
    getUnregisteredDailyLimit: adminProcedure.query(async () => {
      const limit = await getSystemConfigNumber("unregistered_daily_limit", 10);
      return { limit };
    }),

    // 设置未注册用户每日访问限制
    setUnregisteredDailyLimit: adminProcedure
      .input(z.object({ limit: z.number().int().min(0).max(1000) }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id;
        await upsertSystemConfig(
          {
            key: "unregistered_daily_limit",
            value: JSON.stringify(input.limit),
            description: "未注册用户每日访问次数限制（设置为0表示禁止未注册用户访问）",
          },
          userId
        );
        return { success: true };
      }),

    // 统计开关：读取聚合表
    getStatsReadFromAggregate: adminProcedure.query(async () => {
      const { getSystemConfigValue } = await import("../db");
      const value = await getSystemConfigValue("stats_read_from_aggregate", "false");
      return { value };
    }),

    setStatsReadFromAggregate: adminProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id;
        await upsertSystemConfig(
          {
            key: "stats_read_from_aggregate",
            value: input.enabled ? "true" : "false",
            description: "访问统计API是否优先读取 visit_stats_daily 聚合表",
          },
          userId
        );
        return { success: true };
      }),

    // 统计开关：回填任务
    getStatsEnableBackfillJob: adminProcedure.query(async () => {
      const { getSystemConfigValue } = await import("../db");
      const value = await getSystemConfigValue("stats_enable_backfill_job", "false");
      return { value };
    }),

    setStatsEnableBackfillJob: adminProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id;
        await upsertSystemConfig(
          {
            key: "stats_enable_backfill_job",
            value: input.enabled ? "true" : "false",
            description: "是否允许执行访问统计历史回填任务",
          },
          userId
        );
        return { success: true };
      }),

    // 统计开关：夜间校准任务
    getStatsEnableReconcileJob: adminProcedure.query(async () => {
      const { getSystemConfigValue } = await import("../db");
      const value = await getSystemConfigValue("stats_enable_reconcile_job", "false");
      return { value };
    }),

    setStatsEnableReconcileJob: adminProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id;
        await upsertSystemConfig(
          {
            key: "stats_enable_reconcile_job",
            value: input.enabled ? "true" : "false",
            description: "是否允许执行访问统计夜间校准任务",
          },
          userId
        );
        return { success: true };
      }),

    // 获取自动封禁 4xx 错误阈值
    getAutoBlock4xxThreshold: adminProcedure.query(async () => {
      const threshold = await getSystemConfigNumber("auto_block_4xx_threshold", 30);
      return { threshold };
    }),

    // 获取内部访问白名单（按行存储）
    getInternalAccessWhitelist: adminProcedure.query(async () => {
      const { getSystemConfigValue } = await import("../db");
      const value = await getSystemConfigValue("internal_access_whitelist", "");
      return { value };
    }),

    // 设置内部访问白名单（按行：邮箱或@域名）
    setInternalAccessWhitelist: adminProcedure
      .input(z.object({ value: z.string().default("") }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id;
        await upsertSystemConfig(
          {
            key: "internal_access_whitelist",
            value: input.value,
            description: "内部访问白名单：每行一个邮箱或@域名规则",
          },
          userId
        );
        return { success: true };
      }),

    // 设置自动封禁 4xx 错误阈值
    setAutoBlock4xxThreshold: adminProcedure
      .input(z.object({ threshold: z.number().int().positive().max(1000) }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id;
        await upsertSystemConfig(
          {
            key: "auto_block_4xx_threshold",
            value: JSON.stringify(input.threshold),
            description: "自动封禁 4xx 错误阈值：15 分钟内超过此数量的 4xx 错误将自动封禁 IP",
          },
          userId
        );
        return { success: true };
      }),
});
