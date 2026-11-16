import { DatabaseSync } from 'node:sqlite'
import { emptyState, stateSchema, type Command, type State } from '../shared/model'
import { applyCommand } from '../shared/operations'

export class WorkspaceDatabase {
  private db: DatabaseSync
  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1;')
    const initial = emptyState()
    this.db.prepare('INSERT OR IGNORE INTO workspace (id, revision, payload) VALUES (1, ?, ?)').run(initial.revision, JSON.stringify(initial))
    this.load()
  }
  load(): State {
    const row = this.db.prepare('SELECT payload FROM workspace WHERE id=1').get() as { payload: string }
    return stateSchema.parse(JSON.parse(row.payload))
  }
  execute(revision: number, command: Command) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.load()
      if (previous.revision !== revision) throw new Error('数据已更新，请重试这项操作。')
      const next = applyCommand(previous, command)
      this.db.prepare('UPDATE workspace SET revision=?, payload=? WHERE id=1').run(next.revision, JSON.stringify(next))
      this.db.exec('COMMIT')
      return next
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close() { this.db.close() }
}
