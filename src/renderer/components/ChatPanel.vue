<script setup lang="ts">
import {
  ref,
  shallowRef,
  computed,
  watch,
  nextTick,
  onBeforeUnmount,
  onMounted,
} from "vue";
import {
  Sparkles,
  Plus,
  History,
  Send,
  Square,
  Settings,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-vue-next";
import Button from "./ui/button/Button.vue";
import Modal from "./Modal.vue";
import ModelSettings from "./ModelSettings.vue";
import ChatHistory from "./ChatHistory.vue";
import { useWorkspace } from "@/stores/workspace";
import { buildContext } from "../../agent/context";
import { statusLabels, type Change, type Proposal } from "../../domain/model";
const props = defineProps<{ focusedId: string | null; collapsed: boolean }>();
const emit = defineEmits<{
  "update:collapsed": [value: boolean];
  resize: [width: number | null];
}>();
const store = useWorkspace();
const draft = ref(""),
  running = ref(false),
  history = ref(false),
  contextOpen = ref(false),
  contextText = ref("");
const scroll = ref<HTMLElement>();
const chatEl = ref<HTMLElement>();
const chatMinWidth = 300;
const chatMaxWidth = 560;
let stopResize: (() => void) | null = null;
const settingsOpen = ref(false);
const configured = ref(false);
const runError = ref("");
const resolveError = ref("");
type AgentRequest = Parameters<Window["desktop"]["sendAgent"]>[0];
const retryRequest = shallowRef<AgentRequest>();
const retryStatus = ref("");
const streamText = ref("");
const submittedText = ref("");
const runStatus = ref("");
let activeRunId: string | null = null;
let runPromise: Promise<unknown> | null = null;
let unsubscribe: (() => void) | undefined;
let generation = 0;
const sessionId = computed(() => store.state.activeSessionId);
const messages = computed(() =>
  store.state.messages.filter(
    (message) => message.sessionId === sessionId.value,
  ),
);
const proposals = computed(() =>
  store.state.proposals.filter(
    (proposal) => proposal.sessionId === sessionId.value,
  ),
);
watch(
  sessionId,
  () => {
    cancel();
    runError.value = "";
    resolveError.value = "";
    retryRequest.value = undefined;
    draft.value =
      store.state.sessions.find((item) => item.id === sessionId.value)?.draft ||
      "";
  },
  { immediate: true },
);
watch(draft, (value) => {
  if (running.value) return;
  const id = sessionId.value;
  store.dispatch({ type: "draft", sessionId: id, text: value }).catch(() => {});
});
watch([() => messages.value.length, streamText, submittedText], async () => {
  await nextTick();
  scroll.value?.scrollTo({
    top: scroll.value.scrollHeight,
    behavior: "smooth",
  });
});
function clampChatWidth(width: number) {
  return Math.round(Math.min(chatMaxWidth, Math.max(chatMinWidth, width)));
}
function startResize(event: MouseEvent) {
  if (event.button !== 0 || props.collapsed) return;
  event.preventDefault();
  document.body.classList.add("chat-resizing");
  const move = (e: MouseEvent) => {
    e.preventDefault();
    emit("resize", clampChatWidth(window.innerWidth - e.clientX));
  };
  const stop = () => {
    document.body.classList.remove("chat-resizing");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", stop);
    stopResize = null;
  };
  stopResize = stop;
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
}
function keyResize(event: KeyboardEvent) {
  if (props.collapsed) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const current = chatEl.value?.offsetWidth || chatMinWidth;
  emit(
    "resize",
    clampChatWidth(current + (event.key === "ArrowLeft" ? 16 : -16)),
  );
}
function resetWidth() {
  emit("resize", null);
}
async function cancel() {
  generation++;
  const id = activeRunId;
  activeRunId = null;
  if (id) {
    try {
      await window.desktop.cancelAgent(id);
      // 等本轮结束再刷新，避免取消与切会话覆盖刚写入的用户消息。
      await runPromise?.catch(() => {});
      await store.load();
    } catch {
      runError.value = "取消后未能刷新，请重新打开会话检查已保存结果。";
    }
  }
  running.value = false;
  streamText.value = "";
  submittedText.value = "";
  runStatus.value = "";
  retryStatus.value = "";
}
async function sendReal(request: AgentRequest, isRetry = false) {
  if (running.value || request.sessionId !== sessionId.value) return;
  running.value = true;
  const token = ++generation;
  runError.value = "";
  retryRequest.value = undefined;
  if (!isRetry) {
    try {
      await store.dispatch({
        type: "draft",
        sessionId: request.sessionId,
        text: request.text,
      });
    } catch {
      if (token === generation) {
        runError.value = "消息保存失败，请重试。";
        running.value = false;
      }
      return;
    }
    if (token !== generation) return;
    draft.value = "";
  }
  activeRunId = request.runId;
  if (!messages.value.some((message) => message.id === `${request.runId}:user`))
    submittedText.value = request.text;
  runStatus.value = "正在读取上下文…";
  let failed = false;
  try {
    runPromise = window.desktop.sendAgent(request);
    await runPromise;
  } catch {
    failed = true;
  } finally {
    if (token === generation) {
      await store.load();
      if (token !== generation) return;
      if (
        failed &&
        !messages.value.some(
          (message) => message.id === `${request.runId}:assistant`,
        )
      ) {
        runError.value = "本轮未完成。你可以重试，或检查网络和模型设置。";
        retryRequest.value = request;
      }
      activeRunId = null;
      runPromise = null;
      running.value = false;
      submittedText.value = "";
      streamText.value = "";
      runStatus.value = "";
      retryStatus.value = "";
    }
  }
}
async function send() {
  if (!draft.value.trim() || running.value) return;
  if (!configured.value) {
    settingsOpen.value = true;
    return;
  }
  await sendReal({
    runId: crypto.randomUUID(),
    sessionId: sessionId.value,
    text: draft.value.trim(),
    focusedId: props.focusedId,
  });
}
async function resolve(proposal: Proposal, changes: Change[], accept: boolean) {
  resolveError.value = "";
  try {
    await store.dispatch({
      type: "resolve",
      proposalId: proposal.id,
      ids: changes.map((change) => change.id),
      accept,
    });
  } catch {
    resolveError.value = "方案变更未能保存，请重试。";
  }
}
async function switchSession(id: string) {
  await cancel();
  try {
    await store.dispatch({
      type: "draft",
      sessionId: sessionId.value,
      text: draft.value,
    });
    await store.dispatch({ type: "session", id });
    history.value = false;
  } catch {}
}
function inspectContext() {
  contextText.value = JSON.stringify(
    buildContext(store.state, sessionId.value),
    null,
    2,
  );
  contextOpen.value = true;
}
function newSession() {
  switchSession(crypto.randomUUID());
}
function proposalStatus(proposal: Proposal) {
  const accepted = proposal.changes.filter(
    (change) => change.status === "accepted",
  ).length;
  if (accepted === proposal.changes.length) return "已全部接受";
  if (accepted) return "部分接受";
  return proposal.changes.some((change) => change.status === "pending")
    ? "待接受"
    : "已拒绝";
}
function changeSummary(change: Change) {
  if (change.type === "schedule")
    return `${change.fromDate ? `${change.fromDate} → ` : ""}${change.date} · ${change.scope}`;
  if (change.type === "split")
    return change.children.map((child) => child.title).join(" → ");
  if (change.type === "unschedule") return `取消 ${change.date} 的安排`;
  if (change.type === "stage")
    return `${change.date} · ${change.done ? "完成今日阶段" : "恢复今日阶段"}`;
  const fields: Record<string, string> = {
    title: "名称",
    status: "状态",
    startDate: "预计开始",
    expectedDate: "预计完成",
    description: "说明",
    parentId: "所属任务",
  };
  return Object.entries(change.patch ?? {})
    .filter(([key]) => fields[key])
    .map(
      ([key, value]) =>
        `${fields[key]}：${key === "status" ? statusLabels[value as keyof typeof statusLabels] : String(value || "清空")}`,
    )
    .join("；");
}
async function refreshConfig() {
  try {
    configured.value = (await window.desktop.agentConfig()).hasKey;
  } catch {
    configured.value = false;
  }
}
onMounted(() => {
  refreshConfig();
  unsubscribe = window.desktop.onAgentEvent((event) => {
    if (event.runId !== activeRunId) return;
    // 流式文字仅供预览。完整回复及正式变更由本地执行层提交后重新读取。
    if (event.type === "text") streamText.value += event.text;
    else if (event.type === "retry") {
      streamText.value = "";
      retryStatus.value = event.text;
    } else runStatus.value = event.text;
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  stopResize?.();
  void cancel();
});
</script>
<template>
  <aside
    ref="chatEl"
    class="chat"
    :class="{ collapsed: collapsed }"
    aria-label="规划对话"
  >
    <template v-if="collapsed">
      <button
        class="chat-expand"
        aria-label="展开对话"
        @click="emit('update:collapsed', false)"
      >
        <PanelRightClose :size="17" />
      </button>
      <span class="chat-rail-label"><Sparkles :size="15" />对话</span>
    </template>
    <template v-else>
      <div
        class="chat-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整对话区宽度"
        title="拖动调整宽度，双击恢复默认"
        tabindex="0"
        @mousedown="startResize"
        @dblclick="resetWidth"
        @keydown="keyResize"
      ></div>
      <header class="chat-header">
        <span><Sparkles :size="18" />一起，把事情理清楚</span>
        <div class="row">
          <button
            class="icon-button"
            aria-label="模型设置"
            :disabled="running"
            @click="settingsOpen = true"
          >
            <Settings :size="17" />
          </button>
          <button
            class="icon-button"
            aria-label="对话历史"
            @click="history = true"
          >
            <History :size="17" /></button
          ><button
            class="icon-button"
            aria-label="新建对话"
            @click="newSession"
          >
            <Plus :size="18" />
          </button>
          <button
            class="icon-button"
            aria-label="收起对话"
            @click="emit('update:collapsed', true)"
          >
            <PanelRightOpen :size="17" />
          </button>
        </div>
      </header>
      <div ref="scroll" class="chat-scroll" aria-live="polite">
        <div v-if="!messages.length" class="chat-welcome">
          <div class="chat-welcome-title">
            <Sparkles :size="22" />
            <h2>从一件想做的事开始</h2>
          </div>
          <p>说说目标、已有进展或卡住的地方，我们一起找出现在能做的第一步。</p>
          <Button
            v-if="!configured"
            variant="outline"
            @click="settingsOpen = true"
            >配置模型后开始</Button
          >
        </div>
        <div
          v-for="item in messages"
          :key="item.id"
          :class="['message', item.role]"
        >
          <p>{{ item.text }}</p>
          <template
            v-for="proposal in proposals.filter(
              (p) => p.id === item.proposalId,
            )"
            :key="proposal.id"
          >
            <section class="proposal">
              <h3>规划方案 · {{ proposalStatus(proposal) }}</h3>
              <div
                v-for="change in proposal.changes"
                :key="change.id"
                class="proposal-change"
              >
                <strong>{{ change.label }}</strong>
                <p>{{ changeSummary(change) }}</p>
                <p class="muted">{{ change.reason }}</p>
                <span class="change-status">{{
                  {
                    pending: "待接受",
                    accepted: "已接受 · 已生效",
                    rejected: "已拒绝",
                  }[change.status]
                }}</span>
                <div v-if="change.status === 'pending'" class="row">
                  <Button
                    variant="outline"
                    @click="resolve(proposal, [change], true)"
                    >接受这项</Button
                  ><Button
                    variant="ghost"
                    @click="resolve(proposal, [change], false)"
                    >拒绝</Button
                  >
                </div>
              </div>
              <Button
                v-if="proposal.changes.some((c) => c.status === 'pending')"
                variant="outline"
                @click="
                  resolve(
                    proposal,
                    proposal.changes.filter((c) => c.status === 'pending'),
                    true,
                  )
                "
                >接受其余变更</Button
              >
            </section>
          </template>
        </div>
        <div v-if="submittedText" class="message user">
          <p>{{ submittedText }}</p>
        </div>
        <div v-if="streamText" class="message assistant">
          <p>{{ streamText }}</p>
        </div>
        <p v-if="running" class="muted" role="status">
          {{ retryStatus || runStatus || "正在分析…" }}
        </p>
        <div v-if="runError" class="chat-error">
          <p class="error" role="alert">{{ runError }}</p>
          <Button
            v-if="retryRequest"
            variant="outline"
            :disabled="running"
            @click="sendReal(retryRequest, true)"
          >
            重试本轮
          </Button>
        </div>
        <div v-if="resolveError" class="chat-error">
          <p class="error" role="alert">{{ resolveError }}</p>
        </div>
      </div>
      <div class="chat-bottom">
        <div class="presets">
          <button :disabled="running" @click="draft = '帮我开始当前任务'">
            帮我开始</button
          ><button :disabled="running" @click="draft = '我有点卡住了'">
            有点卡住</button
          ><button :disabled="running" @click="draft = '请拆分当前任务'">
            拆分任务</button
          ><button
            :disabled="running"
            @click="
              draft = `我现在${store.state.energy.value || '尚未说明能量'}，请结合任务重新分析今天的安排`
            "
          >
            重新分析
          </button>
        </div>
        <form class="composer" @submit.prevent="send">
          <textarea
            v-model="draft"
            :disabled="running"
            aria-label="和息序聊聊"
            placeholder="说说想做的事，或此刻的感受…"
            rows="3"
            @keydown.ctrl.enter.prevent="send"
          />
          <div class="composer-bottom">
            <button type="button" class="context-link" @click="inspectContext">
              查看当前上下文</button
            ><button
              v-if="running"
              class="send"
              type="button"
              aria-label="取消生成"
              @click="cancel"
            >
              <Square :size="16" /></button
            ><button
              v-else
              class="send"
              type="submit"
              aria-label="发送"
              :disabled="!draft.trim()"
            >
              <Send :size="16" />
            </button>
          </div>
        </form>
        <div class="chat-footer">
          <span>Ctrl + Enter 发送</span>
        </div>
      </div>
      <ChatHistory
        v-model:open="history"
        :running="running"
        @select="switchSession"
      />
      <Modal
        v-model:open="contextOpen"
        title="当前上下文预览"
        description="按当前数据组装。发送消息时会重新读取最新状态。"
      >
        <pre class="context-preview">{{ contextText }}</pre>
      </Modal>
      <ModelSettings v-model:open="settingsOpen" @configured="refreshConfig" />
    </template>
  </aside>
</template>
<style scoped>
.chat-error {
  display: grid;
  justify-items: start;
  gap: 8px;
}
.chat-footer {
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
