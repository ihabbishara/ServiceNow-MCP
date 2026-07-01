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

export class WorkItemService {
  constructor(
    private readonly client: AzureDevOpsClient,
    private readonly cfg: WorkItemServiceConfig
  ) {}

  resolveAreaPath(board?: string, areaPath?: string): string | undefined {
    if (areaPath) return areaPath;
    if (board && this.cfg.boardMap[board]) return this.cfg.boardMap[board];
    return this.cfg.defaultAreaPath;
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
