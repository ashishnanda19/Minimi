import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

/** Callers that send no user id (curl, a test harness) share this one, which keeps the original single-user behaviour. */
export const DEFAULT_USER = "default";

export interface SourceRef {
  id: number;
  title: string;
  url: string;
  published?: string;
}

export interface StoredMessage {
  id: number;
  sessionId: string;
  role: Role;
  content: string;
  sources: SourceRef[];
  /** Result of checking the answer against its sources (see agent/verify.ts). Absent on user messages and old data. */
  verification?: unknown;
  createdAt: Date;
}

export interface NewMessage {
  role: Role;
  content: string;
  sources?: SourceRef[];
  verification?: unknown;
  createdAt: Date;
}

interface Row {
  id: number;
  session_id: string;
  role: Role;
  content: string;
  sources_json: string | null;
  verification_json: string | null;
  created_at: string;
}

const toMessage = (r: Row): StoredMessage => ({
  id: r.id,
  sessionId: r.session_id,
  role: r.role,
  content: r.content,
  sources: r.sources_json ? (JSON.parse(r.sources_json) as SourceRef[]) : [],
  verification: r.verification_json ? JSON.parse(r.verification_json) : undefined,
  createdAt: new Date(r.created_at),
});

export interface SessionInfo {
  id: string;
  title: string;
  updatedAt: Date;
}

/**
 * One SQLite file holds every conversation. Memory is shared across one user's chats, because
 * "what did I ask on 3 November?" is usually asked in a *new* chat, but never across users.
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
    this.migrate();
  }

  /** Additive migrations, so a database created by an earlier version keeps working. */
  private migrate(): void {
    const has = (table: string, column: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!has("sessions", "user_id")) this.db.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT '${DEFAULT_USER}'`);
    if (!has("sessions", "title")) this.db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT`);
    if (!has("messages", "verification_json")) this.db.exec(`ALTER TABLE messages ADD COLUMN verification_json TEXT`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);

    // Full-text index over message text (BM25 ranking, stemming), kept in sync by triggers.
    const hadFts = Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'`).get());
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
    `);
    if (!hadFts) this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
  }

  /** Creates the session if missing; a supplied tz always wins so the zone follows the user's device. The first user to touch a session owns it. */
  ensureSession(id: string, tz: string, now: Date, userId: string = DEFAULT_USER): { id: string; tz: string; userId: string } {
    this.db
      .prepare(
        `INSERT INTO sessions (id, tz, created_at, user_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET tz = excluded.tz`,
      )
      .run(id, tz, now.toISOString(), userId);
    return { id, tz, userId: this.sessionOwner(id) ?? userId };
  }

  sessionOwner(id: string): string | undefined {
    return (this.db.prepare(`SELECT user_id FROM sessions WHERE id = ?`).get(id) as { user_id: string } | undefined)?.user_id;
  }

  /** True when the session does not exist yet or belongs to this user. */
  canAccess(sessionId: string, userId: string): boolean {
    const owner = this.sessionOwner(sessionId);
    return owner === undefined || owner === userId;
  }

  sessionTz(id: string): string | undefined {
    return (this.db.prepare(`SELECT tz FROM sessions WHERE id = ?`).get(id) as { tz: string } | undefined)?.tz;
  }

  /** Atomic multi-message insert. Duplicates (same session, role, time, text) are ignored, which makes seeding idempotent. */
  addMessages(sessionId: string, messages: NewMessage[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO messages (session_id, role, content, sources_json, verification_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const m of messages) {
        insert.run(
          sessionId, m.role, m.content,
          m.sources?.length ? JSON.stringify(m.sources) : null,
          m.verification ? JSON.stringify(m.verification) : null,
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

  messageCount(sessionId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`).get(sessionId) as { n: number }).n;
  }

  /** Newest-first messages from this user's other sessions. The caller applies the token budget. */
  earlierMessages(excludeSessionId: string, limit: number, userId: string = DEFAULT_USER): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND m.session_id != ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      )
      .all(userId, excludeSessionId, limit) as Row[];
    return rows.map(toMessage);
  }

  /** Everything this user said or was told in [from, to), oldest first. Used to answer "what did I ask last week?" exactly. */
  messagesBetween(userId: string, from: Date, to: Date, limit = 300): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND m.created_at >= ? AND m.created_at < ? ORDER BY m.created_at, m.id LIMIT ?`,
      )
      .all(userId, from.toISOString(), to.toISOString(), limit) as Row[];
    return rows.map(toMessage);
  }

  /** Timestamps of this user's questions, newest first. The caller turns them into the days that have records. */
  userMessageTimes(userId: string, limit = 3000): Date[] {
    const rows = this.db
      .prepare(
        `SELECT m.created_at FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.user_id = ? AND m.role = 'user' ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as { created_at: string }[];
    return rows.map((r) => new Date(r.created_at));
  }

  /**
   * BM25-ranked full-text hits over this user's other chats. `match` must already be a safe FTS5 expression
   * (see agent/retrieval.ts). Each hit is returned with the message it answers or was answered by.
   */
  searchMessages(userId: string, match: string, excludeSessionId: string, limit = 20): { message: StoredMessage; rank: number }[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(messages_fts) AS rank
         FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? AND s.user_id = ? AND m.session_id != ?
         ORDER BY rank LIMIT ?`,
      )
      .all(match, userId, excludeSessionId, limit) as (Row & { rank: number })[];
    return rows.map((r) => ({ message: toMessage(r), rank: r.rank }));
  }

  /** How many of this user's messages contain `token`, and how many messages they have: a word in few of them is distinctive. */
  tokenFrequency(userId: string, token: string): { containing: number; total: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.user_id = ?`).get(userId) as { n: number }).n;
    const containing = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN sessions s ON s.id = m.session_id WHERE messages_fts MATCH ? AND s.user_id = ?`)
      .get(`"${token.replace(/"/g, '""')}"`, userId) as { n: number }).n;
    return { containing, total };
  }

  /** The other half of a turn: the answer to a question, or the question behind an answer. */
  pairedTurn(m: StoredMessage): StoredMessage | undefined {
    const row = (m.role === "user"
      ? this.db.prepare(
          `SELECT * FROM messages WHERE session_id = ? AND role = 'assistant' AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at, id LIMIT 1`)
      : this.db.prepare(
          `SELECT * FROM messages WHERE session_id = ? AND role = 'user' AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT 1`)
    ).get(m.sessionId, m.createdAt.toISOString(), m.createdAt.toISOString(), m.id) as Row | undefined;
    return row ? toMessage(row) : undefined;
  }

  /** Conversations for the sidebar, newest activity first. A generated title wins; the first question is the fallback. */
  listSessions(userId: string = DEFAULT_USER, limit = 200): SessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT s.id AS id, s.title AS title,
                (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.created_at, m.id LIMIT 1) AS first_question,
                (SELECT MAX(created_at) FROM messages m WHERE m.session_id = s.id) AS updated_at
         FROM sessions s
         WHERE s.user_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(userId, limit) as { id: string; title: string | null; first_question: string | null; updated_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      title: (r.title ?? r.first_question ?? "New chat").replace(/\s+/g, " ").trim().slice(0, 80) || "New chat",
      updatedAt: new Date(r.updated_at),
    }));
  }

  setTitle(id: string, title: string): void {
    this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
  }

  getTitle(id: string): string | undefined {
    return ((this.db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(id) as { title: string | null } | undefined)?.title) ?? undefined;
  }

  /** What the agent remembers, as the user sees it: their most recent distinct questions across their chats. */
  recentQuestions(userId: string = DEFAULT_USER, limit = 8): { sessionId: string; text: string; createdAt: Date }[] {
    const rows = this.db
      .prepare(
        `SELECT m.session_id, m.content, m.created_at FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE m.role = 'user' AND s.user_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      )
      .all(userId, limit * 4) as { session_id: string; content: string; created_at: string }[];
    const seen = new Set<string>();
    const out: { sessionId: string; text: string; createdAt: Date }[] = [];
    for (const r of rows) {
      const text = r.content.replace(/\s+/g, " ").trim();
      if (seen.has(text.toLowerCase())) continue; // the same question asked twice is one memory
      seen.add(text.toLowerCase());
      out.push({ sessionId: r.session_id, text: text.slice(0, 140), createdAt: new Date(r.created_at) });
      if (out.length === limit) break;
    }
    return out;
  }

  /** Removes one of this user's conversations and, with it, its place in what the agent remembers. */
  deleteSession(id: string, userId: string = DEFAULT_USER): boolean {
    return this.db.transaction(() => {
      if (!this.db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND user_id = ?`).get(id, userId)) return false;
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
    })();
  }

  /** Chats created before accounts existed (or by clients that send no user id) belong to the shared default user. */
  legacyCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE s.user_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`).get(DEFAULT_USER) as { n: number }).n;
  }

  /** Hands the shared default user's chats to `userId`. Returns how many conversations moved. */
  claimLegacy(userId: string): number {
    if (userId === DEFAULT_USER) return 0;
    return this.db.prepare(`UPDATE sessions SET user_id = ? WHERE user_id = ?`).run(userId, DEFAULT_USER).changes;
  }

  close(): void {
    this.db.close();
  }
}
