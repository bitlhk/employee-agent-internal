import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

type DemoFormat = "md" | "pdf" | "docx" | "xlsx" | "pptx";
type DemoRole = "wealth-manager" | "post-loan-risk-control" | "insurance-advisor" | "credential-compliance" | null;

type DemoAssetSpec = {
  id: string;
  relativePath: string;
  title: string;
  format: DemoFormat;
  department: string;
  domain: "wealth" | "risk" | "insurance" | "audit" | "general";
  role: DemoRole;
  version: string | null;
  effectiveDateRequired?: boolean;
  oldVersion?: boolean;
  duplicateOf?: string;
  series?: string;
  supersedes?: string;
  showcase?: boolean;
  summary: string;
};

type GroundTruthAsset = DemoAssetSpec & {
  checksum: string;
  sizeBytes: number;
  expectedDiagnostics: string[];
  expectedLogicalAssetCandidates: string[];
};

const APP_ROOT = process.cwd();
const PACK_ROOT = path.join(APP_ROOT, "examples", "demo-bank-enterprise-assets-v1");
const GENERATED_ROOT = path.join(PACK_ROOT, "generated");
const ASSET_ROOT = path.join(GENERATED_ROOT, "assets");
const ZIP_PATH = path.join(GENERATED_ROOT, "demo-bank-enterprise-assets-v1.zip");
const MANIFEST_PATH = path.join(GENERATED_ROOT, "ground-truth-manifest.json");
const CORPUS_TIME = new Date("2026-08-20T00:00:00.000Z");

const asset = (spec: DemoAssetSpec): DemoAssetSpec => spec;

const ASSETS: DemoAssetSpec[] = [
  asset({ id: "wealth-policy-31", relativePath: "财富管理部/制度/私人银行产品销售适当性管理办法V3.1.pdf", title: "私人银行产品销售适当性管理办法", format: "pdf", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "3.1", effectiveDateRequired: true, series: "wealth-sales-suitability", summary: "历史版本，规定客户风险测评与产品销售的基础要求。" }),
  asset({ id: "wealth-policy-32", relativePath: "财富管理部/制度/私人银行产品销售适当性管理办法V3.2.pdf", title: "私人银行产品销售适当性管理办法", format: "pdf", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "3.2", effectiveDateRequired: true, series: "wealth-sales-suitability", supersedes: "wealth-policy-31", summary: "当前演示基线版本，增加风险测评有效期和双录要求。" }),
  asset({ id: "wealth-policy-33", relativePath: "财富管理部/制度/私人银行产品销售适当性管理办法V3.3.pdf", title: "私人银行产品销售适当性管理办法", format: "pdf", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "3.3", effectiveDateRequired: true, series: "wealth-sales-suitability", supersedes: "wealth-policy-32", showcase: true, summary: "候选新版本，用于演示验证、待生效和有效 Context 切换。" }),
  asset({ id: "wealth-product-pool", relativePath: "财富管理部/产品/在售产品清单V2026.08.xlsx", title: "在售产品清单", format: "xlsx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "2026.08", summary: "演示产品风险等级、期限、起购金额和销售状态。" }),
  asset({ id: "wealth-product-manual", relativePath: "财富管理部/产品/理财产品销售手册V2.0.docx", title: "理财产品销售手册", format: "docx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "2.0", summary: "产品讲解、风险揭示和客户沟通口径。" }),
  asset({ id: "wealth-allocation-sop", relativePath: "财富管理部/SOP/资产配置方案制作规程V1.2.md", title: "资产配置方案制作规程", format: "md", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.2", effectiveDateRequired: true, summary: "资产配置建议的事实核验、分析和留痕步骤。" }),
  asset({ id: "wealth-previsit-sop", relativePath: "财富管理部/SOP/客户访前准备作业指引V1.1.pptx", title: "客户访前准备作业指引", format: "pptx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.1", effectiveDateRequired: true, summary: "访前材料、客户画像和沟通重点准备流程。" }),
  asset({ id: "wealth-maturity-plan", relativePath: "财富管理部/产品/到期客户经营计划V1.0.xlsx", title: "到期客户经营计划", format: "xlsx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.0", summary: "到期产品、客户偏好和跟进节点样例。" }),
  asset({ id: "wealth-suitability-checklist", relativePath: "财富管理部/制度/产品适当性检查清单V2.0.xlsx", title: "产品适当性检查清单", format: "xlsx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "2.0", effectiveDateRequired: true, summary: "风险等级、期限、流动性和集中度检查项。" }),
  asset({ id: "wealth-market-view", relativePath: "财富管理部/投研/市场观点2026-08-20.md", title: "财富市场观点", format: "md", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "2026.08.20", summary: "虚构市场观点，仅用于演示可选 Context。" }),
  asset({ id: "wealth-communication", relativePath: "财富管理部/客户/高净值客户沟通指引.docx", title: "高净值客户沟通指引", format: "docx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: null, effectiveDateRequired: true, summary: "故意缺少版本，用于整改队列演示。" }),
  asset({ id: "wealth-service-flow", relativePath: "财富管理部/客户/私人银行客户服务流程2025.docx", title: "私人银行客户服务流程", format: "docx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: null, summary: "故意使用不完整年份命名，验证版本补录。" }),
  asset({ id: "wealth-faq", relativePath: "财富管理部/产品/产品销售问答V1.0.md", title: "产品销售问答", format: "md", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.0", summary: "产品费用、赎回和风险揭示常见问答。" }),
  asset({ id: "wealth-faq-copy", relativePath: "财富管理部/产品/产品销售问答最终版2.md", title: "产品销售问答", format: "md", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: null, oldVersion: true, duplicateOf: "wealth-faq", summary: "与产品销售问答V1.0内容完全相同，用于重复资产识别。" }),
  asset({ id: "wealth-old-policy", relativePath: "财富管理部/制度/历史/财富客户分层管理办法V2.0.pdf", title: "财富客户分层管理办法", format: "pdf", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "2.0", effectiveDateRequired: true, oldVersion: true, summary: "历史制度，用于旧版本识别与排除说明。" }),
  asset({ id: "wealth-training", relativePath: "财富管理部/培训/财富经理年度培训V1.0.pptx", title: "财富经理年度培训", format: "pptx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.0", summary: "财富客户经营和合规基础培训。" }),
  asset({ id: "wealth-recording", relativePath: "财富管理部/制度/销售双录管理规定V1.0.docx", title: "销售双录管理规定", format: "docx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.0", effectiveDateRequired: true, summary: "双录触发、质检和异常升级要求。" }),
  asset({ id: "wealth-disclosure", relativePath: "财富管理部/模板/产品风险揭示模板V1.0.md", title: "产品风险揭示模板", format: "md", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.0", summary: "演示风险揭示内容和人工确认边界。" }),
  asset({ id: "wealth-commentary", relativePath: "财富管理部/投研/大类资产月度观察V1.0.pdf", title: "大类资产月度观察", format: "pdf", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.0", summary: "虚构投研材料，不包含真实投资建议。" }),
  asset({ id: "wealth-tiering", relativePath: "财富管理部/客户/客户分层指标定义V1.0.xlsx", title: "客户分层指标定义", format: "xlsx", department: "财富管理部", domain: "wealth", role: "wealth-manager", version: "1.0", summary: "客户分层指标和解释口径。" }),

  asset({ id: "risk-warning-10", relativePath: "风险管理部/制度/贷后风险预警管理办法V1.0.docx", title: "贷后风险预警管理办法", format: "docx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", effectiveDateRequired: true, series: "post-loan-warning", summary: "历史预警制度。" }),
  asset({ id: "risk-warning-20", relativePath: "风险管理部/制度/贷后风险预警管理办法V2.0.docx", title: "贷后风险预警管理办法", format: "docx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "2.0", effectiveDateRequired: true, series: "post-loan-warning", supersedes: "risk-warning-10", summary: "现行预警制度，定义风险分层和升级时限。" }),
  asset({ id: "risk-warning-21", relativePath: "风险管理部/制度/贷后风险预警管理办法V2.1.docx", title: "贷后风险预警管理办法", format: "docx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "2.1", effectiveDateRequired: true, series: "post-loan-warning", supersedes: "risk-warning-20", showcase: true, summary: "候选版本，增加舆情和司法信息核查要求。" }),
  asset({ id: "risk-indicators", relativePath: "风险管理部/规则/风险预警指标阈值V3.0.xlsx", title: "风险预警指标阈值", format: "xlsx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "3.0", summary: "逾期、担保、财务和舆情风险阈值样例。" }),
  asset({ id: "risk-inspection", relativePath: "风险管理部/SOP/企业贷后检查作业规程V1.4.docx", title: "企业贷后检查作业规程", format: "docx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.4", effectiveDateRequired: true, summary: "贷后检查、证据收集和升级处置流程。" }),
  asset({ id: "risk-collateral", relativePath: "风险管理部/规则/抵质押物核查清单V1.1.xlsx", title: "抵质押物核查清单", format: "xlsx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.1", summary: "权属、估值、保险和处置检查项。" }),
  asset({ id: "risk-reporting", relativePath: "风险管理部/SOP/风险事件升级处置指引V2.0.pptx", title: "风险事件升级处置指引", format: "pptx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "2.0", effectiveDateRequired: true, summary: "风险事件分级、升级和跟踪闭环。" }),
  asset({ id: "risk-credit-rating", relativePath: "风险管理部/规则/企业信用评级映射V1.0.xlsx", title: "企业信用评级映射", format: "xlsx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", summary: "内部评级、预警等级和处置动作映射。" }),
  asset({ id: "risk-jurisdiction", relativePath: "风险管理部/制度/司法风险信息使用规定V1.0.pdf", title: "司法风险信息使用规定", format: "pdf", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", effectiveDateRequired: true, summary: "司法信息采集、核验和使用边界。" }),
  asset({ id: "risk-review", relativePath: "风险管理部/模板/贷后风险报告模板V1.0.md", title: "贷后风险报告模板", format: "md", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", summary: "风险事实、判断依据和后续动作模板。" }),
  asset({ id: "risk-unversioned", relativePath: "风险管理部/规则/行业风险观察口径.docx", title: "行业风险观察口径", format: "docx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: null, summary: "故意缺少版本，用于整改演示。" }),
  asset({ id: "risk-archive", relativePath: "风险管理部/制度/历史/担保企业风险管理细则V1.0.pdf", title: "担保企业风险管理细则", format: "pdf", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", effectiveDateRequired: true, oldVersion: true, summary: "历史细则。" }),
  asset({ id: "risk-training", relativePath: "风险管理部/培训/贷后风险案例复盘V1.0.pptx", title: "贷后风险案例复盘", format: "pptx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", summary: "虚构案例培训材料。" }),
  asset({ id: "risk-data-dictionary", relativePath: "风险管理部/数据/贷后指标数据字典V1.0.xlsx", title: "贷后指标数据字典", format: "xlsx", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", summary: "风险指标字段、来源和刷新频率。" }),
  asset({ id: "risk-audit-trail", relativePath: "风险管理部/SOP/风险处置留痕规范V1.0.md", title: "风险处置留痕规范", format: "md", department: "风险管理部", domain: "risk", role: "post-loan-risk-control", version: "1.0", summary: "风险事实、审批意见和执行回执留痕要求。" }),

  asset({ id: "insurance-sales-10", relativePath: "保险业务部/制度/保险销售行为管理办法V1.0.md", title: "保险销售行为管理办法", format: "md", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", effectiveDateRequired: true, series: "insurance-sales", summary: "历史保险销售制度。" }),
  asset({ id: "insurance-sales-11", relativePath: "保险业务部/制度/保险销售行为管理办法V1.1.md", title: "保险销售行为管理办法", format: "md", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.1", effectiveDateRequired: true, series: "insurance-sales", supersedes: "insurance-sales-10", summary: "当前演示销售制度。" }),
  asset({ id: "insurance-sales-20", relativePath: "保险业务部/制度/保险销售行为管理办法V2.0.md", title: "保险销售行为管理办法", format: "md", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "2.0", effectiveDateRequired: true, series: "insurance-sales", supersedes: "insurance-sales-11", showcase: true, summary: "候选新版本，增加需求分析和回访要求。" }),
  asset({ id: "insurance-products", relativePath: "保险业务部/产品/保险产品责任清单V2026.08.xlsx", title: "保险产品责任清单", format: "xlsx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "2026.08", summary: "车险、健康险和意外险责任样例。" }),
  asset({ id: "insurance-renewal", relativePath: "保险业务部/SOP/续保客户经营指引V1.2.docx", title: "续保客户经营指引", format: "docx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.2", effectiveDateRequired: true, summary: "续保客户筛选、访前准备和异议处理。" }),
  asset({ id: "insurance-needs", relativePath: "保险业务部/SOP/客户保障需求分析规程V1.0.pptx", title: "客户保障需求分析规程", format: "pptx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", effectiveDateRequired: true, summary: "客户家庭责任、保障缺口和预算分析。" }),
  asset({ id: "insurance-comparison", relativePath: "保险业务部/产品/保险产品对比表V1.0.xlsx", title: "保险产品对比表", format: "xlsx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", summary: "责任范围、免赔额和等待期对比。" }),
  asset({ id: "insurance-claims", relativePath: "保险业务部/SOP/理赔协助操作指引V1.0.md", title: "理赔协助操作指引", format: "md", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", effectiveDateRequired: true, summary: "理赔材料清单和客户沟通边界。" }),
  asset({ id: "insurance-disclosure", relativePath: "保险业务部/制度/保险产品风险揭示规定V1.0.pdf", title: "保险产品风险揭示规定", format: "pdf", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", effectiveDateRequired: true, summary: "费用、退保损失和除外责任揭示要求。" }),
  asset({ id: "insurance-script", relativePath: "保险业务部/培训/客户异议沟通陪练V1.0.pptx", title: "客户异议沟通陪练", format: "pptx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", summary: "虚构客户异议和规范回应示例。" }),
  asset({ id: "insurance-unversioned", relativePath: "保险业务部/客户/家庭保障访谈提纲.docx", title: "家庭保障访谈提纲", format: "docx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: null, summary: "故意缺少版本。" }),
  asset({ id: "insurance-archive", relativePath: "保险业务部/制度/历史/保险回访管理细则V1.0.pdf", title: "保险回访管理细则", format: "pdf", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", effectiveDateRequired: true, oldVersion: true, summary: "历史回访制度。" }),
  asset({ id: "insurance-checklist", relativePath: "保险业务部/模板/投保资料检查清单V1.0.xlsx", title: "投保资料检查清单", format: "xlsx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", summary: "身份、健康告知和支付资料检查项。" }),
  asset({ id: "insurance-record", relativePath: "保险业务部/制度/销售过程留痕规范V1.0.md", title: "销售过程留痕规范", format: "md", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", effectiveDateRequired: true, summary: "需求分析、产品说明和客户确认留痕。" }),
  asset({ id: "insurance-faq", relativePath: "保险业务部/产品/保险服务常见问答V1.0.docx", title: "保险服务常见问答", format: "docx", department: "保险业务部", domain: "insurance", role: "insurance-advisor", version: "1.0", summary: "保全、续期、理赔和退保常见问题。" }),

  asset({ id: "audit-material-policy", relativePath: "运营管理部/智能审核/制度/业务材料审核管理办法V1.0.docx", title: "业务材料审核管理办法", format: "docx", department: "运营管理部", domain: "audit", role: "credential-compliance", version: "1.0", effectiveDateRequired: true, summary: "审核受理、疑点升级和人工复核要求。" }),
  asset({ id: "audit-checklist", relativePath: "运营管理部/智能审核/规则/凭证审核检查清单V2.0.xlsx", title: "凭证审核检查清单", format: "xlsx", department: "运营管理部", domain: "audit", role: "credential-compliance", version: "2.0", summary: "凭证完整性、一致性和合规检查项。" }),
  asset({ id: "audit-review-sop", relativePath: "运营管理部/智能审核/SOP/人工复核操作规程V1.1.pptx", title: "人工复核操作规程", format: "pptx", department: "运营管理部", domain: "audit", role: "credential-compliance", version: "1.1", effectiveDateRequired: true, summary: "疑点确认、复核责任和处理回执流程。" }),
  asset({ id: "audit-reason-codes", relativePath: "运营管理部/智能审核/规则/审核疑点原因码V1.0.xlsx", title: "审核疑点原因码", format: "xlsx", department: "运营管理部", domain: "audit", role: "credential-compliance", version: "1.0", summary: "缺件、金额异常和信息不一致原因码。" }),
  asset({ id: "audit-evidence", relativePath: "运营管理部/智能审核/制度/审核证据留存规定V1.0.pdf", title: "审核证据留存规定", format: "pdf", department: "运营管理部", domain: "audit", role: "credential-compliance", version: "1.0", effectiveDateRequired: true, summary: "审核依据、证据和人工确认记录要求。" }),
  asset({ id: "ops-service", relativePath: "运营管理部/流程/客户服务流程.docx", title: "客户服务流程", format: "docx", department: "运营管理部", domain: "general", role: null, version: null, summary: "故意缺少版本和岗位映射。" }),
  asset({ id: "ops-handover", relativePath: "运营管理部/流程/跨部门交接SOP V1.0.md", title: "跨部门交接SOP", format: "md", department: "运营管理部", domain: "general", role: null, version: "1.0", summary: "故意保留通用域，供管理员补充适用岗位。" }),
  asset({ id: "ops-contact", relativePath: "运营管理部/目录/内部服务通讯录V2026.08.xlsx", title: "内部服务通讯录", format: "xlsx", department: "运营管理部", domain: "general", role: null, version: "2026.08", summary: "演示不应直接进入岗位 Runtime 的通用资产。" }),
  asset({ id: "ops-emergency", relativePath: "运营管理部/制度/运营应急管理办法V1.0.pdf", title: "运营应急管理办法", format: "pdf", department: "运营管理部", domain: "general", role: null, version: "1.0", effectiveDateRequired: true, summary: "通用运营制度，需要人工确认岗位范围。" }),
  asset({ id: "ops-training", relativePath: "运营管理部/培训/新员工操作培训V1.0.pptx", title: "新员工操作培训", format: "pptx", department: "运营管理部", domain: "general", role: null, version: "1.0", summary: "通用培训资产，需要人工确认岗位范围。" }),
];

function markdown(spec: DemoAssetSpec): string {
  return [
    `# ${spec.title}`,
    "",
    "> 本文件为 GRACE 演示银行虚构资产，仅用于产品演示与测试，不代表任何真实机构制度或业务意见。",
    "",
    "## 适用范围",
    "",
    `${spec.summary} 适用于演示银行内部受授权岗位，使用时必须核验客户归属、数据时点和当前有效版本。`,
    "",
    "## 工作要求",
    "",
    "1. 先确认任务所需事实是否完整，不以长期记忆替代实时业务数据。",
    "2. 只采用当前有效且与岗位、机构和用途相符的企业依据。",
    "3. 涉及写入、发送或业务状态变更时，必须经过策略校验和必要的人工确认。",
    "4. 输出应保留依据、数据时点和执行回执，便于审计定位。",
    "",
    "## 演示条款",
    "",
    `- 资产编号：${spec.id}`,
    `- 版本：${spec.version || "待确认"}`,
    `- 责任部门：${spec.department}`,
    `- 说明：${spec.summary}`,
    "",
  ].join("\n");
}

function pdf(spec: DemoAssetSpec): Buffer {
  const lines = [
    "GRACE Demo Bank Enterprise Asset",
    `Asset ID: ${spec.id}`,
    `Version: ${spec.version || "pending confirmation"}`,
    `Department: ${spec.domain}`,
    "Fictional demo content only. Not a real policy or business opinion.",
    "Runtime use requires valid version, permission, and task context.",
  ];
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = ["BT", "/F1 18 Tf", "72 740 Td", `(${escape(lines[0])}) Tj`, "/F1 11 Tf", ...lines.slice(1).flatMap(line => ["0 -26 Td", `(${escape(line)}) Tj`]), "ET", ""].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let value = "%PDF-1.4\n%GRACE\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value, "latin1"));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value, "latin1");
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value, "latin1");
}

function normalizeOfficeArchive(target: string): void {
  const source = new AdmZip(target);
  const normalized = new AdmZip();
  for (const entry of source.getEntries().sort((left, right) => left.entryName.localeCompare(right.entryName))) {
    let content = entry.getData();
    if (entry.entryName === "docProps/core.xml") {
      content = Buffer.from(content.toString("utf8").replace(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
        "2026-08-20T00:00:00Z",
      ));
    }
    const added = normalized.addFile(entry.entryName, content, entry.comment, entry.attr);
    added.header.time = CORPUS_TIME;
  }
  writeFileSync(target, normalized.toBuffer());
}

function writeGeneratedAsset(spec: DemoAssetSpec, generatedById: Map<string, string>): string {
  const target = path.join(ASSET_ROOT, spec.relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  if (spec.duplicateOf) {
    const source = generatedById.get(spec.duplicateOf);
    if (!source) throw new Error(`重复资产引用尚未生成: ${spec.duplicateOf}`);
    copyFileSync(source, target);
    return target;
  }
  if (spec.format === "md") {
    writeFileSync(target, markdown(spec), "utf8");
    return target;
  }
  if (spec.format === "pdf") {
    writeFileSync(target, pdf(spec));
    return target;
  }
  const python = process.env.KNOWLEDGE_PYTHON || path.join(process.env.HOME || "/home/ubuntu", ".venvs", "employee-agent-knowledge", "bin", "python");
  const helper = path.join(APP_ROOT, "scripts", "generate_demo_office_asset.py");
  execFileSync(python, [
    helper,
    "--format", spec.format,
    "--output", target,
    "--title", spec.title,
    "--summary", spec.summary,
    "--asset-id", spec.id,
    "--version", spec.version || "",
    "--department", spec.department,
  ], { stdio: "pipe" });
  normalizeOfficeArchive(target);
  return target;
}

function expectedDiagnostics(spec: DemoAssetSpec): string[] {
  return [
    ...(!spec.version ? ["MISSING_VERSION"] : []),
    ...(spec.effectiveDateRequired ? ["MISSING_EFFECTIVE_DATE"] : []),
    ...(!spec.role ? ["ROLE_UNRESOLVED"] : []),
    ...(spec.oldVersion ? ["SUSPECTED_OLD_VERSION"] : []),
    ...(spec.duplicateOf ? ["DUPLICATE_CONTENT"] : []),
  ].sort();
}

function logicalAssets(spec: DemoAssetSpec): string[] {
  return spec.effectiveDateRequired && spec.domain !== "general" ? [`current_${spec.domain}_policy`] : [];
}

function generate(): void {
  if (ASSETS.length !== 60) throw new Error(`Demo Asset Pack 必须包含 60 份资产，当前为 ${ASSETS.length}`);

  rmSync(GENERATED_ROOT, { recursive: true, force: true });
  mkdirSync(ASSET_ROOT, { recursive: true });
  const generatedById = new Map<string, string>();
  const truth: GroundTruthAsset[] = [];
  for (const spec of ASSETS) {
    const target = writeGeneratedAsset(spec, generatedById);
    generatedById.set(spec.id, target);
    const content = readFileSync(target);
    truth.push({
      ...spec,
      checksum: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.length,
      expectedDiagnostics: expectedDiagnostics(spec),
      expectedLogicalAssetCandidates: logicalAssets(spec),
    });
  }

  const zip = new AdmZip();
  for (const item of truth) {
    const added = zip.addFile(item.relativePath, readFileSync(path.join(ASSET_ROOT, item.relativePath)));
    added.header.time = CORPUS_TIME;
  }
  writeFileSync(ZIP_PATH, zip.toBuffer());

  const formatCounts = Object.fromEntries([...new Set(truth.map(item => item.format))].sort().map(format => [
    format,
    truth.filter(item => item.format === format).length,
  ]));
  const departmentCounts = Object.fromEntries([...new Set(truth.map(item => item.department))].map(department => [
    department,
    truth.filter(item => item.department === department).length,
  ]));
  const payload = {
    schemaVersion: "grace.demo-enterprise-assets/v1",
    generatedAt: CORPUS_TIME.toISOString(),
    disclaimer: "全部内容均为虚构演示资产，不代表任何真实机构、客户、产品、制度或投资意见。",
    sourceId: "demo-bank-assets-v1",
    ownerDepartment: "演示银行企业资产管理部",
    assetCount: truth.length,
    totalBytes: truth.reduce((sum, item) => sum + item.sizeBytes, 0),
    formatCounts,
    departmentCounts,
    assets: truth,
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    packRoot: path.relative(APP_ROOT, GENERATED_ROOT),
    zip: path.relative(APP_ROOT, ZIP_PATH),
    manifest: path.relative(APP_ROOT, MANIFEST_PATH),
    assetCount: truth.length,
    totalBytes: payload.totalBytes,
    formatCounts,
    departmentCounts,
  }, null, 2)}\n`);
}

generate();
