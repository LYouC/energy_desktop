import test from "node:test";
import assert from "node:assert/strict";
import { deletionOrder } from "../src/composables/taskSelection";
import type { Task } from "../shared/model";

function task(id: string, parentId: string | null = null): Task {
  return {
    id,
    version: 1,
    title: id,
    description: "",
    startDate: "",
    expectedDate: "",
    status: "todo",
    parentId,
    updatedAt: "2026-11-19T00:00:00.000Z",
  };
}

test("删除顺序移除已同时选中祖先的任务", () => {
  const tasks = [task("a"), task("b", "a"), task("c", "b"), task("d")];
  assert.deepEqual(deletionOrder(["a", "b", "d"], tasks), ["a", "d"]);
  assert.deepEqual(deletionOrder(["b", "c"], tasks), ["b"]);
});

test("未选中祖先时保留子任务，且不受任务集合外父级影响", () => {
  const tasks = [task("a"), task("b", "a"), task("c", "missing")];
  assert.deepEqual(deletionOrder(["b"], tasks), ["b"]);
  assert.deepEqual(deletionOrder(["c", "b"], tasks), ["c", "b"]);
});

test("保持选择顺序且忽略集合外的未知 ID", () => {
  const tasks = [task("a"), task("b")];
  assert.deepEqual(deletionOrder(["b", "a"], tasks), ["b", "a"]);
  assert.deepEqual(deletionOrder(["ghost"], tasks), []);
});
