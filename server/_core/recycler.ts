// ── 定时回收：每小时检查不活跃的岗位智能体实例 ──
export function startRecycler() {
  setInterval(async () => {
    try {
      const { getDb } = await import("../db");
      const { clawAdoptions } = await import("../../drizzle/schema");
      const { eq, and, lt, isNull, or } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return;

      const now = new Date();
      const starterInactiveDays = Number(process.env.CLAW_STARTER_INACTIVE_DAYS || 15);
      const starterMaxDays = Number(process.env.CLAW_STARTER_MAX_DAYS || 30);
      const inactiveThreshold = new Date(now.getTime() - starterInactiveDays * 86400000);
      const expiryThreshold = now;

      // Starter: 不活跃超过 N 天 → recycled
      const inactiveResult = await db.update(clawAdoptions).set({ status: "recycled" as any }).where(
        and(
          eq(clawAdoptions.status, "active"),
          eq(clawAdoptions.permissionProfile, "starter"),
          or(
            // lastActivityAt 存在且超期
            lt(clawAdoptions.lastActivityAt, inactiveThreshold),
            // lastActivityAt 为空且 createdAt 超期（从未使用过）
            and(isNull(clawAdoptions.lastActivityAt), lt(clawAdoptions.createdAt, inactiveThreshold))
          )
        )
      );
      const inactiveCount = (inactiveResult as any)?.[0]?.affectedRows || 0;

      // 所有套餐：expiresAt 已过 → recycled
      const expiredResult = await db.update(clawAdoptions).set({ status: "recycled" as any }).where(
        and(
          eq(clawAdoptions.status, "active"),
          lt(clawAdoptions.expiresAt, expiryThreshold)
        )
      );
      const expiredCount = (expiredResult as any)?.[0]?.affectedRows || 0;

      if (inactiveCount > 0 || expiredCount > 0) {
        console.log(`[Claw Recycle] inactive=${inactiveCount}, expired=${expiredCount}`);
      }
    } catch (err) {
      console.error("[Claw Recycle] Error:", err);
    }
  }, 60 * 60 * 1000); // 每小时
}
