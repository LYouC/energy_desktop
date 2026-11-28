import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { emptyState, type Command, type State } from "../../domain/model";
import { effectiveRecurrences } from "../../domain/recurrence";

export const useWorkspace = defineStore("workspace", () => {
  const state = ref<State>(emptyState());
  const recurrences = computed(() => effectiveRecurrences(state.value.tasks));
  const stoppedRecurrenceSources = computed(
    () =>
      new Set(
        state.value.repeatSchedules
          .filter(({ stoppedOn }) => stoppedOn)
          .map(({ taskId }) => taskId),
      ),
  );
  function isRecurrenceStopped(taskId: string) {
    const recurrence = recurrences.value.get(taskId);
    return recurrence
      ? stoppedRecurrenceSources.value.has(recurrence.sourceId)
      : false;
  }
  const ready = ref(false);
  const error = ref("");
  let queue: Promise<unknown> = Promise.resolve();
  async function refresh() {
    try {
      state.value = await window.desktop.load();
      ready.value = true;
      error.value = "";
      return true;
    } catch (cause) {
      error.value = String(cause);
      return false;
    }
  }
  function load() {
    const work = queue.then(refresh);
    queue = work;
    return work;
  }
  function dispatch(command: Command): Promise<void> {
    const submitted: Command = JSON.parse(JSON.stringify(command));
    const work = queue.then(async () => {
      try {
        state.value = await window.desktop.execute(
          state.value.revision,
          submitted,
        );
        error.value = "";
      } catch (cause) {
        error.value = String(cause);
        // Refresh stale local data after a conflict while keeping the user's form open.
        state.value = await window.desktop.load();
        throw cause;
      }
    });
    queue = work.catch(() => {});
    return work;
  }
  return {
    state,
    recurrences,
    isRecurrenceStopped,
    ready,
    error,
    load,
    dispatch,
  };
});
