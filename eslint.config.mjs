import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "scripts/**", "test/**", "eslint.config.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        { brands: ["YouSpot", "Obsidian", "Brain"], ignoreRegex: ["^mcp_"] },
      ],
    },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
