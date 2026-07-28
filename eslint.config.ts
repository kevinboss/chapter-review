// Flat config, following typescript-eslint's current typed-linting guide:
// `defineConfig`, `projectService: true`, and no `tsconfigRootDir` (that is a
// legacy-config concern). Every .ts/.mts file in the repo belongs to one of the
// four tsconfigs, which is what lets the type-aware rules run.
//
// Tier is strict-type-checked rather than recommended-type-checked: the upstream
// advice is to take it only where the developers are comfortable in TypeScript,
// and the point of this setup is to catch `any` — including the `any` that leaks
// in untyped from JSON.parse and child_process, which only the type-aware
// no-unsafe-* rules see.

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "**/node_modules/",
      "extension/out/", // tsc output
      "extension/skill/", // generated copy of the skill, rebuilt by bundle-skill.mts
      "demo/", // throwaway fixture repo, rebuilt by scripts/make-demo.ts
      "demo-fixtures/", // C# fixture trees
    ],
  },
  {
    files: ["**/*.ts", "**/*.mts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // Redundant under strict-type-checked, but stated outright because banning
      // `any` is the reason this config exists.
      "@typescript-eslint/no-explicit-any": "error",
      // strict-type-checked forbids interpolating even a number into a template
      // literal, forcing String(n). That is a style position, not a safety one —
      // `${count}` cannot go wrong the way `${someAny}` can — so numbers are
      // allowed back. Everything else the rule catches (objects, any, nullish)
      // stays an error.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      // Prefer pulling fields out of an object over repeated member access. The
      // typescript-eslint version understands type annotations, so it does not
      // fire where destructuring would lose a needed type; arrays are left alone
      // because `const first = arr[0]` usually reads better than destructuring.
      "prefer-destructuring": "off",
      "@typescript-eslint/prefer-destructuring": [
        "error",
        { object: true, array: false },
      ],
    },
  },
  {
    // node:test's `test()` returns a promise the runner owns; calling it at top
    // level without awaiting is the documented usage, not a dropped promise.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
]);
