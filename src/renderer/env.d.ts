/// <reference types="vite/client" />
interface Window {
  desktop: {
    ping(): Promise<string>;
    isWindowMaximized(): Promise<boolean>;
    controlWindow(action: "minimize" | "toggleMaximize" | "close"): void;
    onWindowMaximized(callback: (maximized: boolean) => void): () => void;
    load(): Promise<import("../domain/model").State>;
    execute(
      revision: number,
      command: import("../domain/model").Command,
    ): Promise<import("../domain/model").State>;
    agentConfig(): Promise<{
      baseURL: string;
      model: string;
      hasKey: boolean;
      contextDebug: boolean;
    }>;
    agentContext(
      sessionId: string,
    ): Promise<import("../desktop/agent-context").AgentContextTurn[]>;
    configureAgent(input: {
      baseURL: string;
      model: string;
      apiKey?: string;
    }): Promise<{ baseURL: string; model: string; hasKey: boolean }>;
    sendAgent(input: {
      runId: string;
      sessionId: string;
      text: string;
      focusedId: string | null;
      source?: "optimizeToday";
    }): Promise<import("../domain/model").State>;
    cancelAgent(runId: string): Promise<void>;
    onAgentEvent(
      callback: (event: {
        runId: string;
        type: "text" | "status" | "retry";
        text: string;
      }) => void,
    ): () => void;
  };
}
