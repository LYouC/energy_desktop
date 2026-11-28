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
import AgentContextDebug from "./AgentContextDebug.vue";
import { useWorkspace } from "@/stores/workspace";
import { recurrenceLabel } from "@/lib/recurrence";
import { buildContext } from "../../agent/context";
import {
  isArrangementPending,
  unscheduledTasksDue,
} from "../../domain/operations";
import {
  localDate,
  statusLabels,
  type AdjustmentCard,
  type Change,
  type Proposal,
} from "../../domain/model";
const props = defineProps<{
  focusedId: string | null;
  collapsed: boolean;
}>();
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
const contextDebug = ref(false);
const emptyOptimization = ref(false);
const checkingToday = ref(false);
const hasPendingToday = computed(() => {
  const today = localDate();
  const tasks = new Map(store.state.tasks.map((task) => [task.id, task]));
  return (
    unscheduledTasksDue(store.state, today).length > 0 ||
    store.state.arrangements.some(
      (item) =>
        item.date === today &&
        tasks.has(item.taskId) &&
        isArrangementPending(item, tasks.get(item.taskId)),
    )
  );
});
const runError = ref("");
const respondingCards = ref(new Set<string>());
const responseErrors = ref(new Map<string, string>());
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
    retryRequest.value = undefined;
    emptyOptimization.value = false;
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
  const preserveDraft = request.source === "optimizeToday";
  if (!isRetry) {
    try {
      await store.dispatch({
        type: "draft",
        sessionId: request.sessionId,
        text: preserveDraft ? draft.value : request.text,
      });
    } catch {
      if (token === generation) {
        runError.value = "消息保存失败，请重试。";
        running.value = false;
      }
      return;
    }
    if (token !== generation) return;
    if (!preserveDraft) draft.value = "";
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
async function send(
  text = draft.value.trim(),
  source?: AgentRequest["source"],
) {
  if (!text || running.value) return;
  if (!configured.value) {
    settingsOpen.value = true;
    return;
  }
  await sendReal({
    runId: crypto.randomUUID(),
    sessionId: sessionId.value,
    text,
    focusedId: source === "optimizeToday" ? null : props.focusedId,
    source,
  });
}
async function optimizeToday() {
  if (running.value || checkingToday.value) return;
  const session = sessionId.value;
  checkingToday.value = true;
  try {
    if (!(await store.load()) || session !== sessionId.value) return;
    emptyOptimization.value = !hasPendingToday.value;
  } finally {
    checkingToday.value = false;
  }
  if (emptyOptimization.value) return;
  await send(
    "请一起看看今天已安排但尚未完成的事项，以及预计今天完成但尚未安排的任务。结合重要性、当前能量和已知时间约束，看看怎样安排更合适。如果有调整，请只提出待我接受的方案，我接受后再修改任务或安排。",
    "optimizeToday",
  );
}
async function resolve(
  proposal: Proposal,
  card: AdjustmentCard,
  accept: boolean,
) {
  if (respondingCards.value.has(card.id)) return;
  respondingCards.value.add(card.id);
  try {
    await store.dispatch({
      type: "respondToCard",
      proposalId: proposal.id,
      cardId: card.id,
      accept,
    });
  } catch {
    responseErrors.value.set(card.id, "暂时无法保存卡片结果。");
  } finally {
    respondingCards.value.delete(card.id);
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
function cardSummaries(card: AdjustmentCard) {
  const patch: NonNullable<Change["patch"]> = Object.assign(
    {},
    ...card.changes
      .filter((change) => change.type === "update")
      .map((change) => change.patch),
  );
  const removals = card.changes.filter(
    (change) => change.type === "unschedule",
  );
  const schedules = card.changes.filter((change) => change.type === "schedule");
  const [removal] = removals;
  const [schedule] = schedules;
  const move =
    removals.length === 1 &&
    schedules.length === 1 &&
    !schedule.fromDate &&
    removal.date !== schedule.date;
  const summaries = card.changes
    .filter(
      (change) => change.type !== "update" && !(move && change === removal),
    )
    .map((change) =>
      changeSummary(
        move && change === schedule
          ? {
              ...change,
              fromDate: removal.date,
              originalScope: removal.originalScope,
            }
          : change,
      ),
    );
  return [...summaries, ...fieldSummaries(patch, card.previousExpectedDate)];
}
function changeSummary(change: Change) {
  switch (change.type) {
    case "updateRecurrence":
      return change.recurrence
        ? `重复规则 · ${recurrenceLabel(change.recurrence)}`
        : "";
    case "deleteRecurringTask": {
      const children = change.descendantIds?.length ?? 0;
      const scope = children ? `同时删除 ${children} 项子任务。 ` : "";
      return `${scope}删除所有轮次及完成记录。`;
    }
    case "stopRecurrence":
      return "移除今天未完成的一轮，保留完成记录。";
    case "resumeRecurrence":
      return "按现有规则继续，停止期间不补排。";
    case "setOccurrenceDone":
      return `${change.date} · ${change.done ? "完成这次" : "恢复为未完成"}${completionDetails(change)}`;
    case "skipOccurrence":
      return `${change.date} · 移出当天安排`;
    case "restoreOccurrence":
      return `${change.date} · 恢复当天安排`;
  }
  if (change.type === "schedule") {
    const originalScope =
      change.originalScope && change.originalScope !== change.scope
        ? ` · ${change.originalScope}`
        : "";
    const target = `${change.date} · ${change.scope}`;
    if (change.fromTaskId && change.fromTaskId !== change.taskId) {
      const source =
        change.fromTaskTitle ??
        store.state.tasks.find((task) => task.id === change.fromTaskId)
          ?.title ??
        "原任务";
      const destination = change.targetTaskTitle
        ? `「${change.targetTaskTitle}」`
        : "";
      return `改派：「${source}」${change.fromDate ?? change.date}${originalScope} → ${destination}${target}`;
    }
    if (change.fromDate && change.fromDate !== change.date)
      return `${change.fromDate}${originalScope} → ${target}`;
    return target;
  }
  if (change.type === "split")
    return `拆分为 ${change.children.map((child) => (child.todayScope ? `${child.title}（安排到 ${change.date} · ${child.todayScope}）` : child.title)).join("、")}`;
  if (change.type === "unschedule") return `取消 ${change.date} 的安排`;
  return "";
}
function fieldSummaries(
  patch: NonNullable<Change["patch"]>,
  previousExpectedDate?: string,
) {
  const fields: Record<string, string> = {
    title: "名称",
    status: "状态",
    startDate: "预计开始",
    expectedDate: "预计完成",
    description: "说明",
    parentId: "所属任务",
  };
  return Object.entries(patch)
    .filter(([key]) => fields[key])
    .map(([key, value]) => {
      if (key === "expectedDate" && previousExpectedDate !== undefined)
        return `预计完成：${previousExpectedDate || "未设置"} → ${value || "未设置"}`;
      const display =
        key === "status"
          ? statusLabels[value as keyof typeof statusLabels]
          : key === "parentId" && value
            ? (store.state.tasks.find((task) => task.id === value)?.title ??
              value)
            : value || "清空";
      return `${fields[key]}：${display}`;
    });
}
function completionDetails(change: Change) {
  const count = change.descendantIds?.length ?? 0;
  return change.done && count ? `，同时完成 ${count} 项已安排的子任务` : "";
}
async function refreshConfig() {
  try {
    const config = await window.desktop.agentConfig();
    configured.value = config.hasKey;
    contextDebug.value = config.contextDebug;
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
              <section
                v-for="card in proposal.cards"
                :key="card.id"
                class="proposal-change"
              >
                <h3>{{ card.title }}</h3>
                <p v-for="(summary, index) in cardSummaries(card)" :key="index">
                  {{ summary }}
                </p>
                <p class="muted">{{ card.reason }}</p>
                <span v-if="card.status === 'accepted'" class="change-status"
                  >已接受</span
                >
                <span
                  v-else-if="card.status === 'rejected'"
                  class="change-status"
                  >已拒绝</span
                >
                <p
                  v-else-if="
                    card.status === 'failed' || responseErrors.has(card.id)
                  "
                  class="error"
                  role="alert"
                >
                  执行失败：{{
                    card.failureReason ||
                    responseErrors.get(card.id) ||
                    "无法应用卡片。"
                  }}
                </p>
                <div v-else class="row">
                  <Button
                    variant="outline"
                    :disabled="respondingCards.has(card.id)"
                    @click="resolve(proposal, card, true)"
                    >接受</Button
                  ><Button
                    variant="ghost"
                    :disabled="respondingCards.has(card.id)"
                    @click="resolve(proposal, card, false)"
                    >拒绝</Button
                  >
                </div>
              </section>
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
          <button :disabled="running || checkingToday" @click="optimizeToday">
            一键优化
          </button>
        </div>
        <p
          v-if="emptyOptimization && !hasPendingToday"
          class="optimization-note muted"
          role="status"
        >
          今天没有待优化的安排或预计完成任务。
        </p>
        <form class="composer" @submit.prevent="send()">
          <textarea
            v-model="draft"
            :disabled="running"
            aria-label="和息序聊聊"
            placeholder="说说想做的事，或此刻的感受…"
            rows="3"
            @keydown.ctrl.enter.prevent="send()"
          />
          <div class="composer-bottom">
            <button type="button" class="context-link" @click="inspectContext">
              查看当前上下文
            </button>
            <AgentContextDebug
              v-if="contextDebug"
              :key="sessionId"
              :session-id="sessionId"
            />
            <button
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
.optimization-note {
  margin-bottom: 10px;
}
.chat-footer {
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
