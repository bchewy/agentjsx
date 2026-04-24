import type { FileInfo, FileStore } from "./file-system";

export interface InMemoryStoreOptions {
  // Starting contents. Keys are paths, values are file contents.
  initial?: Record<string, string>;
  // Per-file character cap. Default 200_000.
  maxFileChars?: number;
  // Total workspace character cap across all files. Default 2_000_000.
  maxTotalChars?: number;
}

// Reference FileStore backed by an in-process Map. Ephemeral — dies when
// the runtime disposes. Useful for tests, toy agents, and any run where
// the workspace doesn't need to survive beyond one session.
//
// Implements all six FileStore methods. Glob uses a small matcher
// supporting `*`, `**`, and `?` (no curly-brace alternation, no POSIX
// bracket expressions). Stat derives from read. Directory type is never
// produced — this is a flat keyspace with path strings that happen to
// contain `/`.
export function createInMemoryStore(opts: InMemoryStoreOptions = {}): FileStore {
  const files = new Map<string, string>(
    opts.initial ? Object.entries(opts.initial) : [],
  );
  const maxFileChars = opts.maxFileChars ?? 200_000;
  const maxTotalChars = opts.maxTotalChars ?? 2_000_000;

  const totalSize = (): number => {
    let total = 0;
    for (const v of files.values()) total += v.length;
    return total;
  };

  const asInfo = (path: string, content: string): FileInfo => ({
    path,
    size: content.length,
    type: "file",
  });

  return {
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, content) {
      if (content.length > maxFileChars) {
        throw new Error(`File exceeds max size (${maxFileChars} chars): ${path}`);
      }
      const existing = files.get(path) ?? "";
      const projected = totalSize() - existing.length + content.length;
      if (projected > maxTotalChars) {
        throw new Error(`Total workspace size would exceed ${maxTotalChars} chars`);
      }
      files.set(path, content);
    },
    async list(dir, listOpts) {
      const prefix =
        dir && dir !== "/" && dir !== ""
          ? dir.endsWith("/")
            ? dir
            : dir + "/"
          : "";
      let entries: FileInfo[] = [...files.entries()]
        .filter(([p]) => (prefix ? p.startsWith(prefix) : true))
        .map(([p, c]) => asInfo(p, c));
      if (listOpts?.offset) entries = entries.slice(listOpts.offset);
      if (listOpts?.limit !== undefined) entries = entries.slice(0, listOpts.limit);
      return entries;
    },
    async delete(path, delOpts) {
      if (delOpts?.recursive) {
        const prefix = path.endsWith("/") ? path : path + "/";
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(prefix)) files.delete(key);
        }
      } else {
        files.delete(path);
      }
    },
    async glob(pattern) {
      const regex = globToRegex(pattern);
      return [...files.entries()]
        .filter(([p]) => regex.test(p))
        .map(([p, c]) => asInfo(p, c));
    },
    async stat(path) {
      const content = files.get(path);
      return content === undefined ? null : asInfo(path, content);
    },
  };
}

// Minimal glob matcher: `**` matches any chars (including `/`), `*`
// matches any chars within a segment (no `/`), `?` matches a single
// non-slash character. No brace alternation, no character classes.
// Good enough for an in-memory reference impl; richer backends delegate
// to the host's own glob (e.g. Cloudflare Workspace).
function globToRegex(pattern: string): RegExp {
  const sentinel = "\x00";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, sentinel)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(sentinel, "g"), ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}
