import type { GraphPort } from "./types.js";

/** Resolve a SharePoint site URL to its Graph siteId and default document-library driveId. */
export const resolveSite = async (
  graph: GraphPort,
  siteUrl: string
): Promise<{ siteId: string; driveId: string }> => {
  const u = new URL(siteUrl);
  const serverRelative = u.pathname.replace(/\/+$/, ""); // e.g. "/sites/SRE"
  const site = await graph.get<{ id: string }>(`/sites/${u.hostname}:${serverRelative}`);
  const drive = await graph.get<{ id: string }>(`/sites/${site.id}/drive`);
  return { siteId: site.id, driveId: drive.id };
};
