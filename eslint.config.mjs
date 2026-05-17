import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    {
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/.next/**",
            "services/frontend-web/**",
            "services/backtest-engine/**",
            "services/strategy-engine/**",
            "**/*.config.{js,mjs,cjs,ts}",
            "**/coverage/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: { import: importPlugin },
        rules: {
            "@typescript-eslint/no-floating-promises": "off",
            "@typescript-eslint/no-misused-promises": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/consistent-type-imports": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "no-console": "warn",
            "eqeqeq": ["error", "always", { "null": "ignore" }],
            "prefer-const": "warn",
            "@typescript-eslint/no-unused-expressions": "warn",
            "no-restricted-imports": ["error", {
                patterns: [{
                    group: ["**/services/*/src/**"],
                    message: "Services must not import each other's src directly — go through @trader/* packages.",
                }],
            }],
        },
    },
    {
        files: ["**/__tests__/**", "**/*.test.ts", "**/tests/**"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "no-console": "off",
        },
    },
    prettier,
);
