/**
 * Flat ESLint config — replaces `.eslintrc.json` after the Next 16
 * upgrade. Next 16's `eslint-config-next` ships flat config only,
 * which the legacy `.eslintrc.json` extends mechanism can't consume
 * (the deep-merge throws "Converting circular structure to JSON").
 *
 * Mirrors the rule layout from the previous `.eslintrc.json`:
 *   - default: warn on `any`, restrict deep table imports, allow
 *     described `@ts-ignore` / `@ts-expect-error`.
 *   - tests: relax `no-restricted-imports`.
 *   - `src/lib/security/**` + `src/middleware.ts`: error on `any`.
 *   - `src/app/**Client.tsx`: ban SkeletonTableRow / SkeletonDataTable
 *     imports + restrict deep table imports.
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
// Source the plugin from the `typescript-eslint` meta-package — the
// SAME object `eslint-config-next` registers (its `next/typescript`
// block does `'@typescript-eslint': typescript-eslint.plugin`). A
// direct `@typescript-eslint/eslint-plugin` import is a separate copy:
// when its version skews from the one the meta-package pins (e.g. the
// plugin on ^8.61.1 while the meta stays ^8.61.0), the two registrations
// become different objects under one name and ESLint flat config throws
// "Cannot redefine plugin @typescript-eslint". Reusing the meta's
// `.plugin` keeps a single shared reference regardless of patch skew.
import tseslint from 'typescript-eslint';

const tsPlugin = tseslint.plugin;

/**
 * The Next preset's OWN plugin object for `name`, by reference.
 *
 * The cross-cutting block below has no `files:` key, so it applies to every
 * linted file — but the preset registers its plugins in a block whose glob
 * covers only `.js`, `.jsx`, `.mjs`, `.ts`, `.tsx`, `.mts` and `.cts`.
 * `.cjs` is NOT in it and ESLint lints `.cjs` by default, so on any `.cjs`
 * file the block's `react-hooks/*` and `react/*` rules named a plugin that
 * was not in scope and ESLint aborted the WHOLE run with "could not find
 * plugin react-hooks" — a message that reads as cache corruption or
 * lockfile drift long before it reads as config scoping. Re-registering
 * them here is the follow-through the `tsPlugin` note above already
 * describes for `@typescript-eslint`. Refs #1284.
 *
 * BY REFERENCE, not by a fresh `import 'eslint-plugin-react-hooks'`, for the
 * same reason `tsPlugin` comes out of the meta-package: a direct import is a
 * separate copy the moment npm nests one, and two objects under one name is
 * exactly what makes flat config throw "Cannot redefine plugin". Taking the
 * preset's own object makes a second copy impossible however the tree hoists.
 */
function presetPlugin(name) {
    const plugin = nextCoreWebVitals.find((c) => c?.plugins?.[name])?.plugins[name];
    if (!plugin) {
        // A silent `undefined` would put those rules back out of scope and
        // abort every run again, so fail loudly at config load instead.
        throw new Error(
            `eslint.config.mjs: eslint-config-next no longer registers a '${name}' plugin, ` +
                `so the cross-cutting ${name}/* rules have nothing to resolve against. ` +
                'Re-point this at wherever the plugin now comes from. Refs #1284.',
        );
    }
    return plugin;
}

const reactHooksPlugin = presetPlugin('react-hooks');
const reactPlugin = presetPlugin('react');

const config = [
    ...nextCoreWebVitals,
    {
        ignores: [
            '.next/**',
            // Local E2E (`scripts/e2e-local.mjs`) writes a Next build
            // to `.next-test/` (controlled by `distDir` when
            // `NEXT_TEST_MODE=1`). The chunks there are minified
            // bundler output that trip Next ESLint rules
            // (`@next/next/no-assign-module-variable` etc.) — they're
            // build artefacts, not source.
            '.next-test/**',
            'node_modules/**',
            'coverage/**',
            'playwright-report/**',
            // esbuild output from `npm run build:worker` / `build:seed`
            // (`dist/worker.mjs`, `scheduler.mjs`, `seed.mjs`,
            // `worker-healthcheck.mjs`). Bundled artefacts, not source —
            // and `dist/` is gitignored, so CI's fresh checkout never has
            // them while a developer who has run the worker build does.
            // That asymmetry made `npm run lint` FAIL locally and PASS in
            // CI on identical code: measured 122 vs 121, the whole
            // difference being one warning inside `dist/worker.mjs`.
            'dist/**',
            // Agent/workflow git worktrees are created INSIDE the repo at
            // `.claude/worktrees/<run>/`. They are gitignored, but ESLint
            // walks `.` and does not read .gitignore, so it descends into
            // them. Two failure modes, both measured:
            //
            //   1. a worktree removed mid-run makes the gate CRASH rather
            //      than fail — `lint ceiling failed to run: ENOENT …
            //      .claude/worktrees/wf_…/src/lib/auth/native/auth-codes.ts`
            //   2. a worktree that LINGERS (one whose agent changed files is
            //      kept, not auto-removed) adds a second full copy of the
            //      tree — ~3,900 files — so every count roughly doubles and
            //      every ceiling blows for a reason that has nothing to do
            //      with the diff.
            //
            // Same reasoning as `dist/**` directly above: a gate that
            // disagrees with itself depending on what else is running gets
            // diagnosed as flaky and then ignored.
            '.claude/**',
        ],
    },
    {
        plugins: {
            // The Next preset only registers `@typescript-eslint` for
            // its TS-specific block, so our cross-cutting rules below
            // need the plugin re-registered in scope.
            '@typescript-eslint': tsPlugin,
            // `react-hooks` (ten rules below) and `react`
            // (`no-find-dom-node`) for the same reason — see
            // `presetPlugin` above. Both were out of scope on a `.cjs`
            // file; `react-hooks` is only the one ESLint names FIRST.
            'react-hooks': reactHooksPlugin,
            react: reactPlugin,
        },
        rules: {
            // React 19's `eslint-plugin-react-hooks@6+` ships a set
            // of compiler-aware rules (`set-state-in-effect`, `refs`,
            // `immutability`, `error-boundaries`) that flag real but
            // non-breaking patterns across ~140 existing call sites.
            // Migrating each is a separate epic — downgrade to warn so
            // CI is unblocked and the violations stay visible.
            'react-hooks/set-state-in-effect': 'warn',
            'react-hooks/refs': 'warn',
            'react-hooks/immutability': 'warn',
            // NOT downgraded, unlike its neighbours above. `rules-of-hooks`
            // catches conditional/early-return hook calls — the exact defect
            // that shipped a React "rendered more hooks than during the
            // previous render" crash (#872). Its four remaining repo hits
            // were all the `use*` NAMING heuristic misfiring on non-hooks;
            // those functions were renamed (`secureCookiesEnabled`,
            // `applyTemplate`) rather than suppressed, so this can be an
            // error with zero violations. Refs #874.
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/error-boundaries': 'warn',
            'react-hooks/purity': 'warn',
            'react-hooks/static-components': 'warn',
            'react-hooks/use-memo': 'warn',
            'react-hooks/set-state-in-render': 'warn',
            // `findDOMNode` is deprecated but the existing ~18 call
            // sites are inside library wrappers (vaul, react-grid-
            // layout) that haven't migrated yet. Surface as warn.
            'react/no-find-dom-node': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/ban-ts-comment': [
                'warn',
                {
                    'ts-ignore': 'allow-with-description',
                    'ts-expect-error': 'allow-with-description',
                },
            ],
            'no-restricted-imports': [
                'warn',
                {
                    patterns: [
                        {
                            group: ['@/components/ui/table/*'],
                            message:
                                "Import from '@/components/ui/table' (barrel) instead of deep sub-modules.",
                        },
                    ],
                },
            ],
        },
    },
    {
        files: [
            'tests/**/*',
            '**/*.test.ts',
            '**/*.test.tsx',
            '**/*.spec.ts',
        ],
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-restricted-imports': 'off',
        },
    },
    {
        files: ['src/lib/security/**/*', 'src/middleware.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        files: ['src/app/**/*Client.tsx'],
        rules: {
            'no-restricted-imports': [
                'warn',
                {
                    paths: [
                        {
                            name: '@/components/ui/skeleton',
                            importNames: ['SkeletonTableRow', 'SkeletonDataTable'],
                            message:
                                "Use DataTable's `loading` prop instead of SkeletonTableRow. See src/components/ui/table/GUIDE.md",
                        },
                    ],
                    patterns: [
                        {
                            group: ['@/components/ui/table/*'],
                            message:
                                "Import from '@/components/ui/table' (barrel) instead of deep sub-modules.",
                        },
                    ],
                },
            ],
        },
    },
];

export default config;
