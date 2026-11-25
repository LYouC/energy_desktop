import { legacyProposalSchema, stateSchema, type State } from "../domain/model";

function adjustmentCards(proposals: unknown, invalidatePending = false) {
  return legacyProposalSchema
    .array()
    .parse(proposals)
    .map(({ changes, ...proposal }) => ({
      ...proposal,
      legacy: true as const,
      cards: changes.map(({ reason, status, ...change }) => ({
        id: change.id,
        taskId: change.taskId,
        title: change.label,
        reason,
        status: invalidatePending && status === "pending" ? "rejected" : status,
        changes: [change],
      })),
    }));
}

export function migrateWorkspaceProposals(payload: string): State {
  const previous = JSON.parse(payload);
  return stateSchema.parse({
    ...previous,
    proposals: adjustmentCards(previous.proposals),
  });
}

export function migrateWorkspaceV5(payload: string): State {
  const state = stateSchema.parse(JSON.parse(payload));
  // v5 的 todayOnly 只由 advanceTask 产生；新版整项 schedule 在 v6 起复用该标记。
  for (const proposal of state.proposals)
    for (const card of proposal.cards)
      if (
        card.status === "pending" &&
        card.changes.some(
          (change) => change.type === "schedule" && change.todayOnly,
        )
      ) {
        card.status = "rejected";
        card.invalidated = true;
      }
  state.revision++;
  return state;
}

/** v1 的分散文本合入说明；推进日期不是开始日期，不能据此推断。 */
export function migrateWorkspaceV1(payload: string): State {
  const previous = JSON.parse(payload);
  const tasks = previous.tasks.map((task: Record<string, unknown>) => {
    const text = (key: string) =>
      typeof task[key] === "string" ? (task[key] as string) : "";
    const notes = [text("description")];
    const append = (label: string, value: string) => {
      if (value) notes.push(`${label}：${value}`);
    };
    if (text("goal") !== text("title")) append("目标与完成条件", text("goal"));
    append(
      `背景（${text("backgroundKind") || "来源未标明"}）`,
      text("background"),
    );
    append("当前进展", text("progress"));
    append("当前阻力", text("obstacle"));
    append("下一步", text("nextStep"));
    append("截止要求", text("deadline"));
    if (Array.isArray(task.dependencies)) {
      const names = task.dependencies.map(
        (id: unknown) =>
          previous.tasks.find((item: Record<string, unknown>) => item.id === id)
            ?.title ?? id,
      );
      append("前置要求", names.join("、"));
    }
    return {
      ...task,
      importance: null,
      description: notes.filter(Boolean).join("\n\n"),
      startDate: text("startDate"),
    };
  });
  // 旧方案与待创建草稿绑定旧字段，失效处理，避免接受时悄悄丢掉旧修改。
  const proposals = adjustmentCards(previous.proposals, true);
  const sessions = previous.sessions.map(
    (session: State["sessions"][number]) => ({
      ...session,
      ...(session.agentMemory
        ? { agentMemory: { ...session.agentMemory, taskDraft: null } }
        : {}),
    }),
  );
  return stateSchema.parse({
    ...previous,
    revision: previous.revision + 1,
    tasks,
    proposals,
    sessions,
  });
}
