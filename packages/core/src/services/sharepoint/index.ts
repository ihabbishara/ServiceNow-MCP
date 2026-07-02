import { AzRunner } from "../../clients/ado/az.js";
import { GraphTokenProvider } from "../../clients/sharepoint/token.js";
import { GraphClient } from "../../clients/sharepoint/graph.js";
import { resolveSite } from "../../clients/sharepoint/site.js";
import { findIncidentFolder } from "../../clients/sharepoint/locate.js";
import { walkDocs } from "../../clients/sharepoint/walk.js";
import { extractText, formatOf, extOf } from "../../clients/sharepoint/extract.js";
import { defaultParsers } from "../../clients/sharepoint/parsers.js";
import type {
  SharePointConfig,
  GraphPort,
  Parsers,
  IncidentDocsResult,
  IncidentDocument
} from "../../clients/sharepoint/types.js";

const estTokens = (chars: number): number => Math.ceil(chars / 4);

export class SharePointService {
  private site?: { siteId: string; driveId: string };

  constructor(
    private readonly cfg: SharePointConfig,
    private readonly graph: GraphPort,
    private readonly parsers: Parsers = defaultParsers
  ) {}

  private async drive(): Promise<string> {
    if (!this.site) this.site = await resolveSite(this.graph, this.cfg.siteUrl);
    return this.site.driveId;
  }

  async getIncidentDocuments(inc: string): Promise<IncidentDocsResult> {
    const driveId = await this.drive();
    const folder = await findIncidentFolder(this.graph, driveId, this.cfg.incidentRoot, inc);
    if (!folder) throw new Error(`No SharePoint folder found for ${inc}`);

    const documents: IncidentDocument[] = [];
    const skipped: { name: string; reason: string }[] = [];
    let usedTokens = 0;
    const budget = this.cfg.maxDocTokens;

    for await (const f of walkDocs(this.graph, driveId, folder.id, this.cfg.docsSubfolder, {
      maxFiles: this.cfg.maxFiles
    })) {
      const format = formatOf(f.name);
      if (!format) {
        skipped.push({ name: f.name, reason: `unsupported format: .${extOf(f.name)}` });
        continue;
      }
      if (f.size > this.cfg.maxFileBytes) {
        skipped.push({
          name: f.name,
          reason: `exceeds max file bytes (${f.size} > ${this.cfg.maxFileBytes})`
        });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await this.graph.download(driveId, f.id, this.cfg.maxFileBytes);
      } catch (err) {
        skipped.push({ name: f.name, reason: String(err) });
        continue;
      }
      const result = await extractText(f.name, bytes, this.parsers);
      if ("skipped" in result) {
        skipped.push({ name: f.name, reason: result.skipped });
        continue;
      }
      const remainingTokens = Math.max(0, budget - usedTokens);
      const remainingChars = remainingTokens * 4;
      const truncated = result.text.length > remainingChars;
      const text = truncated ? result.text.slice(0, remainingChars) : result.text;
      usedTokens += estTokens(text.length);
      documents.push({
        name: f.name,
        path: f.path,
        webUrl: f.webUrl,
        format,
        bytes: f.size,
        textChars: text.length,
        truncated,
        text
      });
    }

    return {
      incident: inc,
      folder: { name: folder.name, webUrl: folder.webUrl },
      count: documents.length,
      documents,
      totalChars: documents.reduce((s, d) => s + d.textChars, 0),
      truncatedCount: documents.filter((d) => d.truncated).length,
      skipped
    };
  }
}

/** Build a SharePointService backed by a live Graph client (az-CLI delegated token). */
export const createSharePointService = (cfg: SharePointConfig): SharePointService => {
  const token = new GraphTokenProvider({ az: new AzRunner(cfg.azPath) });
  const graph = new GraphClient({
    getToken: () => token.getToken(),
    proxyUrl: cfg.proxyUrl,
    timeoutMs: cfg.timeoutMs
  });
  return new SharePointService(cfg, graph);
};
