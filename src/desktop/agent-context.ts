export type AgentContextTurn = {
  runId: string;
  sessionId: string;
  sentAt: string;
  requests: string[];
};

const maxTurns = 20;

export class AgentContextHistory {
  private turns = new Map<string, AgentContextTurn>();

  forSession(sessionId: string) {
    return [...this.turns.values()]
      .reverse()
      .filter((turn) => turn.sessionId === sessionId);
  }

  recorder() {
    let captured: AgentContextTurn | undefined;
    return (
      { runId, sessionId }: { runId: string; sessionId: string },
      body: string,
    ) => {
      if (!captured) {
        captured = {
          runId,
          sessionId,
          sentAt: new Date().toISOString(),
          requests: [],
        };
        this.turns.delete(runId);
        this.turns.set(runId, captured);
        const oldest = this.turns.keys().next();
        if (this.turns.size > maxTurns && !oldest.done)
          this.turns.delete(oldest.value);
      }
      captured.requests.push(body);
    };
  }
}
