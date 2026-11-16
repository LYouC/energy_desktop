import { localDate, type State } from './model'

export function buildContext(state: State, sessionId: string, date = localDate()) {
  const active = state.tasks.filter(task => !['done', 'abandoned'].includes(task.status))
  return {
    date, energy: state.energy, preferences: state.preferences,
    today: state.arrangements.filter(item => item.date === date),
    unfinishedTasks: active.map(task => ({ ...task,
      previousArrangements: state.arrangements.filter(item => item.taskId === task.id && item.date < date),
    })),
    recentMessages: state.messages.filter(message => message.sessionId === sessionId).slice(-12),
    pendingProposals: state.proposals.filter(proposal => proposal.changes.some(change => change.status === 'pending')),
  }
}
