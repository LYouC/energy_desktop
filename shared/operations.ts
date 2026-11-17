import {
  commandSchema,
  stateSchema,
  type State,
  type Task,
  type Command,
  type Proposal,
  newTask,
} from "./model";
import { z } from "zod";

function findTask(state: State, id: string) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务已被删除，请刷新后重试。");
  return task;
}
function checkRelations(tasks: Task[]) {
  for (const task of tasks) {
    const visit = (id: string, path: Set<string>) => {
      if (path.has(id)) throw new Error("父子关系形成了循环。");
      const current = tasks.find((item) => item.id === id);
      if (!current) throw new Error("关联任务不存在。");
      if (current.parentId) visit(current.parentId, new Set([...path, id]));
    };
    visit(task.id, new Set());
  }
}
function checkDates(task: Task) {
  for (const date of [task.startDate, task.expectedDate])
    if (date && !z.iso.date().safeParse(date).success)
      throw new Error("请选择有效的任务日期。");
  if (task.startDate && task.expectedDate && task.startDate > task.expectedDate)
    throw new Error("预计完成日期不能早于预计开始日期。");
}
function schedule(state: State, taskId: string, date: string, scope: string) {
  const task = findTask(state, taskId);
  if (["done", "abandoned"].includes(task.status))
    throw new Error("请先恢复任务，再安排推进。");
  if (!z.iso.date().safeParse(date).success)
    throw new Error("请选择有效的安排日期。");
  const existing = state.arrangements.find(
    (item) => item.taskId === taskId && item.date === date,
  );
  if (existing) {
    existing.scope = scope;
    existing.done = false;
  } else state.arrangements.push({ taskId, date, scope, done: false });
  task.version++;
}
function addProposal(state: State, proposal: Proposal) {
  if (!state.sessions.some((session) => session.id === proposal.sessionId))
    throw new Error("方案所属对话不存在。");
  if (state.proposals.some((item) => item.id === proposal.id))
    throw new Error("方案已经存在。");
  for (const change of proposal.changes) {
    if (
      change.status !== "pending" ||
      findTask(state, change.taskId).version !== change.taskVersion
    )
      throw new Error("任务已变化，请重新分析方案。");
  }
  state.proposals.push(proposal);
}
export function applyCommand(previous: State, input: Command): State {
  const command = commandSchema.parse(input);
  const state: State = structuredClone(previous);
  const now = new Date().toISOString();
  switch (command.type) {
    case "saveTask": {
      const old = state.tasks.find((task) => task.id === command.task.id);
      if (old && old.version !== command.task.version)
        throw new Error("任务已更新，请重新打开详情。");
      const task = {
        ...command.task,
        version: (old?.version ?? 0) + 1,
        updatedAt: now,
      };
      checkDates(task);
      if (old) state.tasks[state.tasks.indexOf(old)] = task;
      else state.tasks.push(task);
      checkRelations(state.tasks);
      if (command.arrangement)
        schedule(
          state,
          task.id,
          command.arrangement.date,
          command.arrangement.scope,
        );
      break;
    }
    case "deleteTask": {
      findTask(state, command.id);
      const ids = new Set([command.id]);
      for (let pass = 0; pass < state.tasks.length; pass++) {
        for (const task of state.tasks)
          if (task.parentId && ids.has(task.parentId)) ids.add(task.id);
      }
      state.tasks = state.tasks.filter((task) => !ids.has(task.id));
      state.arrangements = state.arrangements.filter(
        (item) => !ids.has(item.taskId),
      );
      for (const proposal of state.proposals)
        for (const change of proposal.changes) {
          if (
            (ids.has(change.taskId) ||
              (change.fromTaskId && ids.has(change.fromTaskId))) &&
            change.status === "pending"
          )
            change.status = "rejected";
        }
      break;
    }
    case "schedule":
      schedule(state, command.taskId, command.date, command.scope);
      break;
    case "unschedule": {
      state.arrangements = state.arrangements.filter(
        (item) => item.taskId !== command.taskId || item.date !== command.date,
      );
      const task = findTask(state, command.taskId);
      task.version++;
      break;
    }
    case "stage": {
      const item = state.arrangements.find(
        (item) => item.taskId === command.taskId && item.date === command.date,
      );
      if (!item) throw new Error("这项安排已变化。");
      item.done = command.done;
      findTask(state, command.taskId).version++;
      break;
    }
    case "move": {
      const indexes = state.arrangements.flatMap((item, index) =>
        item.date === command.date ? [index] : [],
      );
      const position = indexes.findIndex(
        (index) => state.arrangements[index].taskId === command.taskId,
      );
      const other = position + (command.direction === "up" ? -1 : 1);
      if (position >= 0 && other >= 0 && other < indexes.length) {
        const a = indexes[position],
          b = indexes[other];
        [state.arrangements[a], state.arrangements[b]] = [
          state.arrangements[b],
          state.arrangements[a],
        ];
        findTask(state, command.taskId).version++;
        findTask(state, state.arrangements[a].taskId).version++;
      }
      break;
    }
    case "proposal": {
      addProposal(state, command.proposal);
      break;
    }
    case "resolve": {
      const proposal = state.proposals.find(
        (item) => item.id === command.proposalId,
      );
      if (!proposal) throw new Error("找不到这份方案。");
      const changes = [...new Set(command.ids)]
        .map((id) => {
          const change = proposal.changes.find((item) => item.id === id);
          if (!change) throw new Error("接受范围无效。");
          return change;
        })
        .filter((change) => change.status === "pending");
      if (command.accept) {
        for (const change of changes) {
          if (findTask(state, change.taskId).version !== change.taskVersion)
            throw new Error("任务已变化，这部分方案需要重新分析。");
          if (
            change.fromTaskId &&
            findTask(state, change.fromTaskId).version !==
              change.fromTaskVersion
          )
            throw new Error("原安排所属任务已变化，这部分方案需要重新分析。");
        }
      }
      for (const change of changes) {
        change.status = command.accept ? "accepted" : "rejected";
        if (!command.accept) continue;
        if (change.type === "schedule") {
          // 同批较早的变更也可能已移除源安排，实际替换前再次检查，失败整批回滚。
          if (
            change.fromTaskId &&
            !state.arrangements.some(
              (item) =>
                item.taskId === change.fromTaskId &&
                item.date === (change.fromDate ?? change.date),
            )
          )
            throw new Error("原安排已不存在，请重新分析替换范围。");
          if (
            change.fromTaskId &&
            (change.fromTaskId !== change.taskId ||
              (change.fromDate ?? change.date) !== change.date)
          ) {
            const updated = applyCommand(state, {
              type: "unschedule",
              taskId: change.fromTaskId,
              date: change.fromDate ?? change.date,
            });
            state.tasks = updated.tasks;
            state.arrangements = updated.arrangements;
          } else if (change.fromDate && change.fromDate !== change.date)
            state.arrangements = state.arrangements.filter(
              (item) =>
                item.taskId !== change.taskId || item.date !== change.fromDate,
            );
          schedule(state, change.taskId, change.date, change.scope);
        } else if (change.type === "update") {
          if (!change.patch) throw new Error("任务修改内容缺失。");
          const task = findTask(state, change.taskId);
          Object.assign(task, change.patch, {
            version: task.version + 1,
            updatedAt: now,
          });
          checkDates(task);
          checkRelations(state.tasks);
        } else if (change.type === "unschedule") {
          const updated = applyCommand(state, {
            type: "unschedule",
            taskId: change.taskId,
            date: change.date,
          });
          state.tasks = updated.tasks;
          state.arrangements = updated.arrangements;
        } else if (change.type === "stage") {
          if (change.done === undefined) throw new Error("阶段完成状态缺失。");
          const updated = applyCommand(state, {
            type: "stage",
            taskId: change.taskId,
            date: change.date,
            done: change.done,
          });
          state.tasks = updated.tasks;
          state.arrangements = updated.arrangements;
        } else {
          const parent = findTask(state, change.taskId);
          for (const child of change.children) {
            const task = {
              ...newTask(parent.id),
              ...child,
              version: 1,
              updatedAt: now,
            };
            checkDates(task);
            state.tasks.push(task);
          }
          parent.version++;
        }
      }
      // Sibling changes in this proposal stay applicable after an accepted part.
      const affectedTasks = new Set(
        changes
          .filter((change) => change.status === "accepted")
          .flatMap((change) => [
            change.taskId,
            ...(change.fromTaskId ? [change.fromTaskId] : []),
          ]),
      );
      for (const change of proposal.changes) {
        if (change.status !== "pending") continue;
        if (affectedTasks.has(change.taskId))
          change.taskVersion = findTask(state, change.taskId).version;
        if (change.fromTaskId && affectedTasks.has(change.fromTaskId))
          change.fromTaskVersion = findTask(state, change.fromTaskId).version;
      }
      break;
    }
    case "energy":
      state.energy = {
        value: command.value,
        source: "用户设置",
        updatedAt: now,
      };
      break;
    case "settings":
      state.preferences = command.preferences;
      state.theme = command.theme;
      break;
    case "reply":
    case "message": {
      if (!state.sessions.some((item) => item.id === command.message.sessionId))
        throw new Error("对话不存在。");
      if (command.type === "reply" && command.proposal) {
        if (
          command.message.role !== "assistant" ||
          command.proposal.sessionId !== command.message.sessionId ||
          command.message.proposalId !== command.proposal.id
        )
          throw new Error("回复与方案关联无效。");
        addProposal(state, command.proposal);
      }
      state.messages.push(command.message);
      const session = state.sessions.find(
        (item) => item.id === command.message.sessionId,
      )!;
      if (command.message.role === "user") {
        session.draft = "";
        if (session.title === "新的对话")
          session.title = command.message.text.slice(0, 18);
      }
      break;
    }
    case "draft": {
      const session = state.sessions.find(
        (item) => item.id === command.sessionId,
      );
      if (session) session.draft = command.text;
      break;
    }
    case "session": {
      if (!state.sessions.some((item) => item.id === command.id))
        state.sessions.push({ id: command.id, title: "新的对话", draft: "" });
      state.activeSessionId = command.id;
      break;
    }
  }
  state.revision++;
  return stateSchema.parse(state);
}
