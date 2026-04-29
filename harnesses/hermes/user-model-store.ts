import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// A tiny JSON-backed user model — a stand-in for Honcho's dialectic
// user modeling service. Real Honcho watches the conversation and
// derives a structured model; here, the model is whatever the agent
// itself writes to disk via `update_user_model`. Same shape, simpler
// implementation.

export interface UserModelEntry {
  readonly key: string;
  readonly value: string;
}

export interface UserModelStore {
  readonly read: () => Promise<UserModelEntry[]>;
  readonly upsert: (entry: UserModelEntry) => Promise<void>;
  readonly remove: (key: string) => Promise<boolean>;
}

export const fileUserModelStore = (path: string): UserModelStore => {
  const ensureDir = async () => {
    await mkdir(dirname(path), { recursive: true });
  };

  const load = async (): Promise<UserModelEntry[]> => {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is UserModelEntry =>
          e &&
          typeof e === "object" &&
          typeof (e as UserModelEntry).key === "string" &&
          typeof (e as UserModelEntry).value === "string",
      );
    } catch {
      return [];
    }
  };

  const save = async (entries: UserModelEntry[]): Promise<void> => {
    await ensureDir();
    await writeFile(path, JSON.stringify(entries, null, 2));
  };

  return {
    read: load,
    async upsert(entry) {
      const current = await load();
      const next = current.filter((e) => e.key !== entry.key);
      next.push(entry);
      next.sort((a, b) => a.key.localeCompare(b.key));
      await save(next);
    },
    async remove(key) {
      const current = await load();
      const next = current.filter((e) => e.key !== key);
      if (next.length === current.length) return false;
      await save(next);
      return true;
    },
  };
};
