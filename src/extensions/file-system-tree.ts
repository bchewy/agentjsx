import type { FileInfo } from "./file-system";

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isDir: boolean;
  size: number;
}

// Build + render a bounded ASCII tree from a flat FileInfo list.
// Normalizes slashes to "/", filters out ignored segments at ANY depth,
// caps depth, collapses overflow behind a "… N more" marker.
export const renderTree = (
  files: FileInfo[],
  opts: { maxTreeFiles: number; maxTreeDepth: number; ignore: Set<string> },
): string => {
  const root: TreeNode = { name: "", children: new Map(), isDir: true, size: 0 };
  const segmentIgnored = (seg: string): boolean => opts.ignore.has(seg);

  for (const f of files) {
    const parts = f.path
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p.length > 0);
    if (parts.some(segmentIgnored)) continue;
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLast = i === parts.length - 1;
      let child = cur.children.get(seg);
      if (!child) {
        child = {
          name: seg,
          children: new Map(),
          isDir: !isLast || f.type === "dir",
          size: isLast ? f.size : 0,
        };
        cur.children.set(seg, child);
      }
      cur = child;
    }
  }

  let rendered = 0;
  let truncated = 0;
  const lines: string[] = [];

  const walk = (node: TreeNode, depth: number, prefix: string): void => {
    const entries = [...node.children.values()].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      if (rendered >= opts.maxTreeFiles) {
        truncated += countFiles(entry) + (isLast ? 0 : countRemaining(entries, i + 1));
        break;
      }
      if (depth >= opts.maxTreeDepth && entry.isDir) {
        lines.push(`${prefix}${connector}${entry.name}/ …`);
        rendered++;
        continue;
      }
      lines.push(`${prefix}${connector}${entry.name}${entry.isDir ? "/" : ""}`);
      rendered++;
      if (entry.isDir && entry.children.size > 0) {
        walk(entry, depth + 1, prefix + (isLast ? "    " : "│   "));
      }
    }
  };
  walk(root, 0, "");

  const header = `## Workspace (tree, ≤${opts.maxTreeFiles} entries, depth ${opts.maxTreeDepth})`;
  const body = lines.length > 0 ? lines.join("\n") : "(no files)";
  const footer = truncated > 0 ? `\n… ${truncated} more entries truncated` : "";
  return `${header}\n${body}${footer}`;
};

const countFiles = (node: TreeNode): number => {
  let n = 1;
  for (const c of node.children.values()) n += countFiles(c);
  return n;
};

const countRemaining = (entries: TreeNode[], fromIdx: number): number => {
  let n = 0;
  for (let i = fromIdx; i < entries.length; i++) n += countFiles(entries[i]);
  return n;
};
