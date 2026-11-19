import { DatabaseSync } from "node:sqlite";
import {
  emptyState,
  stateSchema,
  type Command,
  type State,
} from "../shared/model";
import { applyCommand } from "../shared/operations";
import { applyAgentTurn } from "../shared/agent";
import { conversationLimit, trimConversations } from "../shared/conversations";
import { migrateWorkspaceV1 } from "./migrations";

export class WorkspaceDatabase {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try {
      const version = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (version.user_version > 2)
        throw new Error("数据库来自更新版本，请使用相应版本的息序打开。");
      this.db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL);",
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db
          .prepare("SELECT payload FROM workspace WHERE id=1")
          .get() as { payload: string } | undefined;
        if (row && version.user_version < 2) {
          const migrated = migrateWorkspaceV1(row.payload);
          this.db
            .prepare("UPDATE workspace SET revision=?, payload=? WHERE id=1")
            .run(migrated.revision, JSON.stringify(migrated));
        }
        this.db.exec("PRAGMA user_version=2; COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
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
  load(): State {
    const row = this.db
      .prepare("SELECT payload FROM workspace WHERE id=1")
      .get() as { payload: string };
    return stateSchema.parse(JSON.parse(row.payload));
  }
  execute(revision: number, command: Command) {
    return this.transact(revision, (previous) =>
      applyCommand(previous, command),
    );
  }
  commitAgentTurn(
    revision: number,
    sessionId: string,
    userText: string,
    turn: unknown,
    replyId?: string,
  ) {
    return this.transact(revision, (previous) =>
      applyAgentTurn(previous, sessionId, userText, turn, replyId),
    );
  }
  private transact(revision: number, transform: (previous: State) => State) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.load();
      if (previous.revision !== revision)
        throw new Error("数据已更新，请重试这项操作。");
      const next = transform(previous);
      this.db
        .prepare("UPDATE workspace SET revision=?, payload=? WHERE id=1")
        .run(next.revision, JSON.stringify(next));
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
