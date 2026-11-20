/// <reference types="vite/client" />
interface Window {
  desktop: {
    ping(): Promise<string>;
    load(): Promise<import("../domain/model").State>;
    execute(
      revision: number,
      command: import("../domain/model").Command,
    ): Promise<import("../domain/model").State>;
    agentConfig(): Promise<{ baseURL: string; model: string; hasKey: boolean }>;
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
