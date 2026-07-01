import type { WorkItem } from "../types.js";
import type { AzureDevOpsClient, CreateWorkItemPayload } from "../clients/ado/types.js";

export interface WorkItemServiceConfig {
  boardMap: Record<string, string>;
  defaultAreaPath?: string;
  defaultIterationPath?: string;
}

export interface CreateWorkItemInput {
  type: string;
  title: string;
  description?: string;
  board?: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  assignedTo?: string;
  priority?: string;
  storyPoints?: number;
  parentId?: number;
}

export interface CloneWorkItemInput {
  sourceId: number;
  board?: string;
  areaPath?: string;
  iterationPath?: string;
  includeChildren?: boolean;
  linkToSource?: boolean;
  titlePrefix?: string;
  // Board/area targeting and parent linking are controlled by the top-level
  // clone input, not overrides — narrow them out to avoid a no-op API surface.
  overrides?: Omit<Partial<CreateWorkItemInput>, "parentId" | "board" | "areaPath" | "iterationPath">;
}

export interface CloneResult {
  cloneId: number;
  sourceId: number;
  childrenCopied: number;
  linked: boolean;
}

export class WorkItemService {
  constructor(
    private readonly client: AzureDevOpsClient,
    private readonly cfg: WorkItemServiceConfig
  ) {}

  /** True when a board name resolves to a mapped area path (else the caller fell back to the default). */
  isBoardKnown(board: string): boolean {
    return Boolean(this.cfg.boardMap[board]);
  }

  resolveAreaPath(board?: string, areaPath?: string): string | undefined {
    if (areaPath) return areaPath;
    if (board && this.cfg.boardMap[board]) return this.cfg.boardMap[board];
    return this.cfg.defaultAreaPath;
  }

  private parseTags(raw: unknown): string[] | undefined {
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    return raw.split(/;\s*/).map((t) => t.trim()).filter(Boolean);
  }

  // Build a CreateWorkItemPayload from a source item's raw fields. Description and
  // acceptance criteria are carried as raw HTML via `fields` (not `description`)
  // so createWorkItem does not re-run the \n->"<br>" conversion on already-HTML text.
  private payloadFromFields(
    fields: Record<string, unknown>,
    areaPath: string | undefined,
    iterationPath: string | undefined,
    titlePrefix = ""
  ): CreateWorkItemPayload {
    const type = String(fields["System.WorkItemType"] ?? "Task");
    const rawFields: Record<string, string> = {};
    const desc = fields["System.Description"] || fields["Microsoft.VSTS.TCM.ReproSteps"];
    if (typeof desc === "string" && desc) {
      rawFields[type === "Bug" ? "Microsoft.VSTS.TCM.ReproSteps" : "System.Description"] = desc;
    }
    const ac = fields["Microsoft.VSTS.Common.AcceptanceCriteria"];
    if (typeof ac === "string" && ac) rawFields["Microsoft.VSTS.Common.AcceptanceCriteria"] = ac;
    const prio = fields["Microsoft.VSTS.Common.Priority"];
    const sp = fields["Microsoft.VSTS.Scheduling.StoryPoints"];
    return {
      type,
      title: titlePrefix + String(fields["System.Title"] ?? ""),
      areaPath,
      iterationPath,
      tags: this.parseTags(fields["System.Tags"]),
      priority: typeof prio === "number" ? String(prio) : undefined,
      storyPoints: typeof sp === "number" ? sp : undefined,
      // state reset (omit) and assignedTo cleared (omit) by design
      fields: Object.keys(rawFields).length ? rawFields : undefined
    };
  }

  async clone(input: CloneWorkItemInput): Promise<CloneResult> {
    const fields = await this.client.getWorkItemFields(input.sourceId);
    if (!fields) throw new Error(`source work item ${input.sourceId} not found`);

    const areaPath = this.resolveAreaPath(input.board, input.areaPath);
    const iterationPath = input.iterationPath ?? this.cfg.defaultIterationPath;

    const base = this.payloadFromFields(fields, areaPath, iterationPath, input.titlePrefix ?? "");
    const o = input.overrides ?? {};

    // If an override description is provided, drop the carried raw description field
    // so it does not clobber the override — buildCreateOps / az emit `fields` last.
    if (o.description !== undefined && base.fields) {
      delete base.fields["System.Description"];
      delete base.fields["Microsoft.VSTS.TCM.ReproSteps"];
      if (Object.keys(base.fields).length === 0) base.fields = undefined;
    }

    const payload: CreateWorkItemPayload = {
      ...base,
      ...(o.type !== undefined ? { type: o.type } : {}),
      ...(o.title !== undefined ? { title: o.title } : {}),
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.tags !== undefined ? { tags: o.tags } : {}),
      ...(o.assignedTo !== undefined ? { assignedTo: o.assignedTo } : {}),
      ...(o.priority !== undefined ? { priority: o.priority } : {}),
      ...(o.storyPoints !== undefined ? { storyPoints: o.storyPoints } : {})
    };

    const clone = await this.client.createWorkItem(payload);

    let childrenCopied = 0;
    if (input.includeChildren) {
      const children = await this.client.listChildren(input.sourceId);
      for (const childId of children) {
        const cf = await this.client.getWorkItemFields(childId);
        // A child whose fields can't be read (deleted or no permission) is skipped;
        // childrenCopied reflects only children successfully copied.
        if (!cf) continue;
        const childPayload = this.payloadFromFields(cf, areaPath, iterationPath);
        const created = await this.client.createWorkItem(childPayload);
        await this.client.addRelation(created.id, clone.id, "parent");
        childrenCopied++;
      }
    }

    if (input.linkToSource) await this.client.addRelation(clone.id, input.sourceId, "related");

    return { cloneId: clone.id, sourceId: input.sourceId, childrenCopied, linked: !!input.linkToSource };
  }

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const payload: CreateWorkItemPayload = {
      type: input.type,
      title: input.title,
      description: input.description,
      areaPath: this.resolveAreaPath(input.board, input.areaPath),
      iterationPath: input.iterationPath ?? this.cfg.defaultIterationPath,
      tags: input.tags,
      assignedTo: input.assignedTo,
      priority: input.priority,
      storyPoints: input.storyPoints
    };
    const wi = await this.client.createWorkItem(payload);
    if (input.parentId) await this.client.addRelation(wi.id, input.parentId, "parent");
    return wi;
  }
}
