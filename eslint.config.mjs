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
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-constant-condition": "off",
    },
  },
  {
    files: ["scripts/**/*.{ts,js,mjs,cjs}"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        fetch: "readonly",
        require: "readonly",
        module: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // CommonJS 运维工具脚本（一次性扫描/轮换等）：require 风格导入是刻意选择
    files: ["scripts/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // 测试文件与 CLI 工具允许 any（桩对象/外部数据形状不定）
    files: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.ts",
      "scripts/scan-bugs.ts",
      "scripts/bench.ts",
      "scripts/verify-quality.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
