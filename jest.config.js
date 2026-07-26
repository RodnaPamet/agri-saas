/**
 * Jest configuration — multi-project split.
 *
 *   `node` project: the existing 10,031-test suite (unit / integration /
 *     guards / ratchets) — runs under node, no DOM. Keeps the fast
 *     source-contract + backend tests isolated from the heavier jsdom
 *     boot.
 *
 *   `jsdom` project (Epic 55 hardening pass): real React render tests
 *     for the shared UI primitives. Scoped to `tests/rendered/**` so the
 *     existing suite continues to run under node with no behavioural
 *     change. Adds `@testing-library/react` + `@testing-library/jest-dom`
 *     + `jest-axe` for accessibility checks.
 *
 * Coverage settings live on the node project since the jsdom project
 * covers only the UI layer which has its own contract.
 */

// GAP-04 — post NextAuth v4 migration the ESM transform allowlist
// is much shorter. v4 ships as CJS so `next-auth` itself doesn't
// need transforming. The remaining entries (`jose`, `preact`,
// `preact-render-to-string`) are kept because they're transitive ESM
// deps of providers that v4 still pulls in (e.g. JWT signing via
// jose). `oauth4webapi` and `@auth/*` were v5-specific and can be
// dropped from the allowlist.
const ESM_TRANSFORM_ALLOW_LIST =
    'jose|preact|preact-render-to-string|next-intl|use-intl|@formatjs|intl-messageformat|' +
    // sanitize-html (Epic C.5 server-side sanitiser) resolves an ESM
    // htmlparser2 build (`dist/index.js` uses `import`) plus its DOM
    // cluster. Many usecase suites transitively import the sanitiser, so
    // the whole cluster must be transpiled by ts-jest or they fail to load
    // with "Cannot use import statement outside a module". Over-inclusion
    // is safe — ts-jest passes plain CJS through unchanged.
    'sanitize-html|htmlparser2|domelementtype|domhandler|domutils|dom-serializer|entities';

// ─── Coverage thresholds ─────────────────────────────────────────────
//
// Single source of truth for the coverage floors. Loaded here so the
// repo has ONE place where the numbers live; the CI gate reads the
// SAME file and passes it via `--coverageThreshold` CLI flag because
// jest 29.7.0's per-project `coverageThreshold` (and even the top-
// level one in multi-project mode) is silently NOT enforced — the
// run exits 0 even when observed coverage is 9% against a 99% floor.
// The CLI flag IS enforced (exit 1 + violation message). See
// docs/implementation-notes/2026-04-27-gap-15-coverage-enforcement.md
// for the empirical proof + why this layout was chosen.
//
// Writing the values here too gives `npm run test:coverage` (no CLI
// flag) the same documented thresholds — they print to the summary
// even though they don't fail the run. The CI gate is the only
// authoritative enforcement point today.
const coverageThresholds = require('./jest.thresholds.json');

// ─── Coverage scope (shared across both projects) ────────────────────
//
// `coverageThreshold` MUST live inside a project block, NOT at the
// top-level `module.exports`. Jest's multi-project handling silently
// ignores top-level `coverageThreshold` when `projects:` is set —
// historically this codebase had it at the top, which meant the
// thresholds were documented but NEVER enforced. The Coverage CI gate
// passed regardless of observed numbers.
//
// The fix (GAP-15 step 3 closure): keep `collectCoverageFrom` at the
// top level (so both projects' test runs feed the same coverage scope)
// but move the THRESHOLD into the node project's config below — that
// project owns the file types in the scope (`*.ts` under `src/app-layer/`
// and `src/lib/`). The jsdom project covers UI primitives in
// `src/components/**` which are deliberately out of scope today.
const sharedCollectCoverageFrom = [
    'src/app-layer/**/*.ts',
    'src/lib/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/types.ts',
    // Colocated test files are not production code, but they ARE `.ts` under
    // the two scoped roots — so they were being scored as 0%-covered source
    // and dragging the global threshold down. Two files today
    // (src/lib/controls/__tests__/control-taxonomy.test.ts,
    // src/app-layer/utils/__tests__/cadence.test.ts); excluded by pattern so a
    // third cannot reintroduce the distortion.
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
];

/** @type {import('jest').Config} */
const nodeProject = {
    displayName: 'node',
    preset: 'ts-jest',
    testEnvironment: 'node',
    // NOTE: the default test timeout is set via `jest.setTimeout()` in
    // the setupFilesAfterEnv files below — Jest ignores a project-level
    // `testTimeout`, so it MUST go through a setup file (or root config).
    setupFiles: ['<rootDir>/jest.setup.js'],
    // - `jsdom-shims.ts` covers the handful of node-project tests that
    //   opt into jsdom via per-file `@jest-environment jsdom`
    //   directives. Safe to load in pure-node tests too (feature-
    //   detects `window`).
    // - `disconnect-after-suite.ts` registers a global `afterAll` that
    //   closes the `prismaTestClient()` singleton. Without it Jest
    //   workers exit via forceExit (see the "failed to exit
    //   gracefully" warning).
    setupFilesAfterEnv: [
        '<rootDir>/tests/setup/jsdom-shims.ts',
        '<rootDir>/tests/setup/disconnect-after-suite.ts',
    ],
    globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
    globalTeardown: '<rootDir>/tests/setup/teardown.ts',
    moduleNameMapper: {
        '^@/env$': '<rootDir>/tests/mocks/env.ts',
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    testMatch: ['**/*.test.ts', '**/*.test.js'],
    testPathIgnorePatterns: [
        '<rootDir>/.next/',
        '<rootDir>/node_modules/',
        '<rootDir>/tests/e2e/',
        '<rootDir>/tests/rendered/',
        '<rootDir>/dub-reference/',
        // Epic 67 — co-located UI hook tests live next to the hook
        // (`src/components/ui/hooks/__tests__/`) but require jsdom
        // (RTL render, real React lifecycle). Excluded from the node
        // project so they run exclusively under the jsdom project's
        // testMatch.
        '<rootDir>/src/.*/__tests__/',
    ],
    transform: {
        '^.+\\.(ts|tsx)$': 'ts-jest',
        // Transpile the NextAuth ESM graph so middleware-importing
        // tests load without `SyntaxError: Cannot use import statement
        // outside a module`.
        '^.+\\.m?js$': 'ts-jest',
    },
    transformIgnorePatterns: ['node_modules/(?!(' + ESM_TRANSFORM_ALLOW_LIST + ')/)'],
    // Inherits the shared collection scope so the node + jsdom projects
    // emit a comparable merged report.
    collectCoverageFrom: sharedCollectCoverageFrom,
    // ─── Coverage ratchet (GAP-15) ───────────────────────────────────
    //
    // POLICY: `docs/coverage-policy.md` is the risk-tiered coverage
    // policy — why each layer carries the bar it does (usecases/ and
    // policies/ are the highest-assurance tier), the end-state
    // targets, and the staged ratchet plan. The numbers below /
    // in `jest.thresholds.json` are the CURRENT FLOOR on that path.
    //
    // These thresholds DO enforce — they live on the node project, not
    // at the top-level config (where jest silently ignores them in
    // multi-project mode).
    //
    //  Why this is a ratchet, not a target.
    //  The thresholds below are the CURRENT FLOOR, not aspirational
    //  numbers. The single rule: when you add tests that raise the
    //  observed coverage, lift the floor in the same PR so the gain
    //  is locked in. Never lower a floor to "make CI green" — that
    //  is the failure mode the audit caught (GAP-02). Either add the
    //  test that restores the lost coverage, or revert the change
    //  that lost it.
    //
    //  How to raise.
    //  Run `npx jest --coverage --runInBand` locally (or wait for
    //  the CI coverage job to print the summary on your PR) and set
    //  each per-path floor to ~3% below the freshly observed number.
    //  The 3% buffer absorbs run-to-run jitter from parallel-worker
    //  scheduling and the occasional skipped suite. Pick the same
    //  buffer across metrics so the ratchet moves uniformly.
    //
    //  How to add a new gated path.
    //  Drop a new key (`'./src/<area>/'`) and run coverage to seed
    //  the floor. The path-prefix match is ~exact: trailing slash
    //  matters. Only add a path if the area has reached a coverage
    //  worth defending — otherwise the floor is noise.
    //
    //  Why the global is below 60.
    //  The audit's GAP-15 originally asked for 60/60 globally. The
    //  current numbers (br=50/fn=50/ln=62/st=59) say that target is
    //  not realistic with the current scope: `src/lib/**` includes
    //  one-shot scripts, instrumentation helpers, and CLI entry
    //  points shipped intentionally without unit tests. Tightening
    //  the global to match raw averages would penalise legitimate
    //  utility code; the durable lever is per-path tightening on
    //  areas that matter (e.g. `usecases/`) PLUS the structural
    //  enforcement fix above. When a future hardening pass either
    //  trims the scope (excludes scripts) or invests in src/lib/
    //  test coverage, raise the global toward 60.
    //
    //  What kinds of usecase tests count for the floor.
    //  The Wave 1-4 tests (`docs/implementation-notes/2026-04-25-
    //  gap-02-usecase-ratchet.md`) establish the contract:
    //    - assertCanRead/Write/Admin gates on every privileged path
    //    - sanitisation of every free-text field BEFORE persistence
    //      (Epic D.2 / C.5) — render-time only is not sufficient
    //    - cross-tenant id rejection (notFound on a cross-tenant
    //      lookup, not silent acceptance)
    //    - audit emission per state change (action + entityType)
    //    - notFound paths exercised
    //    - idempotency where applicable (e.g. archive/unarchive)
    //    - load-bearing transition ordering (e.g. promote-before-
    //      demote in tenant-ownership transfer)
    //  Each test should name the regression class it protects in a
    //  comment so the next reader can judge whether a refactor is
    //  weakening a guard.
    // Loaded from jest.thresholds.json (single source of truth shared
    // with CI). NOT authoritative — see the GAP-15 comment above and
    // the implementation note. The CI gate's --coverageThreshold flag
    // is the authoritative enforcement point.
    coverageThreshold: coverageThresholds,
};

/** @type {import('jest').Config} */
const jsdomProject = {
    displayName: 'jsdom',
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    // Default test timeout set via `jest.setTimeout()` in
    // tests/rendered/setup.ts (project-level testTimeout is ignored).
    setupFiles: ['<rootDir>/jest.setup.js'],
    setupFilesAfterEnv: ['<rootDir>/tests/rendered/setup.ts'],
    moduleNameMapper: {
        '^@/env$': '<rootDir>/tests/mocks/env.ts',
        '^@/(.*)$': '<rootDir>/src/$1',
        // Epic 41 — react-grid-layout uses the package `exports` field
        // to map `react-grid-layout/legacy` → `dist/legacy.js`. Jest's
        // CJS resolver doesn't honour subpath exports under all
        // tsconfigs, so map the subpath to the resolved file directly.
        '^react-grid-layout/legacy$':
            '<rootDir>/node_modules/react-grid-layout/dist/legacy.js',
        '^react-grid-layout/css/styles\\.css$':
            '<rootDir>/tests/rendered/style-mock.ts',
        '^react-resizable/css/styles\\.css$':
            '<rootDir>/tests/rendered/style-mock.ts',
        // Pass-through stub for render tests that transitively touch the
        // Tooltip primitive through Button / Switch / StatusBadge (all of
        // which import it via `./tooltip`). Radix Tooltip requires a
        // TooltipProvider in the tree and emits portalised content — the
        // stub keeps those tests decoupled from that lifecycle. The
        // dedicated tooltip test at `tests/rendered/tooltip.test.tsx`
        // imports via `@/components/ui/tooltip` which is resolved by the
        // generic `@/` mapper above and bypasses this stub.
        '^\\.\\./tooltip$': '<rootDir>/tests/rendered/tooltip-mock.tsx',
        '^\\./tooltip$': '<rootDir>/tests/rendered/tooltip-mock.tsx',
        // Same problem with react-markdown directly.
        '^react-markdown$': '<rootDir>/tests/rendered/react-markdown-mock.tsx',
        // Vaul drawer crashes under React 19 (`transform.match(...)`
        // on undefined during pointer-up math). Render tests for
        // Modal etc. don't exercise drag gestures; a pass-through
        // stub keeps them decoupled. Re-evaluate when Vaul ships a
        // React 19 fix.
        '^vaul$': '<rootDir>/tests/rendered/vaul-mock.tsx',
        // CSS and static asset stubs for jsdom.
        '\\.(css|less|scss|sass)$': '<rootDir>/tests/rendered/style-mock.ts',
        // Epic 61 — `@number-flow/react` ships a custom-element + Web
        // Animations runtime that jsdom only partially supports. The
        // mock renders the same Intl.NumberFormat output the real
        // component settles on, so card render tests can assert on the
        // formatted text deterministically.
        '^@number-flow/react$': '<rootDir>/tests/rendered/number-flow-mock.tsx',
    },
    testMatch: [
        '<rootDir>/tests/rendered/**/*.test.{ts,tsx}',
        // Epic 67 — co-located UI hook tests pattern. Establishes the
        // future home for hook-level RTL tests so they live next to the
        // hook they verify rather than under tests/rendered/. The
        // existing `tests/rendered/` location stays valid for tests
        // that span multiple primitives or pages.
        '<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}',
    ],
    testPathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/node_modules/'],
    transform: {
        '^.+\\.(ts|tsx)$': [
            'ts-jest',
            { tsconfig: '<rootDir>/tests/rendered/tsconfig.json' },
        ],
        // Allow Jest to transpile transitively-imported ESM in
        // node_modules (react-markdown, @tiptap/*, etc.) so the shared
        // Tooltip / RichTextArea imports resolve under jsdom.
        '^.+\\.m?js$': [
            'ts-jest',
            { tsconfig: '<rootDir>/tests/rendered/tsconfig.json' },
        ],
    },
    transformIgnorePatterns: [
        // Explicitly allow ESM packages in the shared primitive graph
        // to be transformed. Everything else stays native-require.
        'node_modules/(?!(' +
            'react-markdown|' +
            'vfile|vfile-message|' +
            'unist-util-[^/]+|' +
            'mdast-util-[^/]+|' +
            'micromark[^/]*|' +
            'decode-named-character-reference|' +
            'character-entities[^/]*|' +
            'property-information|' +
            'hast-util-[^/]+|' +
            'space-separated-tokens|' +
            'comma-separated-tokens|' +
            'bail|is-plain-obj|trough|unified|' +
            'remark-[^/]+|rehype-[^/]+|' +
            '@tiptap/[^/]+|' +
            'prosemirror-[^/]+|' +
            'linkify-it|markdown-it|orderedmap|' +
            'w3c-keyname|' +
            // Epic 59 — chart platform. visx re-exports d3 modules
            // that ship as ESM; ts-jest must transform them so any
            // jsdom test importing `@/components/ui/charts` resolves
            // its full graph.
            '@visx/[^/]+|' +
            'd3-[^/]+|' +
            'internmap|delaunator|robust-predicates|' +
            // Epic 41 — react-grid-layout v2 ships ESM at the main
            // entry. Allow it through transform so the legacy
            // wrapper used by `<DashboardGrid>` resolves under jsdom.
            'react-grid-layout|react-resizable|react-draggable|' +
            // NextAuth v5 ships as ESM. The edge/node auth split
            // makes middleware.ts directly `import NextAuth from
            // "next-auth"`, so any unit/integration test that
            // imports middleware (cors.test.ts, auth-ratelimit.test.ts,
            // etc.) needs these transformed. Without this, the test
            // runner chokes with `SyntaxError: Cannot use import
            // statement outside a module` on next-auth/index.js.
            'next-auth|@auth/[^/]+|oauth4webapi|jose|preact|preact-render-to-string' +
            ')/)',
    ],
    // Same scope as the node project — jsdom-suite tests of UI
    // primitives don't typically touch `src/app-layer/` or `src/lib/`
    // directly, but coverage data from any incidental hits still
    // contributes to the merged report.
    collectCoverageFrom: sharedCollectCoverageFrom,
};

module.exports = {
    projects: [nodeProject, jsdomProject],
    // Recycle a worker once its heap crosses this after a suite. Over a
    // ~1400-suite run a long-lived worker accumulates module + mock state
    // until GC stalls (or it OOMs), which surfaces as NON-deterministic
    // "passes in isolation, fails in one parallel run" flakes on whatever
    // suite happened to be in-flight (observed: framework-tree-builder,
    // observability-metrics, mailer-init-wiring — all pure/structural, i.e.
    // not their own bug). Restarting the ballooned worker keeps heaps bounded
    // and the run reproducible. Belt-and-braces with the per-worker DB
    // isolation from the flake-fix (#951).
    workerIdleMemoryLimit: '512MB',
    // forceExit DELIBERATELY OFF — Jest exits naturally once the
    // disconnect-after-suite hook in tests/setup/disconnect-after-suite.ts
    // has closed the prisma + bullmq + audit-stream singletons. With
    // forceExit:true Jest emits the "A worker process has failed to
    // exit gracefully" warning even when there's no real leak (just
    // handles that close slightly past the default grace window).
    // Without it the run is ~30% slower but the warning goes away
    // and a real future leak will hang CI immediately, surfacing it
    // for diagnosis instead of getting masked.
    forceExit: false,
    // Path filter applies across both projects.
    coveragePathIgnorePatterns: ['/node_modules/', '/.next/', '/tests/'],
    // NOTE: `coverageThreshold` and `collectCoverageFrom` are
    // INTENTIONALLY on the node project below, not here. Jest silently
    // ignores top-level `coverageThreshold` when `projects:` is set —
    // see the comment block on `nodeProject.coverageThreshold` for the
    // full GAP-15 enforcement-fix history.
    coverageReporters: ['text-summary', 'lcov'],
};
