import { newSession, type State } from "./model";

export const conversationLimit = 1000;

export function conversationHistory(state: State) {
  const lastMessageAt = new Map<string, string>();
  for (const { sessionId, createdAt } of state.messages) {
    if (createdAt > (lastMessageAt.get(sessionId) ?? ""))
      lastMessageAt.set(sessionId, createdAt);
  }
  return [...state.sessions]
    .reverse()
    .map((session) => ({
      session,
      lastActivity: lastMessageAt.get(session.id) ?? session.createdAt,
    }))
    .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
}

function removeConversations(state: State, ids: Set<string>) {
  state.sessions = state.sessions.filter((session) => !ids.has(session.id));
  state.messages = state.messages.filter(
    (message) => !ids.has(message.sessionId),
  );
  state.proposals = state.proposals.filter(
    (proposal) => !ids.has(proposal.sessionId),
  );
}

export function trimConversations(state: State) {
  if (state.sessions.length <= conversationLimit) return;
  const excess = conversationHistory(state)
    .filter(({ session }) => session.id !== state.activeSessionId)
    .slice(conversationLimit - 1);
  removeConversations(state, new Set(excess.map(({ session }) => session.id)));
}

export function deleteConversation(state: State, id: string) {
  if (!state.sessions.some((session) => session.id === id)) return;
  removeConversations(state, new Set([id]));
  if (state.activeSessionId !== id) return;
  const latest = conversationHistory(state)[0]?.session ?? newSession();
  if (!state.sessions.length) state.sessions.push(latest);
  state.activeSessionId = latest.id;
}
