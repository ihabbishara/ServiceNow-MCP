import { loadConfig, AppConfig } from "../../dist/config/configLoader.js";
import { IServiceNowClient } from "../../dist/integrations/servicenow/IServiceNowClient.js";
import { ServiceNowClient } from "../../dist/integrations/servicenow/ServiceNowClient.js";
import { MockServiceNowClient } from "../../dist/integrations/servicenow/MockServiceNowClient.js";
import { IAzureDevOpsClient } from "../../dist/integrations/ado/IAzureDevOpsClient.js";
import { AzureDevOpsClient } from "../../dist/integrations/ado/AzureDevOpsClient.js";
import { MockAzureDevOpsClient } from "../../dist/integrations/ado/MockAzureDevOpsClient.js";
import { NoopAzureDevOpsClient } from "../../dist/integrations/ado/NoopAzureDevOpsClient.js";
import { SlaRiskService } from "../../dist/services/slaRiskService.js";
import { StaleTicketService } from "../../dist/services/staleTicketService.js";
import { ChangeCorrelationService } from "../../dist/services/changeCorrelationService.js";
import { IncidentService } from "../../dist/services/incidentService.js";
import { ReportService } from "../../dist/services/reportService.js";
import { FallbackSummarizationService } from "../../dist/services/llmSummarizationService.js";

export interface McpRuntime {
  config: AppConfig;
  serviceNowClient: IServiceNowClient;
  azureDevOpsClient: IAzureDevOpsClient;
  incidentService: IncidentService;
  reportService: ReportService;
  slaRiskService: SlaRiskService;
  staleTicketService: StaleTicketService;
  correlationService: ChangeCorrelationService;
}

export const createMcpRuntime = (): McpRuntime => {
  const config = loadConfig();

  // ServiceNow client
  const serviceNowClient: IServiceNowClient = config.serviceNow.enabled
    ? new ServiceNowClient(config.serviceNow)
    : new MockServiceNowClient();

  // Azure DevOps client
  const azureDevOpsClient: IAzureDevOpsClient = config.azureDevOps.enabled
    ? new AzureDevOpsClient(config.azureDevOps)
    : config.azureDevOps.disabledMode === "mock"
      ? new MockAzureDevOpsClient()
      : new NoopAzureDevOpsClient();

  // Domain services
  const slaRiskService = new SlaRiskService(config.thresholds.sla);
  const staleTicketService = new StaleTicketService(config.thresholds.staleByPriorityMinutes);
  const correlationService = new ChangeCorrelationService({
    windowBeforeHours: config.thresholds.relatedChangeWindow.beforeHours,
    windowAfterHours: config.thresholds.relatedChangeWindow.afterHours
  });

  // For MCP, we use the fallback summarization (LLM is handled by Copilot)
  const summarizationService = new FallbackSummarizationService();

  const incidentService = new IncidentService(
    serviceNowClient,
    azureDevOpsClient,
    slaRiskService,
    staleTicketService,
    correlationService,
    summarizationService,
    config
  );

  const reportService = new ReportService(incidentService, serviceNowClient, azureDevOpsClient);

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
