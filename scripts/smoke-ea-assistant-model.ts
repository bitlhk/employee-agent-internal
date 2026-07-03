import "dotenv/config";
import { generateEaSessionTitle, getEaAssistantModelConfig } from "../server/_core/ea-assistant-model";

async function main() {
  const config = getEaAssistantModelConfig();
  const samples = [
    "用户：请调用风控 Agent，对上海瑞能发展有限公司做一次企业风险评估，并返回评估结论\n助手：已成功向风控 Agent 提交企业风险评估任务，任务正在异步处理中。",
    "用户：北京明天天气怎么样\n助手：北京明天多云转晴，气温 25 到 33 度，建议注意防晒。",
    "用户：帮我把这段会议纪要整理成待办事项\n助手：可以，请把会议纪要发给我。",
  ];

  console.log(JSON.stringify({
    model: config.model,
    baseUrl: config.baseUrl.replace(/https:\/\/[^/]+/, "https://***"),
    timeoutMs: config.timeoutMs,
    disableThinking: config.disableThinking,
    apiKeyConfigured: Boolean(config.apiKey),
  }, null, 2));

  for (let i = 0; i < samples.length; i += 1) {
    const result = await generateEaSessionTitle(samples[i]);
    console.log(JSON.stringify({
      run: i + 1,
      title: result.title,
      ms: result.elapsedMs,
      usage: result.usage,
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
