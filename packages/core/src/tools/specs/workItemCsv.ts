import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { listCsvFiles, readCsvFile } from "../../services/csvReader.js";
import { defineSpec } from "../spec.js";

const csvGuard = (c: AppConfig): string | null =>
  !c.azureDevOps.enabled
    ? "Azure DevOps integration is disabled. Set ADO_ENABLED=true."
    : !c.azureDevOps.csvDir
      ? "CSV folder not configured. Set ADO_CSV_DIR to a folder of .csv files."
      : null;

export const workItemCsvSpecs = [
  defineSpec({
    name: "list_work_item_csvs",
    description:
      "List CSV files available in the configured work-item CSV folder (ADO_CSV_DIR). Use read_work_item_csv to load one, then create_work_item / clone_work_item per row.",
    schema: {},
    enabledWhen: csvGuard,
    run: async (rt) => {
      const files = await listCsvFiles(rt.config.azureDevOps.csvDir as string);
      return { files };
    }
  }),

  defineSpec({
    name: "read_work_item_csv",
    description:
      "Read a CSV file from the configured folder (ADO_CSV_DIR) and return its headers and rows as structured JSON. Then detect which rows are stories/tasks and call create_work_item / clone_work_item per row.",
    schema: {
      filename: z.string().describe("CSV filename within ADO_CSV_DIR (no path separators)")
    },
    enabledWhen: csvGuard,
    run: async (rt, a) =>
      readCsvFile(
        rt.config.azureDevOps.csvDir as string,
        a.filename,
        rt.config.azureDevOps.csvMaxBytes
      )
  })
];
