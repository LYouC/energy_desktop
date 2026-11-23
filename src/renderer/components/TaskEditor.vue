<script setup lang="ts">
import { ref, computed, watch } from "vue";
import Modal from "./Modal.vue";
import Button from "./ui/button/Button.vue";
import { useWorkspace } from "@/stores/workspace";
import {
  affectedRecurringTasks,
  recurrenceLabel,
  taskProgressForDate,
  tomorrow,
  weekdays,
} from "../lib/recurrence";
import { nextRecurrenceDate } from "../../domain/recurrence";
import {
  newTask,
  statusLabels,
  importanceLabels,
  recurrenceRuleSchema,
  taskSubtreeIds,
  type RecurrenceRule,
  type Task,
} from "../../domain/model";
const props = defineProps<{ task: Task; date: string; fromToday?: boolean }>();
const emit = defineEmits<{
  close: [];
  edit: [task: Task];
  history: [id: string];
}>();
const store = useWorkspace();
const draft = ref<Task>(JSON.parse(JSON.stringify(props.task)));
const rule = props.task.recurrence;
const savedRecurrence = computed(() => store.recurrences.get(props.task.id));
const parentRecurrence = computed(() =>
  store.recurrences.get(draft.value.parentId ?? ""),
);
const repeatType = ref<RecurrenceRule["type"] | "none">(rule?.type ?? "none");
const repeatDays = ref(rule?.type === "weekly" ? [...rule.weekdays] : []);
const repeatStart = ref(rule?.type === "range" ? rule.start : props.date);
const repeatEnd = ref(rule?.type === "range" ? rule.end : "");
const recurrence = computed(() => {
  if (repeatType.value === "none") return;
  if (repeatType.value === "daily") return { type: "daily" } as const;
  if (repeatType.value === "weekly")
    return { type: "weekly", weekdays: [...repeatDays.value].sort() } as const;
  return {
    type: "range",
    start: repeatStart.value,
    end: repeatEnd.value,
  } as const;
});
const effectiveRule = computed(
  () => recurrence.value ?? parentRecurrence.value?.rule,
);
const ruleChanged = computed(() => {
  const next = recurrence.value;
  if (!rule || !next || rule.type !== next.type) return rule !== next;
  if (rule.type === "weekly" && next.type === "weekly")
    return (
      rule.weekdays.length !== next.weekdays.length ||
      rule.weekdays.some((day) => !next.weekdays.includes(day))
    );
  if (rule.type === "range" && next.type === "range")
    return rule.start !== next.start || rule.end !== next.end;
  return false;
});
const inactive = computed(
  () => draft.value.status === "done" || draft.value.status === "abandoned",
);
const ruleError = computed(() => {
  const next = recurrence.value;
  if (!next) return "";
  if (inactive.value) return "请先恢复任务状态，再设置重复。";
  if (next.type === "weekly" && !next.weekdays.length)
    return "请选择至少一个星期。";
  if (next.type === "range") {
    if (!next.start || !next.end) return "请选择重复的起止日期。";
    if (next.start > next.end) return "结束日期不能早于开始日期。";
    const keepsStart = rule?.type === "range" && rule.start === next.start;
    if (!keepsStart && next.start < props.date) return "开始日期不能早于今天。";
    if (savedRecurrence.value && ruleChanged.value && next.end <= props.date)
      return "新规则从明天生效，结束日期需在今天之后。";
  }
  return "";
});
const repeatPreview = computed(() => {
  if (ruleError.value) return ruleError.value;
  if (!recurrence.value && parentRecurrence.value)
    return `随所属任务重复 · ${recurrenceLabel(parentRecurrence.value.rule)}`;
  const result = recurrenceRuleSchema.safeParse(recurrence.value);
  if (!result.success) return "";
  const start = savedRecurrence.value ? tomorrow(props.date) : props.date;
  const date = nextRecurrenceDate(result.data, start);
  if (!date) return "重复已结束。";
  if (date === props.date) {
    const alreadyScheduled = store.state.arrangements.some(
      (item) => item.taskId === props.task.id && item.date === date,
    );
    return alreadyScheduled ? "保留今天已有的安排。" : "保存后加入今日安排。";
  }
  if (!savedRecurrence.value) return `首次安排 ${date}`;
  return ruleChanged.value
    ? `次日起采用新规则，下一次 ${date}`
    : `下次安排 ${date}`;
});
const open = computed({
  get: () => true,
  set: (value) => {
    if (!value) emit("close");
  },
});
const error = ref("");
const deleting = ref(false);
const busy = ref(false);
const scheduleDate = ref(props.date);
const scope = ref("");
const temporaryToday = computed(
  () =>
    !!(
      props.fromToday &&
      savedRecurrence.value &&
      scheduleDate.value === props.date
    ) &&
    store.state.arrangements.some(
      (item) =>
        item.taskId === props.task.id &&
        item.date === props.date &&
        !item.recurrence,
    ),
);
watch(
  scheduleDate,
  (date) => {
    scope.value =
      store.state.arrangements.find(
        (item) => item.taskId === props.task.id && item.date === date,
      )?.scope || "";
  },
  { immediate: true },
);
const existing = computed(() =>
  store.state.tasks.some((task) => task.id === props.task.id),
);
const children = computed(() =>
  store.state.tasks
    .filter((task) => task.parentId === props.task.id)
    .map((task) => ({
      task,
      ...taskProgressForDate(
        task,
        store.state.arrangements.find(
          (item) => item.taskId === task.id && item.date === props.date,
        ),
        Boolean(store.recurrences.get(task.id)),
      ),
    })),
);
const repeatDescendants = computed(() =>
  affectedRecurringTasks(store.state.tasks, [props.task.id]).filter(
    (task) => task.id !== props.task.id,
  ),
);
const parentOptions = computed(() => {
  const descendants = taskSubtreeIds(store.state.tasks, [draft.value.id]);
  return store.state.tasks.filter((task) => !descendants.has(task.id));
});
async function save(arrange = false, addChild = false) {
  if (busy.value) return;
  if (ruleError.value) {
    error.value = ruleError.value;
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    await store.dispatch({
      type: "saveTask",
      task: { ...draft.value, recurrence: recurrence.value },
      arrangement: arrange
        ? { date: scheduleDate.value, scope: scope.value }
        : undefined,
    });
    if (addChild) emit("edit", newTask(draft.value.id));
    else emit("close");
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await store.dispatch({ type: "deleteTask", id: props.task.id });
    emit("close");
  } catch (cause) {
    error.value = String(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal
    v-model:open="open"
    :title="existing ? '任务详情' : '记下一件事'"
    description="先记下要做的事，日期与说明都可以稍后补充。"
  >
    <form class="task-form" @submit.prevent="save()">
      <label
        >任务名称<input
          v-model="draft.title"
          required
          maxlength="200"
          autofocus
          placeholder="想推进什么？"
      /></label>
      <div class="form-grid">
        <label v-if="!effectiveRule || (recurrence && inactive)">
          任务状态<select v-model="draft.status">
            <option
              v-for="(label, value) in statusLabels"
              :key="value"
              :value="value"
            >
              {{ label }}
            </option>
          </select>
        </label>
        <label>
          重要性<select v-model="draft.importance">
            <option :value="null">未设置</option>
            <option
              v-for="(label, value) in importanceLabels"
              :key="value"
              :value="value"
            >
              {{ label }}
            </option>
          </select>
        </label>
      </div>
      <div v-if="!effectiveRule" class="form-grid">
        <label
          >预计开始日期<input v-model="draft.startDate" type="date"
        /></label>
        <label
          >预计完成日期<input v-model="draft.expectedDate" type="date"
        /></label>
      </div>
      <label>
        重复<select v-model="repeatType">
          <option v-if="!rule" value="none">
            {{ parentRecurrence ? "跟随父任务" : "不重复" }}
          </option>
          <option value="daily">每天</option>
          <option value="weekly">每周自选星期</option>
          <option value="range">指定起止日期</option>
        </select>
      </label>
      <fieldset v-if="repeatType === 'weekly'" class="repeat-days">
        <legend>每周哪几天</legend>
        <label v-for="[day, name] in weekdays" :key="day">
          <input v-model="repeatDays" type="checkbox" :value="day" />
          {{ name }}
        </label>
      </fieldset>
      <div v-else-if="repeatType === 'range'" class="form-grid">
        <label
          >重复开始日期<input
            v-model="repeatStart"
            type="date"
            :min="!rule ? date : undefined"
        /></label>
        <label
          >重复结束日期<input
            v-model="repeatEnd"
            type="date"
            :min="repeatStart"
        /></label>
      </div>
      <p v-if="repeatPreview" aria-live="polite" class="muted">
        {{ repeatPreview }}
      </p>
      <label
        >说明<textarea
          v-model="draft.description"
          rows="4"
          placeholder="需要时补充目标、要求、背景或当前进展"
        />
      </label>
      <label
        >所属任务<select v-model="draft.parentId">
          <option :value="null">独立任务</option>
          <option v-for="task in parentOptions" :key="task.id" :value="task.id">
            {{ task.title }}
          </option>
        </select></label
      >
      <p v-if="draft.status === 'done' && !effectiveRule" class="notice">
        请确认这件事已经完成。子任务或今日阶段完成，不会自动完成父任务。
      </p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <div class="form-actions repeat-form-actions">
        <Button
          v-if="existing && !(fromToday && savedRecurrence)"
          type="button"
          variant="ghost"
          :disabled="busy"
          @click="deleting = !deleting"
          >{{ savedRecurrence ? "删除重复任务" : "删除任务" }}</Button
        >
        <Button
          v-if="savedRecurrence"
          type="button"
          variant="ghost"
          @click="emit('history', task.id)"
          >查看执行记录</Button
        >
        <Button type="submit" :disabled="busy">保存任务</Button>
      </div>
      <div v-if="deleting" class="notice">
        <p v-if="savedRecurrence">
          删除「{{
            task.title
          }}」后，后续日期将停止生成安排。已经生成的重复实例（包括今天）会保留。它的子任务也会被删除。
        </p>
        <p v-else>删除「{{ task.title }}」及其全部子任务和相关普通安排？</p>
        <p v-if="repeatDescendants.length">
          以下重复子任务也将停止生成安排。已生成的实例会保留。
        </p>
        <ul v-if="repeatDescendants.length" class="delete-list">
          <li v-for="descendant in repeatDescendants" :key="descendant.id">
            {{ descendant.title }}
          </li>
        </ul>
        <Button
          type="button"
          variant="destructive"
          :disabled="busy"
          @click="remove"
          >{{ savedRecurrence ? "确认删除重复任务" : "确认删除" }}</Button
        >
      </div>
      <details v-if="!effectiveRule || temporaryToday" class="form-section">
        <summary>安排一次推进</summary>
        <div class="form-grid">
          <label
            >推进日期<input
              v-model="scheduleDate"
              type="date"
              :readonly="temporaryToday"
          /></label>
          <label
            >本次阶段目标<input
              v-model="scope"
              placeholder="这一天推进到哪里？"
          /></label>
        </div>
        <Button
          type="button"
          variant="outline"
          :disabled="
            busy || !draft.title.trim() || !scope.trim() || !scheduleDate
          "
          @click="save(true)"
          >保存并安排</Button
        >
      </details>
      <section v-if="existing" class="form-section">
        <h3>子任务</h3>
        <button
          v-for="child in children"
          :key="child.task.id"
          type="button"
          class="child-row"
          @click="emit('edit', child.task)"
        >
          {{ child.label }} · {{ child.task.title }}
        </button>
        <Button
          type="button"
          variant="outline"
          :disabled="busy || !draft.title.trim()"
          @click="save(false, true)"
          >添加子任务</Button
        >
      </section>
    </form>
  </Modal>
</template>
