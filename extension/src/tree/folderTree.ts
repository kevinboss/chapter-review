import { FileNode, FolderNode, Node } from "./nodes";

/** Nested folders per chapter, single-child chains compressed ("src/auth"). */
export function buildFolderTree(ownerId: string, files: FileNode[]): Node[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: FileNode[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const file of files) {
    const segments = file.entry.path.split("/");
    // Descend the path, creating each level that is missing.
    const dir = segments.slice(0, -1).reduce((parent, segment) => {
      const existing = parent.dirs.get(segment);
      if (existing) return existing;
      const created: Dir = { dirs: new Map(), files: [] };
      parent.dirs.set(segment, created);
      return created;
    }, root);
    dir.files.push(file);
  }

  /** Follow a chain of single-child folders that hold no files of their own. */
  function compress(dir: Dir, label: string): { label: string; dir: Dir } {
    if (dir.files.length > 0 || dir.dirs.size !== 1) return { label, dir };
    const only = dir.dirs.entries().next();
    if (only.done) return { label, dir };
    const [name, child] = only.value;
    return compress(child, `${label}/${name}`);
  }

  function emit(dir: Dir, prefix: string): (FolderNode | FileNode)[] {
    const nodes: (FolderNode | FileNode)[] = [];
    for (const [name, sub] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      // Compress chains of single-child folders without direct files.
      const { label, dir: current } = compress(sub, prefix + name);
      nodes.push({
        kind: "folder",
        ownerId,
        label,
        children: emit(current, ""),
      });
    }
    nodes.push(...dir.files.sort((a, b) => a.entry.path.localeCompare(b.entry.path)));
    return nodes;
  }

  return emit(root, "");
}
