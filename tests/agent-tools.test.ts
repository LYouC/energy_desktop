import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateAgentTurn } from "../electron/agent/runtime";
import { emptyState } from "../shared/model";
import { applyAgentTurn } from "../shared/agent";

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
