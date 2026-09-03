import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

/**
 * Obsidian's own review rules. The workspace lints with oxlint, which knows
 * nothing about the plugin API — these are the checks the community-plugin
 * reviewers actually run, so the plugin carries its own config and this is
 * the gate that decides whether a submission is ready.
 *
 * scripts/ and test/ are excluded: they never ship inside the plugin, and
 * the rules are about runtime behaviour in Obsidian.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "scripts/**", "test/**", "eslint.config.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      /**
       * The declarative settings API landed in 1.13.0. Adopting it means
       * raising minAppVersion by eight minor versions to gain settings-search
       * integration, which is not a trade worth making while the plugin is
       * new. Revisit when 1.13 is the floor rather than the ceiling.
       */
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
    },
  },
);
