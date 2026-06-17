import { loadConfig, AppConfig } from "./config.js";
import { ServiceNowClient } from "./clients/servicenow.js";
import { AzureDevOpsClient } from "./clients/ado/index.js";
import { SlaRiskService } from "./services/slaRisk.js";
import { StaleTicketService } from "./services/staleTickets.js";
import { ChangeCorrelationService } from "./services/correlation.js";
import { IncidentService } from "./services/incidents.js";
import { ReportService } from "./services/report.js";

export interface McpRuntime {
  config: AppConfig;
  serviceNowClient: ServiceNowClient;
  azureDevOpsClient: AzureDevOpsClient;
  incidentService: IncidentService;
  reportService: ReportService;
  slaRiskService: SlaRiskService;
  staleTicketService: StaleTicketService;
  correlationService: ChangeCorrelationService;
}

export const createMcpRuntime = (): McpRuntime => {
  const config = loadConfig();

  const serviceNowClient = new ServiceNowClient(config.serviceNow);
  const azureDevOpsClient = new AzureDevOpsClient(config.azureDevOps);

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

  return {
    config,
    serviceNowClient,
    azureDevOpsClient,
    incidentService,
    reportService,
    slaRiskService,
    staleTicketService,
    correlationService
  };
};
