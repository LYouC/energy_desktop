import { test } from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspace } from "../src/stores/workspace";
import { emptyState, newTask, type Command } from "../shared/model";
import { applyCommand } from "../shared/operations";

test("排队写入捕获提交时的输入快照", async () => {
  let persisted = emptyState();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        load: async () => structuredClone(persisted),
        execute: async (_revision: number, command: Command) => {
          persisted = applyCommand(persisted, command);
          return structuredClone(persisted);
        },
      },
    },
  });
  setActivePinia(createPinia());
  const store = useWorkspace();
  await store.load();
  const task = { ...newTask(), title: "提交时名称" };
  const pending = store.dispatch({ type: "saveTask", task });
  task.title = "提交后的编辑";
  await pending;
  assert.equal(persisted.tasks[0].title, "提交时名称");
});

test("失败后队列继续工作，加载恢复清除错误", async () => {
  let persisted = emptyState();
  let failLoad = true;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        load: async () => {
          if (failLoad) throw new Error("暂时无法读取");
          return structuredClone(persisted);
        },
        execute: async (_revision: number, command: Command) => {
          persisted = applyCommand(persisted, command);
          return structuredClone(persisted);
        },
      },
    },
  });
  setActivePinia(createPinia());
  const store = useWorkspace();
  await store.load();
  assert.match(store.error, /暂时无法读取/);
  failLoad = false;
  await store.load();
  assert.equal(store.error, "");
  await assert.rejects(store.dispatch({ type: "deleteTask", id: "missing" }));
  await store.dispatch({ type: "energy", value: "精力充足" });
  assert.equal(store.state.energy.value, "精力充足");
});

test("并发提交按队列使用最新 revision，最终能量为最后一次输入", async () => {
  let persisted = emptyState();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        load: async () => structuredClone(persisted),
        execute: async (revision: number, command: Command) => {
          assert.equal(revision, persisted.revision);
          await new Promise((resolve) => setTimeout(resolve, 5));
          persisted = applyCommand(persisted, command);
          return structuredClone(persisted);
        },
      },
    },
  });
  setActivePinia(createPinia());
  const store = useWorkspace();
  await store.load();
  await Promise.all([
    store.dispatch({ type: "energy", value: "需要恢复" }),
    store.dispatch({ type: "energy", value: "状态平稳" }),
  ]);
  assert.equal(persisted.energy.value, "状态平稳");
  assert.equal(persisted.revision, 2);
});
