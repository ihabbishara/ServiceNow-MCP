import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/*.tsbuildinfo",
      "packages/web/client/dist/**",
      "node_modules/**",
      ".claude/**",
      "**/scripts/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Pragmatic starting posture — tighten in later phases, don't block P0 on churn.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "no-console": "off"
    }
  },
  {
    files: ["**/*.test.ts", "**/tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" }
  }
);
