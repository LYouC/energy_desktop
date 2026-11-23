<script setup lang="ts">
import { ref } from "vue";
import type { Arrangement, Task } from "../../domain/model";
import { useWorkspace } from "../stores/workspace";
import Button from "./ui/button/Button.vue";
import Modal from "./Modal.vue";

const props = defineProps<{ occurrence: Arrangement; task?: Task }>();
const emit = defineEmits<{ close: []; settings: [Task]; history: [string] }>();
const store = useWorkspace();
const scope = ref(props.occurrence.scope);
const error = ref("");
const busy = ref(false);

async function save() {
  if (busy.value || !scope.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    await store.dispatch({
      type: "updateOccurrenceScope",
      taskId: props.occurrence.taskId,
      date: props.occurrence.date,
      scope: scope.value,
    });
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
    :open="true"
    title="本次详情"
    :description="`${occurrence.recurrence?.title ?? ''} · ${occurrence.date}`"
    @update:open="!$event && emit('close')"
  >
    <form class="task-form" @submit.prevent="save">
      <label>
        本次阶段目标
        <textarea v-model="scope" rows="3" required />
      </label>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <div class="form-actions repeat-form-actions">
        <Button
          v-if="task && store.recurrences.get(task.id)"
          type="button"
          variant="ghost"
          @click="emit('settings', task)"
          >查看重复设置</Button
        >
        <Button
          v-else
          type="button"
          variant="ghost"
          @click="emit('history', occurrence.taskId)"
          >查看执行记录</Button
        >
        <Button type="submit" :disabled="busy || !scope.trim()"
          >保存本次范围</Button
        >
      </div>
    </form>
  </Modal>
</template>
