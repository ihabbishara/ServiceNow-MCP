import { describe, it, expect } from "vitest";
import * as api from "../src/index.js";

describe("public API barrel", () => {
  it("exports the symbols packages/web depends on", () => {
    for (const name of [
      "ChatEngine",
      "loadAgentConfig",
      "buildTools",
      "copilotLogin",
      "isCopilotAuthError",
      "loadDotenv",
      "resolveDotenvPath",
      "buildWorkflowPrompt"
    ]) {
      expect(api[name], name).toBeTypeOf("function");
    }
  });
});
