import type { GraphPort, GraphDriveItem, DriveFile } from "./types.js";

const childrenById = (driveId: string, itemId: string) => `/drives/${driveId}/items/${itemId}/children`;

/**
 * Recurse the `<docsSubfolder>` subtree of the incident folder, yielding files
 * (depth-first, parent before children) with human-readable paths. Folders other
 * than the docs subfolder at the top level are ignored. Bounded by maxFiles.
 */
export async function* walkDocs(
  graph: GraphPort,
  driveId: string,
  incidentFolderId: string,
  docsSubfolder: string,
  opts: { maxFiles: number }
): AsyncGenerator<DriveFile> {
  const top = await graph.getAllPages<GraphDriveItem>(childrenById(driveId, incidentFolderId));
  const docs = top.find((i) => i.folder && i.name.toLowerCase() === docsSubfolder.toLowerCase());
  if (!docs) return;

  let yielded = 0;
  const stack: { id: string; path: string }[] = [{ id: docs.id, path: docs.name }];
  while (stack.length) {
    const node = stack.pop()!;
    const children = await graph.getAllPages<GraphDriveItem>(childrenById(driveId, node.id));
    const subdirs: { id: string; path: string }[] = [];
    for (const c of children) {
      const path = `${node.path}/${c.name}`;
      if (c.folder) {
        subdirs.push({ id: c.id, path });
      } else if (c.file) {
        yield { id: c.id, name: c.name, webUrl: c.webUrl, size: c.size ?? 0, path };
        if (++yielded >= opts.maxFiles) return;
      }
    }
    // push subdirs reversed so traversal reads left-to-right
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
}
