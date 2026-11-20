import { computed, ref } from "vue";
import type { Task } from "../../domain/model";

export function deletionOrder(selectedIds: string[], tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = new Set(selectedIds);
  return selectedIds.filter((id) => {
    if (!byId.has(id)) return false;
    let parentId = byId.get(id)?.parentId ?? null;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
}

export function useTaskSelection() {
  const managing = ref(false);
  const ids = ref<string[]>([]);
  const count = computed(() => ids.value.length);
  const selected = computed(() => new Set(ids.value));
  function start() {
    ids.value = [];
    managing.value = true;
  }
  function stop() {
    managing.value = false;
    ids.value = [];
  }
  function toggle(id: string) {
    ids.value = selected.value.has(id)
      ? ids.value.filter((item) => item !== id)
      : [...ids.value, id];
  }
  function isSelected(id: string) {
    return selected.value.has(id);
  }
  function selectAll(tasks: Task[]) {
    ids.value = [...new Set(tasks.map((task) => task.id))];
  }
  function retain(tasks: Task[]) {
    const visible = new Set(tasks.map((task) => task.id));
    ids.value = ids.value.filter((id) => visible.has(id));
  }
  function clear() {
    ids.value = [];
  }
  return {
    managing,
    count,
    start,
    stop,
    toggle,
    isSelected,
    selectAll,
    retain,
    clear,
    deletionOrder: (tasks: Task[]) => deletionOrder(ids.value, tasks),
  };
}
