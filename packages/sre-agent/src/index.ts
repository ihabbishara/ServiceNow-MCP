export { ChatEngine, buildClientOptions } from "./engine/engine.js";
export type { EngineDeps } from "./engine/engine.js";
export { copilotLogin, isCopilotAuthError, resolveSdkRuntime } from "./engine/auth.js";
export type { CopilotLoginOptions } from "./engine/auth.js";
export { loadAgentConfig } from "./config.js";
export type { AgentConfig } from "./config.js";
export { loadDotenv, resolveDotenvPath, packageEnvPath } from "./config/env.js";
export { buildTools } from "./tools/index.js";
export { buildWorkflowPrompt } from "./workflows/index.js";
