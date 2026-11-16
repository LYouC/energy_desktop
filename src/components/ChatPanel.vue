<script setup lang="ts">
import {
  ref,
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
} from "lucide-vue-next";
import Button from "./ui/button/Button.vue";
import Modal from "./Modal.vue";
import ModelSettings from "./ModelSettings.vue";
import { useWorkspace } from "@/stores/workspace";
import { simulateReply } from "@/features/mock";
import { buildContext } from "../../shared/context";
import { statusLabels, type Change, type Proposal } from "../../shared/model";
const props = defineProps<{ focusedId: string | null }>();
const store = useWorkspace();
const draft = ref(""),
  running = ref(false),
  history = ref(false),
  contextOpen = ref(false),
  contextText = ref("");
const scroll = ref<HTMLElement>();
const mode = ref<"real" | "mock">("real");
const settingsOpen = ref(false);
const configured = ref(false);
const runError = ref("");
const streamText = ref("");
const submittedText = ref("");
const runStatus = ref("");
let activeRunId: string | null = null;
let runPromise: Promise<unknown> | null = null;
let unsubscribe: (() => void) | undefined;
let runTimer: ReturnType<typeof setTimeout>;
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
    draft.value =
      store.state.sessions.find((item) => item.id === sessionId.value)?.draft ||
      "";
  },
  { immediate: true },
);
watch(draft, (value) => {
  if (running.value && mode.value === "real") return;
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
async function cancel() {
  generation++;
  clearTimeout(runTimer);
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
}
async function message(
  role: "user" | "assistant",
  text: string,
  id: string,
  proposalId?: string,
) {
  await store.dispatch({
    type: "message",
    message: {
      id: crypto.randomUUID(),
      role,
      text,
      sessionId: id,
      createdAt: new Date().toISOString(),
      proposalId,
    },
  });
}
async function send() {
  if (!draft.value.trim() || running.value) return;
  if (mode.value === "real" && !configured.value) {
    settingsOpen.value = true;
    return;
  }
  const text = draft.value.trim(),
    id = sessionId.value;
  running.value = true;
  const token = ++generation;
  runError.value = "";
  streamText.value = "";
  try {
    if (mode.value === "real") {
      // 先排空草稿保存队列。真实消息由后端统一保存，防止前后端重复追加。
      await store.dispatch({ type: "draft", sessionId: id, text });
      if (token !== generation) return;
      const runId = crypto.randomUUID();
      activeRunId = runId;
      submittedText.value = text;
      draft.value = "";
      runStatus.value = "正在读取上下文…";
      runPromise = window.desktop.sendAgent({
        runId,
        sessionId: id,
        text,
        focusedId: props.focusedId,
      });
      try {
        await runPromise;
      } catch {
        if (token === generation)
          runError.value =
            "本次调用未完成，请检查模型设置或网络。已保存的操作可在任务中查看。";
      } finally {
        await store.load();
        if (token === generation) {
          activeRunId = null;
          running.value = false;
          submittedText.value = "";
          streamText.value = "";
          runStatus.value = "";
        }
      }
      return;
    }
    await message("user", text, id);
    if (token !== generation) return;
    draft.value = "";
    runTimer = setTimeout(async () => {
      if (token !== generation) return;
      try {
        const result = simulateReply(store.state, id, text, props.focusedId);
        await store.dispatch({
          type: "reply",
          proposal: result.proposal,
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            text: result.text,
            sessionId: id,
            createdAt: new Date().toISOString(),
            proposalId: result.proposal?.id,
          },
        });
      } catch {
        runError.value = "模拟回复保存失败，请重试。";
      } finally {
        if (token === generation) running.value = false;
      }
    }, 500);
  } catch {
    runError.value = "消息保存失败，请重试。";
    running.value = false;
  }
}
async function resolve(proposal: Proposal, changes: Change[], accept: boolean) {
  try {
    await store.dispatch({
      type: "resolve",
      proposalId: proposal.id,
      ids: changes.map((change) => change.id),
      accept,
    });
  } catch {}
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
    goal: "目标",
    deadline: "真实截止",
    plannedDate: "推进日期",
    expectedDate: "预期完成",
    importance: "重要性",
    status: "状态",
    background: "背景",
    backgroundKind: "背景来源",
    progress: "进展",
    obstacle: "阻力",
    nextStep: "下一步",
    parentId: "父任务",
    dependencies: "依赖",
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
    else runStatus.value = event.text;
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  void cancel();
});
</script>
<template>
  <aside class="chat" aria-label="规划对话">
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
        ><button class="icon-button" aria-label="新建对话" @click="newSession">
          <Plus :size="18" />
        </button>
      </div>
    </header>
    <div ref="scroll" class="chat-scroll" aria-live="polite">
      <p class="simulation-note">
        {{
          mode === "mock"
            ? "模拟对话 · 用于试操作方案流程"
            : "Agent 对话 · 结合当前任务协助推进"
        }}
      </p>
      <div v-if="!messages.length" class="chat-welcome">
        <Sparkles :size="24" />
        <h2>从一件想做的事开始</h2>
        <p>说说目标、已有进展或卡住的地方，我们一起找出现在能做的第一步。</p>
        <Button
          v-if="mode === 'real' && !configured"
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
        <small>{{ item.role === "user" ? "你" : "息序" }}</small>
        <p>{{ item.text }}</p>
        <template
          v-for="proposal in proposals.filter((p) => p.id === item.proposalId)"
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
        <small>你</small>
        <p>{{ submittedText }}</p>
      </div>
      <div v-if="streamText" class="message assistant">
        <small>息序 · 正在生成</small>
        <p>{{ streamText }}</p>
      </div>
      <p v-if="running" class="muted">
        {{ mode === "mock" ? "正在准备模拟方案…" : runStatus || "正在分析…" }}
      </p>
      <p v-if="runError" class="error" role="alert">{{ runError }}</p>
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
        <select v-model="mode" aria-label="对话模式" :disabled="running">
          <option value="real">真实 Agent</option>
          <option value="mock">本地模拟</option></select
        ><span>Ctrl + Enter 发送</span>
      </div>
    </div>
    <Modal
      v-model:open="history"
      title="对话历史"
      description="新对话共享最新任务、能量和明确偏好。"
      ><div class="history-list">
        <Button
          v-for="session in store.state.sessions"
          :key="session.id"
          variant="outline"
          @click="switchSession(session.id)"
          >{{ session.title }}</Button
        >
      </div></Modal
    >
    <Modal
      v-model:open="contextOpen"
      title="当前上下文预览"
      description="按当前数据组装。发送消息时会重新读取最新状态。"
    >
      <pre class="context-preview">{{ contextText }}</pre>
    </Modal>
    <ModelSettings v-model:open="settingsOpen" @configured="refreshConfig" />
  </aside>
</template>
<style scoped>
.chat-footer {
  align-items: center;
  gap: 8px;
}
.chat-footer select {
  font-size: 11px;
  padding: 4px 6px;
}
</style>
