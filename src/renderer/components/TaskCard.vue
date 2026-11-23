<script setup lang="ts">
import { computed } from "vue";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  Check,
  Square,
  SquareCheck,
  CalendarDays,
  Ellipsis,
  Repeat2,
} from "lucide-vue-next";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
} from "reka-ui";
import Button from "./ui/button/Button.vue";
import { useWorkspace } from "@/stores/workspace";
import { taskProgressForDate } from "../lib/recurrence";
import { taskGroups, taskGroupRows } from "../lib/taskGroups";
import {
  arrangementAncestorIds,
  taskAncestorIds,
} from "../../domain/recurrence";
import { statusLabels, type Task, type Arrangement } from "../../domain/model";
const props = defineProps<{
  task?: Task;
  arrangement: Arrangement;
  focus?: boolean;
  focusedTaskId?: string | null;
  moveTaskId?: string;
  movingGroup?: boolean;
  dueTaskIds?: Set<string>;
  previousTaskId?: string;
  nextTaskId?: string;
  selectable?: boolean;
  selected?: boolean;
  subtasks?: { item: Arrangement & { task?: Task }; depth: number }[];
}>();
const emit = defineEmits<{
  edit: [task: Task];
  occurrence: [item: Arrangement];
  focusTask: [id: string];
  moved: [taskId: string, targetTaskId: string];
  moveGroup: [taskId: string, targetTaskId: string];
  focusStage: [taskId: string];
  select: [id: string];
  skip: [item: Arrangement, focusTaskId?: string];
}>();
const store = useWorkspace();
const children = computed(() =>
  (props.subtasks ?? []).map(({ item }) => ({
    item,
    title: item.recurrence?.title ?? item.task?.title ?? "",
  })),
);
const hasPendingChildren = computed(() =>
  children.value.some(({ item }) => !item.done),
);
const collapseChildren = computed(
  () =>
    props.arrangement.done &&
    children.value.length > 0 &&
    !hasPendingChildren.value,
);
const childRows = computed(() => {
  if (!props.focus && !children.value.length) return [];
  const date = props.arrangement.date;
  const rootId = props.arrangement.taskId;
  const tasks = new Map(store.state.tasks.map((task) => [task.id, task]));
  const scheduledIds = new Set([
    rootId,
    ...store.state.arrangements
      .filter((item) => item.date === date)
      .map((item) => item.taskId),
  ]);
  const skippedIds = new Set<string>();
  for (const { arrangement } of store.state.skippedOccurrences ?? [])
    if (arrangement.date === date) skippedIds.add(arrangement.taskId);
  type Child = { taskId: string; title: string } & (
    | { item: Arrangement & { task?: Task }; task?: never }
    | { task: Task; item?: never }
  );
  const entries = new Map<string, Child>();
  function addPreview(task: Task) {
    if (
      !scheduledIds.has(task.id) &&
      !skippedIds.has(task.id) &&
      !props.dueTaskIds?.has(task.id)
    )
      entries.set(task.id, { taskId: task.id, title: task.title, task });
  }
  for (const { item, title } of children.value) {
    const bridge: Task[] = [];
    for (const parentId of arrangementAncestorIds(tasks, item)) {
      if (scheduledIds.has(parentId)) break;
      const parent = tasks.get(parentId);
      if (parent) bridge.push(parent);
    }
    for (const ancestor of bridge.reverse()) addPreview(ancestor);
    entries.set(item.taskId, { taskId: item.taskId, title, item });
  }
  if (props.focus)
    for (const task of tasks.values())
      if (task.parentId === rootId) addPreview(task);
  return taskGroupRows(
    taskGroups(
      [...entries.values()],
      (child) => child.taskId,
      tasks,
      (child) =>
        child.item
          ? arrangementAncestorIds(tasks, child.item)
          : taskAncestorIds(tasks, child.taskId),
    ),
    1,
  );
});
const childMoves = computed(() => {
  const siblings = new Map<string | null | undefined, string[]>();
  for (const { item } of children.value) {
    if (item.done) continue;
    const parent = item.recurrence?.ancestorIds
      ? item.recurrence.ancestorIds[0]
      : item.task?.parentId;
    const ids = siblings.get(parent) ?? [];
    ids.push(item.taskId);
    siblings.set(parent, ids);
  }
  return new Map(
    [...siblings.values()].flatMap((ids) =>
      ids.map(
        (id, index) =>
          [id, { previous: ids[index - 1], next: ids[index + 1] }] as const,
      ),
    ),
  );
});
const title = computed(
  () => props.arrangement.recurrence?.title ?? props.task?.title ?? "",
);
function arrangementKind(item: Arrangement) {
  return item.recurrence
    ? "重复"
    : store.recurrences.get(item.taskId)
      ? "临时安排"
      : "";
}
const kindLabel = computed(() => arrangementKind(props.arrangement));
const showScope = computed(
  () =>
    !props.arrangement.recurrence ||
    props.arrangement.scope.trim() !== title.value.trim(),
);
function openDetails(item: Arrangement, task?: Task) {
  if (item.recurrence) emit("occurrence", item);
  else if (task) emit("edit", task);
}
async function stage(item: Arrangement, keyboard: boolean) {
  try {
    await store.dispatch({
      type: "stage",
      taskId: item.taskId,
      date: item.date,
      done: !item.done,
    });
    if (keyboard) emit("focusStage", item.taskId);
  } catch {}
}
async function move(taskId: string, targetTaskId: string | undefined) {
  if (!targetTaskId) return;
  const { date } = props.arrangement;
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
async function unschedule(item: Arrangement, focusTaskId?: string) {
  if (item.recurrence) {
    emit("skip", item, focusTaskId);
    return;
  }
  try {
    await store.dispatch({
      type: "unschedule",
      taskId: item.taskId,
      date: item.date,
    });
    if (focusTaskId) emit("focusStage", focusTaskId);
  } catch {}
}
</script>
<template>
  <button
    v-if="selectable"
    type="button"
    :class="['task-card', 'select-card', { selected }]"
    :aria-label="`选择今日安排：${title}`"
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
        :aria-pressed="arrangement.done"
        :title="
          !arrangement.done && hasPendingChildren
            ? '同时完成今天已安排的子任务'
            : undefined
        "
        :data-stage-task-id="arrangement.taskId"
        @click="stage(arrangement, $event.detail === 0)"
      >
        <SquareCheck v-if="arrangement.done" :size="17" /><Square
          v-else
          :size="17"
        />
      </button>
      <div class="task-info">
        <div class="task-title-line">
          <button class="task-name" @click="openDetails(arrangement, task)">
            {{ title }}
          </button>
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
        @click="openDetails(arrangement, task)"
      >
        <ArrowUpRight :size="17" />
      </button>
    </div>
    <p v-if="showScope" class="stage-goal">
      今日目标 · {{ arrangement.scope }}
    </p>
    <component
      :is="collapseChildren ? 'details' : 'div'"
      v-if="childRows.length"
      class="task-children-container"
    >
      <summary v-if="collapseChildren">
        展开子任务（{{ children.length }}）
      </summary>
      <ul class="task-children" :aria-label="`${title}的子任务`">
        <li
          v-for="{ item: child, depth } in childRows"
          :key="child.taskId"
          class="task-child-row"
          :class="{
            'child-focused': child.taskId === focusedTaskId,
            'unscheduled-child': !child.item,
          }"
          :style="{ '--task-indent': `${Math.min(depth - 1, 3) * 12}px` }"
        >
          <template v-if="child.item">
            <button
              type="button"
              class="check child-check"
              :aria-label="`${child.item.done ? '恢复' : '完成'}子任务今日阶段：${child.title}`"
              :aria-pressed="child.item.done"
              :data-stage-task-id="child.item.taskId"
              @click="stage(child.item, $event.detail === 0)"
            >
              <SquareCheck v-if="child.item.done" :size="17" /><Square
                v-else
                :size="17"
              />
            </button>
            <div class="task-child-copy">
              <div class="task-title-line">
                <button
                  class="task-child-name"
                  type="button"
                  @click="openDetails(child.item, child.item.task)"
                >
                  {{ child.title }}
                </button>
                <span
                  v-if="arrangementKind(child.item)"
                  class="recurrence-tag"
                  >{{ arrangementKind(child.item) }}</span
                >
              </div>
              <small v-if="child.item.scope !== child.title">{{
                child.item.scope
              }}</small>
            </div>
            <small>{{
              child.item.done ? "今日阶段已完成" : "今日待推进"
            }}</small>
            <DropdownMenuRoot
              v-if="!child.item.done || !child.item.recurrence"
              :modal="false"
            >
              <DropdownMenuTrigger
                class="icon-button"
                :aria-label="`${child.title}的安排操作`"
                ><Ellipsis :size="16"
              /></DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent
                  class="child-actions-menu"
                  align="end"
                  :side-offset="4"
                >
                  <DropdownMenuItem
                    v-if="
                      !child.item.done && child.item.taskId !== focusedTaskId
                    "
                    @select="emit('focusTask', child.item.taskId)"
                    >聚焦这件事</DropdownMenuItem
                  >
                  <DropdownMenuItem
                    v-if="childMoves.get(child.item.taskId)?.previous"
                    @select="
                      move(
                        child.item.taskId,
                        childMoves.get(child.item.taskId)?.previous,
                      )
                    "
                    >上移子任务</DropdownMenuItem
                  >
                  <DropdownMenuItem
                    v-if="childMoves.get(child.item.taskId)?.next"
                    @select="
                      move(
                        child.item.taskId,
                        childMoves.get(child.item.taskId)?.next,
                      )
                    "
                    >下移子任务</DropdownMenuItem
                  >
                  <DropdownMenuItem
                    @select="unschedule(child.item, arrangement.taskId)"
                    >{{
                      child.item.recurrence ? "从今天移除" : "移出当日"
                    }}</DropdownMenuItem
                  >
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenuRoot>
          </template>
          <template v-else>
            <div class="task-child-copy">
              <button
                class="task-child-name"
                type="button"
                @click="emit('edit', child.task)"
              >
                {{ child.title }}
              </button>
            </div>
            <small>{{
              taskProgressForDate(
                child.task,
                undefined,
                Boolean(store.recurrences.get(child.taskId)),
              ).label
            }}</small>
          </template>
        </li>
      </ul>
    </component>
    <p
      v-if="focus && task?.description && !arrangement.recurrence"
      class="muted background-preview"
    >
      {{ task.description }}
    </p>
    <div
      v-if="!arrangement.done || !arrangement.recurrence || hasPendingChildren"
      class="task-footer"
    >
      <Button
        v-if="!focus && (!arrangement.done || hasPendingChildren)"
        variant="ghost"
        @click="emit('focusTask', moveTaskId ?? arrangement.taskId)"
        >聚焦这件事</Button
      ><span v-else-if="focus && children.length" class="muted">{{
        `${children.filter((child) => child.item.done).length} / ${children.length} 子任务完成`
      }}</span>
      <div class="row task-actions">
        <button
          v-if="previousTaskId"
          class="icon-button"
          aria-label="上移安排"
          :disabled="movingGroup"
          @click="
            emit('moveGroup', moveTaskId ?? arrangement.taskId, previousTaskId)
          "
        >
          <ArrowUp :size="14" />
        </button>
        <button
          v-if="nextTaskId"
          class="icon-button"
          aria-label="下移安排"
          :disabled="movingGroup"
          @click="
            emit('moveGroup', moveTaskId ?? arrangement.taskId, nextTaskId)
          "
        >
          <ArrowDown :size="14" /></button
        ><Button
          v-if="!arrangement.done || !arrangement.recurrence"
          variant="ghost"
          @click="unschedule(arrangement)"
          >{{ arrangement.recurrence ? "从今天移除" : "移出当日" }}</Button
        >
      </div>
    </div>
  </article>
</template>
