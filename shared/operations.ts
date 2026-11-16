import { commandSchema, stateSchema, type State, type Task, type Command } from './model'

function findTask(state: State, id: string) {
  const task = state.tasks.find(item => item.id === id)
  if (!task) throw new Error('任务已被删除，请刷新后重试。')
  return task
}
function checkRelations(tasks: Task[]) {
  for (const task of tasks) {
    const visit = (id: string, path: Set<string>, kind: 'parent' | 'dependency') => {
      if (path.has(id)) throw new Error('父子关系或依赖形成了循环。')
      const current = tasks.find(item => item.id === id)
      if (!current) throw new Error('关联任务不存在。')
      const next = kind === 'parent' ? (current.parentId ? [current.parentId] : []) : current.dependencies
      for (const target of next) visit(target, new Set([...path, id]), kind)
    }
    visit(task.id, new Set(), 'parent')
    visit(task.id, new Set(), 'dependency')
  }
}
function schedule(state: State, taskId: string, date: string, scope: string) {
  const task = findTask(state, taskId)
  if (['done', 'abandoned'].includes(task.status)) throw new Error('请先恢复任务，再安排推进。')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('请选择有效的安排日期。')
  const existing = state.arrangements.find(item => item.taskId === taskId && item.date === date)
  if (existing) { existing.scope = scope; existing.done = false }
  else state.arrangements.push({ taskId, date, scope, done: false })
  task.plannedDate = date
  task.version++
}
export function applyCommand(previous: State, input: Command): State {
  const command = commandSchema.parse(input)
  const state: State = structuredClone(previous)
  const now = new Date().toISOString()
  switch (command.type) {
    case 'saveTask': {
      const old = state.tasks.find(task => task.id === command.task.id)
      if (old && old.version !== command.task.version) throw new Error('任务已更新，请重新打开详情。')
      const task = { ...command.task, version: (old?.version ?? 0) + 1, updatedAt: now }
      if (old) state.tasks[state.tasks.indexOf(old)] = task
      else state.tasks.push(task)
      checkRelations(state.tasks)
      break
    }
    case 'deleteTask': {
      findTask(state, command.id)
      const ids = new Set([command.id])
      for (let pass = 0; pass < state.tasks.length; pass++) {
        for (const task of state.tasks) if (task.parentId && ids.has(task.parentId)) ids.add(task.id)
      }
      state.tasks = state.tasks.filter(task => !ids.has(task.id))
      for (const task of state.tasks) {
        if (task.dependencies.some(id => ids.has(id))) { task.dependencies = task.dependencies.filter(id => !ids.has(id)); task.version++ }
      }
      state.arrangements = state.arrangements.filter(item => !ids.has(item.taskId))
      for (const proposal of state.proposals) for (const change of proposal.changes) {
        if (ids.has(change.taskId) && change.status === 'pending') change.status = 'rejected'
      }
      break
    }
    case 'schedule': schedule(state, command.taskId, command.date, command.scope); break
    case 'unschedule': {
      state.arrangements = state.arrangements.filter(item => item.taskId !== command.taskId || item.date !== command.date)
      const task = findTask(state, command.taskId)
      task.plannedDate = state.arrangements.filter(item => item.taskId === task.id).at(-1)?.date ?? ''
      task.version++
      break
    }
    case 'stage': {
      const item = state.arrangements.find(item => item.taskId === command.taskId && item.date === command.date)
      if (!item) throw new Error('这项安排已变化。')
      item.done = command.done
      findTask(state, command.taskId).version++
      break
    }
    case 'move': {
      const indexes = state.arrangements.flatMap((item, index) => item.date === command.date ? [index] : [])
      const position = indexes.findIndex(index => state.arrangements[index].taskId === command.taskId)
      const other = position + (command.direction === 'up' ? -1 : 1)
      if (position >= 0 && other >= 0 && other < indexes.length) {
        const a = indexes[position], b = indexes[other]
        ;[state.arrangements[a], state.arrangements[b]] = [state.arrangements[b], state.arrangements[a]]
        findTask(state, command.taskId).version++
        findTask(state, state.arrangements[a].taskId).version++
      }
      break
    }
    case 'proposal': {
      if (state.proposals.some(item => item.id === command.proposal.id)) throw new Error('方案已经存在。')
      for (const change of command.proposal.changes) {
        if (change.status !== 'pending' || findTask(state, change.taskId).version !== change.taskVersion) throw new Error('任务已变化，请重新生成方案。')
      }
      state.proposals.push(command.proposal)
      break
    }
    case 'resolve': {
      const proposal = state.proposals.find(item => item.id === command.proposalId)
      if (!proposal) throw new Error('找不到这份方案。')
      const changes = command.ids.map(id => {
        const change = proposal.changes.find(item => item.id === id)
        if (!change) throw new Error('接受范围无效。')
        return change
      }).filter(change => change.status === 'pending')
      if (command.accept) {
        for (const change of changes) {
          if (findTask(state, change.taskId).version !== change.taskVersion) throw new Error('任务已变化，这部分方案需要重新分析。')
        }
      }
      for (const change of changes) {
        change.status = command.accept ? 'accepted' : 'rejected'
        if (!command.accept) continue
        if (change.type === 'schedule') schedule(state, change.taskId, change.date, change.scope)
        else {
          const parent = findTask(state, change.taskId)
          for (const child of change.children) {
            state.tasks.push({ ...parent, ...child, id: crypto.randomUUID(), parentId: parent.id, version: 1, status: 'todo', dependencies: [], progress: '', obstacle: '', background: '', nextStep: child.goal, plannedDate: '', updatedAt: now })
          }
          parent.version++
        }
      }
      // Sibling changes in this proposal stay applicable after an accepted part.
      for (const change of proposal.changes) if (change.status === 'pending' && changes.some(item => item.taskId === change.taskId)) {
        change.taskVersion = findTask(state, change.taskId).version
      }
      break
    }
    case 'energy': state.energy = { value: command.value, source: '用户设置', updatedAt: now }; break
    case 'settings': state.preferences = command.preferences; state.theme = command.theme; break
    case 'message': {
      if (!state.sessions.some(item => item.id === command.message.sessionId)) throw new Error('对话不存在。')
      state.messages.push(command.message)
      const session = state.sessions.find(item => item.id === command.message.sessionId)!
      if (command.message.role === 'user') { session.draft = ''; if (session.title === '新的对话') session.title = command.message.text.slice(0, 18) }
      break
    }
    case 'draft': {
      const session = state.sessions.find(item => item.id === command.sessionId)
      if (session) session.draft = command.text
      break
    }
    case 'session': {
      if (!state.sessions.some(item => item.id === command.id)) state.sessions.push({ id: command.id, title: '新的对话', draft: '' })
      state.activeSessionId = command.id
      break
    }
  }
  state.revision++
  return stateSchema.parse(state)
}
