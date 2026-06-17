import { Incident, RelatedChange, SlaRiskItem, StaleTicketItem, WorkItem } from "../types.js";
import { ServiceNowClient } from "../clients/servicenow.js";
import type { AzureDevOpsClient } from "../clients/ado/types.js";
import { SlaRiskService } from "./slaRisk.js";
import { StaleTicketService } from "./staleTickets.js";
import { ChangeCorrelationService } from "./correlation.js";

const HOUR_MS = 3_600_000;

export interface IncidentQueryFilters {
  onlyOpen?: boolean; // defaults to true when omitted
  assignmentGroup?: string;
  priorities?: string[];
}

export interface IncidentSummary {
  incident: Incident;
  relatedChanges: RelatedChange[];
  relatedWorkItems: WorkItem[];
}

export class IncidentService {
  constructor(
    private readonly serviceNow: ServiceNowClient,
    private readonly ado: AzureDevOpsClient,
    private readonly slaRisk: SlaRiskService,
    private readonly staleTickets: StaleTicketService,
    private readonly correlation: ChangeCorrelationService,
    private readonly window: { beforeHours: number; afterHours: number }
  ) {}

  async summarizeIncident(number: string): Promise<IncidentSummary> {
    const incident = await this.serviceNow.getIncidentByNumber(number);
    if (!incident) throw new Error(`Incident ${number} not found`);
    const relatedChanges = await this.correlateFor(incident);
    let relatedWorkItems: WorkItem[] = [];
    try {
      relatedWorkItems = await this.ado.searchWorkItems({ text: number });
    } catch {
      // ADO failure must not break the incident summary
    }
    return { incident, relatedChanges, relatedWorkItems };
  }

  async findRelatedChanges(
    number: string,
    window?: { beforeHours: number; afterHours: number }
  ): Promise<RelatedChange[]> {
    const incident = await this.serviceNow.getIncidentByNumber(number);
    if (!incident) throw new Error(`Incident ${number} not found`);
    return this.correlateFor(incident, window);
  }

  async listSlaRisks(filters: IncidentQueryFilters): Promise<SlaRiskItem[]> {
    return this.slaRisk.assess(await this.fetchIncidents(filters));
  }

  async listStaleIncidents(filters: IncidentQueryFilters): Promise<StaleTicketItem[]> {
    return this.staleTickets.findStale(await this.fetchIncidents(filters));
  }

  private async correlateFor(
    incident: Incident,
    window: { beforeHours: number; afterHours: number } = this.window
  ): Promise<RelatedChange[]> {
    const openedMs = Date.parse(incident.openedAt);
    if (!Number.isFinite(openedMs)) return []; // blank/invalid openedAt → no change correlation, don't crash
    const startedAfter = new Date(openedMs - window.beforeHours * HOUR_MS).toISOString();
    const changes = await this.serviceNow.listChangesWithFilters({ startedAfter, limit: 200 });
    return this.correlation.correlate(incident, changes, window);
  }

  private async fetchIncidents(filters: IncidentQueryFilters): Promise<Incident[]> {
    const incidents = await this.serviceNow.listIncidents({
      onlyOpen: filters.onlyOpen ?? true,
      assignmentGroup: filters.assignmentGroup
    });
    return filters.priorities?.length
      ? incidents.filter((i) => filters.priorities!.includes(i.priority))
      : incidents;
  }
}
