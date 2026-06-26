import type { GraphPort, GraphDriveItem, DriveItemRef } from "./types.js";

/** Encode a server-relative folder path for Graph `root:/<path>:` addressing. */
export const encodeFolderPath = (path: string): string =>
  path.split("/").filter(Boolean).map(encodeURIComponent).join("%2F");

const childrenPath = (driveId: string, incidentRoot: string): string =>
  incidentRoot
    ? `/drives/${driveId}/root:/${encodeFolderPath(incidentRoot)}:/children`
    : `/drives/${driveId}/root/children`;

/** Find the incident folder under the configured root by prefix match on its name. */
export const findIncidentFolder = async (
  graph: GraphPort,
  driveId: string,
  incidentRoot: string,
  inc: string
): Promise<DriveItemRef | null> => {
  const needle = inc.trim().toLowerCase();
  const items = await graph.getAllPages<GraphDriveItem>(childrenPath(driveId, incidentRoot));
  const hit = items.find((i) => i.folder && i.name.toLowerCase().startsWith(needle));
  return hit ? { id: hit.id, name: hit.name, webUrl: hit.webUrl } : null;
};
