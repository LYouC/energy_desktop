/// <reference types="vite/client" />
interface Window {
  desktop: {
    ping(): Promise<string>;
    load(): Promise<import("../shared/model").State>;
    execute(
      revision: number,
      command: import("../shared/model").Command,
    ): Promise<import("../shared/model").State>;
  };
}
