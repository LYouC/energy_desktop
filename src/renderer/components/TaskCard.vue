<script setup lang="ts">
import { computed } from "vue";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  Check,
  Circle,
  CalendarDays,
  Repeat2,
} from "lucide-vue-next";
import Button from "./ui/button/Button.vue";
import { useWorkspace } from "@/stores/workspace";
import { statusLabels, type Task, type Arrangement } from "../../domain/model";
const props = defineProps<{
  task?: Task;
  arrangement: Arrangement;
  focus?: boolean;
  previousTaskId?: string;
  nextTaskId?: string;
  selectable?: boolean;
  selected?: boolean;
}>();
const emit = defineEmits<{
  edit: [task: Task];
  occurrence: [item: Arrangement];
  focusTask: [id: string];
  moved: [taskId: string, targetTaskId: string];
  select: [id: string];
  skip: [item: Arrangement];
}>();
const store = useWorkspace();
const children = computed(() =>
  props.task && !props.arrangement.recurrence
    ? store.state.tasks.filter((task) => task.parentId === props.task?.id)
    : [],
);
const title = computed(
  () => props.arrangement.recurrence?.title ?? props.task?.title ?? "",
);
const kindLabel = computed(() =>
  props.arrangement.recurrence
    ? "重复"
    : props.task?.recurrence
      ? "临时安排"
      : "",
);
const showScope = computed(
  () =>
    !props.arrangement.recurrence ||
    props.arrangement.scope.trim() !== title.value.trim(),
);
function openDetails() {
  if (props.arrangement.recurrence) emit("occurrence", props.arrangement);
  else if (props.task) emit("edit", props.task);
}
async function stage() {
  try {
    await store.dispatch({
      type: "stage",
      taskId: props.arrangement.taskId,
      date: props.arrangement.date,
      done: !props.arrangement.done,
    });
  } catch {}
}
async function move(targetTaskId: string | undefined) {
  if (!targetTaskId) return;
  const { taskId, date } = props.arrangement;
  try {
    await store.dispatch({
      type: "move",
      taskId,
      date,
      targetTaskId,
    });
    emit("moved", taskId, targetTaskId);
  } catch {}
}
async function unschedule() {
  if (props.arrangement.recurrence) {
    emit("skip", props.arrangement);
    return;
  }
  try {
    await store.dispatch({
      type: "unschedule",
      taskId: props.arrangement.taskId,
      date: props.arrangement.date,
    });
  } catch {}
}
</script>
<template>
  <button
    v-if="selectable"
    type="button"
    :class="['task-card', 'select-card', { selected }]"
    :aria-pressed="selected"
    @click="emit('select', arrangement.taskId)"
  >
    <span class="select-box" :class="{ checked: selected }">
      <Check v-if="selected" :size="12" />
    </span>
    <span class="select-copy">
      <span class="task-title-line">
        <span class="select-title">{{ title }}</span>
        <span v-if="kindLabel" class="recurrence-tag">{{ kindLabel }}</span>
      </span>
      <small v-if="showScope">{{ arrangement.scope }}</small>
    </span>
  </button>
  <article
    v-else
    :class="['task-card', { focused: focus, 'stage-done': arrangement.done }]"
  >
    <div v-if="focus" class="eyebrow">当前聚焦</div>
    <div class="task-head">
      <button
        class="check"
        :aria-label="arrangement.done ? '恢复今日阶段' : '完成今日阶段'"
        @click="stage"
      >
        <Check v-if="arrangement.done" :size="15" /><Circle v-else :size="15" />
      </button>
      <div class="task-info">
        <div class="task-title-line">
          <button class="task-name" @click="openDetails">{{ title }}</button>
          <span v-if="kindLabel" class="recurrence-tag">
            <Repeat2
              v-if="arrangement.recurrence"
              :size="12"
              aria-hidden="true"
            />{{ kindLabel }}
          </span>
        </div>
        <div v-if="task && !arrangement.recurrence" class="task-meta">
          <span v-if="task.startDate || task.expectedDate"
            ><CalendarDays :size="12" />
            <template v-if="task.startDate"
              >预计开始 {{ task.startDate }}</template
            >
            <template v-if="task.expectedDate"
              >预计完成 {{ task.expectedDate }}</template
            > </span
          ><span
            >{{ arrangement.done ? "整体任务：" : ""
            }}{{ statusLabels[task.status] }}</span
          >
        </div>
      </div>
      <button
        class="icon-button"
        :aria-label="arrangement.recurrence ? '本次详情' : '查看任务详情'"
        @click="openDetails"
      >
        <ArrowUpRight :size="17" />
      </button>
    </div>
    <p v-if="showScope" class="stage-goal">
      今日目标 · {{ arrangement.scope }}
    </p>
    <template v-if="focus">
      <button
        v-for="child in children"
        :key="child.id"
        class="child-row"
        @click="emit('edit', child)"
      >
        <Check v-if="child.status === 'done'" :size="15" /><Circle
          v-else
          :size="15"
        /><span>{{ child.title }}</span
        ><small>{{ statusLabels[child.status] }}</small>
      </button>
      <p
        v-if="task?.description && !arrangement.recurrence"
        class="muted background-preview"
      >
        {{ task.description }}
      </p>
    </template>
    <div
      v-if="!arrangement.done || !arrangement.recurrence"
      class="task-footer"
    >
      <Button
        v-if="!focus && !arrangement.done"
        variant="ghost"
        @click="emit('focusTask', arrangement.taskId)"
        >聚焦这件事</Button
      ><span v-else-if="focus && children.length" class="muted">{{
        `${children.filter((child) => child.status === "done").length} / ${children.length} 子任务完成`
      }}</span>
      <div class="row task-actions">
        <button
          v-if="previousTaskId"
          class="icon-button"
          aria-label="上移安排"
          @click="move(previousTaskId)"
        >
          <ArrowUp :size="14" />
        </button>
        <button
          v-if="nextTaskId"
          class="icon-button"
          aria-label="下移安排"
          @click="move(nextTaskId)"
        >
          <ArrowDown :size="14" /></button
        ><Button variant="ghost" @click="unschedule">{{
          arrangement.recurrence ? "从今天移除" : "移出当日"
        }}</Button>
      </div>
    </div>
  </article>
</template>
