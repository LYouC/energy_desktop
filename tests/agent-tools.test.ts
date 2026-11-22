import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { AgentRuntime, generateAgentTurn } from "../src/agent/runtime";
import { WorkspaceDatabase } from "../src/persistence/storage";
import { emptyState } from "../src/domain/model";
import { applyAgentTurn } from "../src/agent/turn";

test("SDK 预演返回重复规则、已删除模板与保留的今天实例", async (context) => {
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
          assert.match(receipt, /"taskTitle":"拉伸"/);
          return response([], "已删除模板，今天这次仍在。");
        case 5:
          return response([{ name: "readTask", input: { taskId } }]);
        case 6:
          assert.match(receipt, /"task":null/);
          assert.match(receipt, /"title":"拉伸"/);
          return prepare([
            { type: "skipOccurrence", mode: "direct", taskId, date },
          ]);
        default:
          assert.match(receipt, /"skippedToday":\[\{/);
          return response([], "已移出今天的拉伸。");
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
        focusedId: null,
      },
      () => {},
    );
  const created = await send("每周一、三、五拉伸，帮我设一下");
  taskId = created.tasks[0].id;
  const deleted = await send("删除拉伸模板");
  assert.deepEqual(deleted.tasks, []);
  assert.equal(deleted.arrangements[0].taskId, taskId);
  const skipped = await send("把留下的今天这次拉伸移出安排");
  assert.deepEqual(skipped.arrangements, []);
  assert.equal(skipped.skippedOccurrences?.[0].arrangement.taskId, taskId);
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
