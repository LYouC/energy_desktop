<script setup lang="ts">
import { computed, ref } from "vue";
import type { Arrangement } from "../../domain/model";
import { useWorkspace } from "../stores/workspace";
import Button from "./ui/button/Button.vue";
import Modal from "./Modal.vue";

const props = defineProps<{ date: string; taskId?: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useWorkspace();
const selectedId = ref(props.taskId);
const historyItems = computed(() => {
  const entries = new Map<string, Arrangement[]>();
  for (const item of store.state.arrangements) {
    if (!item.recurrence || item.date > props.date) continue;
    const group = entries.get(item.taskId);
    if (group) group.push(item);
    else entries.set(item.taskId, [item]);
  }
  const active = new Map(
    store.state.tasks
      .filter((task) => task.recurrence)
      .map((task) => [task.id, task]),
  );
  for (const id of active.keys()) {
    if (!entries.has(id)) entries.set(id, []);
  }
  return [...entries].map(([id, items]) => {
    const days = [...items].sort((a, b) => b.date.localeCompare(a.date));
    return {
      id,
      title: active.get(id)?.title ?? days[0]?.recurrence?.title ?? "",
      stopped: !active.has(id),
      days,
      done: days.filter((item) => item.done).length,
      missed: days.filter((item) => !item.done && item.date < props.date)
        .length,
    };
  });
});
const selected = computed(() =>
  historyItems.value.find((item) => item.id === selectedId.value),
);
</script>

<template>
  <Modal
    :open="true"
    title="重复记录"
    description="按任务查看每次安排和执行结果。"
    @update:open="!$event && emit('close')"
  >
    <template v-if="selected">
      <div class="section-heading recurrence-history-heading">
        <h3>{{ selected.title }}</h3>
        <Button type="button" variant="ghost" @click="selectedId = undefined"
          >全部重复记录</Button
        >
      </div>
      <p class="muted recurrence-history-summary">
        <template v-if="selected.stopped">已停止重复 · </template>
        完成 {{ selected.done }} 次 · 错过 {{ selected.missed }} 次
      </p>
      <ul v-if="selected.days.length" class="recurrence-history-list">
        <li
          v-for="item in selected.days"
          :key="item.date"
          class="recurrence-history-row"
        >
          <div>
            <strong>{{ item.recurrence?.title }}</strong>
            <p class="muted">{{ item.date }} · {{ item.scope }}</p>
          </div>
          <span class="recurrence-tag">{{
            item.done ? "完成" : item.date < date ? "错过" : "待完成"
          }}</span>
        </li>
      </ul>
      <p v-else class="notice">还没有执行记录。</p>
    </template>
    <ul v-else-if="historyItems.length" class="recurrence-history-list">
      <li
        v-for="item in historyItems"
        :key="item.id"
        class="recurrence-history-row"
      >
        <div>
          <strong>{{ item.title }}</strong>
          <p class="muted">
            <template v-if="item.stopped">已停止重复 · </template>
            完成 {{ item.done }} 次 · 错过 {{ item.missed }} 次
          </p>
        </div>
        <Button type="button" variant="ghost" @click="selectedId = item.id"
          >查看执行记录</Button
        >
      </li>
    </ul>
    <p v-else class="notice">还没有重复记录。</p>
  </Modal>
</template>
