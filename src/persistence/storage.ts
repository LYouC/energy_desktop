import { DatabaseSync } from "node:sqlite";
import {
  emptyState,
  localDate,
  stateSchema,
  type Command,
  type State,
} from "../domain/model";
import { applyCommand } from "../domain/operations";
import { synchronizeRecurrence } from "../domain/recurrence";
import { applyAgentTurn } from "../agent/turn";

const workspaceVersion = 10;

export class WorkspaceDatabase {
  private db: DatabaseSync;
  constructor(
    filename: string,
    private today = localDate,
    { resetOnFormatMismatch = false } = {},
  ) {
    this.db = new DatabaseSync(filename);
    try {
      this.inTransaction(() => {
        const { user_version: version } = this.db
          .prepare("PRAGMA user_version")
          .get() as {
          user_version: number;
        };
        if (version === workspaceVersion) return;
        const existingWorkspace =
          version === 0 &&
          this.db
            .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workspace'")
            .get();
        if (version !== 0 || existingWorkspace) {
          if (!resetOnFormatMismatch)
            throw new Error(
              "工作区格式与当前版本不一致。请关闭应用，移走 workspace.db 及同名的 -wal、-shm 文件（如存在），再启动以创建新工作区。",
            );
          this.db.exec("DROP TABLE IF EXISTS workspace");
        }
        this.db.exec(
          "CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);",
        );
        this.db
          .prepare("INSERT INTO workspace (id, payload) VALUES (1, ?)")
          .run(JSON.stringify(emptyState()));
        this.db.exec(`PRAGMA user_version=${workspaceVersion}`);
      });
      this.db.exec("PRAGMA journal_mode=WAL");
      this.load();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  currentDate() {
    return this.today();
  }
  load(): State {
    return this.loadForDate(this.today());
  }
  private loadForDate(date: string): State {
    const snapshot = this.readSnapshot();
    if (!synchronizeRecurrence(snapshot, date)) return snapshot;
    return this.inTransaction(() => {
      const current = this.readSnapshot();
      if (synchronizeRecurrence(current, date)) {
        current.revision++;
        this.writeSnapshot(current);
      }
      return current;
    });
  }
  private readSnapshot(): State {
    const row = this.db
      .prepare("SELECT payload FROM workspace WHERE id=1")
      .get() as { payload: string };
    return stateSchema.parse(JSON.parse(row.payload));
  }
  execute(revision: number, command: Command) {
    // 卡片按 ID 和自身的任务版本校验，允许处理期间其他数据或日期已刷新。
    return this.transact(
      command.type === "respondToCard" ? undefined : revision,
      (previous, date) => applyCommand(previous, command, date),
    );
  }
  commitAgentTurn(
    revision: number,
    sessionId: string,
    userText: string,
    turn: unknown,
    replyId?: string,
    expectedDate?: string,
  ) {
    return this.transact(revision, (previous, date) => {
      if (expectedDate && date !== expectedDate)
        throw new Error("分析期间本地日期已变化，请重新发送。");
      return applyAgentTurn(previous, sessionId, userText, turn, replyId, date);
    });
  }
  private transact(
    revision: number | undefined,
    transform: (previous: State, date: string) => State,
  ) {
    const date = this.today();
    const result = this.inTransaction(() => {
      const previous = this.readSnapshot();
      if (synchronizeRecurrence(previous, date)) {
        previous.revision++;
        this.writeSnapshot(previous);
      }
      if (revision !== undefined && previous.revision !== revision) return null;
      const next = transform(previous, date);
      this.writeSnapshot(next);
      return next;
    });
    if (!result) throw new Error("数据已更新，请重试这项操作。");
    return result;
  }
  private writeSnapshot(state: State) {
    this.db
      .prepare("UPDATE workspace SET payload=? WHERE id=1")
      .run(JSON.stringify(state));
  }
  private inTransaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
