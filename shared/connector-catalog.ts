export type ConnectorCatalogCategory =
  | "business-data"
  | "knowledge-creation"
  | "development-collaboration"
  | "consumer-services";

export type ConnectorBindingTemplate = {
  id: string;
  catalogId?: string;
  displayName: string;
  endpointUrl: string;
  authType: "none" | "bearer" | "api_key" | "query_api_key";
  authHeaderName?: string;
};

export type ConnectorOAuthDefinition = {
  endpointUrl: string;
  scope?: string;
  clientMetadata?: Record<string, unknown>;
};

export type ConnectorCatalogTemplate = {
  id: string;
  name: string;
  description: string;
  capabilities: [string, string, string];
  category: ConnectorCatalogCategory;
  availability: "direct" | "oauth" | "partner" | "preview";
  requirement: string;
  docsUrl?: string;
  binding?: ConnectorBindingTemplate;
  oauthCatalogId?: string;
  oauth?: ConnectorOAuthDefinition;
  visible?: boolean;
};

export const CONNECTOR_CATALOG_CATEGORIES: Array<{ id: ConnectorCatalogCategory; label: string }> = [
  { id: "business-data", label: "业务数据" },
  { id: "knowledge-creation", label: "知识创作" },
  { id: "development-collaboration", label: "研发协作" },
  { id: "consumer-services", label: "生活服务" },
];

export const CONNECTOR_CATALOG_TEMPLATES: ConnectorCatalogTemplate[] = [
  {
    id: "yingmi", name: "盈米 · 且慢",
    description: "连接基金与家庭财富数据，支持资产分析、基金研究和组合诊断。",
    capabilities: ["基金数据", "家庭财务", "组合分析"], category: "business-data", availability: "direct",
    requirement: "使用者填写自己的盈米 API Key。",
    docsUrl: "https://yingmi.feishu.cn/docx/PRPRds5SBo2MITxHJL2cMPminEf",
    binding: { id: "yingmi", displayName: "盈米 · 且慢", endpointUrl: "https://stargate.yingmi.com/mcp/v2", authType: "api_key", authHeaderName: "X-API-Key" },
  },
  {
    id: "github", name: "GitHub",
    description: "查询代码仓、Issue 和 Pull Request，让研发协作信息进入岗位对话。",
    capabilities: ["代码仓库", "Issue", "Pull Request"], category: "development-collaboration", availability: "direct",
    requirement: "使用者填写自己的 GitHub Personal Access Token。",
    binding: { id: "github", displayName: "GitHub", endpointUrl: "https://api.githubcopilot.com/mcp/", authType: "bearer" },
  },
  {
    id: "microsoft-learn", name: "Microsoft Learn",
    description: "检索微软官方技术文档、代码示例和产品说明，无需单独账号授权。",
    capabilities: ["技术文档", "代码示例", "产品说明"], category: "knowledge-creation", availability: "direct",
    requirement: "无需凭据，可直接测试并绑定。",
    binding: { id: "microsoft-learn", displayName: "Microsoft Learn", endpointUrl: "https://learn.microsoft.com/api/mcp", authType: "none" },
  },
  {
    id: "jinshuju", name: "金数据",
    description: "用自然语言管理表单、查询提交数据并连接运营工作流。",
    capabilities: ["表单管理", "数据查询", "流程触发"], category: "business-data", availability: "oauth",
    requirement: "点击授权后登录金数据；凭据由平台加密保存，并仅供当前岗位智能体使用。",
    oauthCatalogId: "jinshuju",
    oauth: { endpointUrl: "https://jinshuju.net/mcp", scope: "public profile forms read_entries write_entries" },
  },
  {
    id: "hengshengjuyuan", name: "恒生聚源",
    description: "连接专业金融数据与研究资讯，支持行情、公司资料和公告研报检索。",
    capabilities: ["行情数据", "公司资料", "公告研报"], category: "business-data", availability: "direct",
    requirement: "使用者向恒生聚源申请自己的 JY_API_KEY；平台会加密保存，不会写入连接地址。",
    docsUrl: "https://vcn7e7nesi3s.feishu.cn/docx/MeCmd4q0Yo7nmkx9D8IcMYbknob",
    binding: { id: "hengshengjuyuan", displayName: "恒生聚源", endpointUrl: "https://api.gildata.com/mcp-servers/aidata-assistant-srv-tool", authType: "query_api_key", authHeaderName: "token" },
  },
  {
    id: "tianyancha", name: "天眼查",
    description: "连接企业工商、司法风险、知识产权与经营信息，辅助尽调和客户核验。",
    capabilities: ["企业工商", "司法风险", "知识产权"], category: "business-data", availability: "direct",
    requirement: "使用者在天眼 AI 智能体数据平台注册并获取自己的 API Key。",
    docsUrl: "https://ai.tianyancha.com/guide",
    binding: { id: "tianyancha", displayName: "天眼查", endpointUrl: "https://mcp.tianyancha.com/v1", authType: "bearer" },
  },
  {
    id: "canva", name: "Canva 可画",
    description: "生成、编辑和导出设计，连接品牌素材、模板与协作评论。",
    capabilities: ["设计生成", "素材管理", "多格式导出"], category: "knowledge-creation", availability: "oauth",
    requirement: "点击授权后登录 Canva；每位用户只会访问自己有权限的设计、素材和品牌内容。",
    oauthCatalogId: "canva", oauth: { endpointUrl: "https://mcp.canva.com/mcp" },
  },
  {
    id: "notion", name: "Notion",
    description: "搜索和维护知识页面、项目资料、任务与团队工作记录。",
    capabilities: ["知识检索", "页面编辑", "任务管理"], category: "knowledge-creation", availability: "oauth",
    requirement: "点击授权后登录 Notion，并选择允许当前岗位智能体访问的工作区内容。",
    oauthCatalogId: "notion", oauth: { endpointUrl: "https://mcp.notion.com/mcp" },
  },
  {
    id: "slack", name: "Slack",
    description: "搜索频道和文件、发送消息，并让团队协作上下文进入智能体。",
    capabilities: ["消息检索", "频道协作", "内容发送"], category: "development-collaboration", availability: "oauth",
    requirement: "需要企业注册并审批 Slack App，然后由用户授权。",
  },
  {
    id: "google-drive", name: "Google Drive",
    description: "查找和读取云端文件，为资料整理、问答和内容创作提供上下文。",
    capabilities: ["文件检索", "内容读取", "云端资料"], category: "knowledge-creation", availability: "preview",
    requirement: "Google Drive MCP 当前处于开发者预览阶段。",
  },
  {
    id: "yunzhangfang", name: "云账房 AI 开票",
    description: "连接企业开票场景，辅助抬头校验、开票申请和结果查询。",
    capabilities: ["抬头校验", "开票申请", "结果查询"], category: "business-data", availability: "oauth",
    requirement: "点击授权后使用云账房手机号和短信验证码登录；开票等写操作仍需用户确认。",
    oauthCatalogId: "yunzhangfang",
    oauth: { endpointUrl: "https://super-ai-app.yunzhangfang.com/api/mcp", scope: "mcp:visit", clientMetadata: { mcp_name: "yzf-invoice-mcp-server" } },
  },
  {
    id: "mcdonalds", name: "麦当劳",
    description: "查询餐品营养、门店与优惠信息，并连接会员积分、领券和点餐服务。",
    capabilities: ["餐品门店", "优惠积分", "点餐配送"], category: "consumer-services", availability: "direct",
    requirement: "使用者登录麦当劳 MCP 平台申请自己的 MCP Token；涉及地址、兑换和下单时请核对关键信息。",
    docsUrl: "https://open.mcd.cn/mcp/doc",
    binding: { id: "mcdonalds", displayName: "麦当劳", endpointUrl: "https://mcp.mcd.cn", authType: "bearer" },
  },
  {
    id: "atlassian", name: "Jira · Confluence",
    description: "兼容已有 Jira 与 Confluence OAuth 连接。",
    capabilities: ["Issue", "知识页面", "项目协作"], category: "development-collaboration", availability: "oauth",
    requirement: "仅保留已有连接兼容，不在连接器市场展示。", oauthCatalogId: "atlassian", visible: false,
    oauth: { endpointUrl: "https://mcp.atlassian.com/v1/mcp/authv2" },
  },
];

export const FEISHU_CONNECTOR_ID = "platform:feishu";
export const FEISHU_CONNECTOR_TOOLS = [
  { name: "feishu_conversation", description: "在飞书私聊中与当前岗位智能体双向对话" },
  { name: "feishu_delivery", description: "将任务结果和主动消息投递到已绑定的飞书账号" },
  { name: "feishu_schedule", description: "接收定时任务的执行结果与提醒" },
  { name: "feishu_collaboration", description: "接收协作邀请、进度变化和完成通知" },
];

export function visibleConnectorCatalogTemplates(): ConnectorCatalogTemplate[] {
  return CONNECTOR_CATALOG_TEMPLATES.filter((entry) => entry.visible !== false);
}

export function connectorCatalogEntry(id: string): ConnectorCatalogTemplate | null {
  const normalized = String(id || "").trim();
  return CONNECTOR_CATALOG_TEMPLATES.find((entry) => entry.id === normalized) || null;
}
