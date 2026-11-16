import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, newTask } from "../shared/model";
import { applyCommand } from "../shared/operations";
import { agentTurnSchema, applyAgentTurn } from "../shared/agent";
import { WorkspaceDatabase } from "../electron/storage";

function fixture() {
  return applyCommand(emptyState(), {
    type: "saveTask",
    task: { ...newTask(), title: "英语" },
  });
}
test("按这份拆分建子任务是明确接受，否定和试探仍被拦截", () => {
  const initial = fixture();
  const state = applyAgentTurn(
    initial,
    initial.activeSessionId,
    "给拆分建议，也给安排建议",
    {
      text: "待接受的拆分",
      actions: [
        {
          type: "split",
          taskId: initial.tasks[0].id,
          children: [{ title: "提纲", goal: "列出讨论问题" }],
          mode: "proposal",
          quote: "给拆分建议",
        },
        {
          type: "schedule",
          taskId: initial.tasks[0].id,
          date: "2026-11-16",
          scope: "整理材料",
          mode: "proposal",
          quote: "给安排建议",
        },
      ],
    },
  );
  const proposal = state.proposals[0];
  const quote = "就按你这份拆分建子任务";
  const turn = {
    text: "已建立子任务",
    actions: [
      {
        type: "resolve",
        proposalId: proposal.id,
        ids: [proposal.changes[0].id],
        accept: true,
        mode: "direct",
        quote,
      },
    ],
  };
  const next = applyAgentTurn(
    state,
    state.activeSessionId,
    quote + "；今天只安排整理提纲，其他步骤先不安排。",
    turn,
  );
  assert.equal(next.tasks.length, 2);
  assert.equal(next.arrangements.length, 0);
  assert.equal(next.proposals[0].changes[1].status, "pending");
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, quote, {
        ...turn,
        actions: [
          { ...turn.actions[0], ids: proposal.changes.map((c) => c.id) },
        ],
      }),
    /只授权拆分/,
  );
  for (const prefix of ["不要", "能不能"]) {
    assert.throws(
      () =>
        applyAgentTurn(state, state.activeSessionId, prefix + quote, {
          ...turn,
          actions: [{ ...turn.actions[0], quote: prefix + quote }],
        }),
      /授权/,
    );
  }
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
          patch: { goal: "提交报告" },
          mode: "direct",
          quote: "记下报告",
        },
        {
          type: "split",
          taskId: "new-report",
          children: [{ title: "提纲", goal: "列出讨论问题" }],
          mode: "proposal",
          quote: "给个拆分建议",
        },
      ],
    },
  );
  assert.equal(next.tasks.length, 1);
  assert.equal(next.proposals[0].changes[0].taskId, next.tasks[0].id);
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
test("事实背景有来源，不能通过context偷偷改截止", () => {
  const state = fixture();
  const next = applyAgentTurn(state, state.activeSessionId, "没拿到材料", {
    text: "记下了",
    actions: [
      {
        type: "context",
        taskId: state.tasks[0].id,
        background: "缺少材料",
        backgroundKind: "用户事实",
        progress: "",
        obstacle: "没拿到材料",
        nextStep: "询问材料",
        deadline: "2026-11-17",
        mode: "direct",
        quote: "没拿到材料",
      },
    ],
  });
  assert.equal(next.tasks[0].deadline, "");
  assert.equal(next.tasks[0].backgroundSource, "没拿到材料");
});
test("否定完成与试探建议均不能变成直接操作", () => {
  const state = fixture();
  for (const text of ["还没完成", "要不要改到明天"]) {
    const action =
      text === "还没完成"
        ? { type: "updateTask", patch: { status: "done" } }
        : { type: "schedule", date: "2026-11-17", scope: "英语" };
    assert.throws(
      () =>
        applyAgentTurn(state, state.activeSessionId, text, {
          text: "错误",
          actions: [
            {
              ...action,
              taskId: state.tasks[0].id,
              mode: "direct",
              quote: text,
            },
          ],
        }),
      /授权/,
    );
  }
});
test("编造原文被拒绝，后续失败会撤回整轮早先操作", () => {
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
            title: "英语",
            patch: {},
            mode: "direct",
            quote: "添加英语",
          },
        ],
      }),
    /原文/,
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
        children: [{ title: "朗读", goal: "读一页" }],
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
        ids: [proposal.changes[0].id],
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
  const p = state.proposals[0];
  state = applyCommand(state, {
    type: "resolve",
    proposalId: p.id,
    ids: [p.changes[0].id],
    accept: false,
  });
  assert.equal(state.tasks[0].status, "todo");
  state = applyCommand(state, {
    type: "resolve",
    proposalId: p.id,
    ids: [p.changes[1].id],
    accept: true,
  });
  assert.equal(state.tasks[0].status, "todo");
  assert.equal(state.arrangements[0].done, true);
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

test("截断原文不能绕过否定完成，记录已完成任务需要完成事实", () => {
  const state = fixture();
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, "还没完成", {
        text: "已完成",
        actions: [
          {
            type: "updateTask",
            taskId: state.tasks[0].id,
            patch: { status: "done" },
            mode: "direct",
            quote: "完成",
          },
        ],
      }),
    /授权/,
  );
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, "记下报告", {
        text: "已记录",
        actions: [
          {
            type: "createTask",
            title: "报告",
            patch: { status: "done" },
            mode: "direct",
            quote: "记下报告",
          },
        ],
      }),
    /进展状态/,
  );
  const next = applyAgentTurn(
    state,
    state.activeSessionId,
    "记下报告，已经完成了",
    {
      text: "已记录完成事实",
      actions: [
        {
          type: "createTask",
          title: "报告",
          patch: { status: "done" },
          mode: "direct",
          quote: "记下报告，已经完成了",
        },
      ],
    },
  );
  assert.equal(next.tasks.at(-1)?.status, "done");
});
