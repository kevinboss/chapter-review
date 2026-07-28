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
      // A whole VS Code install, downloaded by @vscode/test-electron. Typed
      // linting runs out of heap trying to read it.
      "**/.vscode-test/",
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
      "@typescript-eslint/no-unsafe-type-assertion": "error",
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
      // No `delete`: it mutates in place, so the shape change reaches every
      // other holder of the reference, and it strips a property the type still
      // promises. Build the value without the key instead.
      "no-restricted-syntax": [
        "error",
        {
          selector: "UnaryExpression[operator='delete']",
          message:
            "Don't use `delete`. Assign undefined and strip it with withoutUndefined(), or destructure the key out.",
        },
        // No `let`. A rebindable local means the reader has to track its value
        // through every branch to know what it holds at the end. Compute the
        // value instead: a helper that returns it, a ternary, or map/filter/
        // reduce over the sequence you were accumulating.
        {
          selector: "VariableDeclaration[kind='let']",
          message: "Use `const`. Compute the value with a helper or an expression instead of rebinding.",
        },
      ],
    },
  },
  {
    // node:test's `test()`/`describe()`/`it()` return a promise the runner owns;
    // calling them at top level without awaiting is the documented usage, not a
    // dropped promise. Mocha's `suite()`/`test()` in the extension host suite are
    // synchronous, but sit in the same folders.
    files: ["test/**/*.ts", "extension/src/test/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
]);
