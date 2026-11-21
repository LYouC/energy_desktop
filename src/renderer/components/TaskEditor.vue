<script setup lang="ts">
import { ref, computed, watch } from "vue";
import Modal from "./Modal.vue";
import Button from "./ui/button/Button.vue";
import { useWorkspace } from "@/stores/workspace";
import {
  newTask,
  localDate,
  statusLabels,
  importanceLabels,
  type Task,
} from "../../domain/model";
const props = defineProps<{ task: Task }>();
const emit = defineEmits<{ close: []; edit: [task: Task] }>();
const store = useWorkspace();
const draft = ref<Task>(JSON.parse(JSON.stringify(props.task)));
const open = computed({
  get: () => true,
  set: (value) => {
    if (!value) emit("close");
  },
});
const error = ref("");
const deleting = ref(false);
const busy = ref(false);
const scheduleDate = ref(localDate());
const scope = ref("");
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
  store.state.tasks.filter((task) => task.parentId === props.task.id),
);
const parentOptions = computed(() => {
  const descendants = new Set([draft.value.id]);
  for (let pass = 0; pass < store.state.tasks.length; pass++)
    for (const task of store.state.tasks)
      if (task.parentId && descendants.has(task.parentId))
        descendants.add(task.id);
  return store.state.tasks.filter((task) => !descendants.has(task.id));
});
async function save(arrange = false, addChild = false) {
  busy.value = true;
  try {
    await store.dispatch({
      type: "saveTask",
      task: draft.value,
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
  try {
    await store.dispatch({ type: "deleteTask", id: props.task.id });
    emit("close");
  } catch (cause) {
    error.value = String(cause);
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
        <label>
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
      <div class="form-grid">
        <label
          >预计开始日期<input v-model="draft.startDate" type="date"
        /></label>
        <label
          >预计完成日期<input v-model="draft.expectedDate" type="date"
        /></label>
      </div>
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
      <p v-if="draft.status === 'done'" class="notice">
        请确认这件事已经完成。子任务或今日阶段完成，不会自动完成父任务。
      </p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <div class="form-actions">
        <Button
          v-if="existing"
          type="button"
          variant="ghost"
          @click="deleting = !deleting"
          >删除任务</Button
        >
        <Button type="submit" :disabled="busy">保存任务</Button>
      </div>
      <div v-if="deleting" class="notice">
        <p>删除「{{ draft.title }}」及其全部子任务和相关安排？</p>
        <Button type="button" variant="destructive" @click="remove"
          >确认删除</Button
        >
      </div>
      <details class="form-section">
        <summary>安排一次推进</summary>
        <div class="form-grid">
          <label>推进日期<input v-model="scheduleDate" type="date" /></label>
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
          :key="child.id"
          type="button"
          class="child-row"
          @click="emit('edit', child)"
        >
          {{ statusLabels[child.status] }} · {{ child.title }}
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
