export type SkillValueEvidenceDimension = {
  id: string;
  label: string;
  leftScore: number;
  rightScore: number;
  reason: string;
};

export type SkillValueEvidenceJob = {
  jobId: string;
  skillId: string;
  skillName: string;
  roleTemplate: string;
  status: string;
  stageLabel: string;
  createdAt: string;
  updatedAt: string;
  left: {
    modelId: string;
    skillVersion: string | null;
    skillVersionId?: string | null;
    skillArtifactSha256?: string | null;
  };
  right: {
    modelId: string;
    skillVersion: string | null;
    skillVersionId?: string | null;
    skillArtifactSha256?: string | null;
  };
  cases: Array<{
    promptId: string;
    name: string;
    prompt: string;
    evaluationGoal: string;
    left: {
      status: string;
      assistantText: string;
      elapsedMs: number;
      error: string | null;
    } | null;
    right: {
      status: string;
      assistantText: string;
      elapsedMs: number;
      error: string | null;
    } | null;
    judge: {
      winner: "left" | "right" | "tie";
      confidence: "low" | "medium" | "high";
      summary: string;
      dimensions: SkillValueEvidenceDimension[];
      reviewerLabel: string;
    } | null;
    judgeError: string | null;
  }>;
  promptfoo: { version: string; completed: boolean };
  evaluationEngine: { id: string; version: string };
  judge: { modelId: string; completedCases: number };
  summary: {
    leftWins: number;
    rightWins: number;
    ties: number;
    unavailable: number;
    headline: string;
  } | null;
  configurationFingerprint: string;
  reportFingerprint: string | null;
  error: string | null;
};

export type SkillValueEvidenceSummary = {
  comparisonType: string;
  headline: string;
  winner: "left" | "right" | "tie" | "unavailable";
  winnerLabel: string;
  completedSides: number;
  totalSides: number;
  judgedCases: number;
  highConfidenceCases: number;
  averageElapsedSeconds: { left: number | null; right: number | null };
  dimensions: Array<{
    id: string;
    label: string;
    leftScore: number;
    rightScore: number;
    delta: number;
  }>;
  evidenceStatus: "complete" | "partial" | "interrupted";
  evidenceLabel: string;
};

function sideLabel(
  side: SkillValueEvidenceJob["left"],
  fallback: string
): string {
  return `${side.skillVersion ? `v${side.skillVersion}` : "无 Skill"} · ${side.modelId || fallback}`;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function averageElapsed(
  job: SkillValueEvidenceJob,
  side: "left" | "right"
): number | null {
  const completed = job.cases
    .map(item => item[side])
    .filter(
      (result): result is NonNullable<typeof result> =>
        result?.status === "completed"
    );
  if (!completed.length) return null;
  return rounded(
    completed.reduce((total, result) => total + result.elapsedMs, 0) /
      completed.length /
      1_000
  );
}

export function buildSkillValueEvidenceSummary(
  job: SkillValueEvidenceJob
): SkillValueEvidenceSummary {
  const sameModel = job.left.modelId === job.right.modelId;
  const sameSkillVersion = job.left.skillVersion === job.right.skillVersion;
  const comparisonType = sameModel
    ? job.left.skillVersion && job.right.skillVersion
      ? "Skill 版本对比"
      : "Skill 增益对比"
    : sameSkillVersion
      ? "模型对比"
      : "综合配置对比";
  const totalSides = job.cases.length * 2;
  const completedSides = job.cases.reduce(
    (total, item) =>
      total +
      (item.left?.status === "completed" ? 1 : 0) +
      (item.right?.status === "completed" ? 1 : 0),
    0
  );
  const dimensionBuckets = new Map<
    string,
    {
      label: string;
      left: number[];
      right: number[];
    }
  >();
  for (const item of job.cases) {
    for (const dimension of item.judge?.dimensions || []) {
      const bucket = dimensionBuckets.get(dimension.id) || {
        label: dimension.label,
        left: [],
        right: [],
      };
      bucket.left.push(dimension.leftScore);
      bucket.right.push(dimension.rightScore);
      dimensionBuckets.set(dimension.id, bucket);
    }
  }
  const dimensions = [...dimensionBuckets.entries()].map(([id, bucket]) => {
    const leftScore = rounded(
      bucket.left.reduce((sum, score) => sum + score, 0) / bucket.left.length
    );
    const rightScore = rounded(
      bucket.right.reduce((sum, score) => sum + score, 0) / bucket.right.length
    );
    return {
      id,
      label: bucket.label,
      leftScore,
      rightScore,
      delta: rounded(rightScore - leftScore),
    };
  });
  const winner =
    !job.summary || job.summary.unavailable === job.cases.length
      ? "unavailable"
      : job.summary.rightWins > job.summary.leftWins
        ? "right"
        : job.summary.leftWins > job.summary.rightWins
          ? "left"
          : "tie";
  const winnerLabel =
    winner === "right"
      ? `B：${sideLabel(job.right, "未记录模型")}`
      : winner === "left"
        ? `A：${sideLabel(job.left, "未记录模型")}`
        : winner === "tie"
          ? "A / B 表现持平"
          : "尚未形成有效结论";
  const evidenceStatus =
    job.status !== "completed"
      ? "interrupted"
      : job.summary?.unavailable
        ? "partial"
        : "complete";
  return {
    comparisonType,
    headline: job.summary?.headline || job.error || job.stageLabel,
    winner,
    winnerLabel,
    completedSides,
    totalSides,
    judgedCases: job.cases.filter(item => item.judge).length,
    highConfidenceCases: job.cases.filter(
      item => item.judge?.confidence === "high"
    ).length,
    averageElapsedSeconds: {
      left: averageElapsed(job, "left"),
      right: averageElapsed(job, "right"),
    },
    dimensions,
    evidenceStatus,
    evidenceLabel:
      evidenceStatus === "complete"
        ? "证据完整"
        : evidenceStatus === "partial"
          ? "部分题目未判定"
          : "本轮执行中断",
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function sideArtifactLine(side: SkillValueEvidenceJob["left"]): string {
  if (!side.skillVersion) return "不装配当前 Skill";
  const identity = [
    `v${side.skillVersion}`,
    side.skillVersionId ? `版本 ID ${side.skillVersionId}` : "",
    side.skillArtifactSha256 ? `Artifact ${side.skillArtifactSha256}` : "",
  ].filter(Boolean);
  return identity.join("；");
}

export function buildSkillValueEvidenceMarkdown(
  job: SkillValueEvidenceJob
): string {
  const evidence = buildSkillValueEvidenceSummary(job);
  const lines = [
    `# ${job.skillName} Skill 价值评测证据`,
    "",
    `- Skill：\`${job.skillId}\``,
    `- 评测任务：\`${job.jobId}\``,
    `- 完成时间：${job.updatedAt}`,
    `- 对比类型：${evidence.comparisonType}`,
    `- 结论：**${evidence.headline}**`,
    `- 较优配置：${evidence.winnerLabel}`,
    `- 证据状态：${evidence.evidenceLabel}`,
    "",
    "## 对比配置",
    "",
    "| 侧别 | Skill | 模型 |",
    "|---|---|---|",
    `| A | ${markdownCell(sideArtifactLine(job.left))} | ${markdownCell(job.left.modelId)} |`,
    `| B | ${markdownCell(sideArtifactLine(job.right))} | ${markdownCell(job.right.modelId)} |`,
    "",
    "## 四维专业评分",
    "",
    "| 维度 | A 均分 | B 均分 | B-A |",
    "|---|---:|---:|---:|",
    ...evidence.dimensions.map(
      item =>
        `| ${markdownCell(item.label)} | ${item.leftScore.toFixed(1)} | ${item.rightScore.toFixed(1)} | ${item.delta > 0 ? "+" : ""}${item.delta.toFixed(1)} |`
    ),
    "",
    "## 逐题证据",
    "",
  ];
  job.cases.forEach((item, index) => {
    lines.push(
      `### ${index + 1}. ${item.name}`,
      "",
      `**测试目标：** ${item.evaluationGoal}`,
      "",
      `**题目：** ${item.prompt}`,
      "",
      `**Judge 结论：** ${item.judge ? `${item.judge.winner === "left" ? "A 更优" : item.judge.winner === "right" ? "B 更优" : "持平"}；置信度 ${item.judge.confidence}；${item.judge.summary}` : item.judgeError || "未判定"}`,
      ""
    );
    if (item.judge?.dimensions.length) {
      lines.push(
        "| 维度 | A | B | 评审依据 |",
        "|---|---:|---:|---|",
        ...item.judge.dimensions.map(
          dimension =>
            `| ${markdownCell(dimension.label)} | ${dimension.leftScore} | ${dimension.rightScore} | ${markdownCell(dimension.reason)} |`
        ),
        ""
      );
    }
    lines.push(
      "#### A 输出",
      "",
      item.left?.assistantText || item.left?.error || "未产生输出",
      "",
      "#### B 输出",
      "",
      item.right?.assistantText || item.right?.error || "未产生输出",
      ""
    );
  });
  lines.push(
    "## 方法与完整性",
    "",
    `- 执行方法：同题、同环境左右对照；${job.judge.modelId} 匿名业务 Judge。`,
    `- 执行器：Finance Skill Eval ${job.evaluationEngine.version}；Promptfoo ${job.promptfoo.version}。`,
    `- 成功执行：${evidence.completedSides}/${evidence.totalSides} 侧。`,
    `- 有效判定：${evidence.judgedCases}/${job.cases.length} 题，其中高置信度 ${evidence.highConfidenceCases} 题。`,
    `- 配置指纹：\`${job.configurationFingerprint}\``,
    `- 报告指纹：\`${job.reportFingerprint || "历史记录未生成"}\``,
    "",
    "> 本报告证明指定模型、Skill 资产、题目和运行环境下的本轮对比结果，不等同于对所有任务和生产场景的普遍保证。",
    ""
  );
  return lines.join("\n");
}
