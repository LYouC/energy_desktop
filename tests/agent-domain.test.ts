import { migrateWorkspaceProposals } from "../src/persistence/migrations";
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, newTask, stateSchema } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { agentTurnSchema, applyAgentTurn } from "../src/agent/turn";
import { WorkspaceDatabase } from "../src/persistence/storage";
import { buildContext, readConversation } from "../src/agent/context";

function fixture() {
  return applyCommand(emptyState(), {
    type: "saveTask",
    task: { ...newTask(), title: "英语" },
  });
}

test("Agent按六项属性创建任务，日期不隐式产生每日安排", () => {
  const initial = emptyState();
  const next = applyAgentTurn(
    initial,
    initial.activeSessionId,
    "记下报告准备",
    {
      text: "已记录",
      actions: [
        {
          type: "createTask",
          title: "报告准备",
          mode: "direct",
          patch: {
            description: "交付可讨论的初稿，硬截止2026-11-25下午三点",
            startDate: "2026-11-18",
            expectedDate: "2026-11-23",
            status: "doing",
          },
        },
      ],
    },
  );
  assert.equal(next.tasks[0].startDate, "2026-11-18");
  assert.equal(next.tasks[0].expectedDate, "2026-11-23");
  assert.equal(next.tasks[0].status, "doing");
  assert.match(next.tasks[0].description, /硬截止2026-11-25/);
  assert.deepEqual(next.arrangements, []);
  assert.deepEqual(
    Object.keys(next.tasks[0]).sort(),
    Object.keys(newTask()).sort(),
  );
});

test("Agent同轮新建父子任务可用临时引用指定所属任务", () => {
  const initial = emptyState();
  const next = applyAgentTurn(
    initial,
    initial.activeSessionId,
    "创建报告及资料整理子任务",
    {
      text: "已创建",
      actions: [
        {
          type: "createTask",
          ref: "report",
          title: "报告",
          patch: {},
          mode: "direct",
        },
        {
          type: "createTask",
          title: "资料整理",
          patch: { parentId: "report" },
          mode: "direct",
        },
      ],
    },
  );
  assert.equal(next.tasks[1].parentId, next.tasks[0].id);
});

test("Agent拆分支持简单子任务和完整属性，非法子任务日期整轮回滚", () => {
  const state = fixture();
  const split = {
    type: "split",
    taskId: state.tasks[0].id,
    mode: "direct",
    children: [
      { title: "打开材料" },
      {
        title: "准备初稿",
        description: "整理出两页内容",
        startDate: "2026-11-18",
        expectedDate: "2026-11-20",
        status: "doing",
      },
    ],
  };
  const next = applyAgentTurn(state, state.activeSessionId, "就这样拆", {
    text: "已拆分",
    actions: [split],
  });
  assert.equal(next.tasks[1].description, "");
  assert.equal(next.tasks[2].description, "整理出两页内容");
  assert.equal(next.tasks[2].startDate, "2026-11-18");
  assert.equal(next.tasks[2].expectedDate, "2026-11-20");
  assert.equal(next.tasks[2].status, "doing");
  assert.equal(next.tasks[2].parentId, state.tasks[0].id);
  const before = structuredClone(state);
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, "拆分", {
        text: "拆分",
        actions: [
          {
            ...split,
            children: [
              split.children[0],
              { ...split.children[1], expectedDate: "2026-11-17" },
            ],
          },
        ],
      }),
    /完成日期不能早于/,
  );
  assert.deepEqual(state, before);
});

test("A20 今日优化同时看到已安排和待安排任务，部分推进整卡接受并独立完成", () => {
  const date = "2026-11-24";
  const tomorrow = "2026-11-25";
  const parent = { ...newTask(), title: "整理发票", expectedDate: date };
  const other = { ...newTask(), title: "准备报告", expectedDate: date };
  let state = emptyState();
  for (const task of [parent, other])
    state = applyCommand(state, { type: "saveTask", task }, date);
  state = applyCommand(
    state,
    { type: "schedule", taskId: other.id, date, scope: other.title },
    date,
  );
  const context = buildContext(state, state.activeSessionId, date);
  assert.deepEqual(
    context.today.map(({ taskId }) => taskId),
    [other.id],
  );
  assert.deepEqual(
    context.dueToday.map(({ id }) => id),
    [parent.id],
  );
  const proposed = applyAgentTurn(
    state,
    state.activeSessionId,
    "优化今天",
    {
      text: "建议今天核对本周的发票。",
      actions: [
        {
          type: "split",
          taskId: parent.id,
          mode: "proposal",
          reason: "今天的时间只够处理本周的发票。",
          children: [
            { title: "核对本周发票", todayScope: "核对本周已收到的发票" },
          ],
        },
      ],
    },
    undefined,
    date,
  );
  assert.deepEqual(proposed.tasks, state.tasks);
  assert.deepEqual(proposed.arrangements, state.arrangements);
  const [proposal] = proposed.proposals;
  const resolve = {
    type: "resolve" as const,
    proposalId: proposal.id,
    cardIds: [proposal.cards[0].id],
    accept: true,
  };
  assert.throws(() => applyCommand(proposed, resolve, tomorrow), /原建议当天/);
  const fresh = applyAgentTurn(
    proposed,
    state.activeSessionId,
    "今天就照这样拆并安排",
    {
      text: "已拆分并安排。",
      actions: [
        {
          type: "split",
          taskId: parent.id,
          mode: "direct",
          children: proposal.cards[0].changes[0].children,
        },
      ],
    },
    undefined,
    tomorrow,
  );
  assert.equal(fresh.proposals[0].cards[0].status, "pending");
  assert.equal(fresh.arrangements.at(-1)?.date, tomorrow);
  const rejected = applyCommand(proposed, { ...resolve, accept: false }, date);
  assert.deepEqual(rejected.tasks, state.tasks);
  assert.deepEqual(rejected.arrangements, state.arrangements);
  const accepted = applyCommand(proposed, resolve, date);
  const child = accepted.tasks.find((task) => task.parentId === parent.id)!;
  assert.deepEqual(
    accepted.arrangements.map(({ taskId }) => taskId),
    [other.id, child.id],
  );
  assert.equal(accepted.arrangements[1].scope, "核对本周已收到的发票");
  const finished = applyCommand(
    accepted,
    { type: "setTaskDone", taskId: child.id, done: true },
    date,
  );
  assert.equal(
    finished.tasks.find(({ id }) => id === child.id)?.status,
    "done",
  );
  assert.equal(
    finished.tasks.find(({ id }) => id === parent.id)?.status,
    "todo",
  );
});

test("Agent动作与草稿拒绝旧字段，历史拆分读取时保留旧目标内容", () => {
  for (const field of [
    "goal",
    "deadline",
    "plannedDate",
    "importance",
    "background",
    "dependencies",
  ]) {
    assert.equal(
      agentTurnSchema.safeParse({
        text: "记录",
        actions: [
          {
            type: "createTask",
            title: "任务",
            patch: { [field]: "旧值" },
            mode: "direct",
          },
        ],
      }).success,
      false,
    );
  }
  assert.equal(
    agentTurnSchema.safeParse({
      text: "交流",
      actions: [],
      memory: {
        summary: "",
        taskDraft: { title: "旧草稿", patch: { goal: "旧目标" } },
      },
    }).success,
    false,
  );
  assert.equal(
    agentTurnSchema.safeParse({ text: "更新", actions: [{ type: "context" }] })
      .success,
    false,
  );
  const state = fixture();
  const restored = migrateWorkspaceProposals(
    JSON.stringify({
      ...state,
      proposals: [
        {
          id: "legacy",
          sessionId: state.activeSessionId,
          createdAt: new Date().toISOString(),
          changes: [
            {
              id: "split",
              taskId: state.tasks[0].id,
              taskVersion: state.tasks[0].version,
              type: "split",
              label: "旧拆分",
              reason: "历史",
              date: "",
              scope: "",
              status: "pending",
              children: [{ title: "朗读", goal: "读一页" }],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(
    restored.proposals[0].cards[0].changes[0].children[0].description,
    "读一页",
  );
  const accepted = applyCommand(restored, {
    type: "resolve",
    proposalId: "legacy",
    cardIds: ["split"],
    accept: true,
  });
  assert.equal(accepted.tasks[1].description, "读一页");
});

test("直接采用相同拆分会接受原方案且重试不重复子任务", () => {
  const initial = fixture();
  const taskId = initial.tasks[0].id;
  const children = [
    { title: "朗读一页", description: "朗读完整一页并标记生词" },
  ];
  const proposed = applyAgentTurn(
    initial,
    initial.activeSessionId,
    "怎么拆分",
    {
      text: "拆分待接受",
      actions: [{ type: "split", taskId, children, mode: "proposal" }],
    },
  );
  const proposalId = proposed.proposals[0].id;
  const adopted = applyAgentTurn(
    proposed,
    proposed.activeSessionId,
    "就照这个拆分建好",
    {
      text: "已建立",
      actions: [{ type: "split", taskId, children, mode: "direct" }],
    },
  );
  assert.equal(
    adopted.proposals.find((p) => p.id === proposalId)?.cards[0].status,
    "accepted",
  );
  assert.equal(adopted.tasks.filter((t) => t.parentId === taskId).length, 1);
  const retried = applyCommand(adopted, {
    type: "resolve",
    proposalId,
    cardIds: [adopted.proposals.find((p) => p.id === proposalId)!.cards[0].id],
    accept: true,
  });
  assert.equal(retried.tasks.filter((t) => t.parentId === taskId).length, 1);
});

function arrangementFixture() {
  let state = emptyState();
  const parent = { ...newTask(), title: "报告" };
  const child = { ...newTask(parent.id), title: "整理提纲" };
  state = applyCommand(state, { type: "saveTask", task: parent });
  state = applyCommand(state, { type: "saveTask", task: child });
  state = applyCommand(state, {
    type: "schedule",
    taskId: parent.id,
    date: "2026-11-17",
    scope: "整理报告提纲",
  });
  return { state, parentId: parent.id, childId: child.id };
}

test("更新安排直接父转子原子替换且不重复计算今日工作", () => {
  const { state, parentId, childId } = arrangementFixture();
  const next = applyAgentTurn(
    state,
    state.activeSessionId,
    "今天改为三个问题",
    {
      text: "已更新范围",
      actions: [
        {
          type: "updateArrangement",
          taskId: parentId,
          date: "2026-11-17",
          targetTaskId: childId,
          scope: "列三个讨论问题",
          mode: "direct",
        },
      ],
    },
  );
  assert.equal(next.arrangements.length, 1);
  assert.equal(next.arrangements[0].taskId, childId);
  assert.equal(next.arrangements[0].scope, "列三个讨论问题");
  assert.equal(next.tasks.find((t) => t.id === parentId)?.startDate, "");
  assert.equal(next.tasks.find((t) => t.id === childId)?.startDate, "");
  assert.equal(state.arrangements[0].taskId, parentId);
});

test("更新安排建议待接受，接受后父转子只有一个安排", () => {
  const { state, parentId, childId } = arrangementFixture();
  const proposed = applyAgentTurn(
    state,
    state.activeSessionId,
    "重新看看今天",
    {
      text: "建议缩小范围",
      actions: [
        {
          type: "updateArrangement",
          taskId: parentId,
          date: "2026-11-17",
          targetTaskId: childId,
          scope: "列三个讨论问题",
          mode: "proposal",
        },
      ],
    },
  );
  assert.deepEqual(proposed.arrangements, state.arrangements);
  const proposal = proposed.proposals[0];
  assert.equal(proposal.cards[0].changes[0].fromTaskId, parentId);
  assert.equal(proposal.cards[0].taskId, childId);
  const next = applyCommand(proposed, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [proposal.cards[0].id],
    accept: true,
  });
  assert.equal(next.arrangements.length, 1);
  assert.equal(next.arrangements[0].taskId, childId);
  assert.equal(next.arrangements[0].scope, "列三个讨论问题");
});

test("源安排所属任务变化后拒绝旧替换方案并保留完整状态", () => {
  const { state: initial, parentId, childId } = arrangementFixture();
  let state = applyAgentTurn(initial, initial.activeSessionId, "重新看看", {
    text: "建议调整",
    actions: [
      {
        type: "updateArrangement",
        taskId: parentId,
        date: "2026-11-17",
        targetTaskId: childId,
        scope: "三个问题",
        mode: "proposal",
      },
    ],
  });
  const proposal = state.proposals[0];
  state = applyCommand(state, {
    type: "saveTask",
    task: {
      ...state.tasks.find((t) => t.id === parentId)!,
      description: "用户修正后的目标",
    },
  });
  const before = structuredClone(state);
  assert.throws(
    () =>
      applyCommand(state, {
        type: "resolve",
        proposalId: proposal.id,
        cardIds: [proposal.cards[0].id],
        accept: true,
      }),
    /原安排所属任务已变化/,
  );
  assert.deepEqual(state, before);
});

test("同任务改安排范围保持今日顺序及其他任务安排", () => {
  const { state: initial, parentId, childId } = arrangementFixture();
  const state = applyCommand(initial, {
    type: "schedule",
    taskId: childId,
    date: "2026-11-17",
    scope: "另一个已有阶段",
  });
  const beforeIds = state.arrangements.map((a) => a.taskId);
  const next = applyAgentTurn(state, state.activeSessionId, "改一下今天范围", {
    text: "已更新",
    actions: [
      {
        type: "updateArrangement",
        taskId: parentId,
        date: "2026-11-17",
        scope: "列三个讨论问题",
        mode: "direct",
      },
    ],
  });
  assert.deepEqual(
    next.arrangements.map((a) => a.taskId),
    beforeIds,
  );
  assert.equal(next.arrangements[0].scope, "列三个讨论问题");
  assert.deepEqual(next.arrangements[1], state.arrangements[1]);
});

test("修改不存在的源安排被拒绝且不产生新安排", () => {
  const { state, parentId, childId } = arrangementFixture();
  const before = structuredClone(state);
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, "改一下范围", {
        text: "已改",
        actions: [
          {
            type: "updateArrangement",
            taskId: parentId,
            date: "2026-11-18",
            targetTaskId: childId,
            scope: "三个问题",
            mode: "direct",
          },
        ],
      }),
    /已存在的原taskId/,
  );
  assert.deepEqual(state, before);
});

test("改派与原任务的预计完成日期一起确认，卡内保留两端任务", () => {
  const { state, parentId, childId } = arrangementFixture();
  const actions = [
    {
      type: "updateArrangement",
      mode: "proposal",
      taskId: parentId,
      targetTaskId: childId,
      date: "2026-11-17",
      scope: "写提纲",
      reason: "单独推进提纲",
    },
    {
      type: "updateTask",
      mode: "proposal",
      taskId: parentId,
      patch: { expectedDate: "2026-11-18" },
    },
  ];
  const planned = applyAgentTurn(
    state,
    state.activeSessionId,
    "建议把提纲交给子任务做",
    {
      text: "建议改派并更新报告完成日期。",
      actions,
    },
  );
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, "同时调整两个任务", {
        text: "建议更新两端字段。",
        actions: [
          ...actions,
          {
            type: "updateTask",
            mode: "proposal",
            taskId: childId,
            patch: { expectedDate: "2026-11-18" },
          },
        ],
      }),
    /两端任务的待定调整有重叠/,
  );
  const [proposal] = planned.proposals;
  assert.equal(proposal.cards.length, 1);
  const [card] = proposal.cards;
  const transfer = card.changes.find((change) => change.type === "schedule");
  assert.equal(card.taskId, parentId);
  assert.equal(transfer?.fromTaskTitle, "报告");
  assert.equal(transfer?.targetTaskTitle, "整理提纲");
  const accepted = applyCommand(planned, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [card.id],
    accept: true,
  });
  assert.deepEqual(
    accepted.arrangements.map(({ taskId }) => taskId),
    [childId],
  );
  assert.equal(accepted.tasks[0].expectedDate, "2026-11-18");
});

test("同源替代方案接受一项后另一项失效，同批冲突原子回滚", () => {
  const { state: initial, parentId, childId } = arrangementFixture();
  const alternate = { ...newTask(parentId), title: "另一个阶段" };
  const withAlternate = applyCommand(initial, {
    type: "saveTask",
    task: alternate,
  });
  let state = applyAgentTurn(
    withAlternate,
    withAlternate.activeSessionId,
    "给两个候选方案",
    {
      text: "两个替代候选",
      actions: [
        {
          type: "updateArrangement",
          taskId: parentId,
          date: "2026-11-17",
          targetTaskId: childId,
          scope: "A",
          mode: "proposal",
        },
        {
          type: "updateArrangement",
          taskId: parentId,
          date: "2026-11-17",
          targetTaskId: alternate.id,
          scope: "B",
          mode: "proposal",
        },
      ],
    },
  );
  const proposal = state.proposals[0];
  const allBefore = structuredClone(state);
  assert.throws(
    () =>
      applyCommand(state, {
        type: "resolve",
        proposalId: proposal.id,
        cardIds: proposal.cards.map((c) => c.id),
        accept: true,
      }),
    /原安排已不存在/,
  );
  assert.deepEqual(state, allBefore);
  state = applyCommand(state, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [proposal.cards[0].id],
    accept: true,
  });
  const acceptedBefore = structuredClone(state);
  assert.throws(
    () =>
      applyCommand(state, {
        type: "resolve",
        proposalId: proposal.id,
        cardIds: [proposal.cards[1].id],
        accept: true,
      }),
    /原安排.*需要重新分析/,
  );
  assert.deepEqual(state, acceptedBefore);
  assert.equal(state.arrangements.length, 1);
  assert.equal(state.arrangements[0].scope, "A");
});
test("自然确认按整卡接受，明确缩小范围时只执行新授权", () => {
  const initial = fixture();
  const taskId = initial.tasks[0].id;
  const split = {
    type: "split",
    taskId,
    children: [{ title: "提纲", description: "列出讨论问题" }],
    mode: "proposal",
  } as const;
  const state = applyAgentTurn(
    initial,
    initial.activeSessionId,
    "给拆分和安排建议",
    {
      text: "待接受的调整",
      actions: [
        split,
        {
          type: "schedule",
          taskId,
          date: "2026-11-16",
          scope: "整理材料",
          mode: "proposal",
        },
      ],
    },
  );
  const [proposal] = state.proposals;
  const [card] = proposal.cards;
  assert.equal(proposal.cards.length, 1);
  const narrowed = applyAgentTurn(
    state,
    state.activeSessionId,
    "只拆分，今天先别排",
    {
      text: "已建立子任务",
      actions: [{ ...split, mode: "direct" }],
    },
  );
  assert.equal(narrowed.tasks.length, 2);
  assert.equal(narrowed.arrangements.length, 0);
  assert.equal(narrowed.proposals[0].cards[0].status, "pending");
  const command = {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [card.id],
    accept: true,
    mode: "direct",
  };
  const all = applyAgentTurn(state, state.activeSessionId, "就按这张卡来", {
    text: "已接受调整",
    actions: [command],
  });
  assert.equal(all.tasks.length, 2);
  assert.equal(all.arrangements.length, 1);
  assert.equal(all.proposals[0].cards[0].status, "accepted");
  assert.throws(
    () =>
      applyAgentTurn(narrowed, narrowed.activeSessionId, "就按这张卡来", {
        text: "已接受调整",
        actions: [command],
      }),
    /重新分析/,
  );
});
test("建立任务与待接受拆分可同轮提交，引用由应用分配", () => {
  const state = emptyState();
  const next = applyAgentTurn(
    state,
    state.activeSessionId,
    "记下报告，给个拆分建议",
    {
      text: "已记录，以下拆分待接受",
      actions: [
        {
          type: "createTask",
          title: "报告",
          ref: "new-report",
          patch: { description: "提交报告" },
          mode: "direct",
          quote: "记下报告",
        },
        {
          type: "split",
          taskId: "new-report",
          children: [{ title: "提纲", description: "列出讨论问题" }],
          mode: "proposal",
          quote: "给个拆分建议",
        },
      ],
    },
  );
  assert.equal(next.tasks.length, 1);
  assert.equal(next.proposals[0].cards[0].taskId, next.tasks[0].id);
  assert.equal(next.messages.at(-1)?.proposalId, next.proposals[0].id);
  assert.equal(state.tasks.length, 0);
});
test("移动安排直接生效且不会保留旧日重复安排", () => {
  let state = fixture();
  state = applyCommand(state, {
    type: "schedule",
    taskId: state.tasks[0].id,
    date: "2026-11-16",
    scope: "二十分钟",
  });
  const next = applyAgentTurn(state, state.activeSessionId, "把英语移到明天", {
    text: "已移动",
    actions: [
      {
        type: "schedule",
        taskId: state.tasks[0].id,
        date: "2026-11-17",
        fromDate: "2026-11-16",
        scope: "二十分钟",
        mode: "direct",
        quote: "把英语移到明天",
      },
    ],
  });
  assert.deepEqual(
    next.arrangements.map((a) => a.date),
    ["2026-11-17"],
  );
});
test("说明更新保存停点，预计日期与安排独立", () => {
  const state = fixture();
  const next = applyAgentTurn(state, state.activeSessionId, "没拿到材料", {
    text: "记下了",
    actions: [
      {
        type: "updateTask",
        taskId: state.tasks[0].id,
        patch: { description: "缺少材料，下一步询问材料" },
        mode: "direct",
        quote: "没拿到材料",
      },
    ],
  });
  assert.equal(next.tasks[0].startDate, "");
  assert.equal(next.tasks[0].expectedDate, "");
  assert.equal(next.tasks[0].description, "缺少材料，下一步询问材料");
  assert.deepEqual(next.arrangements, state.arrangements);
});
test("模型判断为讨论或否定时空动作保留任务与安排", () => {
  const state = fixture();
  for (const text of ["还没完成", "要不要改到明天"]) {
    const next = applyAgentTurn(state, state.activeSessionId, text, {
      text: "继续讨论具体情况",
      actions: [],
    });
    assert.deepEqual(next.tasks, state.tasks);
    assert.deepEqual(next.arrangements, state.arrangements);
  }
});
test("后续重复创建失败会撤回整轮早先操作", () => {
  const state = emptyState();
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, "记下报告", {
        text: "已记录",
        actions: [
          {
            type: "createTask",
            title: "报告",
            patch: {},
            mode: "direct",
            quote: "记下报告",
          },
          {
            type: "createTask",
            title: "报告",
            patch: {},
            mode: "direct",
            quote: "添加英语",
          },
        ],
      }),
    /同名/,
  );
  assert.equal(state.tasks.length, 0);
});
test("不能跨会话接受方案，接受重试只生效一次", () => {
  let state = fixture();
  state = applyAgentTurn(state, state.activeSessionId, "建议怎么拆分", {
    text: "拆分建议",
    actions: [
      {
        type: "split",
        taskId: state.tasks[0].id,
        children: [{ title: "朗读", description: "读一页" }],
        mode: "proposal",
        quote: "建议怎么拆分",
      },
    ],
  });
  const proposal = state.proposals[0];
  const turn = {
    text: "已接受",
    actions: [
      {
        type: "resolve",
        proposalId: proposal.id,
        cardIds: [proposal.cards[0].id],
        accept: true,
        mode: "direct",
        quote: "接受这项",
      },
    ],
  };
  const other = applyCommand(state, { type: "session", id: "other" });
  assert.throws(
    () => applyAgentTurn(other, "other", "接受这项", turn),
    /当前对话/,
  );
  state = applyAgentTurn(state, proposal.sessionId, "接受这项", turn);
  state = applyAgentTurn(state, proposal.sessionId, "接受这项", turn);
  assert.equal(state.tasks.length, 2);
});
test("新增方案操作更新任务与阶段，拒绝不改业务数据", () => {
  let state = fixture();
  state = applyCommand(state, {
    type: "schedule",
    taskId: state.tasks[0].id,
    date: "2026-11-16",
    scope: "读一页",
  });
  state = applyAgentTurn(state, state.activeSessionId, "重新分析", {
    text: "建议暂停",
    actions: [
      {
        type: "updateTask",
        taskId: state.tasks[0].id,
        patch: { status: "waiting" },
        mode: "proposal",
        quote: "重新分析",
      },
      {
        type: "stage",
        taskId: state.tasks[0].id,
        date: "2026-11-16",
        done: true,
        mode: "proposal",
        quote: "重新分析",
      },
    ],
  });
  const [p] = state.proposals;
  assert.equal(p.cards.length, 1);
  const command = {
    type: "resolve" as const,
    proposalId: p.id,
    cardIds: [p.cards[0].id],
  };
  const rejected = applyCommand(state, { ...command, accept: false });
  assert.deepEqual(rejected.tasks, state.tasks);
  assert.deepEqual(rejected.arrangements, state.arrangements);
  assert.equal(rejected.proposals[0].cards[0].status, "rejected");
  const accepted = applyCommand(state, { ...command, accept: true });
  assert.equal(accepted.tasks[0].status, "waiting");
  assert.equal(accepted.arrangements[0].done, true);
});
function invoiceAdjustmentFixture(db: WorkspaceDatabase, today: string) {
  const tomorrow = "2026-11-21";
  const invoice = {
    ...newTask(),
    title: "整理发票",
    startDate: today,
    expectedDate: today,
  };
  const state = db.execute(db.load().revision, {
    type: "saveTask",
    task: invoice,
    arrangement: { date: today, scope: "核对发票" },
  });
  const move = {
    type: "schedule",
    mode: "proposal",
    taskId: invoice.id,
    fromDate: today,
    date: tomorrow,
    scope: "核对发票",
    reason: "给今天的报告留出时间",
  };
  const update = {
    type: "updateTask",
    mode: "proposal",
    taskId: invoice.id,
    patch: { expectedDate: tomorrow },
  };
  return { state, invoice, move, update, tomorrow };
}

test("A18 整卡改期与预计日期联动，A06 的另一任务可以单独拒绝", (t) => {
  const today = "2026-11-20";
  const db = new WorkspaceDatabase(":memory:", () => today);
  t.after(() => db.close());
  const {
    state: initial,
    invoice,
    move,
    update,
    tomorrow,
  } = invoiceAdjustmentFixture(db, today);
  const report = { ...newTask(), title: "报告" };
  const state = db.execute(initial.revision, {
    type: "saveTask",
    task: report,
  });
  const suggested = db.commitAgentTurn(
    state.revision,
    state.activeSessionId,
    "帮我调整一下",
    {
      text: "建议调整发票和报告的安排。",
      actions: [
        move,
        update,
        {
          type: "schedule",
          mode: "proposal",
          taskId: report.id,
          date: today,
          scope: "完成初稿",
        },
      ],
    },
  );
  assert.deepEqual(suggested.tasks, state.tasks);
  assert.deepEqual(suggested.arrangements, state.arrangements);
  const [proposal] = suggested.proposals;
  assert.equal(proposal.cards.length, 2);
  const [invoiceCard, reportCard] = proposal.cards;
  assert.equal(invoiceCard.reason, move.reason);
  const resolve = {
    type: "resolve" as const,
    proposalId: proposal.id,
    cardIds: [invoiceCard.id],
  };
  const rejected = applyCommand(
    suggested,
    { ...resolve, accept: false },
    today,
  );
  assert.deepEqual(rejected.arrangements, state.arrangements);
  assert.deepEqual(rejected.tasks, state.tasks);
  assert.equal(rejected.proposals[0].cards[0].status, "rejected");

  const accepted = db.execute(suggested.revision, { ...resolve, accept: true });
  assert.equal(accepted.tasks[0].expectedDate, tomorrow);
  assert.deepEqual(
    accepted.arrangements.map(({ date, taskId }) => [date, taskId]),
    [[tomorrow, invoice.id]],
  );
  assert.equal(accepted.proposals[0].cards[0].status, "accepted");
  assert.equal(accepted.proposals[0].cards[1].status, "pending");
  assert.deepEqual(
    db.execute(accepted.revision, { ...resolve, accept: true }),
    accepted,
  );
  const done = db.execute(accepted.revision, {
    ...resolve,
    cardIds: [reportCard.id],
    accept: false,
  });
  assert.deepEqual(done.tasks[1], state.tasks[1]);
  assert.deepEqual(done.arrangements, accepted.arrangements);
});

test("A18 日期校验失败回滚已预先应用的改期，保留待接受状态", (t) => {
  const today = "2026-11-20";
  const db = new WorkspaceDatabase(":memory:", () => today);
  t.after(() => db.close());
  const { state, move, update } = invoiceAdjustmentFixture(db, today);
  const invalid = db.commitAgentTurn(
    state.revision,
    state.activeSessionId,
    "建议改期",
    {
      text: "建议调整安排与完成日期。",
      actions: [move, { ...update, patch: { expectedDate: "2026-11-19" } }],
    },
  );
  const bad = invalid.proposals.at(-1)!;
  assert.throws(
    () =>
      db.execute(invalid.revision, {
        type: "resolve",
        proposalId: bad.id,
        cardIds: [bad.cards[0].id],
        accept: true,
      }),
    /预计完成日期/,
  );
  assert.deepEqual(db.load(), invalid);
});

test("一张卡只保留连续移期的最终安排，并按完整日期组合校验", () => {
  const task = {
    ...newTask(),
    title: "整理发票",
    startDate: "2026-11-25",
    expectedDate: "2026-11-26",
  };
  const initial = applyCommand(emptyState(), {
    type: "saveTask",
    task,
    arrangement: { date: "2026-11-20", scope: "先核对发票" },
  });
  const options = { taskId: task.id, mode: "proposal" };
  const planned = applyAgentTurn(
    initial,
    initial.activeSessionId,
    "请建议一个新日期",
    {
      text: "建议改到 22 日。",
      actions: [
        {
          ...options,
          type: "schedule",
          fromDate: "2026-11-20",
          date: "2026-11-21",
          scope: "先核对发票",
          reason: "给今天的报告让出时间",
        },
        {
          ...options,
          type: "schedule",
          fromDate: "2026-11-21",
          date: "2026-11-22",
          scope: "核对并登记发票",
        },
        {
          ...options,
          type: "updateTask",
          patch: { expectedDate: "2026-11-23" },
        },
        { ...options, type: "updateTask", patch: { startDate: "2026-11-22" } },
      ],
    },
  );
  const [proposal] = planned.proposals;
  const [card] = proposal.cards;
  const moves = card.changes.filter((change) => change.type === "schedule");
  assert.equal(moves.length, 1);
  assert.equal(moves[0].fromDate, "2026-11-20");
  assert.equal(moves[0].date, "2026-11-22");
  assert.equal(moves[0].originalScope, "先核对发票");
  const accepted = applyCommand(planned, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [card.id],
    accept: true,
  });
  assert.equal(accepted.tasks[0].startDate, "2026-11-22");
  assert.equal(accepted.tasks[0].expectedDate, "2026-11-23");
  assert.deepEqual(
    accepted.arrangements.map(({ date, scope }) => [date, scope]),
    [["2026-11-22", "核对并登记发票"]],
  );
});

test("连续移期会移除本卡先前在中间日期新增的安排", () => {
  const task = { ...newTask(), title: "整理发票" };
  const initial = applyCommand(emptyState(), {
    type: "saveTask",
    task,
    arrangement: { date: "2026-11-20", scope: "核对发票" },
  });
  const base = {
    type: "schedule",
    mode: "proposal",
    taskId: task.id,
    scope: "核对发票",
  };
  const planned = applyAgentTurn(initial, initial.activeSessionId, "建议改期", {
    text: "建议安排到 22 日。",
    actions: [
      { ...base, date: "2026-11-21", reason: "给今天留出时间" },
      { ...base, fromDate: "2026-11-20", date: "2026-11-21" },
      { ...base, fromDate: "2026-11-21", date: "2026-11-22" },
    ],
  });
  const [proposal] = planned.proposals;
  const accepted = applyCommand(planned, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [proposal.cards[0].id],
    accept: true,
  });
  assert.deepEqual(
    accepted.arrangements.map(({ date }) => date),
    ["2026-11-22"],
  );
});

test("数据库Agent整轮事务失败保持原状态并检查版本", () => {
  const db = new WorkspaceDatabase(":memory:");
  const initial = db.load();
  assert.throws(
    () =>
      db.commitAgentTurn(
        initial.revision,
        initial.activeSessionId,
        "记下报告",
        {
          text: "记录",
          actions: [
            {
              type: "createTask",
              title: "报告",
              patch: {},
              mode: "direct",
              quote: "记下报告",
            },
            {
              type: "schedule",
              taskId: "missing",
              date: "2026-11-17",
              scope: "范围",
              mode: "proposal",
              quote: "记下报告",
            },
          ],
        },
      ),
    /不存在/,
  );
  assert.deepEqual(db.load(), initial);
  db.execute(initial.revision, { type: "energy", value: "状态平稳" });
  assert.throws(
    () =>
      db.commitAgentTurn(initial.revision, initial.activeSessionId, "你好", {
        text: "你好",
        actions: [],
      }),
    /重试/,
  );
  db.close();
});
test("动作协议排除能量及任意命令", () => {
  assert.equal(
    agentTurnSchema.safeParse({
      text: "已改",
      actions: [{ type: "energy", value: "需要恢复" }],
    }).success,
    false,
  );
});

test("自然确认可采用模型整理的标题与说明", () => {
  const state = fixture();
  const next = applyAgentTurn(state, state.activeSessionId, "好，就建这个", {
    text: "已建立任务",
    actions: [
      {
        type: "createTask",
        title: "整理项目复盘材料",
        patch: { description: "整理出用于项目复盘的材料目录" },
        mode: "direct",
        quote: "模型对多轮交流的概括",
      },
    ],
  });
  assert.equal(next.tasks.at(-1)?.description, "整理出用于项目复盘的材料目录");
  assert.equal(next.tasks.at(-1)?.title, "整理项目复盘材料");
  assert.equal(next.tasks.at(-1)?.status, "todo");
  assert.equal(state.tasks.length, 1);
});

test("草拟任务随会话持久化，自然确认创建后可清除草稿", () => {
  const initial = emptyState();
  const drafted = applyAgentTurn(
    initial,
    initial.activeSessionId,
    "我想整理复盘材料",
    {
      text: "可以整理成一个材料归档任务，你看这样是否合适？",
      actions: [],
      memory: {
        summary: "用户想整理项目复盘材料，正在确认任务范围",
        taskDraft: {
          title: "整理复盘材料",
          patch: { description: "整理出材料目录" },
        },
      },
    },
  );
  assert.equal(drafted.tasks.length, 0);
  const restored = stateSchema.parse(JSON.parse(JSON.stringify(drafted)));
  assert.equal(
    restored.sessions[0].agentMemory?.taskDraft?.title,
    "整理复盘材料",
  );
  const confirmed = applyAgentTurn(
    restored,
    restored.activeSessionId,
    "好，就建这个",
    {
      text: "已建立",
      actions: [
        {
          type: "createTask",
          title: "整理复盘材料",
          patch: { description: "整理出材料目录" },
          mode: "direct",
          quote: "好，就建这个",
        },
      ],
    },
  );
  assert.equal(confirmed.tasks.length, 1);
  assert.equal(confirmed.sessions[0].agentMemory?.taskDraft, null);
  assert.equal(
    stateSchema.parse(JSON.parse(JSON.stringify(initial))).sessions[0]
      .agentMemory,
    undefined,
  );
});

test("会话草拟隔离，省略memory时保留现有草稿", () => {
  const initial = emptyState();
  let state = applyAgentTurn(initial, initial.activeSessionId, "想做报告", {
    text: "先讨论",
    actions: [],
    memory: { summary: "报告草拟", taskDraft: { title: "报告", patch: {} } },
  });
  const first = state.activeSessionId;
  state = applyCommand(state, { type: "session", id: "second" });
  state = applyAgentTurn(state, "second", "聊一下英语", {
    text: "继续",
    actions: [],
  });
  assert.equal(
    state.sessions.find((s) => s.id === "second")?.agentMemory,
    undefined,
  );
  assert.equal(
    state.sessions.find((s) => s.id === first)?.agentMemory?.taskDraft?.title,
    "报告",
  );
  state = applyAgentTurn(state, first, "还有个问题", {
    text: "继续讨论",
    actions: [],
  });
  assert.equal(
    state.sessions.find((s) => s.id === first)?.agentMemory?.taskDraft?.title,
    "报告",
  );
});

test("历史读取按会话分页并能找回近期窗口之外的事实", () => {
  let state = emptyState();
  const sessionId = state.activeSessionId;
  for (let i = 0; i < 17; i++) {
    state = applyCommand(state, {
      type: "message",
      message: {
        id: `history-${i}`,
        sessionId,
        role: i % 2 ? "assistant" : "user",
        text:
          i === 0
            ? "受众是跨部门新人，格式为背景、影响、下一步"
            : `中性交流${i}`,
        createdAt: new Date().toISOString(),
      },
    });
  }
  state = applyCommand(state, { type: "session", id: "another" });
  state = applyCommand(state, {
    type: "message",
    message: {
      id: "private-other",
      sessionId: "another",
      role: "user",
      text: "另一会话内容",
      createdAt: new Date().toISOString(),
    },
  });
  const context = buildContext(state, sessionId);
  assert.equal(context.recentMessages.length, 12);
  assert.equal(
    context.recentMessages.some((m) => m.id === "history-0"),
    false,
  );
  const latest = readConversation(state, sessionId, undefined, 10);
  assert.equal(latest.messages.length, 10);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.nextBeforeMessageId, "history-7");
  const earlier = readConversation(
    state,
    sessionId,
    latest.nextBeforeMessageId!,
    10,
  );
  assert.equal(earlier.messages.length, 7);
  assert.equal(earlier.messages[0].id, "history-0");
  assert.equal(earlier.hasMore, false);
  assert.equal(earlier.nextBeforeMessageId, null);
  assert(
    [...latest.messages, ...earlier.messages].every(
      (m) => m.sessionId === sessionId,
    ),
  );
  assert.throws(
    () => readConversation(state, sessionId, "private-other"),
    /当前会话/,
  );
  assert.throws(
    () => readConversation(state, sessionId, "nonexistent"),
    /当前会话/,
  );
});
