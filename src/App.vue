<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import {
  Sun,
  ListTodo,
  CircleCheck,
  Plus,
  Leaf,
  Settings,
  Coffee,
  Search,
  Check,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-vue-next";
import { useWorkspace } from "./stores/workspace";
import Button from "./components/ui/button/Button.vue";
import Modal from "./components/Modal.vue";
import ManageBar from "./components/ManageBar.vue";
import TaskEditor from "./components/TaskEditor.vue";
import TaskCard from "./components/TaskCard.vue";
import ChatPanel from "./components/ChatPanel.vue";
import { useTaskSelection } from "./composables/taskSelection";
import {
  localDate,
  newTask,
  energyLabels,
  statusLabels,
  type Task,
} from "../shared/model";
const store = useWorkspace();
const view = ref<"today" | "all" | "completed">("today");
const labels = { today: "今日安排", all: "所有任务", completed: "已完成" };
const editor = ref<Task | null>(null);
const settingsOpen = ref(false);
const preferences = ref("");
const theme = ref<"light" | "dark" | "system">("system");
const focusId = ref<string | null>(null);
const contextTaskId = ref<string | null>(null);
const sidebarCollapsed = ref(
  localStorage.getItem("xixu-sidebar-collapsed") === "1",
);
const chatCollapsed = ref(localStorage.getItem("xixu-chat-collapsed") === "1");
const chatWidth = ref<number | null>(
  Number(localStorage.getItem("xixu-chat-width")) || null,
);
watch(sidebarCollapsed, (value) =>
  localStorage.setItem("xixu-sidebar-collapsed", value ? "1" : "0"),
);
watch(chatCollapsed, (value) =>
  localStorage.setItem("xixu-chat-collapsed", value ? "1" : "0"),
);
watch(chatWidth, (value) => {
  if (value) localStorage.setItem("xixu-chat-width", String(value));
  else localStorage.removeItem("xixu-chat-width");
});
const shellStyle = computed(() => {
  const style: Record<string, string> = {};
  if (sidebarCollapsed.value) style["--sidebar-w"] = "var(--sidebar-collapsed)";
  if (chatWidth.value) style["--chat-w"] = `${chatWidth.value}px`;
  if (chatCollapsed.value) style["--chat-col"] = "48px";
  return style;
});
const search = ref("");
const {
  managing: selecting,
  count: selectedCount,
  start: startSelection,
  stop: stopSelection,
  toggle: toggleSelection,
  isSelected,
  selectAll: selectAllTasks,
  retain: retainSelection,
  clear: clearSelection,
  deletionOrder,
} = useTaskSelection();
const deleteOpen = ref(false);
const deleting = ref(false);
const deleteError = ref("");
const deleteTargets = ref<Task[]>([]);
const date = ref(localDate());
const dateTimer = setInterval(() => {
  date.value = localDate();
}, 30000);
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  document.documentElement.classList.toggle(
    "dark",
    store.state.theme === "dark" ||
      (store.state.theme === "system" && systemTheme.matches),
  );
}
systemTheme.addEventListener("change", applyTheme);
watch(
  () => store.state.theme,
  (value) => {
    localStorage.setItem("xixu-theme", value);
    applyTheme();
  },
);
onBeforeUnmount(() => {
  clearInterval(dateTimer);
  systemTheme.removeEventListener("change", applyTheme);
});
onMounted(async () => {
  await store.load();
  applyTheme();
});
const visibleTasks = computed(() =>
  store.state.tasks.filter(
    (task) =>
      (view.value === "completed"
        ? task.status === "done"
        : task.status !== "done") && task.title.includes(search.value),
  ),
);
const arrangements = computed(() =>
  store.state.arrangements
    .filter((item) => item.date === date.value)
    .flatMap((item) => {
      const task = store.state.tasks.find((task) => task.id === item.taskId);
      return task ? [{ ...item, task }] : [];
    }),
);
const pending = computed(() => arrangements.value.filter((item) => !item.done));
const completed = computed(() =>
  arrangements.value.filter((item) => item.done),
);
const focused = computed(
  () =>
    pending.value.find((item) => item.taskId === focusId.value) ??
    pending.value[0],
);
const remaining = computed(() =>
  pending.value.filter((item) => item.taskId !== focused.value?.taskId),
);
const manageableTasks = computed(() =>
  view.value === "today"
    ? pending.value.map((item) => item.task)
    : visibleTasks.value,
);
const allSelected = computed(
  () =>
    manageableTasks.value.length > 0 &&
    manageableTasks.value.every((task) => isSelected(task.id)),
);
watch(view, () => stopSelection());
watch(manageableTasks, (tasks) => {
  if (selecting.value) retainSelection(tasks);
});
watch(pending, (items) => {
  if (!items.some((item) => item.taskId === focusId.value))
    focusId.value = null;
});
const historicalUnfinished = computed(
  () =>
    store.state.arrangements.filter(
      (item) =>
        item.date < date.value &&
        !item.done &&
        store.state.tasks.some(
          (task) =>
            task.id === item.taskId &&
            !["done", "abandoned"].includes(task.status),
        ),
    ).length,
);
function edit(task: Task) {
  editor.value = JSON.parse(JSON.stringify(task));
  contextTaskId.value = task.id;
}
function selectFocus(taskId: string) {
  focusId.value = taskId;
  contextTaskId.value = null;
}
function toggleManaging() {
  if (selecting.value) stopSelection();
  else startSelection();
}
function toggleAll() {
  if (allSelected.value) clearSelection();
  else selectAllTasks(manageableTasks.value);
}
function openDelete() {
  const ids = deletionOrder(manageableTasks.value);
  deleteTargets.value = manageableTasks.value.filter((task) =>
    ids.includes(task.id),
  );
  if (!deleteTargets.value.length) return;
  deleteError.value = "";
  deleteOpen.value = true;
}
async function confirmDelete() {
  if (!deleteTargets.value.length) return;
  deleting.value = true;
  deleteError.value = "";
  let removed = 0;
  try {
    for (const task of [...deleteTargets.value]) {
      await store.dispatch({ type: "deleteTask", id: task.id });
      removed += 1;
    }
    deleteOpen.value = false;
    stopSelection();
  } catch (cause) {
    deleteTargets.value = deleteTargets.value.slice(removed);

    deleteError.value = `已删除 ${removed} 项，其余任务未处理：${String(cause)}`;
  } finally {
    deleting.value = false;
  }
}
function openSettings() {
  preferences.value = store.state.preferences;
  theme.value = store.state.theme;
  settingsOpen.value = true;
}
async function saveSettings() {
  try {
    await store.dispatch({
      type: "settings",
      preferences: preferences.value,
      theme: theme.value,
    });
    settingsOpen.value = false;
  } catch {}
}
async function energy(event: Event) {
  try {
    await store.dispatch({
      type: "energy",
      value:
        ((event.target as HTMLSelectElement)
          .value as (typeof energyLabels)[number]) || null,
    });
  } catch {}
}
</script>
<template>
  <div v-if="!store.ready" class="loading">
    <Leaf :size="30" />
    <h1>息序</h1>
    <p v-if="store.error" role="alert">{{ store.error }}</p>
    <p v-else>正在打开本地工作台…</p>
    <Button v-if="store.error" @click="store.load">重试打开</Button>
  </div>
  <div v-else class="app-shell" :style="shellStyle">
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="brand">
        <Sun :size="34" :stroke-width="1.3" />
        <div v-if="!sidebarCollapsed">
          <strong>息序</strong><small>小步前行 · 从容生长</small>
        </div>
      </div>
      <Button
        variant="outline"
        class="new-task"
        :aria-label="sidebarCollapsed ? '记下一件事' : undefined"
        :title="sidebarCollapsed ? '记下一件事' : undefined"
        @click="editor = newTask()"
        ><Plus :size="16" /><span v-if="!sidebarCollapsed"
          >记下一件事</span
        ></Button
      >
      <nav aria-label="主导航">
        <button
          :class="{ active: view === 'today' }"
          :aria-current="view === 'today' ? 'page' : undefined"
          :aria-label="sidebarCollapsed ? '今日安排' : undefined"
          :title="sidebarCollapsed ? '今日安排' : undefined"
          @click="view = 'today'"
        >
          <Sun :size="18" /><span v-if="!sidebarCollapsed"
            >今日安排<span>{{ arrangements.length }}</span></span
          ></button
        ><button
          :class="{ active: view === 'all' }"
          :aria-current="view === 'all' ? 'page' : undefined"
          :aria-label="sidebarCollapsed ? '所有任务' : undefined"
          :title="sidebarCollapsed ? '所有任务' : undefined"
          @click="view = 'all'"
        >
          <ListTodo :size="18" /><span v-if="!sidebarCollapsed"
            >所有任务<span>{{
              store.state.tasks.filter((t) => t.status !== "done").length
            }}</span></span
          ></button
        ><button
          :class="{ active: view === 'completed' }"
          :aria-current="view === 'completed' ? 'page' : undefined"
          :aria-label="sidebarCollapsed ? '已完成' : undefined"
          :title="sidebarCollapsed ? '已完成' : undefined"
          @click="view = 'completed'"
        >
          <CircleCheck :size="18" /><span v-if="!sidebarCollapsed">已完成</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <p v-if="!sidebarCollapsed" class="quiet-note">
          <Leaf :size="24" />不必把所有事情，<br />都放进今天。
        </p>
        <button
          class="profile"
          :aria-label="sidebarCollapsed ? '我的空间 本地保存' : undefined"
          :title="sidebarCollapsed ? '我的空间' : undefined"
          @click="openSettings"
        >
          <span class="avatar">息</span
          ><span v-if="!sidebarCollapsed">我的空间<small>本地保存</small></span
          ><Settings v-if="!sidebarCollapsed" :size="18" />
        </button>
        <button
          class="collapse-toggle"
          :aria-label="sidebarCollapsed ? '展开导航' : '收起导航'"
          :aria-expanded="!sidebarCollapsed"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          <PanelLeftOpen v-if="sidebarCollapsed" :size="17" />
          <PanelLeftClose v-else :size="17" />
        </button>
      </div>
    </aside>
    <main class="workspace">
      <header class="topbar">
        <span>我的空间 <span class="separator">›</span> {{ labels[view] }}</span
        ><span class="prototype-label">交互原型</span>
      </header>
      <div v-if="store.error" role="alert" class="error-banner">
        {{ store.error }}<button @click="store.error = ''">关闭提示</button>
      </div>
      <div class="main-scroll">
        <template v-if="view === 'today'">
          <header class="page-heading today-heading">
            <div>
              <p class="date">
                {{
                  new Date(date + "T12:00:00").toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "long",
                  })
                }}
              </p>
              <h1>今天，留一点余地。</h1>
              <p class="subtitle">把重要的事往前推，也给自己一点空间。</p>
            </div>
            <div class="page-actions">
              <Button
                v-if="pending.length || selecting"
                variant="ghost"
                :aria-pressed="selecting"
                @click="toggleManaging"
                ><ListChecks :size="15" />{{
                  selecting ? "完成" : "管理"
                }}</Button
              >
              <div class="day-stamp">
                {{ date.slice(-2)
                }}<small>{{
                  new Date(date + "T12:00:00")
                    .toLocaleDateString("en", { month: "long" })
                    .toUpperCase()
                }}</small>
              </div>
            </div>
          </header>
          <section class="energy">
            <Sun :size="26" :stroke-width="1.5" />
            <div>
              <label for="energy" class="eyebrow">此刻的能量</label
              ><select
                id="energy"
                :value="store.state.energy.value || ''"
                @change="energy"
              >
                <option value="">尚未说明</option>
                <option v-for="value in energyLabels" :key="value">
                  {{ value }}
                </option>
              </select>
            </div>
            <span class="energy-caption">按自己的节奏，稳稳向前。</span>
          </section>
          <div class="section-heading">
            <h2>今日安排</h2>
            <span v-if="pending.length && !selecting" class="muted"
              >{{ pending.length }} 项待推进</span
            >
          </div>
          <ManageBar
            v-if="selecting"
            :count="selectedCount"
            :total="pending.length"
            :all-selected="allSelected"
            @toggle-all="toggleAll"
            @remove="openDelete"
          />
          <div v-if="!arrangements.length" class="empty-state">
            <Sun :size="28" />
            <h2>给今天一个开始</h2>
            <p>记下一件事，设定本次推进范围。也可以在右侧试着生成安排。</p>
            <Button variant="outline" @click="editor = newTask()"
              ><Plus :size="16" />记下一件事</Button
            >
          </div>
          <div v-else :class="['today-plan', { selecting }]">
            <TaskCard
              v-if="focused"
              :task="focused.task"
              :arrangement="focused"
              focus
              :selectable="selecting"
              :selected="isSelected(focused.task.id)"
              @select="toggleSelection"
              @edit="edit"
            />
            <p v-else class="today-finished" role="status">
              <CircleCheck :size="18" /> 今日安排已全部完成
            </p>
            <section
              v-if="remaining.length"
              aria-labelledby="remaining-heading"
            >
              <div class="remaining-heading">
                <h3 id="remaining-heading">其余待推进</h3>
                <span class="muted rest-hint"
                  ><Coffee :size="14" />需要时歇一会儿</span
                >
              </div>
              <TaskCard
                v-for="(item, index) in remaining"
                :key="item.taskId"
                :task="item.task"
                :arrangement="item"
                :previous-task-id="remaining[index - 1]?.taskId"
                :next-task-id="remaining[index + 1]?.taskId"
                :selectable="selecting"
                :selected="isSelected(item.task.id)"
                @select="toggleSelection"
                @edit="edit"
                @focus-task="selectFocus"
              />
            </section>
            <details
              v-if="completed.length && !selecting"
              class="today-completed"
            >
              <summary>
                已完成的今日阶段 <span>{{ completed.length }} 项</span>
              </summary>
              <TaskCard
                v-for="item in completed"
                :key="item.taskId"
                :task="item.task"
                :arrangement="item"
                @edit="edit"
              />
            </details>
          </div>
          <p v-if="historicalUnfinished" class="notice today-notice">
            有
            {{ historicalUnfinished }}
            项历史安排尚未完成，已纳入分析上下文。可以重新判断推进日期与价值。
          </p>
        </template>
        <template v-else
          ><header class="page-heading">
            <div class="page-heading-copy">
              <p class="date">我的任务总览</p>
              <h1>{{ labels[view] }}</h1>
              <p class="subtitle">
                {{
                  view === "completed"
                    ? "留下真实完成的记录。"
                    : "想做的事先记下来，留给合适的时候。"
                }}
              </p>
            </div>
            <div class="page-actions">
              <Button
                v-if="view === 'all' && !selecting"
                variant="outline"
                @click="editor = newTask()"
                ><Plus :size="15" />添加任务</Button
              >
              <Button
                v-if="selecting || visibleTasks.length"
                variant="ghost"
                :aria-pressed="selecting"
                @click="toggleManaging"
                ><ListChecks :size="15" />{{
                  selecting ? "完成" : "管理"
                }}</Button
              >
              <label class="search"
                ><Search :size="15" /><input
                  v-model="search"
                  placeholder="搜索任务"
                  aria-label="搜索任务"
              /></label>
            </div>
          </header>
          <ManageBar
            v-if="selecting"
            :count="selectedCount"
            :total="visibleTasks.length"
            :all-selected="allSelected"
            @toggle-all="toggleAll"
            @remove="openDelete"
          />
          <div v-else class="list-heading">
            <span>任务</span><span>{{ visibleTasks.length }} 项</span>
          </div>
          <button
            v-for="task in visibleTasks"
            :key="task.id"
            class="task-list-row"
            :class="{
              selected: selecting && isSelected(task.id),
            }"
            :aria-pressed="selecting ? isSelected(task.id) : undefined"
            @click="selecting ? toggleSelection(task.id) : edit(task)"
          >
            <span
              v-if="selecting"
              class="select-box"
              :class="{ checked: isSelected(task.id) }"
              ><Check v-if="isSelected(task.id)" :size="12"
            /></span>
            <CircleCheck v-else-if="task.status === 'done'" :size="17" /><span
              v-else
              class="list-dot"
            ></span
            ><span class="list-task-name"
              ><small v-if="task.parentId">子任务 · </small
              >{{ task.title }}</span
            ><small v-if="task.status === 'abandoned'">主动放弃</small
            ><small v-else>{{
              store.state.arrangements.some(
                (a) => a.taskId === task.id && a.date === date,
              )
                ? "今日"
                : task.startDate && task.expectedDate
                  ? `${task.startDate} → ${task.expectedDate}`
                  : task.startDate
                    ? `预计开始 ${task.startDate}`
                    : task.expectedDate
                      ? `预计完成 ${task.expectedDate}`
                      : statusLabels[task.status]
            }}</small>
          </button>
          <p v-if="!visibleTasks.length" class="empty-state">
            {{ search ? "没有匹配的任务。" : "这里还没有任务记录。" }}
          </p>
        </template>
      </div>
    </main>
    <ChatPanel
      v-model:collapsed="chatCollapsed"
      :focused-id="contextTaskId ?? focused?.taskId ?? null"
      @resize="chatWidth = $event"
    />
    <Modal
      v-model:open="deleteOpen"
      title="删除任务"
      description="任务及其子任务、相关安排会一并删除，且无法恢复。"
      ><div class="delete-summary">
        <p class="manage-count">
          将删除以下 <strong>{{ deleteTargets.length }}</strong> 项任务
        </p>
        <ul class="delete-list">
          <li v-for="task in deleteTargets.slice(0, 5)" :key="task.id">
            {{ task.title }}
          </li>
        </ul>
        <p v-if="deleteTargets.length > 5" class="muted">
          以及另外 {{ deleteTargets.length - 5 }} 项
        </p>
      </div>
      <p v-if="deleteError" role="alert" class="error">{{ deleteError }}</p>
      <div class="form-actions confirm-actions">
        <Button variant="ghost" @click="deleteOpen = false">取消</Button>
        <Button
          variant="destructive"
          :disabled="deleting || !deleteTargets.length"
          @click="confirmDelete"
          >{{
            deleting ? "正在删除…" : `删除 ${deleteTargets.length} 项`
          }}</Button
        >
      </div>
    </Modal>
    <TaskEditor
      v-if="editor"
      :key="editor.id"
      :task="editor"
      @edit="edit"
      @close="editor = null"
    />
    <Modal
      v-model:open="settingsOpen"
      title="工作台设置"
      description="主题和明确偏好会保存在本机。"
      ><form class="task-form" @submit.prevent="saveSettings">
        <label
          >主题<select v-model="theme">
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select></label
        ><label
          >明确偏好<textarea
            v-model="preferences"
            rows="5"
            placeholder="例如，上午适合专注，晚上留出休息时间。"
          />
        </label>
        <p class="notice">
          模型 API 接入安排在后续阶段。当前模拟模式使用本地模板回复。
        </p>
        <Button type="submit">保存设置</Button>
      </form></Modal
    >
  </div>
</template>
