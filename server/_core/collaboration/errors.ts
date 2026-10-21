// Safe platform instruction; carries no private resource details to callers.
export class CollaborationAwaitingResources extends Error {
  constructor() {
    super(
      "仍有本次协作的回复、本人确认或未知写入结果尚未核实。请调用 checkpoint_collaboration_goal 保存进度并结束本轮等待，平台会在结果到达后自动唤醒；不要重试答复或宣称调整已完成。"
    );
  }
}
