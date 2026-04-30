import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// File-backed session archive. Mirrors the contract Hermes's
// session_search_tool.py expects from its SQLite-FTS5 store: list
// recent sessions, search messages by query (with optional role
// filter), and fetch a session's full message list.
//
// The implementation is naive — JSON file per session, in-memory scan
// for search. Adequate for a single-user CLI agent; a production
// Hermes-scale store would back this with SQLite + FTS5.

export interface SessionMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string;
  readonly messages: ReadonlyArray<SessionMessage>;
}

export interface SessionMatch {
  readonly session: SessionRecord;
  readonly score: number;
  readonly excerpt: string;
}

export interface SessionStore {
  readonly addSession: (session: SessionRecord) => Promise<void>;
  readonly listRecent: (limit: number) => Promise<SessionRecord[]>;
  readonly search: (
    query: string,
    opts?: { limit?: number; roles?: ReadonlyArray<string> },
  ) => Promise<SessionMatch[]>;
}

const SESSION_EXT = ".json";
const EXCERPT_RADIUS = 120;

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

const scoreMessage = (
  text: string,
  terms: ReadonlyArray<string>,
): { score: number; firstHit: number } => {
  if (terms.length === 0) return { score: 0, firstHit: -1 };
  const lower = text.toLowerCase();
  let score = 0;
  let firstHit = -1;
  for (const term of terms) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(term, from);
      if (idx < 0) break;
      score += 1;
      if (firstHit < 0) firstHit = idx;
      from = idx + term.length;
    }
  }
  return { score, firstHit };
};

const buildExcerpt = (text: string, hitAt: number): string => {
  const start = Math.max(0, hitAt - EXCERPT_RADIUS);
  const end = Math.min(text.length, hitAt + EXCERPT_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};

export const fileSystemSessionStore = (root: string): SessionStore => {
  const ensureRoot = async () => {
    await mkdir(root, { recursive: true });
  };

  const pathFor = (id: string) => join(root, `${id}${SESSION_EXT}`);

  const readAll = async (): Promise<SessionRecord[]> => {
    await ensureRoot();
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(SESSION_EXT)) continue;
      try {
        const raw = await readFile(join(root, name), "utf8");
        const parsed = JSON.parse(raw) as SessionRecord;
        if (
          parsed &&
          typeof parsed.id === "string" &&
          Array.isArray(parsed.messages)
        ) {
          records.push(parsed);
        }
      } catch {
        // skip unreadable
      }
    }
    return records;
  };

  return {
    async addSession(session) {
      await ensureRoot();
      await writeFile(pathFor(session.id), JSON.stringify(session, null, 2));
    },

    async listRecent(limit) {
      const all = await readAll();
      all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      return all.slice(0, Math.max(0, limit));
    },

    async search(query, opts) {
      const limit = Math.max(1, Math.min(opts?.limit ?? 3, 10));
      const roles = opts?.roles ? new Set(opts.roles) : null;
      const terms = tokenize(query);
      if (terms.length === 0) return [];

      const all = await readAll();
      const scored: SessionMatch[] = [];
      for (const session of all) {
        let bestScore = 0;
        let bestExcerpt = "";
        for (const msg of session.messages) {
          if (roles && !roles.has(msg.role)) continue;
          const { score, firstHit } = scoreMessage(msg.content, terms);
          if (score > bestScore) {
            bestScore = score;
            bestExcerpt =
              firstHit >= 0 ? buildExcerpt(msg.content, firstHit) : "";
          }
        }
        if (bestScore > 0) {
          scored.push({ session, score: bestScore, excerpt: bestExcerpt });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },
  };
};
