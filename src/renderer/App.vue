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
  PanelLeftClose,
  PanelLeftOpen,
  Repeat2,
} from "lucide-vue-next";
import { useWorkspace } from "./stores/workspace";
import Button from "./components/ui/button/Button.vue";
import Modal from "./components/Modal.vue";
import ManageBar from "./components/ManageBar.vue";
import ManageToggle from "./components/ManageToggle.vue";
import TaskEditor from "./components/TaskEditor.vue";
import TaskCard from "./components/TaskCard.vue";
import OccurrenceEditor from "./components/OccurrenceEditor.vue";
import RecurrenceHistory from "./components/RecurrenceHistory.vue";
import ChatPanel from "./components/ChatPanel.vue";
import { deletionOrder, useTaskSelection } from "./composables/taskSelection";
import {
  affectedRecurringTasks,
  recurrenceLabel,
  tomorrow,
} from "./lib/recurrence";
import { nextRecurrenceDate } from "../domain/recurrence";
import {
  localDate,
  newTask,
  energyLabels,
  statusLabels,
  importanceLabels,
  type Arrangement,
  type Task,
} from "../domain/model";
const store = useWorkspace();
const view = ref<"today" | "all" | "completed">("today");
const labels = { today: "今日安排", all: "所有任务", completed: "已完成" };
const editor = ref<Task | null>(null);
const editorFromToday = ref(false);
const occurrence = ref<Arrangement | null>(null);
const history = ref<{ taskId?: string } | null>(null);
const settingsOpen = ref(false);
const settingsError = ref("");
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
const importanceFilter = ref<Task["importance"] | "all">("all");
const typeFilter = ref<"all" | "single" | "repeated">("all");
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
} = useTaskSelection();
const deleteOpen = ref(false);
const deleting = ref(false);
const deleteError = ref("");
const deleteTargets = ref<Task[]>([]);
const affectedTemplates = computed(() =>
  affectedRecurringTasks(
    store.state.tasks,
    deleteTargets.value.map((task) => task.id),
  ),
);
const changingOccurrences = ref(false);
const date = ref(localDate());
let refreshingDate = false;
async function refreshDate() {
  const next = localDate();
  if (next === date.value || refreshingDate) return;
  refreshingDate = true;
  try {
    if (!(await store.load())) return;
    date.value = next;
    occurrence.value = null;
  } finally {
    refreshingDate = false;
  }
}
const dateTimer = setInterval(refreshDate, 30000);
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
  window.removeEventListener("focus", refreshDate);
  document.removeEventListener("visibilitychange", refreshDate);
});
onMounted(async () => {
  window.addEventListener("focus", refreshDate);
  document.addEventListener("visibilitychange", refreshDate);
  await store.load();
  applyTheme();
});
const visibleTasks = computed(() =>
  store.state.tasks.filter(
    (task) =>
      (view.value === "completed"
        ? task.status === "done"
        : task.status !== "done") &&
      task.title.includes(search.value) &&
      (view.value !== "all" ||
        importanceFilter.value === "all" ||
        task.importance === importanceFilter.value) &&
      (view.value !== "all" ||
        typeFilter.value === "all" ||
        (typeFilter.value === "repeated") === Boolean(task.recurrence)),
  ),
);
const arrangements = computed(() =>
  store.state.arrangements
    .filter((item) => item.date === date.value)
    .flatMap((item) => {
      const task = store.state.tasks.find((task) => task.id === item.taskId);
      return task || item.recurrence ? [{ ...item, task }] : [];
    }),
);
const pending = computed(() => arrangements.value.filter((item) => !item.done));
const upcomingRepeatDays = computed(() => {
  const current = new Set(
    pending.value.filter((item) => item.recurrence).map((item) => item.taskId),
  );
  return new Map(
    store.state.tasks.flatMap((task) => {
      if (!task.recurrence) return [];
      const next = current.has(task.id)
        ? date.value
        : nextRecurrenceDate(task.recurrence, tomorrow(date.value));
      return [[task.id, next] as const];
    }),
  );
});
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
const moveNeighbors = computed(() => {
  const queue = pending.value.some((item) => item.recurrence)
    ? pending.value
    : remaining.value;
  return new Map(
    queue.map((item, index) => [
      item.taskId,
      { previous: queue[index - 1]?.taskId, next: queue[index + 1]?.taskId },
    ]),
  );
});
const manageableItems = computed(() =>
  view.value === "today"
    ? pending.value.map((item) => ({ id: item.taskId }))
    : visibleTasks.value,
);
const pickedToday = computed(() =>
  pending.value.filter((item) => isSelected(item.taskId)),
);
const pickedRepeat = computed(() =>
  pickedToday.value.filter((item) => item.recurrence),
);
const pickedTemporary = computed(() =>
  pickedToday.value.filter((item) => !item.recurrence && item.task?.recurrence),
);
const pickedOrdinary = computed(() =>
  pickedToday.value.flatMap((item) =>
    item.task && !item.recurrence && !item.task.recurrence ? [item.task] : [],
  ),
);
const skippedToday = computed(
  () =>
    store.state.skippedOccurrences?.filter(
      (item) => item.arrangement.date === date.value,
    ) ?? [],
);
const allSelected = computed(
  () =>
    manageableItems.value.length > 0 &&
    manageableItems.value.every((item) => isSelected(item.id)),
);
watch(view, () => stopSelection());
watch(manageableItems, (items) => {
  if (selecting.value) retainSelection(items);
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
        !item.recurrence &&
        store.state.tasks.some(
          (task) =>
            task.id === item.taskId &&
            !["done", "abandoned"].includes(task.status),
        ),
    ).length,
);
function openEditor(task: Task, fromToday: boolean) {
  occurrence.value = null;
  editorFromToday.value = fromToday;
  editor.value = JSON.parse(JSON.stringify(task));
  contextTaskId.value = task.id;
}
function edit(task: Task) {
  openEditor(task, view.value === "today");
}
function addTask() {
  editorFromToday.value = view.value === "today";
  editor.value = newTask();
}
function openOccurrence(item: Arrangement) {
  occurrence.value = item;
  contextTaskId.value = store.state.tasks.some(
    (task) => task.id === item.taskId,
  )
    ? item.taskId
    : null;
}
function openHistory(taskId?: string) {
  editor.value = null;
  occurrence.value = null;
  history.value = { taskId };
}
const occurrenceTask = computed(() =>
  store.state.tasks.find((task) => task.id === occurrence.value?.taskId),
);
function selectFocus(taskId: string) {
  focusId.value = taskId;
  contextTaskId.value = null;
}
function moved(taskId: string, targetTaskId: string) {
  if (focusId.value === taskId || focusId.value === targetTaskId)
    focusId.value = null;
}
function toggleManaging() {
  if (selecting.value) stopSelection();
  else startSelection();
}
function toggleAll() {
  if (allSelected.value) clearSelection();
  else selectAllTasks(manageableItems.value);
}
function openDelete() {
  const selected =
    view.value === "today"
      ? pickedOrdinary.value
      : visibleTasks.value.filter((task) => isSelected(task.id));
  const ids = deletionOrder(
    selected.map((task) => task.id),
    store.state.tasks,
  );
  deleteTargets.value = selected.filter((task) => ids.includes(task.id));
  if (!deleteTargets.value.length) return;
  deleteError.value = "";
  deleteOpen.value = true;
}
async function removeTodayItems(items: Arrangement[]) {
  if (changingOccurrences.value) return;
  changingOccurrences.value = true;
  try {
    for (const item of items) {
      await store.dispatch({
        type: item.recurrence ? "skipOccurrence" : "unschedule",
        taskId: item.taskId,
        date: item.date,
      });
    }
  } catch {
    // The workspace displays errors and reloads the latest data.
  } finally {
    changingOccurrences.value = false;
  }
}
async function restoreOccurrences() {
  if (changingOccurrences.value) return;
  changingOccurrences.value = true;
  try {
    for (const { arrangement } of [...skippedToday.value].reverse()) {
      await store.dispatch({
        type: "restoreOccurrence",
        taskId: arrangement.taskId,
        date: arrangement.date,
      });
    }
  } catch {
    // The remaining skipped items remain available for retry.
  } finally {
    changingOccurrences.value = false;
  }
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
  settingsError.value = "";
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
    settingsError.value = "";
  } catch (cause) {
    settingsError.value = `保存设置失败：${String(cause)}`;
  }
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
        @click="addTask"
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
              <ManageToggle
                v-if="pending.length || selecting"
                :active="selecting"
                @toggle="toggleManaging"
              />
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
          >
            <template #actions>
              <Button
                v-if="pickedRepeat.length"
                variant="outline"
                :disabled="changingOccurrences"
                @click="removeTodayItems(pickedRepeat)"
                >从今天移除 {{ pickedRepeat.length }} 项重复安排</Button
              >
              <Button
                v-if="pickedTemporary.length"
                variant="outline"
                :disabled="changingOccurrences"
                @click="removeTodayItems(pickedTemporary)"
                >移出 {{ pickedTemporary.length }} 项临时安排</Button
              >
              <Button
                v-if="pickedOrdinary.length"
                variant="destructive"
                :disabled="changingOccurrences"
                @click="openDelete"
                >删除 {{ pickedOrdinary.length }} 项普通任务</Button
              >
            </template>
          </ManageBar>
          <div v-if="skippedToday.length" class="notice recurrence-undo">
            <span role="status"
              >已从今天移除 {{ skippedToday.length }} 项重复安排</span
            >
            <Button
              variant="ghost"
              :disabled="changingOccurrences"
              @click="restoreOccurrences"
              >{{ skippedToday.length === 1 ? "撤销" : "撤销全部" }}</Button
            >
          </div>
          <div v-if="!arrangements.length" class="empty-state">
            <Sun :size="28" />
            <h2>给今天一个开始</h2>
            <p>记下一件事，设定本次推进范围。也可以在右侧试着生成安排。</p>
            <Button variant="outline" @click="addTask"
              ><Plus :size="16" />记下一件事</Button
            >
          </div>
          <div v-else :class="['today-plan', { selecting }]">
            <TaskCard
              v-if="focused"
              :task="focused.task"
              :arrangement="focused"
              :previous-task-id="moveNeighbors.get(focused.taskId)?.previous"
              :next-task-id="moveNeighbors.get(focused.taskId)?.next"
              focus
              :selectable="selecting"
              :selected="isSelected(focused.taskId)"
              @select="toggleSelection"
              @edit="edit"
              @occurrence="openOccurrence"
              @skip="removeTodayItems([$event])"
              @moved="moved"
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
                v-for="item in remaining"
                :key="item.taskId"
                :task="item.task"
                :arrangement="item"
                :previous-task-id="moveNeighbors.get(item.taskId)?.previous"
                :next-task-id="moveNeighbors.get(item.taskId)?.next"
                :selectable="selecting"
                :selected="isSelected(item.taskId)"
                @select="toggleSelection"
                @edit="edit"
                @occurrence="openOccurrence"
                @skip="removeTodayItems([$event])"
                @focus-task="selectFocus"
                @moved="moved"
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
                @occurrence="openOccurrence"
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
                v-if="view === 'all'"
                variant="ghost"
                @click="openHistory()"
                >重复记录</Button
              >
              <Button
                v-if="view === 'all' && !selecting"
                variant="outline"
                @click="addTask"
                ><Plus :size="15" />添加任务</Button
              >
              <ManageToggle
                v-if="selecting || visibleTasks.length"
                :active="selecting"
                @toggle="toggleManaging"
              />
            </div>
          </header>
          <div class="task-list-filters">
            <select
              v-if="view === 'all'"
              v-model="typeFilter"
              class="task-list-filter"
              aria-label="按任务类型筛选"
            >
              <option value="all">全部类型</option>
              <option value="single">一次性</option>
              <option value="repeated">重复</option>
            </select>
            <select
              v-if="view === 'all'"
              v-model="importanceFilter"
              class="importance-filter task-list-filter"
              aria-label="按重要性筛选"
            >
              <option value="all">重要性不限</option>
              <option
                v-for="(label, value) in importanceLabels"
                :key="value"
                :value="value"
              >
                重要性 · {{ label }}
              </option>
              <option :value="null">未设置重要性</option>
            </select>
            <label class="search"
              ><Search :size="15" /><input
                v-model="search"
                placeholder="搜索任务"
                aria-label="搜索任务"
            /></label>
          </div>
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
            ></span>
            <span class="list-task-name">
              <span class="task-title-line">
                <span
                  ><small v-if="task.parentId">子任务 · </small
                  >{{ task.title }}</span
                >
                <span v-if="task.recurrence" class="recurrence-tag">
                  <Repeat2 :size="12" aria-hidden="true" />重复
                </span>
              </span>
              <small v-if="task.recurrence" class="list-repeat-rule">{{
                recurrenceLabel(task.recurrence)
              }}</small>
            </span>
            <span class="list-task-details">
              <span
                v-if="view === 'all' && task.importance"
                class="task-importance"
                :class="{ 'task-importance-high': task.importance === 'high' }"
              >
                重要性 · {{ importanceLabels[task.importance] }}
              </span>
              <small v-if="task.recurrence">
                {{
                  upcomingRepeatDays.get(task.id) === date
                    ? "今日"
                    : upcomingRepeatDays.get(task.id)
                      ? `下次 ${upcomingRepeatDays.get(task.id)}`
                      : "重复已结束"
                }}
              </small>
              <small v-else-if="task.status === 'abandoned'">主动放弃</small>
              <small v-else>{{
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
            </span>
          </button>
          <p v-if="!visibleTasks.length" class="empty-state">
            {{
              search ||
              (view === "all" &&
                (importanceFilter !== "all" || typeFilter !== "all"))
                ? "没有匹配的任务。"
                : "这里还没有任务记录。"
            }}
          </p>
        </template>
      </div>
    </main>
    <ChatPanel
      v-model:collapsed="chatCollapsed"
      :focused-id="contextTaskId ?? focused?.task?.id ?? null"
      @resize="chatWidth = $event"
    />
    <Modal
      v-model:open="deleteOpen"
      :title="
        deleteTargets.length === 1 && deleteTargets[0].recurrence
          ? '删除重复任务'
          : '删除任务'
      "
      description="任务、全部子任务及各日期的普通安排将被删除，且无法恢复。"
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
        <div v-if="affectedTemplates.length" class="notice">
          <p>以下重复任务将停止生成安排。已经生成的实例（包括今天）会保留。</p>
          <ul class="delete-list">
            <li v-for="task in affectedTemplates" :key="task.id">
              {{ task.title }}
            </li>
          </ul>
        </div>
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
      :date="date"
      :from-today="editorFromToday"
      @edit="edit"
      @history="openHistory"
      @close="editor = null"
    />
    <OccurrenceEditor
      v-if="occurrence"
      :occurrence="occurrence"
      :task="occurrenceTask"
      @close="occurrence = null"
      @settings="openEditor($event, true)"
      @history="openHistory"
    />
    <RecurrenceHistory
      v-if="history"
      :date="date"
      :task-id="history.taskId"
      @close="history = null"
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
        <p v-if="settingsError" role="alert" class="notice error">
          {{ settingsError }}
        </p>
        <p class="notice">模型凭据仅保存在本机，任务与对话不会离开本机。</p>
        <Button type="submit">保存设置</Button>
      </form></Modal
    >
  </div>
</template>
