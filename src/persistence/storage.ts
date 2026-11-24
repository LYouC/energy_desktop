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
import { conversationLimit, trimConversations } from "../domain/conversations";
import { migrateWorkspaceProposals, migrateWorkspaceV1 } from "./migrations";

const workspaceVersion = 5;

export class WorkspaceDatabase {
  private db: DatabaseSync;
  constructor(
    filename: string,
    private today = localDate,
  ) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA journal_mode=WAL");
      this.inTransaction(() => {
        const { user_version: version } = this.db
          .prepare("PRAGMA user_version")
          .get() as {
          user_version: number;
        };
        if (version > workspaceVersion)
          throw new Error("数据库来自更新版本，请使用相应版本的息序打开。");
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL);",
        );
        const row = this.db
          .prepare("SELECT payload FROM workspace WHERE id=1")
          .get() as { payload: string } | undefined;
        if (row && version < 2) {
          const migrated = migrateWorkspaceV1(row.payload);
          this.writeSnapshot(migrated);
        } else if (row && version < workspaceVersion) {
          this.writeSnapshot(migrateWorkspaceProposals(row.payload));
        }
        this.db.exec(`PRAGMA user_version=${workspaceVersion}`);
      });
      const initial = emptyState();
      this.db
        .prepare(
          "INSERT OR IGNORE INTO workspace (id, revision, payload) VALUES (1, ?, ?)",
        )
        .run(initial.revision, JSON.stringify(initial));
      const state = this.load();
      if (state.sessions.length > conversationLimit)
        this.transact(state.revision, (previous) => {
          trimConversations(previous);
          previous.revision++;
          return previous;
        });
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
    return this.transact(revision, (previous, date) =>
      applyCommand(previous, command, date),
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
    revision: number,
    transform: (previous: State, date: string) => State,
  ) {
    const date = this.today();
    const result = this.inTransaction(() => {
      const previous = this.readSnapshot();
      if (synchronizeRecurrence(previous, date)) {
        previous.revision++;
        this.writeSnapshot(previous);
      }
      if (previous.revision !== revision) return null;
      const next = transform(previous, date);
      this.writeSnapshot(next);
      return next;
    });
    if (!result) throw new Error("数据已更新，请重试这项操作。");
    return result;
  }
  private writeSnapshot(state: State) {
    this.db
      .prepare("UPDATE workspace SET revision=?, payload=? WHERE id=1")
      .run(state.revision, JSON.stringify(state));
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
