// ESLint 10 flat config（TypeScript 推荐规则）
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "electron-app/**", "node_modules/**", "scripts/*.txt"],
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-constant-condition": "off",
    },
  },
  {
    files: [
      "src/**/*.test.ts",
      "scripts/scan-bugs.ts",
      "scripts/bench.ts",
      "scripts/verify-quality.ts",
      "scripts/zhique-prep.ts",
      "scripts/api-test.ts",
      "scripts/api-test-2.ts",
      "scripts/multi-case-test.ts",
      "scripts/ox-test.ts",
      "scripts/zhuque-test.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);