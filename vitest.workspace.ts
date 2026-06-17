import { defineWorkspace } from "vitest/config";
import { fileURLToPath } from "node:url";

const coreSrc = fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url));

export default defineWorkspace([
  {
    test: { name: "core", root: "./packages/core", environment: "node" },
    resolve: { alias: { "@sre/core": coreSrc } }
  },
  {
    test: { name: "mcp-server", root: "./packages/mcp-server", environment: "node" },
    resolve: { alias: { "@sre/core": coreSrc } }
  }
]);
