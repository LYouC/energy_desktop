import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateCapacity } from "../shared/capacity";
test("三小时不能装六小时，但两小时演示可完整保留且缓冲计入容量", () => {
  const result = calculateCapacity({
    availableMinutes: 180,
    tasks: [
      { title: "报告", estimatedMinutes: 240 },
      { title: "演示", estimatedMinutes: 120 },
    ],
  });
  assert.equal(result.shortfallMinutes, 180);
  assert.deepEqual(
    result.tasks.map((t) => t.fitsIndividually),
    [false, true],
  );
  assert.equal(result.conditionalAlternatives.length, 1);
  const option = result.conditionalAlternatives[0];
  assert.equal(option.fullTaskMinutes, 120);
  assert.equal(option.partialWorkMinutes, 45);
  assert.equal(
    option.fullTaskMinutes + option.partialWorkMinutes + option.bufferMinutes,
    180,
  );
});
test("零容量和单项超容量不产生可完成候选", () => {
  const result = calculateCapacity({
    availableMinutes: 0,
    tasks: [{ title: "报告", estimatedMinutes: 60 }],
  });
  assert.equal(result.conditionalAlternatives.length, 0);
  assert.equal(result.shortfallMinutes, 60);
});
