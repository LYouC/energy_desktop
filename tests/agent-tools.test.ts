import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentRuntime, generateAgentTurn } from "../src/agent/runtime";
import { upcomingTasks } from "../src/agent/context";
import { WorkspaceDatabase } from "../src/persistence/storage";
import {
  emptyState,
  newTask,
  type Arrangement,
  type Task,
} from "../src/domain/model";
import { applyAgentTurn } from "../src/agent/turn";
import { applyCommand } from "../src/domain/operations";

test("近期候选包含日期与计划命中，排除今天两区、结束、重复和保留移除记录的任务", () => {
  const today = "2026-12-29";
  const through = "2027-01-05";
  const task = (id: string, patch: Partial<Task> = {}): Task => ({
    ...newTask(),
    id,
    title: id,
    ...patch,
  });
  const arrangement = (
    taskId: string,
    date: string,
    done = false,
  ): Arrangement => ({
    taskId,
    date,
    scope: `${taskId} ${date}`,
    done,
  });
  const state = emptyState();
  state.tasks = [
    task("starts", {
      startDate: "2026-12-30",
      description: "需先拿到材料",
      importance: "high",
    }),
    task("ends", { expectedDate: through, parentId: "starts" }),
    task("future-plan"),
    task("day-eight", { expectedDate: "2027-01-06" }),
    task("completed-plan"),
    task("already-planned", { expectedDate: through }),
    task("due-today", { expectedDate: today }),
    task("complete", { expectedDate: through, status: "done" }),
    task("abandoned", { expectedDate: through, status: "abandoned" }),
    task("template", { recurrence: { type: "daily" } }),
    task("inherits", { expectedDate: through, parentId: "template" }),
    task("skipped", { expectedDate: through }),
    task("undated"),
    task("past", { expectedDate: "2026-12-28" }),
  ];
  state.arrangements = [
    arrangement("future-plan", through),
    arrangement("future-plan", "2026-12-30"),
    arrangement("future-plan", "2026-12-31", true),
    arrangement("future-plan", "2027-01-06"),
    arrangement("future-plan", "2026-12-28"),
    arrangement("completed-plan", "2027-01-01", true),
    arrangement("already-planned", today),
    arrangement("due-today", through),
    arrangement("deleted-task", through),
  ];
  state.skippedOccurrences = [
    {
      arrangement: {
        ...arrangement("skipped", today),
        recurrence: { title: "已移除" },
      },
      previousTaskIds: [],
      nextTaskIds: [],
    },
  ];
  const before = structuredClone(state);
  const results = upcomingTasks(state, today, through);
  assert.deepEqual(
    results.map(({ id }) => id),
    ["starts", "ends", "future-plan"],
  );
  assert.deepEqual(
    results.map(({ description, importance, parentId }) => [
      description,
      importance,
      parentId,
    ]),
    [
      ["需先拿到材料", "high", null],
      ["", null, "starts"],
      ["", null, null],
    ],
  );
  assert.deepEqual(results[2].arrangements, [
    { date: "2026-12-30", scope: "future-plan 2026-12-30" },
    { date: through, scope: "future-plan 2027-01-05" },
  ]);
  assert.deepEqual(state, before);
});

test("SDK 强制一周上限和较短窗口，接受前只读候选及保存建议", async (context) => {
  const date = "2026-12-29";
  const db = new WorkspaceDatabase(":memory:", () => date);
  context.after(() => db.close());
  const near = {
    ...newTask(),
    title: "核对表单",
    startDate: "2027-01-02",
    expectedDate: "2027-01-05",
  };
  const far = {
    ...newTask(),
    title: "汇总远期记录",
    expectedDate: "2027-01-06",
  };
  const initial = db.execute(db.load().revision, {
    type: "saveTask",
    task: near,
    arrangement: { date: "2027-01-02", scope: "核对所有表单" },
  });
  const before = db.execute(initial.revision, {
    type: "saveTask",
    task: far,
    arrangement: { date: "2027-01-06", scope: "汇总全部远期记录" },
  });
  const advance = {
    name: "prepareTurn",
    input: {
      intent: "changes",
      actions: [
        {
          type: "advanceTask",
          mode: "proposal",
          taskId: near.id,
          scope: "核对所有表单",
          reason: "今天还有足够时间。",
        },
      ],
    },
  };
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const results = JSON.stringify(
        options.prompt.filter(({ role }) => role === "tool"),
      );
      switch (++step) {
        case 1:
          assert.doesNotMatch(
            JSON.stringify(options.prompt),
            /核对表单|汇总远期记录/,
          );
          return response([
            { name: "readUpcomingTasks", input: { days: 8 } },
            { name: "readUpcomingTasks", input: { days: 3 } },
          ]);
        case 2:
          assert.equal(results.match(/"through":/g)?.length, 1);
          assert.match(
            results,
            /"from":"2026-12-30","through":"2027-01-01","tasks":\[\]/,
          );
          return response([advance]);
        case 3:
          assert.match(
            results,
            /提前推进须从本轮 readUpcomingTasks 返回的候选选择/,
          );
          return response([{ name: "readUpcomingTasks", input: {} }]);
        case 4:
          assert.match(results, /"through":"2027-01-05"/);
          assert.match(results, /核对表单/);
          assert.doesNotMatch(results, /汇总远期记录/);
          return response([{ name: "readUpcomingTasks", input: { days: 3 } }]);
        case 5:
          // The narrower follow-up does not discard the candidate already read in this turn.
          assert.equal(results.match(/"through":"2027-01-01"/g)?.length, 2);
          return response([advance]);
        default:
          assert.doesNotMatch(results, /汇总远期记录|汇总全部远期记录/);
          return response([], "建议今天核对表单，接受后生效。");
      }
    },
  });
  const runtime = new AgentRuntime(
    db,
    () => connection,
    (options) => generateAgentTurn({ ...options, model }),
  );
  const proposed = await runtime.send(
    {
      runId: crypto.randomUUID(),
      sessionId: before.activeSessionId,
      text: "未来一周有什么能提前到今天？先给建议。",
      focusedId: null,
      source: "optimizeToday",
    },
    () => {},
  );
  assert.equal(step, 6);
  assert.deepEqual(proposed.tasks, before.tasks);
  assert.deepEqual(proposed.arrangements, before.arrangements);
  const proposal = proposed.proposals[0];
  const card = proposal.cards[0];
  assert.equal(card.status, "pending");
  const resolve = {
    type: "resolve" as const,
    proposalId: proposal.id,
    cardIds: [card.id],
    accept: true,
  };
  assert.throws(
    () => applyCommand(proposed, resolve, "2026-12-30"),
    /本地日期已变化/,
  );
  assert.equal(proposed.proposals[0].cards[0].status, "pending");
  const conflicting = applyAgentTurn(
    before,
    before.activeSessionId,
    "测试同轮变更",
    {
      text: "有一条已确认的今日安排。",
      actions: [
        {
          type: "schedule",
          mode: "direct",
          taskId: near.id,
          date,
          scope: "已确认的范围",
        },
        ...advance.input.actions,
      ],
    },
    undefined,
    date,
  );
  const conflictProposal = conflicting.proposals.at(-1)!;
  assert.throws(
    () =>
      applyCommand(
        conflicting,
        {
          ...resolve,
          proposalId: conflictProposal.id,
          cardIds: [conflictProposal.cards[0].id],
        },
        date,
      ),
    /已有今日安排/,
  );
  assert.equal(conflicting.arrangements.at(-1)?.scope, "已确认的范围");
  const accepted = db.execute(proposed.revision, resolve);
  assert.deepEqual(accepted.arrangements, [
    ...before.arrangements,
    { taskId: near.id, date, scope: "核对所有表单", done: false },
  ]);
  assert.equal(accepted.tasks[0].expectedDate, near.expectedDate);
});

test("SDK 可由模板补加当天实例，终答收到单次范围和完成结果", async () => {
  const state = emptyState();
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      if (calls === 1)
        return response([
          {
            name: "prepareTurn",
            input: {
              intent: "changes",
              actions: [
                {
                  type: "createTask",
                  mode: "direct",
                  ref: "stretch",
                  title: "拉伸",
                  patch: {},
                  recurrence: { type: "weekly", weekdays: [2] },
                },
                {
                  type: "createOccurrence",
                  mode: "direct",
                  taskId: "stretch",
                  date: "2026-11-23",
                  scope: "只拉伸肩部",
                },
                {
                  type: "setOccurrenceDone",
                  mode: "direct",
                  taskId: "stretch",
                  date: "2026-11-23",
                  done: true,
                },
              ],
            },
          },
        ]);
      const receipt = JSON.stringify(
        options.prompt.filter(({ role }) => role === "tool"),
      );
      assert.match(receipt, /只拉伸肩部/);
      assert.match(receipt, /"done":true/);
      assert.match(receipt, /"weekdays":\[2\]/);
      return response([], "已记下今天这次拉伸并完成。");
    },
  });
  const result = await generateAgentTurn({
    state,
    sessionId: state.activeSessionId,
    focusedId: null,
    userText: "设置每周二拉伸，今天单加肩部拉伸并记完成",
    connection,
    model,
    date: "2026-11-23",
    signal: AbortSignal.timeout(10000),
    emit: () => {},
  });
  assert.equal(calls, 2);
  assert.equal(result.turn.actions.length, 3);
});

test("SDK 仅在删除回执中说明已删模板，后续规划和读取不发送旧实例", async (context) => {
  const date = "2026-11-23";
  const db = new WorkspaceDatabase(":memory:", () => date);
  context.after(() => db.close());
  let calls = 0;
  let taskId: string;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      const prepare = (actions: unknown[]) =>
        response([
          { name: "prepareTurn", input: { intent: "changes", actions } },
        ]);
      const receipt = JSON.stringify(
        options.prompt.filter((item) => item.role === "tool"),
      );
      switch (calls) {
        case 1:
          assert(JSON.stringify(options.prompt).includes(date));
          return prepare([
            {
              type: "createTask",
              mode: "direct",
              title: "拉伸",
              patch: {},
              recurrence: { type: "weekly", weekdays: [1, 3, 5] },
            },
          ]);
        case 2:
          assert.match(
            receipt,
            /"recurrence":\{"type":"weekly","weekdays":\[1,3,5\]\}/,
          );
          return response([], "已设置每周一、三、五拉伸。");
        case 3:
          return prepare([
            { type: "deleteRecurringTask", mode: "direct", taskId },
          ]);
        case 4:
          assert.match(receipt, /"deletedTasks":\["拉伸"\]/);
          assert.match(receipt, /"arrangements":\[\]/);
          return response([], "已删除模板，执行记录仍在工作台。");
        case 5: {
          const workspace = options.prompt.find((item) => item.role === "user");
          const text = workspace?.content.find(
            (part) => part.type === "text",
          )?.text;
          const data = JSON.parse(text!.split("\n")[1]).context;
          assert.deepEqual(data.today, []);
          assert.deepEqual(data.skippedToday, []);
          assert.equal(data.focusedId, null);
          return response([{ name: "readTask", input: { taskId } }]);
        }
        case 6:
          assert.match(receipt, /"task":null/);
          assert.match(receipt, /"arrangements":\[\]/);
          assert.doesNotMatch(receipt, /拉伸/);
          return prepare([
            // A different task can still be created without echoing the archived instance.
            { type: "createTask", mode: "direct", title: "晨读", patch: {} },
          ]);
        default:
          assert.doesNotMatch(receipt, /拉伸/);
          return response([], "已创建晨读。");
      }
    },
  });
  const runtime = new AgentRuntime(
    db,
    () => connection,
    (options) => generateAgentTurn({ ...options, model }),
  );
  const send = (text: string) =>
    runtime.send(
      {
        runId: crypto.randomUUID(),
        sessionId: db.load().activeSessionId,
        text,
        focusedId: taskId ?? null,
      },
      () => {},
    );
  const created = await send("每周一、三、五拉伸，帮我设一下");
  taskId = created.tasks[0].id;
  const deleted = await send("删除拉伸模板");
  assert.deepEqual(deleted.tasks, []);
  assert.equal(deleted.arrangements[0].taskId, taskId);
  const next = await send("记下晨读");
  assert.equal(next.tasks[0].title, "晨读");
  assert.deepEqual(next.arrangements, deleted.arrangements);
  assert.equal(calls, 7);
});

function response(
  calls: { name: string; input: unknown }[],
  text = "",
  replyFirst = false,
) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        const emitText = () => {
          if (!text) return;
          controller.enqueue({ type: "text-start", id: "reply" });
          controller.enqueue({ type: "text-delta", id: "reply", delta: text });
          controller.enqueue({ type: "text-end", id: "reply" });
        };
        if (replyFirst) emitText();
        for (const call of calls) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: crypto.randomUUID(),
            toolName: call.name,
            input: JSON.stringify(call.input),
          });
        }
        if (!replyFirst) emitText();
        controller.enqueue({
          type: "finish",
          finishReason: {
            unified: calls.length ? "tool-calls" : "stop",
            raw: "test",
          },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}
const action = {
  type: "createTask",
  title: "整理会议笔记",
  patch: {
    description: "方便检索决定和待办",
    startDate: "2026-11-18",
    expectedDate: "2026-11-20",
  },
  mode: "direct",
  quote: "好，就建这个",
};
const prepare = {
  name: "prepareTurn",
  input: { intent: "changes", actions: [action] },
};
const connection = {
  baseURL: "https://example.invalid/v1",
  apiKey: "test",
  model: "test",
};
const finalText = "已创建整理会议笔记任务，目标是方便检索决定和待办。";

test("Agent 决策和终答都收到系统本地日期与时分", async (context) => {
  context.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 10, 23, 0, 7, 42),
  });
  const state = emptyState();
  const systemMessages: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const instructions = prompt.find((message) => message.role === "system");
      systemMessages.push(instructions?.content ?? "");

      return prompt.some((message) => message.role === "tool")
        ? response([], "2026-11-23 00:07")
        : response([
            {
              name: "prepareTurn",
              input: { intent: "conversation", actions: [] },
            },
          ]);
    },
  });

  const { turn } = await generateAgentTurn({
    state,
    sessionId: state.activeSessionId,
    userText: "现在是几月几日几点几分？",
    focusedId: null,
    connection,
    signal: new AbortController().signal,
    emit: () => {},
    model,
  });
  assert.equal(turn.text, "2026-11-23 00:07");
  assert.equal(systemMessages.length, 2);
  for (const message of systemMessages) {
    assert.match(message, /2026-11-23 00:07/);
  }
});

test("最终回复流中断会丢弃半段预览并从决策步骤重试", async (context) => {
  const db = new WorkspaceDatabase(":memory:");
  context.after(() => db.close());
  let steps = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      steps++;
      if (steps === 1 || steps === 3) return response([prepare]);
      if (steps === 4) return response([], finalText);
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "partial" });
            controller.enqueue({
              type: "text-delta",
              id: "partial",
              delta: "半段回复",
            });
            controller.enqueue({
              type: "error",
              error: new TypeError("terminated"),
            });
            controller.close();
          },
        }),
      };
    },
  });
  const runtime = new AgentRuntime(
    db,
    () => connection,
    (options) => generateAgentTurn({ ...options, model }),
  );
  const events: string[] = [];
  const state = await runtime.send(
    {
      runId: crypto.randomUUID(),
      sessionId: db.load().activeSessionId,
      text: "好，就建这个",
      focusedId: null,
    },
    (event) => {
      if (event.type === "text") events.push(event.text);
      if (event.type === "retry") events.push("retry");
    },
  );
  assert.deepEqual(events, ["半段回复", "retry", finalText]);
  assert.equal(steps, 4);
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(
    state.messages.map(({ text }) => text),
    ["好，就建这个", finalText],
  );
});

test("模型未提交决定时不展示执行完成正文", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => response([], "任务已经创建了"),
  });
  const state = emptyState();
  const previews: string[] = [];
  await assert.rejects(
    generateAgentTurn({
      state,
      sessionId: state.activeSessionId,
      focusedId: null,
      userText: "帮我创建任务",
      connection,
      model,
      signal: AbortSignal.timeout(10000),
      emit: (event) => {
        if (event.type === "text") previews.push(event.text);
      },
    }),
    /模型未生成可应用的完整结果/,
  );
  assert.deepEqual(previews, []);
  assert.deepEqual(state.tasks, []);
});

test("最终正文中的DSML补充操作使整轮失败，不能提交缺字段任务", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      return calls === 1
        ? response([prepare])
        : response(
            [],
            '<｜DSML｜ calls><｜DSML｜ invoke name="prepareTurn">补充说明和日期</｜DSML｜ invoke></｜DSML｜ calls>',
          );
    },
  });
  const state = emptyState();
  await assert.rejects(
    generateAgentTurn({
      state,
      sessionId: state.activeSessionId,
      focusedId: null,
      userText: "按已有信息创建",
      connection,
      model,
      signal: AbortSignal.timeout(10000),
      emit: () => {},
    }),
    /模型未生成可应用的完整结果/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.messages, []);
});

for (const replyFirst of [true, false]) {
  test(`同一步${replyFirst ? "先文字" : "先工具"}时，读回执后才产生最终回复`, async () => {
    let calls = 0;
    const previews: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls++;
        if (calls === 1)
          return response([prepare], "尚未读取回执的文字", replyFirst);
        assert.equal(calls, 2);
        assert(JSON.stringify(options.prompt).includes("方便检索决定和待办"));
        const receipts = options.prompt.filter((item) => item.role === "tool");
        const serialized = JSON.stringify(receipts);
        assert(serialized.includes("startDate"));
        assert(serialized.includes("expectedDate"));
        assert(!serialized.includes('"goal"'));
        assert(!serialized.includes('"deadline"'));
        assert.equal(options.tools?.length ?? 0, 0);
        return response([], finalText);
      },
    });
    const state = emptyState();
    const result = await generateAgentTurn({
      state,
      sessionId: state.activeSessionId,
      focusedId: null,
      userText: "好，就建这个",
      connection,
      model,
      signal: AbortSignal.timeout(10000),
      emit: (event) => {
        if (event.type === "text") previews.push(event.text);
      },
    });
    assert.equal(result.trace.steps, 2);
    assert.equal(result.turn.actions.length, 1);
    assert.equal(previews.join(""), finalText);
    assert.equal(state.tasks.length, 0);
    const next = applyAgentTurn(
      state,
      state.activeSessionId,
      "好，就建这个",
      result.turn,
    );
    assert.equal(next.tasks[0].description, "方便检索决定和待办");
  });
}

test("准备失败在同一SDK循环修正，最终仅应用成功变更", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      if (calls === 1)
        return response([
          {
            name: "prepareTurn",
            input: {
              intent: "changes",
              actions: [
                {
                  type: "schedule",
                  taskId: "missing",
                  date: "2026-11-17",
                  scope: "推进",
                  mode: "direct",
                },
              ],
            },
          },
        ]);
      if (calls === 2) {
        assert(JSON.stringify(options.prompt).includes("不存在"));
        return response([prepare]);
      }
      assert.equal(calls, 3);
      return response([], finalText);
    },
  });
  const state = emptyState();
  const result = await generateAgentTurn({
    state,
    sessionId: state.activeSessionId,
    focusedId: null,
    userText: "好，就建这个",
    connection,
    model,
    signal: AbortSignal.timeout(10000),
    emit: () => {},
  });
  assert(result.trace.validationErrors?.length);
  const next = applyAgentTurn(
    state,
    state.activeSessionId,
    "好，就建这个",
    result.turn,
  );
  assert.equal(next.tasks.length, 1);
  assert.equal(next.messages.length, 1);
});

test("模型决定纯交流后自然语言回复，保留真实对话角色", async () => {
  const state = emptyState();
  state.messages.push({
    id: "earlier",
    sessionId: state.activeSessionId,
    role: "assistant",
    text: "你想聊聊哪件事？",
    createdAt: new Date().toISOString(),
  });
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      assert(options.prompt.some((message) => message.role === "assistant"));
      if (calls === 1) {
        assert.equal(options.prompt.at(-1)?.role, "user");
        return response([
          {
            name: "prepareTurn",
            input: { intent: "conversation", actions: [] },
          },
        ]);
      }
      return response([], "可以先看看你想开新坑时，最吸引你的是哪一部分。");
    },
  });
  const result = await generateAgentTurn({
    state,
    sessionId: state.activeSessionId,
    focusedId: null,
    userText: "先聊聊我为什么总想开新坑",
    connection,
    model,
    signal: AbortSignal.timeout(10000),
    emit: () => {},
  });
  assert.equal(result.turn.actions.length, 0);
  assert.equal(result.trace.steps, 2);
  assert.deepEqual(result.trace.tools, ["prepareTurn"]);
});

test("模型决定执行时必须携带动作，空动作决定可在同一循环修正", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls++;
      if (calls === 1)
        return response([
          {
            name: "prepareTurn",
            input: { intent: "changes", actions: [] },
          },
        ]);
      if (calls === 2) {
        assert(options.tools?.some((tool) => tool.name === "prepareTurn"));
        return response([
          {
            ...prepare,
            input: {
              ...prepare.input,
              memory: { summary: "任务已记录", taskDraft: null },
            },
          },
        ]);
      }
      assert.equal(calls, 3);
      return response([], finalText);
    },
  });
  const state = emptyState();
  const result = await generateAgentTurn({
    state,
    sessionId: state.activeSessionId,
    focusedId: null,
    userText: "好，就建这个",
    connection,
    model,
    signal: AbortSignal.timeout(10000),
    emit: () => {},
  });
  assert.equal(result.turn.actions.length, 1);
  assert.equal(result.turn.memory?.taskDraft, null);
});

test("模型只说草稿已保存时，用户仍能看到模型草拟的实际标题和目标", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      return calls === 1
        ? response([
            {
              name: "prepareTurn",
              input: {
                intent: "conversation",
                actions: [],
                memory: {
                  summary: "用户等待确认草稿",
                  taskDraft: { title: action.title, patch: action.patch },
                },
              },
            },
          ])
        : response([], "草稿已记下，等待你的意见。");
    },
  });
  const state = emptyState();
  const result = await generateAgentTurn({
    state,
    sessionId: state.activeSessionId,
    focusedId: null,
    userText: "先草拟一下",
    connection,
    model,
    signal: AbortSignal.timeout(10000),
    emit: () => {},
  });
  assert(result.turn.text.includes(action.title));
  assert(result.turn.text.includes(action.patch.description));
  assert(result.turn.text.includes(action.patch.startDate));
  assert(result.turn.text.includes(action.patch.expectedDate));
  assert.equal(result.turn.actions.length, 0);
});
