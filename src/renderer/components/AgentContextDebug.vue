<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import type { AgentContextTurn } from "../../desktop/agent-context";
import Modal from "./Modal.vue";

const props = defineProps<{ sessionId: string }>();
const open = ref(false);
const loading = ref(false);
const error = ref(false);
const turns = shallowRef<AgentContextTurn[]>([]);
const turnIndex = ref(0);
const requestIndex = ref(0);
const turn = computed(() => turns.value[turnIndex.value]);
const request = computed(() => turn.value?.requests[requestIndex.value]);
const contextText = computed(() =>
  request.value ? JSON.stringify(JSON.parse(request.value), null, 2) : "",
);

function selectLastRequest() {
  requestIndex.value = (turn.value?.requests.length ?? 1) - 1;
}

async function inspect() {
  open.value = true;
  loading.value = true;
  error.value = false;
  try {
    turns.value = await window.desktop.agentContext(props.sessionId);
    turnIndex.value = 0;
    selectLastRequest();
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <button type="button" class="context-link" @click="inspect">
    调试上下文
  </button>
  <Modal
    v-model:open="open"
    title="Agent 请求上下文"
    description="本次启动期间发给模型服务的请求体。默认显示当前会话最近一轮的最后一次请求。"
  >
    <p v-if="loading" role="status">正在读取请求…</p>
    <p v-else-if="error" role="alert">暂时无法读取请求，请重新打开。</p>
    <div v-else-if="turn">
      <div class="context-debug-selectors">
        <label>
          对话轮次
          <select
            v-model="turnIndex"
            aria-label="对话轮次"
            @change="selectLastRequest"
          >
            <option
              v-for="(item, index) in turns"
              :key="item.runId"
              :value="index"
            >
              {{ index === 0 ? "最近一轮" : `往前 ${index} 轮` }} ·
              {{ new Date(item.sentAt).toLocaleString() }}
            </option>
          </select>
        </label>
        <label>
          模型请求
          <select v-model="requestIndex" aria-label="模型请求">
            <option
              v-for="(_, index) in turn.requests"
              :key="index"
              :value="index"
            >
              第 {{ index + 1 }} 次请求
            </option>
          </select>
        </label>
      </div>
      <pre class="context-debug-body" tabindex="0" aria-label="模型请求体">{{
        contextText
      }}</pre>
    </div>
    <p v-else role="status">当前会话暂无已捕获的模型请求。</p>
  </Modal>
</template>

<style scoped>
.context-debug-selectors {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-block: 14px;
}
.context-debug-body {
  max-height: 56dvh;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  white-space: pre-wrap;
  overflow: auto;
  overflow-wrap: anywhere;
}
</style>
