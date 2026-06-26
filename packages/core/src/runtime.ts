import { loadConfig, AppConfig } from "./config.js";
import { ServiceNowClient } from "./clients/servicenow.js";
import { createAdoClient } from "./clients/ado/index.js";
import type { AzureDevOpsClient } from "./clients/ado/types.js";
import { SlaRiskService } from "./services/slaRisk.js";
import { StaleTicketService } from "./services/staleTickets.js";
import { ChangeCorrelationService } from "./services/correlation.js";
import { IncidentService } from "./services/incidents.js";
import { ReportService } from "./services/report.js";
import { KnowledgeService } from "./services/knowledge/index.js";
import { SharePointService, createSharePointService } from "./services/sharepoint/index.js";

export interface McpRuntime {
  config: AppConfig;
  serviceNowClient: ServiceNowClient;
  azureDevOpsClient: AzureDevOpsClient;
  incidentService: IncidentService;
  reportService: ReportService;
  slaRiskService: SlaRiskService;
  staleTicketService: StaleTicketService;
  correlationService: ChangeCorrelationService;
  knowledge: KnowledgeService;
  sharePoint?: SharePointService;
}

export const createMcpRuntime = (env: Record<string, string | undefined> = process.env): McpRuntime => {
  const config = loadConfig(env);

  const serviceNowClient = new ServiceNowClient(config.serviceNow);
  const azureDevOpsClient = createAdoClient(config.azureDevOps);

  const slaRiskService = new SlaRiskService();
  const staleTicketService = new StaleTicketService(config.thresholds.staleByPriorityMinutes);
  const correlationService = new ChangeCorrelationService(config.thresholds.relatedChangeWindow);

  const incidentService = new IncidentService(
    serviceNowClient,
    azureDevOpsClient,
    slaRiskService,
    staleTicketService,
    correlationService,
    config.thresholds.relatedChangeWindow
  );
  const reportService = new ReportService(incidentService, serviceNowClient);
  const knowledge = new KnowledgeService(config.knowledge);
  const sharePoint = config.sharePoint.enabled ? createSharePointService(config.sharePoint) : undefined;

  return {
    config,
    serviceNowClient,
    azureDevOpsClient,
    incidentService,
    reportService,
    slaRiskService,
    staleTicketService,
    correlationService,
    knowledge,
    sharePoint
  };
};
