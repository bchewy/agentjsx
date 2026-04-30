import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A filesystem-backed skill store. Each skill lives at
// `<root>/<slug>/SKILL.md` and starts with YAML frontmatter:
//
//   ---
//   name: "summarize-pr"
//   description: "Summarize a GitHub PR diff into a short changelog entry"
//   ---
//   <body>
//
// Hermes does the same thing — skills are directories on disk, the
// agent loads the body lazily via `load_skill`. Putting the store
// behind a small interface lets both the read-side ambient and the
// write-side `save_skill` tool share state without coupling extensions.

export const SKILL_STATES = ["active", "stale", "archived"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

export interface SkillUsage {
  readonly state: SkillState;
  readonly pinned: boolean;
  readonly viewCount: number;
  readonly useCount: number;
  readonly patchCount: number;
  readonly createdAt: string;
  readonly lastViewedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly lastPatchedAt: string | null;
  readonly archivedAt: string | null;
}

export interface SkillEntry {
  readonly handle: string;
  readonly name: string;
  readonly description: string;
  readonly usage: SkillUsage;
}

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

// Mirrors Hermes's skill_usage.py: counters bumped by view/use/patch,
// state transitions managed by a curator, archived skills relocated to
// `<root>/.archive/`. The shape is intentionally additive on top of
// the read/save/update minimum so existing extensions don't break.
export interface SkillStore {
  readonly list: (opts?: {
    readonly includeArchived?: boolean;
  }) => Promise<SkillEntry[]>;
  readonly read: (handle: string) => Promise<string | null>;
  readonly save: (draft: SkillDraft) => Promise<SkillEntry>;
  readonly update: (
    handle: string,
    draft: SkillDraft,
  ) => Promise<SkillEntry>;
  readonly bumpUse: (handle: string) => Promise<void>;
  readonly bumpView: (handle: string) => Promise<void>;
  readonly bumpPatch: (handle: string) => Promise<void>;
  readonly setPinned: (handle: string, pinned: boolean) => Promise<void>;
  readonly archive: (handle: string) => Promise<boolean>;
  readonly restore: (handle: string) => Promise<boolean>;
  readonly markStale: (handle: string) => Promise<void>;
  readonly markActive: (handle: string) => Promise<void>;
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "skill";

const escape = (value: string): string => value.replace(/"/g, '\\"');

const encode = (draft: SkillDraft): string =>
  `---\nname: "${escape(draft.name)}"\ndescription: "${escape(draft.description)}"\n---\n\n${draft.body.trimEnd()}\n`;

interface DecodedHeader {
  readonly handle: string;
  readonly name: string;
  readonly description: string;
}

const decode = (
  handle: string,
  raw: string,
): { header: DecodedHeader; body: string } | null => {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const front = match[1];
  const body = match[2].replace(/^\n/, "");
  const nameLine = front.match(/^name:\s*"?([^"\n]+)"?\s*$/m);
  const descLine = front.match(/^description:\s*"?([^"\n]+)"?\s*$/m);
  if (!nameLine || !descLine) return null;
  return {
    header: {
      handle,
      name: nameLine[1].trim(),
      description: descLine[1].trim(),
    },
    body,
  };
};

const nowIso = () => new Date().toISOString();

const emptyUsage = (): SkillUsage => ({
  state: "active",
  pinned: false,
  viewCount: 0,
  useCount: 0,
  patchCount: 0,
  createdAt: nowIso(),
  lastViewedAt: null,
  lastUsedAt: null,
  lastPatchedAt: null,
  archivedAt: null,
});

export const fileSystemSkillStore = (root: string): SkillStore => {
  const archiveRoot = join(root, ".archive");
  const usagePath = join(root, ".usage.json");

  const ensureRoot = async () => {
    await mkdir(root, { recursive: true });
  };

  const pathFor = (handle: string, archived = false) =>
    join(archived ? archiveRoot : root, handle, "SKILL.md");

  const dirFor = (handle: string, archived = false) =>
    join(archived ? archiveRoot : root, handle);

  const loadUsage = async (): Promise<Record<string, SkillUsage>> => {
    try {
      const raw = await readFile(usagePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, SkillUsage>;
      }
    } catch {
      // Missing or unreadable — fresh map.
    }
    return {};
  };

  const saveUsage = async (data: Record<string, SkillUsage>) => {
    await ensureRoot();
    await writeFile(usagePath, JSON.stringify(data, null, 2));
  };

  const usageFor = async (
    handle: string,
  ): Promise<{ all: Record<string, SkillUsage>; record: SkillUsage }> => {
    const all = await loadUsage();
    const record = all[handle] ?? emptyUsage();
    return { all, record };
  };

  const mutateUsage = async (
    handle: string,
    f: (record: SkillUsage) => SkillUsage,
  ): Promise<void> => {
    const { all, record } = await usageFor(handle);
    all[handle] = f(record);
    await saveUsage(all);
  };

  const readEntry = async (
    handle: string,
    archived = false,
  ): Promise<{ entry: SkillEntry; body: string } | null> => {
    try {
      const raw = await readFile(pathFor(handle, archived), "utf8");
      const decoded = decode(handle, raw);
      if (!decoded) return null;
      const { record } = await usageFor(handle);
      const usage = archived ? { ...record, state: "archived" as const } : record;
      return {
        entry: { ...decoded.header, usage },
        body: decoded.body,
      };
    } catch {
      return null;
    }
  };

  return {
    async list(opts): Promise<SkillEntry[]> {
      await ensureRoot();
      const handles = await readdir(root, { withFileTypes: true });
      const entries: SkillEntry[] = [];
      for (const dirent of handles) {
        if (!dirent.isDirectory()) continue;
        if (dirent.name.startsWith(".")) continue; // skip .archive
        const got = await readEntry(dirent.name);
        if (got) entries.push(got.entry);
      }
      if (opts?.includeArchived) {
        try {
          const archHandles = await readdir(archiveRoot, {
            withFileTypes: true,
          });
          for (const dirent of archHandles) {
            if (!dirent.isDirectory()) continue;
            const got = await readEntry(dirent.name, true);
            if (got) entries.push(got.entry);
          }
        } catch {
          // archive missing — ok
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return entries;
    },

    async read(handle: string): Promise<string | null> {
      const got = await readEntry(handle);
      return got ? got.body : null;
    },

    async save(draft: SkillDraft): Promise<SkillEntry> {
      await ensureRoot();
      const base = slugify(draft.name);
      let handle = base;
      let n = 1;
      while ((await readEntry(handle)) !== null) {
        n += 1;
        handle = `${base}-${n}`;
      }
      await mkdir(dirFor(handle), { recursive: true });
      await writeFile(pathFor(handle), encode(draft));
      const { all } = await usageFor(handle);
      all[handle] = emptyUsage();
      await saveUsage(all);
      return {
        handle,
        name: draft.name,
        description: draft.description,
        usage: all[handle],
      };
    },

    async update(handle: string, draft: SkillDraft): Promise<SkillEntry> {
      await ensureRoot();
      await mkdir(dirFor(handle), { recursive: true });
      await writeFile(pathFor(handle), encode(draft));
      const { record } = await usageFor(handle);
      return {
        handle,
        name: draft.name,
        description: draft.description,
        usage: record,
      };
    },

    async bumpView(handle: string): Promise<void> {
      await mutateUsage(handle, (r) => ({
        ...r,
        viewCount: r.viewCount + 1,
        lastViewedAt: nowIso(),
      }));
    },

    async bumpUse(handle: string): Promise<void> {
      await mutateUsage(handle, (r) => ({
        ...r,
        useCount: r.useCount + 1,
        lastUsedAt: nowIso(),
        // Any explicit use re-activates a stale skill.
        state: r.state === "stale" ? "active" : r.state,
      }));
    },

    async bumpPatch(handle: string): Promise<void> {
      await mutateUsage(handle, (r) => ({
        ...r,
        patchCount: r.patchCount + 1,
        lastPatchedAt: nowIso(),
        state: r.state === "stale" ? "active" : r.state,
      }));
    },

    async setPinned(handle: string, pinned: boolean): Promise<void> {
      await mutateUsage(handle, (r) => ({ ...r, pinned }));
    },

    async archive(handle: string): Promise<boolean> {
      try {
        await mkdir(archiveRoot, { recursive: true });
        await rename(dirFor(handle), dirFor(handle, true));
        await mutateUsage(handle, (r) => ({
          ...r,
          state: "archived",
          archivedAt: nowIso(),
        }));
        return true;
      } catch {
        return false;
      }
    },

    async restore(handle: string): Promise<boolean> {
      try {
        await rename(dirFor(handle, true), dirFor(handle));
        await mutateUsage(handle, (r) => ({
          ...r,
          state: "active",
          archivedAt: null,
        }));
        return true;
      } catch {
        return false;
      }
    },

    async markStale(handle: string): Promise<void> {
      await mutateUsage(handle, (r) =>
        r.pinned || r.state === "archived" ? r : { ...r, state: "stale" },
      );
    },

    async markActive(handle: string): Promise<void> {
      await mutateUsage(handle, (r) =>
        r.state === "archived" ? r : { ...r, state: "active" },
      );
    },
  };
};
