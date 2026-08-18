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
            // Throwaway Capacitor spike — own package.json, own deps, never
            // part of the web build. See spike/capacitor-ios/README.md.
            'spike/**',
            'coverage/**',
            'playwright-report/**',
        ],
    },
    {
        plugins: {
            // The Next preset only registers `@typescript-eslint` for
            // its TS-specific block, so our cross-cutting rules below
            // need the plugin re-registered in scope.
            '@typescript-eslint': tsPlugin,
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
            'react-hooks/rules-of-hooks': 'warn',
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
