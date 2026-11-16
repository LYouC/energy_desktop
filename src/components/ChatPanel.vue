<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { Sparkles, Plus, History, Send, Square } from "lucide-vue-next";
import Button from "./ui/button/Button.vue";
import Modal from "./Modal.vue";
import { useWorkspace } from "@/stores/workspace";
import { simulateReply } from "@/features/mock";
import { buildContext } from "../../shared/context";
import type { Change, Proposal } from "../../shared/model";
const props = defineProps<{ focusedId: string | null }>();
const store = useWorkspace();
const draft = ref(""),
  running = ref(false),
  history = ref(false),
  contextOpen = ref(false),
  contextText = ref("");
const scroll = ref<HTMLElement>();
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
  const id = sessionId.value;
  store.dispatch({ type: "draft", sessionId: id, text: value }).catch(() => {});
});
watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    scroll.value?.scrollTo({
      top: scroll.value.scrollHeight,
      behavior: "smooth",
    });
  },
);
function cancel() {
  generation++;
  clearTimeout(runTimer);
  running.value = false;
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
  const text = draft.value.trim(),
    id = sessionId.value;
  running.value = true;
  const token = ++generation;
  try {
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
      } finally {
        if (token === generation) running.value = false;
      }
    }, 500);
  } catch {
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
  cancel();
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
onBeforeUnmount(cancel);
</script>
<template>
  <aside class="chat" aria-label="规划对话">
    <header class="chat-header">
      <span><Sparkles :size="18" />一起，把事情理清楚</span>
      <div class="row">
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
      <p class="simulation-note">模拟对话 · 用于试操作方案流程</p>
      <div v-if="!messages.length" class="chat-welcome">
        <Sparkles :size="24" />
        <h2>从一件想做的事开始</h2>
        <p>先记下任务，再试着规划今天。选中任务后，可以模拟拆分或启动协助。</p>
        <p>这里使用模板回复，真实 Agent 在后续接入。</p>
      </div>
      <div
        v-for="item in messages"
        :key="item.id"
        :class="['message', item.role]"
      >
        <small>{{ item.role === "user" ? "你" : "息序 · 模拟回复" }}</small>
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
              <p>
                {{
                  change.type === "schedule"
                    ? `${change.date} · ${change.scope}`
                    : change.children.map((c) => c.title).join(" → ")
                }}
              </p>
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
      <p v-if="running" class="muted">正在准备模拟方案…</p>
    </div>
    <div class="chat-bottom">
      <div class="presets">
        <button @click="draft = '帮我开始当前任务'">帮我开始</button
        ><button @click="draft = '我有点卡住了'">有点卡住</button
        ><button @click="draft = '请拆分当前任务'">拆分任务</button
        ><button
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
        <span>模拟模式</span><span>Ctrl + Enter 发送</span>
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
  </aside>
</template>
