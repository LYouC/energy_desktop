import { buildContext } from "../../shared/context";
import {
  localDate,
  type State,
  type Proposal,
  type Change,
} from "../../shared/model";

// A deterministic interaction fixture. Real model reasoning is deferred.
export function simulateReply(
  state: State,
  sessionId: string,
  text: string,
  focusedId: string | null,
) {
  const context = buildContext(state, sessionId);
  const tasks = context.unfinishedTasks
    .filter((task) => !task.parentId)
    .sort((a, b) => {
      const rank = { 高: 0, 中: 1, 低: 2, 待定: 3 };
      return (
        (a.deadline || "9999").localeCompare(b.deadline || "9999") ||
        rank[a.importance] - rank[b.importance]
      );
    });
  const focused = tasks.find((task) => task.id === focusedId) ?? tasks[0];
  if (!focused)
    return {
      text: "先记下一件想推进的事吧。可以点击“记下一件事”，只填名称开始，再补充完成条件和时间。模拟模式通过任务表单整理背景。",
      proposal: null,
    };
  if (/开始|卡住|烦|困难/.test(text)) {
    return {
      text: `我们先看「${focused.title}」。${focused.obstacle ? `你记录的阻力是“${focused.obstacle}”。` : "目前还没有记录具体阻力，可以先补充最难开始的地方。"}\n\n下一步可以从这里继续：${focused.nextStep || "打开现有材料，列出一个需要回答的问题。"}\n本轮结束条件：${focused.goal || "留下一个可以继续处理的具体问题。"}\n\n你可以继续挑战，也可以先记录停点、换方法或休息。需要改安排时，可以单独生成方案。`,
      proposal: null,
    };
  }
  const changes: Change[] = [];
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
      status: "pending",
      children: [
        { title: "整理已有材料与缺口", goal: "得到一份材料与待解决问题清单" },
        { title: "完成一个关键部分", goal: "形成一份可以检查的阶段产出" },
        {
          title: "对照目标检查与补齐",
          goal: focused.goal || "对照原目标列出已满足和仍需补齐的内容",
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
        reason: `重要性${task.importance}，${task.deadline ? `截止 ${task.deadline.replace("T", " ")}` : "真实截止待明确"}。${task.plannedDate && task.plannedDate < localDate() ? "之前的计划日期已过，重新判断本次范围。" : ""}`,
        type: "schedule",
        date: localDate(),
        scope:
          task.nextStep || task.goal || "先明确一个具体产出，再补充今日范围",
        children: [],
        status: "pending",
      });
    }
  }
  const proposal: Proposal = {
    id: crypto.randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    changes,
  };
  return {
    text: `已读取最新状态「${context.energy.value ?? "尚未说明"}」、今日安排和 ${context.unfinishedTasks.length} 项未完成任务。\n\n下面是用于试操作的模拟方案。请逐项检查今日范围与真实时间条件，再接受需要的部分。任务价值、容量冲突和精力适配，留待真实 Agent 接入后验证。`,
    proposal,
  };
}
