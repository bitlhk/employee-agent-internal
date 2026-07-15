import { bigint, boolean, index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

const LEGACY_RUNTIME_PORT_COLUMN = ["her", "mes_port"].join("");

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  password: varchar("password", { length: 255 }), // 密码哈希值
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  groupId: int("groupId").default(0).notNull(),
  organization: varchar("organization", { length: 200 }),
  accessLevel: mysqlEnum("accessLevel", ["public_only", "all"]).default("public_only").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Workforce Agent Platform collaboration - collaboration space (v1 hard isolation boundary)
 */
export const lxCollabSpaces = mysqlTable('lx_collab_spaces', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  status: mysqlEnum('status', ['active', 'disabled']).default('active').notNull(),
  sortOrder: int('sort_order').default(99).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  updatedBy: int('updated_by'),
}, (table) => ({
  nameUniqueIdx: uniqueIndex('uk_lx_collab_spaces_name').on(table.name),
}));

export type LxCollabSpace = typeof lxCollabSpaces.$inferSelect;
export type InsertLxCollabSpace = typeof lxCollabSpaces.$inferInsert;

/**
 * Workforce Agent Platform collaboration - user collaboration identity profile
 */
export const lxCollabUserProfiles = mysqlTable('lx_collab_user_profiles', {
  userId: int('user_id').primaryKey(),
  realName: varchar('real_name', { length: 100 }),
  organizationName: varchar('organization_name', { length: 200 }),
  departmentName: varchar('department_name', { length: 200 }),
  teamName: varchar('team_name', { length: 200 }),
  spaceId: int('space_id'),
  status: mysqlEnum('status', ['pending', 'active', 'disabled']).default('pending').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  updatedBy: int('updated_by'),
}, (table) => ({
  spaceStatusIdx: index('idx_lx_collab_user_profiles_space_status').on(table.spaceId, table.status),
  organizationIdx: index('idx_lx_collab_user_profiles_org').on(table.organizationName),
  departmentIdx: index('idx_lx_collab_user_profiles_dept').on(table.departmentName),
  teamIdx: index('idx_lx_collab_user_profiles_team').on(table.teamName),
}));

export type LxCollabUserProfile = typeof lxCollabUserProfiles.$inferSelect;
export type InsertLxCollabUserProfile = typeof lxCollabUserProfiles.$inferInsert;

/**
 * 注册用户表 - 存储通过落地页注册的用户信息
 */
export const registrations = mysqlTable("registrations", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  company: varchar("company", { length: 200 }).notNull(),
  partnerType: varchar("partner_type", { length: 50 }), // "financial_institution" or "isv_partner"
  email: varchar("email", { length: 320 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Registration = typeof registrations.$inferSelect;
export type InsertRegistration = typeof registrations.$inferInsert;

/**
 * 访问统计表 - 记录用户点击体验按钮的行为数据
 */
export const visitStats = mysqlTable("visit_stats", {
  id: int("id").autoincrement().primaryKey(),
  registrationId: int("registrationId").notNull(),
  scenarioId: varchar("scenarioId", { length: 50 }).notNull(), // acquisition, operations, investment
  experienceId: varchar("experienceId", { length: 50 }).notNull(), // demo-assistant, operations-review, etc.
  experienceTitle: varchar("experienceTitle", { length: 200 }).notNull(),
  clickedAt: bigint("clickedAt", { mode: "number" }).notNull(), // UTC timestamp in milliseconds
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type VisitStat = typeof visitStats.$inferSelect;
export type InsertVisitStat = typeof visitStats.$inferInsert;

/**
 * 安全日志表 - 记录可疑活动和安全事件
 */
export const securityLogs = mysqlTable("security_logs", {
  id: int("id").autoincrement().primaryKey(),
  ip: varchar("ip", { length: 45 }).notNull(), // IPv6 最长 45 字符
  path: varchar("path", { length: 500 }).notNull(),
  method: varchar("method", { length: 10 }).notNull(),
  userAgent: text("userAgent"),
  reason: varchar("reason", { length: 200 }).notNull(), // 触发原因
  details: text("details"), // 详细信息（JSON 格式）
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).default("medium").notNull(),
  status: mysqlEnum("status", ["pending", "resolved", "ignored", "blocked"]).default("pending").notNull(), // 处理状态
  handledBy: int("handledBy"), // 处理人ID（管理员）
  handledAt: timestamp("handledAt"), // 处理时间
  handledNote: text("handledNote"), // 处理备注
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SecurityLog = typeof securityLogs.$inferSelect;
export type InsertSecurityLog = typeof securityLogs.$inferInsert;

/**
 * IP 管理表 - 存储封禁IP、可疑IP、黑白名单
 */
export const ipManagement = mysqlTable("ip_management", {
  id: int("id").autoincrement().primaryKey(),
  ip: varchar("ip", { length: 45 }).notNull(), // IPv4 or IPv6
  type: mysqlEnum("type", ["blacklist", "whitelist", "suspicious", "blocked"]).notNull(), // IP类型
  reason: varchar("reason", { length: 500 }), // 原因说明
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).default("medium").notNull(), // 严重程度
  createdBy: int("createdBy"), // 创建人ID（管理员）
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt"), // 过期时间（可选，null表示永久）
  isActive: mysqlEnum("isActive", ["yes", "no"]).default("yes").notNull(), // 是否激活
  notes: text("notes"), // 备注
});

export type IpManagement = typeof ipManagement.$inferSelect;
export type InsertIpManagement = typeof ipManagement.$inferInsert;

/**
 * 邮箱验证码表 - 存储邮箱验证码
 */
export const emailVerificationCodes = mysqlTable("email_verification_codes", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  code: varchar("code", { length: 10 }).notNull(), // 验证码的截断带密钥摘要
  expiresAt: timestamp("expiresAt").notNull(), // 过期时间
  used: mysqlEnum("used", ["yes", "no"]).default("no").notNull(), // 是否已使用
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type EmailVerificationCode = typeof emailVerificationCodes.$inferSelect;
export type InsertEmailVerificationCode = typeof emailVerificationCodes.$inferInsert;

/**
 * SMTP配置表 - 存储邮件服务器配置
 */
export const smtpConfig = mysqlTable("smtp_config", {
  id: int("id").autoincrement().primaryKey(),
  host: varchar("host", { length: 255 }),
  port: varchar("port", { length: 10 }),
  user: varchar("user", { length: 320 }),
  password: varchar("password", { length: 255 }), // AES-256-GCM 信封加密
  from: varchar("from", { length: 320 }),
  enabled: mysqlEnum("enabled", ["yes", "no"]).default("no").notNull(), // 是否启用
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  updatedBy: int("updatedBy"), // 更新人ID（管理员）
});

export type SmtpConfig = typeof smtpConfig.$inferSelect;
export type InsertSmtpConfig = typeof smtpConfig.$inferInsert;

/**
 * 密码重置token表 - 存储密码重置请求
 */
export const passwordResetTokens = mysqlTable("password_reset_tokens", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  token: varchar("token", { length: 64 }).notNull().unique(), // token 的带密钥摘要
  expiresAt: timestamp("expiresAt").notNull(),
  used: mysqlEnum("used", ["yes", "no"]).default("no").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

/**
 * 功能开关表 - 存储系统功能开关配置
 */
export const featureFlags = mysqlTable("feature_flags", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(), // 功能键名，如 "scenario_experience"
  name: varchar("name", { length: 200 }).notNull(), // 功能名称，如 "场景体验功能"
  description: text("description"), // 功能描述
  enabled: mysqlEnum("enabled", ["yes", "no"]).default("yes").notNull(), // 是否启用
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  updatedBy: int("updatedBy"), // 更新人ID（管理员）
});

export type FeatureFlag = typeof featureFlags.$inferSelect;
export type InsertFeatureFlag = typeof featureFlags.$inferInsert;

/**
 * 场景表 - 存储场景的元信息（标题、图标、描述、排序）
 */
export const scenarios = mysqlTable("scenarios", {
  id: varchar("id", { length: 50 }).primaryKey(), // 场景ID，如 "acquisition", "operations" 等
  title: varchar("title", { length: 100 }).notNull(), // 场景标题，如 "获客增收"
  subtitle: varchar("subtitle", { length: 200 }), // 副标题，如 "智能营销获客引擎"
  description: text("description"), // 场景描述
  icon: varchar("icon", { length: 50 }), // 图标名称，如 "Users", "Zap", "TrendingUp"
  displayOrder: int("displayOrder").default(0).notNull(), // 显示顺序
  status: mysqlEnum("status", ["active", "hidden"]).default("active").notNull(), // 状态：active-显示，hidden-隐藏
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Scenario = typeof scenarios.$inferSelect;
export type InsertScenario = typeof scenarios.$inferInsert;

/**
 * 场景体验配置表 - 存储场景体验的配置信息
 */
export const experienceConfigs = mysqlTable("experience_configs", {
  id: int("id").autoincrement().primaryKey(),
  experienceId: varchar("experienceId", { length: 100 }).notNull().unique(), // 体验ID，如 "demo-assistant"
  title: varchar("title", { length: 200 }).notNull(), // 体验标题
  description: text("description"), // 体验描述
  url: varchar("url", { length: 500 }).notNull(), // 体验URL地址
  scenarioId: varchar("scenarioId", { length: 50 }).notNull(), // 所属场景ID，如 "acquisition"
  status: mysqlEnum("status", ["active", "developing"]).default("active").notNull(), // 状态：active-正常，developing-开发中
  visibility: mysqlEnum("visibility", ["public", "internal"]).default("public").notNull(), // 可见性：public-公开，internal-内部
  displayOrder: int("displayOrder").default(0).notNull(), // 显示顺序
  inToolbox: mysqlEnum("inToolbox", ["yes", "no"]).default("no").notNull(), // 是否在智能工具箱显示
  icon: varchar("icon", { length: 100 }), // 图标名称，如 "Bot", "Shield", "Mic" 等
  tag: varchar("tag", { length: 50 }), // 标签，如 "银行", "保险", "证券" 等
  features: text("features"), // 功能特性列表，JSON格式存储，如 ["功能1", "功能2"]
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  updatedBy: int("updatedBy"), // 更新人ID（管理员）
});

export type ExperienceConfig = typeof experienceConfigs.$inferSelect;
export type InsertExperienceConfig = typeof experienceConfigs.$inferInsert;

/**
 * 每日洞察表 - 存储首页咨询简报
 */
export const dailyInsights = mysqlTable("daily_insights", {
  id: int("id").autoincrement().primaryKey(),
  date: varchar("date", { length: 20 }).notNull().unique(), // YYYY-MM-DD
  title: varchar("title", { length: 300 }).notNull(),
  summary: text("summary"),
  content: text("content").notNull(),
  source: varchar("source", { length: 100 }).default("openclaw").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DailyInsight = typeof dailyInsights.$inferSelect;
export type InsertDailyInsight = typeof dailyInsights.$inferInsert;

/**
 * IP访问统计表 - 记录未注册用户的IP访问记录
 */
export const ipAccessLogs = mysqlTable("ip_access_logs", {
  id: int("id").autoincrement().primaryKey(),
  ip: varchar("ip", { length: 45 }).notNull(), // IPv4 or IPv6
  action: varchar("action", { length: 50 }).notNull(), // 访问动作：login, register, visit等
  path: varchar("path", { length: 500 }), // 访问路径
  userAgent: text("userAgent"), // 用户代理
  userId: int("userId"), // 如果已登录，记录用户ID
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type IpAccessLog = typeof ipAccessLogs.$inferSelect;
export type InsertIpAccessLog = typeof ipAccessLogs.$inferInsert;

/**
 * 系统配置表 - 存储系统级别的配置项
 */
export const systemConfigs = mysqlTable("system_configs", {
  id: int("id").autoincrement().primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(), // 配置键名，如 "unregistered_daily_limit"
  value: text("value").notNull(), // 配置值（JSON格式或字符串）
  description: text("description"), // 配置描述
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  updatedBy: int("updatedBy"), // 更新人ID（管理员）
});

/**
 * 岗位智能体协作 - 组定义
 */
export const lxGroups = mysqlTable("lx_groups", {
  id: int("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  sortOrder: int("sort_order").default(99),
  createdAt: timestamp("created_at").defaultNow(),
});

export type LxGroup = typeof lxGroups.$inferSelect;


export type SystemConfig = typeof systemConfigs.$inferSelect;
export type InsertSystemConfig = typeof systemConfigs.$inferInsert;

/**
 * 访问统计日聚合表 - 后台统计查询专用（全量准确 + 快速查询）
 * 粒度：date + scenario + experience + userType
 */
export const visitStatsDaily = mysqlTable("visit_stats_daily", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  statDate: varchar("statDate", { length: 10 }).notNull(), // YYYY-MM-DD
  scenarioId: varchar("scenarioId", { length: 64 }).notNull(),
  experienceId: varchar("experienceId", { length: 128 }).notNull(),
  userType: mysqlEnum("userType", ["registered", "unlogged"]).notNull(),
  pv: bigint("pv", { mode: "number" }).default(0).notNull(),
  uv: bigint("uv", { mode: "number" }).default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type VisitStatsDaily = typeof visitStatsDaily.$inferSelect;
export type InsertVisitStatsDaily = typeof visitStatsDaily.$inferInsert;

/**
 * 灵感龙虾方案 - 用户领养实例主表
 */
export const clawAdoptions = mysqlTable("claw_adoptions", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  adoptId: varchar("adoptId", { length: 64 }).notNull().unique(),
  agentId: varchar("agentId", { length: 128 }).notNull().unique(),
  status: mysqlEnum("status", ["creating", "active", "expiring", "recycled", "failed"]).default("creating").notNull(),
  permissionProfile: varchar("permissionProfile", { length: 32 }).default("plus").notNull(),
  roleTemplate: varchar("roleTemplate", { length: 64 }).default("general-assistant").notNull(),
  industry: varchar("industry", { length: 32 }).default("general").notNull(),
  runtime: varchar("runtime", { length: 32 }).default("openclaw").notNull(),
  legacyRuntimePort: int(LEGACY_RUNTIME_PORT_COLUMN),
  ttlDays: int("ttlDays").default(7).notNull(),
  entryUrl: varchar("entryUrl", { length: 512 }).notNull(),
  expiresAt: timestamp("expiresAt"), // nullable: null表示永久
  lastError: text("lastError"),
  lastActivityAt: timestamp("lastActivityAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ClawAdoption = typeof clawAdoptions.$inferSelect;
export type InsertClawAdoption = typeof clawAdoptions.$inferInsert;

/**
 * 灵感龙虾方案 - 领养生命周期事件日志
 */
export const clawAdoptionEvents = mysqlTable("claw_adoption_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  adoptionId: bigint("adoptionId", { mode: "number" }).notNull(),
  eventType: mysqlEnum("eventType", [
    "create_requested",
    "create_succeeded",
    "create_failed",
    "profile_updated",
    "ttl_extended",
    "recycle_requested",
    "recycle_succeeded",
    "recycle_failed",
  ]).notNull(),
  operatorType: mysqlEnum("operatorType", ["system", "user", "admin"]).default("system").notNull(),
  operatorId: int("operatorId"),
  detail: text("detail"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ClawAdoptionEvent = typeof clawAdoptionEvents.$inferSelect;
export type InsertClawAdoptionEvent = typeof clawAdoptionEvents.$inferInsert;

/**
 * 岗位智能体个性化设置（灵魂/记忆/上下文）
 */
export const clawProfileSettings = mysqlTable("claw_profile_settings", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  adoptionId: bigint("adoptionId", { mode: "number" }).notNull().unique(),
  displayName: varchar("displayName", { length: 100 }),
  personaPrompt: text("personaPrompt"),
  stylePreset: mysqlEnum("stylePreset", ["steady_research", "aggressive_trading", "education_advisor", "custom"]).default("steady_research").notNull(),
  memoryEnabled: mysqlEnum("memoryEnabled", ["yes", "no"]).default("yes").notNull(),
  memorySummary: text("memorySummary"),
  contextTurns: int("contextTurns").default(20).notNull(),
  model: varchar("model", { length: 128 }),
  crossSessionContext: mysqlEnum("crossSessionContext", ["yes", "no"]).default("yes").notNull(),
  updatedBy: int("updatedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ClawProfileSetting = typeof clawProfileSettings.$inferSelect;
export type InsertClawProfileSetting = typeof clawProfileSettings.$inferInsert;

/**
 * 岗位智能体协作 - 协作设置（每个 plus agent 可配置）
 */
export const clawCollabSettings = mysqlTable("claw_collab_settings", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  adoptionId: bigint("adoptionId", { mode: "number" }).notNull().unique(),
  displayName: varchar("displayName", { length: 100 }),
  headline: varchar("headline", { length: 200 }),
  visibilityMode: mysqlEnum("visibilityMode", ["private", "org", "public"]).default("private").notNull(),
  acceptDm: mysqlEnum("acceptDm", ["off", "org", "specified"]).default("off").notNull(),
  acceptTask: mysqlEnum("acceptTask", ["off", "approval", "auto"]).default("off").notNull(),
  allowedTaskTypes: text("allowedTaskTypes"),
  sharingPolicy: mysqlEnum("sharingPolicy", ["result-only", "none"]).default("none").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ClawCollabSetting = typeof clawCollabSettings.$inferSelect;
export type InsertClawCollabSetting = typeof clawCollabSettings.$inferInsert;

/**
 * 岗位智能体协作 - 协作请求（task delegation，非 session 直通）
 */
export const clawCollabRequests = mysqlTable("claw_collab_requests", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  sessionId: varchar("sessionId", { length: 64 }),
  subtaskIndex: int("subtaskIndex"),
  requesterAdoptId: varchar("requesterAdoptId", { length: 64 }).notNull(),
  targetAdoptId: varchar("targetAdoptId", { length: 64 }).notNull(),
  requesterUserId: int("requesterUserId").notNull(),
  targetUserId: int("targetUserId").notNull(),
  taskType: varchar("taskType", { length: 64 }).default("general").notNull(),
  taskSummary: text("taskSummary"),
  inputPayload: text("inputPayload"),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "running", "completed", "failed", "cancelled", "partial_success", "waiting_input"]).default("pending").notNull(),
  resultSummary: text("resultSummary"),
  resultVisibleToAll: boolean("resultVisibleToAll").default(false).notNull(),
  approvedAt: timestamp("approvedAt"),
  completedAt: timestamp("completedAt"),
  approvedBy: int("approvedBy"),
  approvalMode: mysqlEnum("approvalMode", ["auto", "manual"]).default("manual").notNull(),
  executionScope: text("executionScope"),
  riskLevel: mysqlEnum("riskLevel", ["low", "medium", "high"]).default("low").notNull(),
  resultMeta: text("resultMeta"),
  constraintsApplied: text("constraintsApplied"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ClawCollabRequest = typeof clawCollabRequests.$inferSelect;
export type InsertClawCollabRequest = typeof clawCollabRequests.$inferInsert;

/**
 * 岗位智能体协作 V2 - 协作 session（N 人协作的父记录）
 */
export const lxCoopSessions = mysqlTable("lx_coop_sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  creatorUserId: int('creator_user_id').notNull(),
  spaceId: int('space_id'),
  creatorAdoptId: varchar("creator_adopt_id", { length: 64 }).notNull(),
  title: varchar("title", { length: 200 }),
  originMessage: text("origin_message"),
  consolidationPromptPreset: varchar("consolidation_prompt_preset", { length: 1000 }),
  status: mysqlEnum("status", ["drafting","inviting","running","consolidating","published","closed","dissolved"]).default("drafting").notNull(),
  visibilityMode: mysqlEnum("visibility_mode", ["creator_only","all_members"]).default("creator_only").notNull(),
  finalSummary: text("final_summary"),
  finalArtifacts: text("final_artifacts"),
  memberCount: int("member_count").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  publishedAt: timestamp("published_at"),
  closedAt: timestamp("closed_at"),
  deletedAt: timestamp("deleted_at"),
});

export type LxCoopSession = typeof lxCoopSessions.$inferSelect;
export type InsertLxCoopSession = typeof lxCoopSessions.$inferInsert;

/**
 * 岗位智能体协作 V2 - 用户隐藏的协作 session
 *
 * 用于“我参与的协作”列表的个人归档/隐藏，不改变 session 本身的成员和审计记录。
 */
export const lxCoopUserHidden = mysqlTable("lx_coop_user_hidden", {
  userId: int("user_id").notNull(),
  sessionId: varchar("session_id", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userSessionUniqueIdx: uniqueIndex("uk_lx_coop_user_hidden_user_session").on(table.userId, table.sessionId),
  userIdx: index("idx_lx_coop_user_hidden_user").on(table.userId),
  sessionIdx: index("idx_lx_coop_user_hidden_session").on(table.sessionId),
}));

export type LxCoopUserHidden = typeof lxCoopUserHidden.$inferSelect;
export type InsertLxCoopUserHidden = typeof lxCoopUserHidden.$inferInsert;

/**
 * 岗位智能体协作 V2 - 协作事件流（append-only timeline）
 */
export const lxCoopEvents = mysqlTable("lx_coop_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  sessionId: varchar("session_id", { length: 64 }).notNull(),
  eventType: varchar("event_type", { length: 48 }).notNull(),
  actorUserId: int("actor_user_id"),
  actorAdoptId: varchar("actor_adopt_id", { length: 64 }),
  requestId: bigint("request_id", { mode: "number" }),
  payload: text("payload"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type LxCoopEvent = typeof lxCoopEvents.$inferSelect;
export type InsertLxCoopEvent = typeof lxCoopEvents.$inferInsert;

/**
 * Workforce Agent Platform collaboration - session shared files
 */
export const lxCoopFiles = mysqlTable("lx_coop_files", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  sessionId: varchar("session_id", { length: 64 }).notNull(),
  requestId: bigint("request_id", { mode: "number" }),
  ownerUserId: int("owner_user_id").notNull(),
  sourceAdoptId: varchar("source_adopt_id", { length: 64 }),
  sourcePath: varchar("source_path", { length: 1000 }),
  storedPath: varchar("stored_path", { length: 1200 }).notNull(),
  name: varchar("name", { length: 300 }).notNull(),
  size: bigint("size", { mode: "number" }).default(0).notNull(),
  mime: varchar("mime", { length: 160 }),
  sourceType: mysqlEnum("source_type", ["upload", "agent_workspace", "final_artifact"]).default("upload").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  sessionIdx: index("idx_lx_coop_files_session").on(table.sessionId),
  requestIdx: index("idx_lx_coop_files_request").on(table.requestId),
  ownerIdx: index("idx_lx_coop_files_owner").on(table.ownerUserId),
}));

export type LxCoopFile = typeof lxCoopFiles.$inferSelect;
export type InsertLxCoopFile = typeof lxCoopFiles.$inferInsert;


/**
 * 工具执行审计表
 * 每次 tool_call 都记录完整的路由+执行+结果链路
 */


/**
 * 工具执行审计表
 * 每次 tool_call 都记录完整的路由+执行+结果链路
 */
export const toolExecutionAudits = mysqlTable("tool_execution_audits", {
  auditId:          varchar("audit_id", { length: 64 }).primaryKey(),
  requestId:        varchar("request_id", { length: 64 }),
  userId:           int("user_id"),
  agentId:          varchar("agent_id", { length: 128 }),
  profile:          mysqlEnum("profile", ["starter","plus","internal"]),
  toolCallId:       varchar("tool_call_id", { length: 128 }).notNull(),
  originalToolName: varchar("original_tool_name", { length: 64 }).notNull(),
  routedToolName:   varchar("routed_tool_name", { length: 64 }).notNull(),
  command:          text("command"),
  args:             text("args"),
  cwd:              varchar("cwd", { length: 256 }),
  timeoutMs:        int("timeout_ms"),
  policyDecision:   mysqlEnum("policy_decision", ["allow","deny","rewrite"]).notNull(),
  denyReason:       varchar("deny_reason", { length: 64 }),
  deniedReason:     text("denied_reason"),
  executor:         mysqlEnum("executor", ["sandbox","native","none"]).notNull(),
  exitCode:         int("exit_code"),
  stdoutBytes:      int("stdout_bytes"),
  stderrBytes:      int("stderr_bytes"),
  truncated:        int("truncated").default(0),
  durationMs:       int("duration_ms"),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
});

export type ToolExecutionAudit = typeof toolExecutionAudits.$inferSelect;
export type InsertToolExecutionAudit = typeof toolExecutionAudits.$inferInsert;

/**
 * 业务 Agent 配置表（可配置的协作广场业务能力）
 */
// Enterprise Audit Ledger v1
export const auditEvents = mysqlTable("audit_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  eventId: varchar("event_id", { length: 64 }).notNull().unique(),
  eventTime: timestamp("event_time").notNull(),
  category: varchar("category", { length: 64 }).notNull(),
  action: varchar("action", { length: 128 }).notNull(),
  result: mysqlEnum("result", ["success", "failed", "denied", "warning"]).notNull().default("success"),
  severity: mysqlEnum("severity", ["info", "low", "medium", "high", "critical"]).notNull().default("info"),
  actorType: varchar("actor_type", { length: 32 }).notNull().default("user"),
  actorUserId: int("actor_user_id"),
  actorName: varchar("actor_name", { length: 128 }),
  actorEmail: varchar("actor_email", { length: 320 }),
  actorRole: varchar("actor_role", { length: 64 }),
  actorOrgId: varchar("actor_org_id", { length: 64 }),
  actorDepartmentId: varchar("actor_department_id", { length: 64 }),
  targetType: varchar("target_type", { length: 64 }),
  targetId: varchar("target_id", { length: 128 }),
  targetName: varchar("target_name", { length: 256 }),
  resourceType: varchar("resource_type", { length: 64 }),
  resourceId: varchar("resource_id", { length: 128 }),
  resourceName: varchar("resource_name", { length: 256 }),
  workspaceId: varchar("workspace_id", { length: 128 }),
  agentInstanceId: varchar("agent_instance_id", { length: 128 }),
  runtimeType: varchar("runtime_type", { length: 64 }),
  runtimeAgentId: varchar("runtime_agent_id", { length: 128 }),
  requestId: varchar("request_id", { length: 128 }),
  sessionId: varchar("session_id", { length: 128 }),
  correlationId: varchar("correlation_id", { length: 128 }),
  ip: varchar("ip", { length: 45 }),
  userAgent: text("user_agent"),
  source: varchar("source", { length: 64 }).notNull().default("platform"),
  environment: varchar("environment", { length: 64 }),
  detailType: varchar("detail_type", { length: 64 }),
  detailId: varchar("detail_id", { length: 128 }),
  errorCode: varchar("error_code", { length: 64 }),
  policyCode: varchar("policy_code", { length: 64 }),
  riskType: varchar("risk_type", { length: 64 }),
  channel: varchar("channel", { length: 64 }),
  toolName: varchar("tool_name", { length: 128 }),
  metadataJson: json("metadata_json").$type<Record<string, unknown> | null>(),
  metadataTruncated: boolean("metadata_truncated").notNull().default(false),
  metadataOriginalBytes: int("metadata_original_bytes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  eventTimeIdx: index("idx_audit_events_time").on(table.eventTime),
  actorIdx: index("idx_audit_events_actor").on(table.actorUserId, table.eventTime),
  categoryIdx: index("idx_audit_events_category").on(table.category, table.action, table.eventTime),
  targetIdx: index("idx_audit_events_target").on(table.targetType, table.targetId),
  agentIdx: index("idx_audit_events_agent").on(table.agentInstanceId, table.runtimeAgentId),
  severityIdx: index("idx_audit_events_severity").on(table.severity, table.result, table.eventTime),
  correlationIdx: index("idx_audit_events_correlation").on(table.correlationId),
  errorCodeIdx: index("idx_audit_events_error_code").on(table.errorCode),
  policyCodeIdx: index("idx_audit_events_policy_code").on(table.policyCode),
}));

export const auditToolEvents = mysqlTable("audit_tool_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  eventId: varchar("event_id", { length: 64 }).notNull().unique(),
  toolType: varchar("tool_type", { length: 64 }).notNull(),
  toolName: varchar("tool_name", { length: 128 }).notNull(),
  originalToolName: varchar("original_tool_name", { length: 128 }),
  routedToolName: varchar("routed_tool_name", { length: 128 }),
  executor: varchar("executor", { length: 64 }),
  policyDecision: mysqlEnum("policy_decision", ["allow", "deny", "rewrite"]).notNull(),
  denyReason: varchar("deny_reason", { length: 128 }),
  command: text("command"),
  argsJson: json("args_json").$type<Record<string, unknown> | null>(),
  cwd: varchar("cwd", { length: 512 }),
  url: text("url"),
  method: varchar("method", { length: 16 }),
  timeoutMs: int("timeout_ms"),
  exitCode: int("exit_code"),
  stdoutBytes: int("stdout_bytes"),
  stderrBytes: int("stderr_bytes"),
  truncated: boolean("truncated").notNull().default(false),
  durationMs: int("duration_ms"),
  metadataJson: json("metadata_json").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  toolTypeIdx: index("idx_audit_tool_type").on(table.toolType, table.toolName),
  policyIdx: index("idx_audit_tool_policy").on(table.policyDecision),
  createdIdx: index("idx_audit_tool_created").on(table.createdAt),
}));

export const auditSecurityFindings = mysqlTable("audit_security_findings", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  findingId: varchar("finding_id", { length: 64 }).notNull().unique(),
  eventId: varchar("event_id", { length: 64 }),
  findingType: varchar("finding_type", { length: 128 }).notNull(),
  severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).notNull().default("medium"),
  status: mysqlEnum("status", ["open", "acknowledged", "resolved", "ignored"]).notNull().default("open"),
  title: varchar("title", { length: 256 }).notNull(),
  description: text("description"),
  evidenceJson: json("evidence_json").$type<Record<string, unknown> | null>(),
  targetType: varchar("target_type", { length: 64 }),
  targetId: varchar("target_id", { length: 128 }),
  handledBy: int("handled_by"),
  handledAt: timestamp("handled_at"),
  handledNote: text("handled_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  statusIdx: index("idx_audit_findings_status").on(table.status, table.severity),
  typeIdx: index("idx_audit_findings_type").on(table.findingType),
  eventIdx: index("idx_audit_findings_event").on(table.eventId),
  createdIdx: index("idx_audit_findings_created").on(table.createdAt),
}));

export const auditExports = mysqlTable("audit_exports", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  exportId: varchar("export_id", { length: 64 }).notNull().unique(),
  actorUserId: int("actor_user_id").notNull(),
  actorEmail: varchar("actor_email", { length: 320 }),
  filtersJson: json("filters_json").$type<Record<string, unknown> | null>(),
  format: mysqlEnum("format", ["csv", "json", "xlsx"]).notNull().default("csv"),
  rowCount: int("row_count").notNull().default(0),
  storageKey: varchar("storage_key", { length: 128 }).notNull(),
  fileHash: varchar("file_hash", { length: 64 }).notNull(),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
  encrypted: boolean("encrypted").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
}, (table) => ({
  actorIdx: index("idx_audit_exports_actor").on(table.actorUserId, table.createdAt),
  createdIdx: index("idx_audit_exports_created").on(table.createdAt),
  storageIdx: index("idx_audit_exports_storage_key").on(table.storageKey),
}));

export type AuditEvent = typeof auditEvents.$inferSelect;
export type InsertAuditEvent = typeof auditEvents.$inferInsert;
export type AuditToolEvent = typeof auditToolEvents.$inferSelect;
export type InsertAuditToolEvent = typeof auditToolEvents.$inferInsert;
export type AuditSecurityFinding = typeof auditSecurityFindings.$inferSelect;
export type InsertAuditSecurityFinding = typeof auditSecurityFindings.$inferInsert;
export type AuditExport = typeof auditExports.$inferSelect;
export type InsertAuditExport = typeof auditExports.$inferInsert;

export const businessAgents = mysqlTable("business_agents", {
  id:            varchar("id", { length: 64 }).primaryKey(),
  name:          varchar("name", { length: 128 }).notNull(),
  description:   text("description"),
  kind:          mysqlEnum("kind", ["local", "remote"]).notNull().default("remote"),
  apiUrl:        varchar("api_url", { length: 512 }),
  apiToken:      text("api_token"),
  remoteAgentId: varchar("remote_agent_id", { length: 128 }).default("main"),
  localAgentId:  varchar("local_agent_id", { length: 128 }),
  skills:        text("skills"),
  icon:          varchar("icon", { length: 8 }).default("🤖"),
  enabled:       int("enabled").notNull().default(1),
  sortOrder:     int("sort_order").notNull().default(0),
  expiresAt:     timestamp("expires_at"),
  maxDailyRequests: int("max_daily_requests").notNull().default(0),
  healthStatus:  mysqlEnum("health_status", ["healthy", "degraded", "offline", "unknown"]).notNull().default("unknown"),
  lastHealthCheck: timestamp("last_health_check"),
  allowedProfiles: varchar("allowed_profiles", { length: 128 }).default("plus,internal"),
  tags:          varchar("tags", { length: 256 }).default(""),
  systemPrompt:  text("system_prompt"),
  uiConfig:      text("ui_config"),
  providerType:  varchar("provider_type", { length: 64 }),
  adapterProtocol: varchar("adapter_protocol", { length: 96 }),
  capabilitiesJson: text("capabilities_json"),
  endpointConfigJson: text("endpoint_config_json"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type BusinessAgent = typeof businessAgents.$inferSelect;
export type InsertBusinessAgent = typeof businessAgents.$inferInsert;

// ── Business Agent tenant isolation audit ──
export const businessAgentAudits = mysqlTable("business_agent_audit", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  tenantToken: varchar("tenant_token", { length: 128 }).notNull(),
  agentId: varchar("agent_id", { length: 128 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  sessionKey: varchar("session_key", { length: 128 }),
  meta: text("meta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("idx_business_agent_audit_user").on(table.userId),
  agentIdx: index("idx_business_agent_audit_agent").on(table.agentId),
  tenantIdx: index("idx_business_agent_audit_tenant").on(table.tenantToken),
  createdIdx: index("idx_business_agent_audit_created").on(table.createdAt),
}));

export const businessAgentTenantMap = mysqlTable("business_agent_tenant_map", {
  tenantToken: varchar("tenant_token", { length: 128 }).primaryKey(),
  userId: int("user_id").notNull(),
  agentId: varchar("agent_id", { length: 128 }).notNull(),
  workspacePath: varchar("workspace_path", { length: 512 }),
  firstUsedAt: timestamp("first_used_at"),
  lastUsedAt: timestamp("last_used_at"),
  messageCount: int("message_count").notNull().default(0),
}, (table) => ({
  userIdx: index("idx_business_agent_tenant_map_user").on(table.userId),
  agentIdx: index("idx_business_agent_tenant_map_agent").on(table.agentId),
  lastUsedIdx: index("idx_business_agent_tenant_map_last_used").on(table.lastUsedAt),
}));

export type BusinessAgentAudit = typeof businessAgentAudits.$inferSelect;
export type BusinessAgentTenantMap = typeof businessAgentTenantMap.$inferSelect;

// ── Agent 调用日志 ──
export const agentCallLogs = mysqlTable("agent_call_logs", {
  id:           int("id").autoincrement().primaryKey(),
  agentId:      varchar("agent_id", { length: 64 }).notNull(),
  userId:       int("user_id"),
  adoptId:      varchar("adopt_id", { length: 64 }),
  status:       mysqlEnum("status", ["success", "error", "timeout"]).notNull().default("success"),
  durationMs:   int("duration_ms").default(0),
  errorMessage: text("error_message"),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});

export type AgentCallLog = typeof agentCallLogs.$inferSelect;

// ── Anonymous installer telemetry ──
export const installEvents = mysqlTable("install_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  installId: varchar("install_id", { length: 64 }).notNull(),
  eventType: mysqlEnum("event_type", ["command_copied", "downloaded", "started", "succeeded", "failed"]).notNull(),
  stage: varchar("stage", { length: 64 }),
  source: varchar("source", { length: 32 }).notNull().default("bootstrap"),
  installerVersion: varchar("installer_version", { length: 32 }),
  osType: varchar("os_type", { length: 32 }),
  arch: varchar("arch", { length: 32 }),
  mirror: varchar("mirror", { length: 16 }),
  durationMs: int("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueInstallEvent: uniqueIndex("uk_install_events_install_event").on(table.installId, table.eventType),
  eventCreatedIdx: index("idx_install_events_event_created").on(table.eventType, table.createdAt),
  installCreatedIdx: index("idx_install_events_install_created").on(table.installId, table.createdAt),
}));

export type InstallEvent = typeof installEvents.$inferSelect;
export type InsertInstallEvent = typeof installEvents.$inferInsert;

export const agentTasks = mysqlTable("agent_tasks", {
  id: varchar("id", { length: 64 }).primaryKey(),
  adoptId: varchar("adopt_id", { length: 64 }).notNull(),
  userId: int("user_id").notNull(),
  agentId: varchar("agent_id", { length: 64 }).notNull(),
  sourceConversationId: varchar("source_conversation_id", { length: 128 }),
  sourceSessionId: varchar("source_session_id", { length: 160 }),
  sourceMessageId: varchar("source_message_id", { length: 128 }),
  status: mysqlEnum("status", ["pending", "running", "succeeded", "failed", "cancelled"]).notNull().default("pending"),
  input: text("input").notNull(),
  resultMarkdown: text("result_markdown"),
  errorMessage: text("error_message"),
  adapterProtocol: varchar("adapter_protocol", { length: 96 }),
  remoteTaskId: varchar("remote_task_id", { length: 128 }),
  rawEventsJson: text("raw_events_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  adoptStatusIdx: index("idx_agent_tasks_adopt_status").on(table.adoptId, table.status, table.createdAt),
  sourceConversationIdx: index("idx_agent_tasks_source_conversation").on(table.sourceConversationId),
  agentStatusIdx: index("idx_agent_tasks_agent_status").on(table.agentId, table.status),
}));

export type AgentTask = typeof agentTasks.$inferSelect;
export type InsertAgentTask = typeof agentTasks.$inferInsert;

// ── External channel bindings ──
export const channelBindings = mysqlTable("channel_bindings", {
  id: int("id").autoincrement().primaryKey(),
  channel: varchar("channel", { length: 32 }).notNull(),
  adoptId: varchar("adopt_id", { length: 64 }).notNull(),
  userId: int("user_id").notNull(),
  externalUserId: varchar("external_user_id", { length: 128 }).notNull(),
  externalChatId: varchar("external_chat_id", { length: 128 }),
  externalChannelId: varchar("external_channel_id", { length: 64 }),
  sourceMessageId: varchar("source_message_id", { length: 128 }),
  status: mysqlEnum("status", ["active", "disabled"]).notNull().default("active"),
  metadataJson: text("metadata_json"),
  boundAt: timestamp("bound_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  adoptIdx: index("idx_channel_bindings_adopt").on(table.adoptId),
  externalIdx: index("idx_channel_bindings_external").on(table.externalUserId),
  channelStatusIdx: index("idx_channel_bindings_channel_status").on(table.channel, table.status),
  uniqAdoptChannel: uniqueIndex("uk_channel_bindings_adopt").on(table.channel, table.adoptId),
  uniqExternalChannel: uniqueIndex("uk_channel_bindings_external").on(table.channel, table.externalUserId),
}));

export type ChannelBinding = typeof channelBindings.$inferSelect;
export type InsertChannelBinding = typeof channelBindings.$inferInsert;

// ── 技能市场 ──
export const skillMarketplace = mysqlTable("skill_marketplace", {
  id:            int("id").autoincrement().primaryKey(),
  skillId:       varchar("skill_id", { length: 64 }).notNull(),
  name:          varchar("name", { length: 128 }).notNull(),
  description:   text("description"),
  author:        varchar("author", { length: 128 }),
  authorUserId:  int("author_user_id"),
  version:       varchar("version", { length: 32 }).default("1.0.0"),
  category:      mysqlEnum("category", ["finance", "dev", "data", "writing", "general", "office", "design"]).default("general"),
  origin:        varchar("origin", { length: 32 }).default("opensource").notNull(),
  status:        mysqlEnum("status", ["pending", "approved", "rejected", "offline"]).default("pending").notNull(),
  reviewNote:    text("review_note"),
  downloadCount: int("download_count").notNull().default(0),
  license:       varchar("license", { length: 64 }).default("MIT"),
  packagePath:   varchar("package_path", { length: 512 }),
  roleTag:       varchar("role_tag", { length: 32 }),
  provider:      varchar("provider", { length: 64 }),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type SkillMarketItem = typeof skillMarketplace.$inferSelect;
export type InsertSkillMarketItem = typeof skillMarketplace.$inferInsert;

// ── Role-based Skill/MCP grants ──
export const roleAssetGrants = mysqlTable("role_asset_grants", {
  id: int("id").autoincrement().primaryKey(),
  roleKey: varchar("role_key", { length: 64 }).notNull(),
  assetType: mysqlEnum("asset_type", ["skill", "mcp_server"]).notNull(),
  assetId: varchar("asset_id", { length: 128 }).notNull(),
  grantMode: mysqlEnum("grant_mode", ["default", "optional"]).notNull().default("optional"),
  source: mysqlEnum("source", ["seed", "admin", "market"]).notNull().default("market"),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: varchar("created_by", { length: 128 }),
  updatedBy: varchar("updated_by", { length: 128 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  roleLookupIdx: index("idx_role_asset_grants_role").on(table.roleKey, table.assetType, table.enabled),
  assetLookupIdx: index("idx_role_asset_grants_asset").on(table.assetType, table.assetId, table.enabled),
  sourceIdx: index("idx_role_asset_grants_source").on(table.source),
  uniqGrant: uniqueIndex("uk_role_asset_grants_scope").on(table.roleKey, table.assetType, table.assetId, table.source),
}));

export type RoleAssetGrant = typeof roleAssetGrants.$inferSelect;
export type InsertRoleAssetGrant = typeof roleAssetGrants.$inferInsert;

// ── 用户记忆 (平台级) ──
export const userMemories = mysqlTable("user_memories", {
  id:           int("id").autoincrement().primaryKey(),
  userId:       int("user_id").notNull(),
  adoptId:      varchar("adopt_id", { length: 64 }),
  target:       varchar("target", { length: 16 }).notNull().default("memory"),
  content:      text("content").notNull(),
  sourceAgent:  varchar("source_agent", { length: 64 }),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  updatedAt:    timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

export type UserMemory = typeof userMemories.$inferSelect;
export type InsertUserMemory = typeof userMemories.$inferInsert;

// ── 消息质量反馈（不保存对话正文） ──
export const messageFeedback = mysqlTable("message_feedback", {
  id:                 bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  userId:             int("user_id").notNull(),
  adoptId:            varchar("adopt_id", { length: 64 }).notNull(),
  conversationId:     varchar("conversation_id", { length: 128 }).notNull(),
  messageId:          varchar("message_id", { length: 128 }).notNull(),
  rating:             mysqlEnum("rating", ["positive", "negative"]).notNull(),
  reasonCodesJson:    text("reason_codes_json"),
  comment:            varchar("comment", { length: 500 }),
  roleTemplate:       varchar("role_template", { length: 64 }),
  runtimeType:        varchar("runtime_type", { length: 32 }),
  selectedModelId:    varchar("selected_model_id", { length: 200 }),
  actualModelId:      varchar("actual_model_id", { length: 200 }),
  skillIdsJson:       text("skill_ids_json"),
  toolSummaryJson:    text("tool_summary_json"),
  inputTokens:        int("input_tokens"),
  outputTokens:       int("output_tokens"),
  durationMs:         int("duration_ms"),
  createdAt:          timestamp("created_at").defaultNow().notNull(),
  updatedAt:          timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  uniqMessageFeedback: uniqueIndex("uk_message_feedback_message").on(
    table.userId,
    table.adoptId,
    table.conversationId,
    table.messageId,
  ),
  ratingCreatedIdx: index("idx_message_feedback_rating_created").on(table.rating, table.createdAt),
  adoptCreatedIdx: index("idx_message_feedback_adopt_created").on(table.adoptId, table.createdAt),
  modelRatingIdx: index("idx_message_feedback_model_rating").on(table.actualModelId, table.rating),
}));

export type MessageFeedback = typeof messageFeedback.$inferSelect;
export type InsertMessageFeedback = typeof messageFeedback.$inferInsert;
