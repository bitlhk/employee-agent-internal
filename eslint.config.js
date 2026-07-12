import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const sourceFiles = ["**/*.{js,cjs,mjs,ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      ".git/**",
      ".github/**",
      "node_modules/**",
      "dist/**",
      "**/dist/**",
      "build/**",
      "coverage/**",
      "data/**",
      "logs/**",
      "reports/**",
      "backups/**",
      "tmp/**",
      "temp/**",
      "*.log",
      "*.bak",
      "*.bak-*",
      "*.bak.*",
      "*.before-*",
      "*.before.*",
      "tmp-*.cjs",
      "*.tsbuildinfo",
      "client/src/index.css",
    ],
  },
  {
    files: sourceFiles,
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      "no-case-declarations": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "no-console": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-assignment": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
  {
    files: ["eslint.config.js", "vite.config.ts", "vitest.config.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
