import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSnippet, parseQuery } from "./query.ts";
import type { NormalizedConversation, Role, SourceId } from "./types.ts";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  url TEXT,
  active_leaf_source_id TEXT,
  raw TEXT,
  imported_at INTEGER NOT NULL,
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  parent_source_id TEXT,
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER,
  model TEXT,
  UNIQUE (conversation_id, source_id)
);

CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
`;

const FTS_SCHEMA = `
-- Trigram tokenization lets substring search work for languages written
-- without spaces (Chinese, Japanese), which word tokenizers can't split.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

const FTS_TRIGGERS = ["messages_fts_insert", "messages_fts_delete", "messages_fts_update"];

export type UpsertStatus = "added" | "updated" | "unchanged";

export interface ImportStats {
  conversationsAdded: number;
  conversationsUpdated: number;
  conversationsUnchanged: number;
  messagesAdded: number;
}

export interface SearchOptions {
  source?: SourceId;
  /** Maximum number of conversations to return. Defaults to 20. */
  limit?: number;
}

export interface SearchHit {
  conversationId: number;
  source: SourceId;
  title: string;
  url: string | null;
  messageId: number;
  role: Role;
  createdAt: number | null;
  snippet: string;
  /** Terms from the query, for highlighting the snippet. */
  terms: string[];
}

export interface StoredMessage {
  id: number;
  sourceId: string;
  parentSourceId: string | null;
  role: Role;
  content: string;
  createdAt: number | null;
  model: string | null;
}

export interface StoredConversation {
  id: number;
  source: SourceId;
  sourceId: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  url: string | null;
  /** Messages on the active branch, oldest first. */
  messages: StoredMessage[];
}

export interface SourceStats {
  source: SourceId;
  conversations: number;
  messages: number;
}

type Row = Record<string, unknown>;

export interface StoreOptions {
  /**
   * Use the FTS5 full-text index. Defaults to whether this SQLite build has
   * FTS5 with the trigram tokenizer; some Node builds (e.g. Homebrew's, linked
   * against a system SQLite) don't. Without it, search falls back to LIKE scans.
   */
  fullTextSearch?: boolean;
}

export class Store {
  readonly #db: DatabaseSync;
  /** Whether search can use the messages_fts index. */
  readonly fullTextSearch: boolean;

  constructor(path: string, options: StoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
    this.fullTextSearch = options.fullTextSearch ?? this.#supportsTrigramFts();
    this.#syncFtsIndex();
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.#db.close();
  }

  /** Imports conversations in a single transaction; safe to re-run on the same export. */
  importAll(conversations: Iterable<NormalizedConversation>): ImportStats {
    const stats: ImportStats = {
      conversationsAdded: 0,
      conversationsUpdated: 0,
      conversationsUnchanged: 0,
      messagesAdded: 0,
    };
    this.#transaction(() => {
      for (const conversation of conversations) {
        const { status, messagesAdded } = this.#upsert(conversation);
        if (status === "added") stats.conversationsAdded++;
        else if (status === "updated") stats.conversationsUpdated++;
        else stats.conversationsUnchanged++;
        stats.messagesAdded += messagesAdded;
      }
    });
    return stats;
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const parsed = parseQuery(query);
    const { terms } = parsed;
    if (terms.length === 0) return [];
    const ftsTerms = this.fullTextSearch ? parsed.ftsTerms : [];
    const likeTerms = this.fullTextSearch ? parsed.likeTerms : terms;
    const limit = options.limit ?? 20;

    const params: (string | number)[] = [];
    let sql: string;
    if (ftsTerms.length > 0) {
      sql = `SELECT m.*, c.source, c.title, c.url
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?`;
      params.push(ftsTerms.join(" AND "));
    } else {
      sql = `SELECT m.*, c.source, c.title, c.url
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE 1`;
    }
    for (const term of likeTerms) {
      sql += ` AND m.content LIKE ? ESCAPE '\\'`;
      params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (options.source) {
      sql += " AND c.source = ?";
      params.push(options.source);
    }
    sql += ftsTerms.length > 0 ? " ORDER BY messages_fts.rank" : " ORDER BY m.created_at DESC";

    // Report each conversation once, using its best-ranked message.
    const hits: SearchHit[] = [];
    const seen = new Set<number>();
    for (const row of this.#db.prepare(sql).iterate(...params) as Iterable<Row>) {
      const conversationId = row.conversation_id as number;
      if (seen.has(conversationId)) continue;
      seen.add(conversationId);
      hits.push({
        conversationId,
        source: row.source as string,
        title: row.title as string,
        url: row.url as string | null,
        messageId: row.id as number,
        role: row.role as Role,
        createdAt: row.created_at as number | null,
        snippet: buildSnippet(row.content as string, terms),
        terms,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  getConversation(id: number): StoredConversation | undefined {
    const row = this.#db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const all = (
      this.#db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY position").all(id) as Row[]
    ).map(toStoredMessage);

    return {
      id,
      source: row.source as string,
      sourceId: row.source_id as string,
      title: row.title as string,
      createdAt: row.created_at as number | null,
      updatedAt: row.updated_at as number | null,
      url: row.url as string | null,
      messages: activeBranch(all, row.active_leaf_source_id as string | null),
    };
  }

  stats(): SourceStats[] {
    return this.#db
      .prepare(
        `SELECT c.source,
           COUNT(DISTINCT c.id) AS conversations,
           COUNT(m.id) AS messages
         FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.source ORDER BY c.source`,
      )
      .all()
      .map((row) => ({
        source: row.source as string,
        conversations: row.conversations as number,
        messages: row.messages as number,
      }));
  }

  #upsert(conversation: NormalizedConversation): { status: UpsertStatus; messagesAdded: number } {
    const existing = this.#db
      .prepare("SELECT id, updated_at FROM conversations WHERE source = ? AND source_id = ?")
      .get(conversation.source, conversation.sourceId) as Row | undefined;

    const { id } = this.#db
      .prepare(
        `INSERT INTO conversations
           (source, source_id, title, created_at, updated_at, url, active_leaf_source_id, raw, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, source_id) DO UPDATE SET
           title = excluded.title,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           url = excluded.url,
           active_leaf_source_id = excluded.active_leaf_source_id,
           raw = excluded.raw,
           imported_at = excluded.imported_at
         RETURNING id`,
      )
      .get(
        conversation.source,
        conversation.sourceId,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt,
        conversation.url,
        conversation.activeLeafSourceId,
        JSON.stringify(conversation.raw),
        Date.now(),
      ) as { id: number };

    const insertMessage = this.#db.prepare(
      `INSERT INTO messages
         (conversation_id, source_id, parent_source_id, position, role, content, created_at, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, source_id) DO UPDATE SET
         parent_source_id = excluded.parent_source_id,
         position = excluded.position,
         role = excluded.role,
         content = excluded.content,
         created_at = excluded.created_at,
         model = excluded.model
       WHERE content IS NOT excluded.content
          OR position IS NOT excluded.position
          OR parent_source_id IS NOT excluded.parent_source_id`,
    );
    const known = new Set(
      (this.#db.prepare("SELECT source_id FROM messages WHERE conversation_id = ?").all(id) as Row[]).map(
        (row) => row.source_id as string,
      ),
    );

    let messagesAdded = 0;
    let messagesChanged = 0;
    conversation.messages.forEach((message, position) => {
      const { changes } = insertMessage.run(
        id,
        message.sourceId,
        message.parentSourceId,
        position,
        message.role,
        message.content,
        message.createdAt,
        message.model,
      );
      if (!known.has(message.sourceId)) messagesAdded++;
      else if (changes > 0) messagesChanged++;
    });

    let status: UpsertStatus = "added";
    if (existing) {
      const touched =
        messagesAdded > 0 || messagesChanged > 0 || existing.updated_at !== conversation.updatedAt;
      status = touched ? "updated" : "unchanged";
    }
    return { status, messagesAdded };
  }

  #supportsTrigramFts(): boolean {
    try {
      this.#db.exec("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x, tokenize = 'trigram'); DROP TABLE temp.fts_probe;");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates or removes the FTS index and its triggers to match
   * `fullTextSearch`. The same database may be opened by Node builds with and
   * without FTS5, so the index is rebuilt whenever its triggers were missing.
   */
  #syncFtsIndex(): void {
    const placeholders = FTS_TRIGGERS.map(() => "?").join(", ");
    const { count } = this.#db
      .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders})`)
      .get(...FTS_TRIGGERS) as { count: number };

    if (!this.fullTextSearch) {
      // Leftover triggers would make every insert fail without the fts5 module.
      for (const name of FTS_TRIGGERS) this.#db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      return;
    }
    this.#db.exec(FTS_SCHEMA);
    if (count < FTS_TRIGGERS.length) {
      this.#db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    }
  }

  #transaction(fn: () => void): void {
    this.#db.exec("BEGIN");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toStoredMessage(row: Row): StoredMessage {
  return {
    id: row.id as number,
    sourceId: row.source_id as string,
    parentSourceId: row.parent_source_id as string | null,
    role: row.role as Role,
    content: row.content as string,
    createdAt: row.created_at as number | null,
    model: row.model as string | null,
  };
}

/** Walks from the active leaf up to the root; falls back to all messages for linear chats. */
function activeBranch(messages: StoredMessage[], leafSourceId: string | null): StoredMessage[] {
  if (!leafSourceId) return messages;
  const bySourceId = new Map(messages.map((m) => [m.sourceId, m]));
  const branch: StoredMessage[] = [];
  let current = bySourceId.get(leafSourceId);
  while (current && branch.length <= messages.length) {
    branch.push(current);
    current = current.parentSourceId ? bySourceId.get(current.parentSourceId) : undefined;
  }
  return branch.length > 0 ? branch.reverse() : messages;
}
