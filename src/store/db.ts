import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

export interface SourceRef {
  id: number;
  title: string;
  url: string;
  published?: string;
}

export interface StoredMessage {
  sessionId: string;
  role: Role;
  content: string;
  sources: SourceRef[];
  createdAt: Date;
}

export interface NewMessage {
  role: Role;
  content: string;
  sources?: SourceRef[];
  createdAt: Date;
}

interface Row {
  session_id: string;
  role: Role;
  content: string;
  sources_json: string | null;
  created_at: string;
}

const toMessage = (r: Row): StoredMessage => ({
  sessionId: r.session_id,
  role: r.role,
  content: r.content,
  sources: r.sources_json ? (JSON.parse(r.sources_json) as SourceRef[]) : [],
  createdAt: new Date(r.created_at),
});

/**
 * One SQLite file holds every conversation. Memory is user-global on purpose:
 * "what did I ask on 3 November?" is usually asked in a *new* chat.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tz TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        sources_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, role, created_at, content)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    `);
  }

  /** Creates the session if missing; a supplied tz always wins so the zone follows the user's device. */
  ensureSession(id: string, tz: string, now: Date): { id: string; tz: string } {
    this.db
      .prepare(
        `INSERT INTO sessions (id, tz, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tz = excluded.tz`,
      )
      .run(id, tz, now.toISOString());
    return { id, tz };
  }

  sessionTz(id: string): string | undefined {
    return (this.db.prepare(`SELECT tz FROM sessions WHERE id = ?`).get(id) as { tz: string } | undefined)?.tz;
  }

  /** Atomic multi-message insert. Duplicates (same session, role, time, text) are ignored, which makes seeding idempotent. */
  addMessages(sessionId: string, messages: NewMessage[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO messages (session_id, role, content, sources_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const m of messages) {
        insert.run(
          sessionId, m.role, m.content,
          m.sources?.length ? JSON.stringify(m.sources) : null,
          m.createdAt.toISOString(),
        );
      }
    })();
  }

  sessionMessages(sessionId: string): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id`)
      .all(sessionId) as Row[];
    return rows.map(toMessage);
  }

  /** Newest-first messages from every other session. The caller applies the token budget. */
  earlierMessages(excludeSessionId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id != ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(excludeSessionId, limit) as Row[];
    return rows.map(toMessage);
  }

  close(): void {
    this.db.close();
  }
}
