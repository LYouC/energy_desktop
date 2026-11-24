import { buildContext } from "../../src/agent/context";
import {
  localDate,
  type State,
  type Proposal,
  type Change,
} from "../../src/domain/model";

// 确定性的模拟交互，供工作区回归测试构造回复和方案。
export function simulateReply(
  state: State,
  sessionId: string,
  text: string,
  focusedId: string | null,
) {
  const context = buildContext(state, sessionId);
  const tasks = context.unfinishedTasks
    .filter((task) => !task.parentId)
    .sort((a, b) =>
      (a.expectedDate || "9999").localeCompare(b.expectedDate || "9999"),
    );
  const focused =
    context.unfinishedTasks.find((task) => task.id === focusedId) ?? tasks[0];
  if (!focused)
    return {
      text: "先记下一件想推进的事吧。可以点击“记下一件事”，只填名称开始，再补充完成条件和时间。模拟模式通过任务表单整理背景。",
      proposal: null,
    };
  if (/开始|卡住|烦|困难/.test(text)) {
    return {
      text: `我们先看「${focused.title}」。${focused.description ? `当前说明为“${focused.description}”。` : "可以先补充最难开始的地方。"}\n\n可以尝试打开现有材料，列出一个需要回答的问题，本轮先留下一个可以继续处理的具体问题。\n\n你可以继续挑战，也可以先记录停点、换方法或休息。需要改安排时，可以单独生成方案。`,
      proposal: null,
    };
  }
  const changes: (Change & { reason: string })[] = [];
  if (/拆分/.test(text)) {
    changes.push({
      id: crypto.randomUUID(),
      taskId: focused.id,
      taskVersion: focused.version,
      label: `拆分「${focused.title}」`,
      reason: "模拟三个近期步骤，请根据真实工作编辑子任务。",
      type: "split",
      date: "",
      scope: "",
      children: [
        {
          title: "整理已有材料与缺口",
          description: "得到一份材料与待解决问题清单",
        },
        {
          title: "完成一个关键部分",
          description: "形成一份可以检查的阶段产出",
        },
        {
          title: "对照目标检查与补齐",
          description: "结合父任务说明，列出已满足和仍需补齐的内容",
        },
      ],
    });
  } else {
    for (const task of tasks.slice(0, 3)) {
      changes.push({
        id: crypto.randomUUID(),
        taskId: task.id,
        taskVersion: task.version,
        label: `今天推进「${task.title}」`,
        reason: `${task.expectedDate ? `预计 ${task.expectedDate} 完成。` : "预计完成日期尚未填写。"}${task.description ? `参考任务说明：${task.description}` : "请结合真实时间条件检查。"}`,
        type: "schedule",
        date: localDate(),
        scope: `推进「${task.title}」，先明确一个具体产出`,
        children: [],
      });
    }
  }
  const proposal: Proposal = {
    id: crypto.randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    cards: changes.map(({ reason, ...change }) => ({
      id: crypto.randomUUID(),
      taskId: change.taskId,
      title: change.label,
      reason,
      status: "pending",
      changes: [change],
    })),
  };
  return {
    text: `已读取最新状态「${context.energy.value ?? "尚未说明"}」、今日安排和 ${context.unfinishedTasks.length} 项未完成任务。\n\n下面是用于试操作的模拟方案。请逐项检查今日范围与真实时间条件，再接受需要的部分。任务价值、容量冲突和精力适配，留待真实 Agent 接入后验证。`,
    proposal,
  };
}
