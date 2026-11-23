import type { Task } from "../../domain/model";
import { taskAncestorIds } from "../../domain/recurrence";

export type TaskGroup<T> = { item: T; children: TaskGroup<T>[] };

export function taskGroups<T>(
  items: T[],
  taskId: (item: T) => string,
  tasks: ReadonlyMap<string, Task>,
  ancestorIds?: (item: T) => readonly string[],
) {
  const groups = new Map<string, TaskGroup<T>>(
    items.map((item) => [taskId(item), { item, children: [] }]),
  );
  const roots: TaskGroup<T>[] = [];
  const displayedParents = new Map<string, string>();
  for (const [id, group] of groups) {
    const parentId = (
      ancestorIds?.(group.item) ?? taskAncestorIds(tasks, id)
    ).find((parent) => groups.has(parent));
    let ancestor = parentId;
    while (ancestor && ancestor !== id)
      ancestor = displayedParents.get(ancestor);
    // Snapshots generated at different times can disagree on ancestry.
    if (parentId && ancestor !== id) {
      displayedParents.set(id, parentId);
      groups.get(parentId)!.children.push(group);
    } else roots.push(group);
  }
  return roots;
}

export function taskGroupRows<T>(
  groups: TaskGroup<T>[],
  depth = 0,
): { item: T; depth: number }[] {
  return groups.flatMap(({ item, children }) => [
    { item, depth },
    ...taskGroupRows(children, depth + 1),
  ]);
}
