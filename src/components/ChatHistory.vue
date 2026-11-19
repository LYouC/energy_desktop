<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Trash2 } from "lucide-vue-next";
import { useWorkspace } from "@/stores/workspace";
import {
  conversationHistory,
  conversationLimit,
} from "../../shared/conversations";
import Button from "./ui/button/Button.vue";
import Modal from "./Modal.vue";

const props = defineProps<{ running: boolean }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ select: [id: string] }>();
const store = useWorkspace();
const pageSize = ref(10);
const page = ref(1);
const list = ref<HTMLElement>();
const pendingDelete = ref<{ id: string; title: string }>();
const deleting = ref(false);
const error = ref("");
const entries = computed(() => conversationHistory(store.state));
const pageCount = computed(() =>
  Math.max(1, Math.ceil(entries.value.length / pageSize.value)),
);
const visible = computed(() =>
  entries.value.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
);
const formatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});
function formatTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? formatter.format(timestamp) : "暂无时间";
}

watch(open, (opened) => {
  if (opened) page.value = 1;
  pendingDelete.value = undefined;
  error.value = "";
});
watch(pageCount, (count) => {
  page.value = Math.min(page.value, count);
});
watch(pageSize, () => {
  page.value = 1;
});
watch(page, () => {
  if (list.value) list.value.scrollTop = 0;
});

async function remove() {
  if (!pendingDelete.value || deleting.value || props.running) return;
  deleting.value = true;
  error.value = "";
  try {
    await store.dispatch({ type: "deleteSession", id: pendingDelete.value.id });
    pendingDelete.value = undefined;
    await nextTick();
    list.value?.focus();
  } catch {
    error.value = "未能删除对话，请再试一次。";
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <Modal
    v-model:open="open"
    title="对话历史"
    :description="`按最近对话时间排序，最多保留 ${conversationLimit} 个对话。`"
  >
    <ul ref="list" class="history-list" aria-label="对话列表" tabindex="-1">
      <li
        v-for="{ session, lastActivity } in visible"
        :key="session.id"
        class="history-row"
      >
        <Button
          variant="outline"
          class="history-link"
          :disabled="deleting"
          @click="emit('select', session.id)"
        >
          <span class="history-title" :title="session.title">{{
            session.title
          }}</span>
          <span v-if="session.id === store.state.activeSessionId" class="muted"
            >当前</span
          >
          <time :datetime="lastActivity || undefined" class="muted">{{
            formatTime(lastActivity)
          }}</time>
        </Button>
        <button
          type="button"
          class="icon-button"
          :aria-label="`删除对话：${session.title}`"
          title="删除对话"
          :disabled="running || deleting"
          @click="
            pendingDelete = session;
            error = '';
          "
        >
          <Trash2 :size="16" />
        </button>
      </li>
    </ul>
    <div
      v-if="pendingDelete"
      class="history-confirm"
      role="group"
      aria-label="确认删除对话"
    >
      <p>
        删除「{{
          pendingDelete.title
        }}」？聊天记录、草稿和会话方案将被删除，已保存的任务和安排不受影响。
      </p>
      <div class="history-actions">
        <Button
          variant="outline"
          :disabled="deleting"
          @click="
            pendingDelete = undefined;
            error = '';
          "
          >取消</Button
        >
        <Button
          variant="destructive"
          :disabled="running || deleting"
          @click="remove"
          >确认删除</Button
        >
      </div>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
    </div>
    <footer class="history-footer">
      <label class="muted"
        >每页
        <select v-model.number="pageSize" aria-label="每页对话数">
          <option :value="5">5</option>
          <option :value="10">10</option>
          <option :value="20">20</option>
        </select>
      </label>
      <div class="history-actions">
        <Button variant="outline" :disabled="page <= 1" @click="page--"
          >上一页</Button
        >
        <span class="muted" aria-live="polite"
          >{{ page }} / {{ pageCount }} 页 · {{ entries.length }} 个</span
        >
        <Button variant="outline" :disabled="page >= pageCount" @click="page++"
          >下一页</Button
        >
      </div>
    </footer>
  </Modal>
</template>

<style scoped>
.history-list {
  display: grid;
  gap: 6px;
  max-height: 45dvh;
  overflow: auto;
  padding: 4px;
  margin: 16px 0 0;
}
.history-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
}
.history-link {
  display: flex;
  justify-content: flex-start;
  gap: 8px;
}
.history-title {
  flex: 1;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
}
.history-link time {
  font-size: 12px;
}
.history-footer,
.history-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.history-footer {
  justify-content: space-between;
  margin-top: 12px;
}
.history-confirm {
  display: grid;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
  margin-top: 8px;
}
</style>
