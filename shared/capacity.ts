import { z } from "zod";

export const capacitySchema = z.object({
  availableMinutes: z.number().nonnegative(),
  tasks: z.array(
    z.object({ title: z.string(), estimatedMinutes: z.number().nonnegative() }),
  ),
});
/** 时间算术由程序核算，模型仍负责判断价值、条件与用户是否接受。 */
export function calculateCapacity(input: z.infer<typeof capacitySchema>) {
  const { availableMinutes, tasks } = capacitySchema.parse(input);
  const totalEstimatedMinutes = tasks.reduce(
    (sum, task) => sum + task.estimatedMinutes,
    0,
  );
  const bufferMinutes = Math.min(15, availableMinutes);
  return {
    availableMinutes,
    totalEstimatedMinutes,
    shortfallMinutes: Math.max(0, totalEstimatedMinutes - availableMinutes),
    tasks: tasks.map((task) => ({
      ...task,
      fitsIndividually: task.estimatedMinutes <= availableMinutes,
    })),
    conditionalAlternatives: tasks
      .filter(
        (task) => task.estimatedMinutes + bufferMinutes <= availableMinutes,
      )
      .map((task) => ({
        fullTask: task.title,
        fullTaskMinutes: task.estimatedMinutes,
        partialWorkMinutes:
          availableMinutes - task.estimatedMinutes - bufferMinutes,
        bufferMinutes,
        condition:
          "仅当此任务更应保住且另一任务可协商范围或截止时适用。用户估时仍不保证完成。",
      })),
    rule: "候选分配已包含缓冲，不能另外再扣一次。不得减少fullTaskMinutes却声称完整做完，partialWorkMinutes只用于有限推进，不保证另一个任务完成。没有合适候选时先协商范围/截止/支持。",
  };
}
