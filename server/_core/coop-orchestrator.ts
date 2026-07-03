/**
 * 岗位智能体协作 V2 - Orchestrator
 *
 * 职责：接收一个 coop session 的 N 份成员结果，合成一份发起人可直接使用的汇总报告
 */
import { llmText } from "./llm-provider";
import { buildAttachmentsBlock, type Attachment } from "./coop-attachment-extractor";

export type MemberResult = {
  targetName: string;
  groupName: string | null;
  subtask: string;
  status: string; // completed / rejected / failed
  result: string | null;
  attachments?: Attachment[];  // 2026-04-17: 接收方 CoopChatBox 提交时上传的附件
};

export type ConsolidateInput = {
  sessionTitle: string;
  originMessage: string;
  members: MemberResult[];
  customInstructions?: string; // 2026-04-17: 发起人可填的自定义汇总指令（如"按部门分组""限500字""公文风格"）
};

const SYSTEM_PROMPT = `你是严谨的企业协作汇总助手。规则：
1. 只报具体数字、文件名、指标。严禁写大家都很努力通力合作这类套话。
2. 输出 markdown，含标题、条目、必要时的表格。
3. 如果有成员拒绝或失败，明确列出缺失部分。
4. 末尾追加一段协作统计：N 位参与、M 个子任务完成、关键数据引用清单。
5. 输出直接从正文开始，不要写好的以下是等开场白。`;

export async function consolidateCoopSession(input: ConsolidateInput): Promise<{ draft: string; providerUsed: string }> {
  const completed = input.members.filter((m) => m.status === "completed" && m.result);
  const rejected = input.members.filter((m) => m.status === "rejected");
  const failed = input.members.filter((m) => m.status === "failed");

  if (completed.length === 0) {
    return {
      draft: `# ${input.sessionTitle}\n\n**暂无可汇总的成果。**\n\n- 拒绝：${rejected.length} 人\n- 失败：${failed.length} 人`,
      providerUsed: "local-fallback",
    };
  }

  // 2026-04-17 A 阶段：附件清单（只列 name + size）拼到每位成员结果后
  // B 阶段（演示后）改 extractText: true 让 server 解析 docx/pdf 文本喂给 LLM
  const memberBlocks = await Promise.all(
    completed.map(async (m, i) => {
      const attBlock = await buildAttachmentsBlock(m.attachments, { extractText: false });
      return `### 成员 ${i + 1}:${m.targetName}·${m.groupName || "默认组"}\n**分配子任务**:${m.subtask}\n\n**执行结果**:\n${m.result}${attBlock}`;
    })
  );
  const resultsBlock = memberBlocks.join("\n\n---\n\n");

  const issuesBlock =
    rejected.length > 0 || failed.length > 0
      ? `\n\n### ⚠️ 未完成项\n` +
        rejected.map((m) => `- ${m.targetName}（${m.groupName}）**拒绝**了子任务：${m.subtask}`).join("\n") +
        (rejected.length && failed.length ? "\n" : "") +
        failed.map((m) => `- ${m.targetName}（${m.groupName}）**执行失败**：${m.subtask}`).join("\n")
      : "";

  // 自定义指令（发起人填写）拼到 user prompt 顶部，优先级高于默认 system rules
  const customBlock = input.customInstructions?.trim()
    ? `\n\n**⚠️ 发起人特别要求（请优先满足）**：\n${input.customInstructions.trim()}\n`
    : "";

  const userPrompt = `任务：${input.sessionTitle}
发起消息：${input.originMessage}${customBlock}

以下是 ${completed.length} 位成员并行完成的子任务结果：

${resultsBlock}${issuesBlock}

请合成为一份专业的业务汇总报告（markdown），严格遵循 system 提示的规则${input.customInstructions?.trim() ? "，并优先满足上面的发起人特别要求" : ""}。`;

  try {
    const content = await llmText(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 2500, temperature: 0.3 }
    );
    return { draft: content || "（模型返回为空，请手工汇总）", providerUsed: "llm" };
  } catch (e: any) {
    console.error("[coop-orchestrator] LLM call failed:", e?.message || e);
    // fallback：简单拼接各成员结果
    const fallback = [
      `# ${input.sessionTitle}`,
      "",
      `> 由于 LLM 调用失败，以下为各成员原始结果拼接，请手工整理。`,
      "",
      ...completed.map((m, i) => `## ${i + 1}. ${m.targetName}·${m.groupName || ""}\n\n${m.result || ""}`),
      issuesBlock,
    ].join("\n\n");
    return { draft: fallback, providerUsed: "local-fallback" };
  }
}
