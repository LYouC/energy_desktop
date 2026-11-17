<script setup lang="ts">
import { computed } from "vue";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  Check,
  Circle,
  CalendarDays,
} from "lucide-vue-next";
import Button from "./ui/button/Button.vue";
import { useWorkspace } from "@/stores/workspace";
import { statusLabels, type Task, type Arrangement } from "../../shared/model";
const props = defineProps<{
  task: Task;
  arrangement: Arrangement;
  focus: boolean;
}>();
defineEmits<{ edit: [task: Task]; focusTask: [id: string] }>();
const store = useWorkspace();
const children = computed(() =>
  store.state.tasks.filter((task) => task.parentId === props.task.id),
);
async function stage() {
  try {
    await store.dispatch({
      type: "stage",
      taskId: props.task.id,
      date: props.arrangement.date,
      done: !props.arrangement.done,
    });
  } catch {}
}
async function move(direction: "up" | "down") {
  try {
    await store.dispatch({
      type: "move",
      taskId: props.task.id,
      date: props.arrangement.date,
      direction,
    });
  } catch {}
}
async function unschedule() {
  try {
    await store.dispatch({
      type: "unschedule",
      taskId: props.task.id,
      date: props.arrangement.date,
    });
  } catch {}
}
</script>
<template>
  <article
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
        <button class="task-name" @click="$emit('edit', task)">
          {{ task.title }}
        </button>
        <div class="task-meta">
          <span v-if="task.startDate || task.expectedDate"
            ><CalendarDays :size="12" />
            <template v-if="task.startDate"
              >预计开始 {{ task.startDate }}</template
            >
            <template v-if="task.expectedDate"
              >预计完成 {{ task.expectedDate }}</template
            > </span
          ><span>{{ statusLabels[task.status] }}</span>
        </div>
      </div>
      <button
        class="icon-button"
        aria-label="查看任务详情"
        @click="$emit('edit', task)"
      >
        <ArrowUpRight :size="17" />
      </button>
    </div>
    <p class="stage-goal">今日目标 · {{ arrangement.scope }}</p>
    <p v-if="arrangement.done" class="muted">
      今日阶段已完成 · 整体任务状态为{{ statusLabels[task.status] }}
    </p>
    <template v-if="focus">
      <button
        v-for="child in children"
        :key="child.id"
        class="child-row"
        @click="$emit('edit', child)"
      >
        <Check v-if="child.status === 'done'" :size="15" /><Circle
          v-else
          :size="15"
        /><span>{{ child.title }}</span
        ><small>{{ statusLabels[child.status] }}</small>
      </button>
      <p v-if="task.description" class="muted background-preview">
        {{ task.description }}
      </p>
    </template>
    <div class="task-footer">
      <Button v-if="!focus" variant="ghost" @click="$emit('focusTask', task.id)"
        >聚焦这件事</Button
      ><span v-else class="muted">{{
        children.length
          ? `${children.filter((t) => t.status === "done").length} / ${children.length} 子任务完成`
          : "按本次阶段目标推进"
      }}</span>
      <div class="row">
        <button class="icon-button" aria-label="上移安排" @click="move('up')">
          <ArrowUp :size="14" /></button
        ><button
          class="icon-button"
          aria-label="下移安排"
          @click="move('down')"
        >
          <ArrowDown :size="14" /></button
        ><Button variant="ghost" @click="unschedule">移出当日</Button>
      </div>
    </div>
  </article>
</template>
