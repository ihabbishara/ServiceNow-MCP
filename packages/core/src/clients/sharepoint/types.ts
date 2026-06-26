export interface SharePointConfig {
  enabled: boolean;
  siteUrl: string;          // https://acme.sharepoint.com/sites/SRE
  incidentRoot: string;     // "" = drive root; else server-relative folder path
  docsSubfolder: string;    // "Docs"
  authMode: "azcli";
  azPath: string;           // "az"
  proxyUrl?: string;
  maxDocTokens: number;     // 50000
  maxFiles: number;         // 50
  maxFileBytes: number;     // 10485760
  timeoutMs: number;        // 30000
}

export interface GraphDriveItem {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}

export interface DriveItemRef { id: string; name: string; webUrl?: string; }

export interface DriveFile {
  id: string;
  name: string;
  webUrl?: string;
  size: number;
  path: string;             // e.g. "Docs/sub/runbook.docx"
}

export type ExtractResult = { text: string } | { skipped: string };

export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf";

export interface IncidentDocument {
  name: string;
  path: string;
  webUrl?: string;
  format: DocFormat;
  bytes: number;
  textChars: number;
  truncated: boolean;
  text: string;
}

export interface IncidentDocsResult {
  incident: string;
  folder: { name: string; webUrl?: string };
  count: number;
  documents: IncidentDocument[];
  totalChars: number;
  truncatedCount: number;
  skipped: { name: string; reason: string }[];
}

// The seam the service depends on; GraphClient implements it, tests fake it.
export interface GraphPort {
  get<T>(path: string): Promise<T>;
  getAllPages<T>(path: string): Promise<T[]>;
  download(driveId: string, itemId: string, maxBytes?: number): Promise<Buffer>;
}

export interface Parsers {
  docx: (b: Buffer) => Promise<string>;
  xlsx: (b: Buffer) => Promise<string>;
  pptx: (b: Buffer) => Promise<string>;
  pdf: (b: Buffer) => Promise<string>;
}
