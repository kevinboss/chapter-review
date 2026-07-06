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
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }

  function emit(dir: Dir, prefix: string): (FolderNode | FileNode)[] {
    const nodes: (FolderNode | FileNode)[] = [];
    for (const [name, sub] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      // Compress chains of single-child folders without direct files.
      let label = prefix + name;
      let current = sub;
      while (current.files.length === 0 && current.dirs.size === 1) {
        const [next] = current.dirs.entries().next().value as [string, Dir];
        label += "/" + next;
        current = current.dirs.get(next)!;
      }
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
