<script setup lang="ts">
import { ref, computed } from "vue";
import Modal from "./Modal.vue";
import Button from "./ui/button/Button.vue";
import { useWorkspace } from "@/stores/workspace";
import {
  newTask,
  localDate,
  statusLabels,
  type Task,
} from "../../shared/model";
const props = defineProps<{ task: Task }>();
const emit = defineEmits<{ close: [] }>();
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
const scheduleDate = ref(draft.value.plannedDate || localDate());
const scope = ref(
  store.state.arrangements.find(
    (item) => item.taskId === props.task.id && item.date === scheduleDate.value,
  )?.scope || draft.value.nextStep,
);
const existing = computed(() =>
  store.state.tasks.some((task) => task.id === props.task.id),
);
async function save(arrange = false) {
  busy.value = true;
  try {
    await store.dispatch({
      type: "saveTask",
      task: draft.value,
      arrangement: arrange
        ? { date: scheduleDate.value, scope: scope.value }
        : undefined,
    });
    draft.value = JSON.parse(
      JSON.stringify(
        store.state.tasks.find((task) => task.id === draft.value.id)!,
      ),
    );
    emit("close");
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
async function addChild() {
  const child = newTask(props.task.id);
  child.title = childTitle.value;
  child.goal = childGoal.value;
  try {
    await store.dispatch({ type: "saveTask", task: child });
    childTitle.value = "";
    childGoal.value = "";
  } catch (cause) {
    error.value = String(cause);
  }
}
const childTitle = ref("");
const childGoal = ref("");
</script>
<template>
  <Modal
    v-model:open="open"
    :title="existing ? '任务详情' : '记下一件事'"
    description="明确整体目标，记录进展，再决定哪天推进。"
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
      <label
        >整体目标与完成条件<textarea
          v-model="draft.goal"
          rows="2"
          placeholder="做到什么程度，算整个任务完成？"
        />
      </label>
      <div class="form-grid">
        <label
          >重要性<select v-model="draft.importance">
            <option v-for="value in ['待定', '高', '中', '低']" :key="value">
              {{ value }}
            </option>
          </select></label
        >
        <label
          >任务状态<select v-model="draft.status">
            <option
              v-for="(label, value) in statusLabels"
              :key="value"
              :value="value"
            >
              {{ label }}
            </option>
          </select></label
        >
        <label
          >真实截止<input v-model="draft.deadline" type="datetime-local"
        /></label>
        <label
          >预期完成日期<input v-model="draft.expectedDate" type="date"
        /></label>
      </div>
      <label
        >所属任务<select v-model="draft.parentId">
          <option :value="null">独立任务</option>
          <option
            v-for="task in store.state.tasks.filter((t) => t.id !== draft.id)"
            :key="task.id"
            :value="task.id"
          >
            {{ task.title }}
          </option>
        </select></label
      >
      <label
        >前置依赖<select
          v-model="draft.dependencies"
          multiple
          aria-label="前置依赖"
        >
          <option
            v-for="task in store.state.tasks.filter((t) => t.id !== draft.id)"
            :key="task.id"
            :value="task.id"
          >
            {{ task.title }}
          </option></select
        ><small>按 Ctrl 可选择或取消多项。</small></label
      >
      <label
        >当前进展 / 停点<textarea
          v-model="draft.progress"
          rows="2"
          placeholder="已经完成了什么，上次停在哪里？"
        />
      </label>
      <div class="form-grid">
        <label
          >当前阻力<input
            v-model="draft.obstacle"
            placeholder="缺少材料、方法不清楚…" /></label
        ><label
          >下一步行动<input
            v-model="draft.nextStep"
            placeholder="现在可以开始的具体动作"
        /></label>
      </div>
      <label
        >任务背景<textarea
          v-model="draft.background"
          rows="3"
          placeholder="缘由、材料、约束、尝试过的方法…"
        />
      </label>
      <label
        >背景来源<select v-model="draft.backgroundKind">
          <option>用户事实</option>
          <option>暂估</option>
          <option>推测</option>
        </select></label
      >
      <p v-if="draft.status === 'done'" class="notice">
        请对照整体完成条件检查。子任务或今日阶段完成，仍可能有后续工作。
      </p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <div class="form-actions">
        <Button
          v-if="existing"
          type="button"
          variant="ghost"
          @click="deleting = !deleting"
          >删除任务</Button
        ><Button type="submit" :disabled="busy">保存任务</Button>
      </div>
      <div v-if="deleting" class="notice">
        <p>删除「{{ draft.title }}」及其全部子任务和相关安排？</p>
        <Button type="button" variant="destructive" @click="remove"
          >确认删除</Button
        >
      </div>
      <section class="form-section">
        <h3>安排一次推进</h3>
        <div class="form-grid">
          <label>推进日期<input v-model="scheduleDate" type="date" /></label
          ><label
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
      </section>
    </form>
    <section v-if="existing" class="form-section">
      <h3>可跟踪子任务</h3>
      <p
        v-for="child in store.state.tasks.filter((t) => t.parentId === task.id)"
        :key="child.id"
      >
        {{ statusLabels[child.status] }} · {{ child.title }}
      </p>
      <form @submit.prevent="addChild" class="task-form">
        <label>子任务名称<input v-model="childTitle" required /></label
        ><label>完成条件<input v-model="childGoal" required /></label
        ><Button variant="outline" type="submit">添加子任务</Button>
      </form>
    </section>
  </Modal>
</template>
