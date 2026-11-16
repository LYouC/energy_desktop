/// <reference types="vite/client" />
interface Window {
  desktop: {
    ping(): Promise<string>;
    load(): Promise<import("../shared/model").State>;
    execute(
      revision: number,
      command: import("../shared/model").Command,
    ): Promise<import("../shared/model").State>;
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
    }): Promise<import("../shared/model").State>;
    cancelAgent(runId: string): Promise<void>;
    onAgentEvent(
      callback: (event: {
        runId: string;
        type: "text" | "status";
        text: string;
      }) => void,
    ): () => void;
  };
}
