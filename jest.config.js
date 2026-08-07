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
// ── Which coverage option belongs WHERE, and why it matters ──────────
//
// Jest splits a resolved config into a GlobalConfig and a per-project
// ProjectConfig (`groupOptions` in jest-config). Coverage options are
// split across both, and putting one on the wrong side makes it INERT
// — silently, with no warning:
//
//   • `collectCoverageFrom` is read from the GLOBAL config only.
//     `jest-runner` passes `globalConfig.collectCoverageFrom` into the
//     runtime's `shouldInstrument` options, and `@jest/reporters`
//     reads `globalConfig.collectCoverageFrom` in `_addUntestedFiles`.
//     A `collectCoverageFrom` written INSIDE a project block does
//     nothing at all.
//
//   • `coveragePathIgnorePatterns` is read from the PROJECT config
//     only — `shouldInstrument` tests it as
//     `config.coveragePathIgnorePatterns`, where `config` is the
//     project. And because `readConfigs` normalises every entry of
//     `projects:` STANDALONE (nothing at the top level is inherited by
//     a project), a top-level `coveragePathIgnorePatterns` never
//     reaches either project either.
//
// This repo previously carried a project-level `collectCoverageFrom`
// (positive scope + `!` negations). All of it was inert. The observable
// consequence: the emitted report contains every file any test happens
// to load — including `src/components/**` and `src/app/**`, neither of
// which the positive scope listed — and none of the `!` negations ever
// removed anything. That is the denominator every floor in
// `jest.thresholds.json` was calibrated against.
//
// Do NOT "fix" this by hoisting `collectCoverageFrom` to the top level.
// Activating it would drop `src/components/**` + `src/app/**` from the
// report entirely and force-include never-loaded files at 0% — i.e. it
// would redefine the population the floors describe, in one step, with
// no way to tell a real regression from the re-scoping. It would also
// revive `!src/**/types.ts`, which today would delete genuinely tested
// code from the report (`src/lib/errors/types.ts` alone is 26/26
// functions covered). The scope is what it is; the lever that works
// without redefining it is `coveragePathIgnorePatterns`, below.

// Pure re-export barrels — excluded from the coverage denominator.
//
// TypeScript compiles `export { X } from './m'` into
//   Object.defineProperty(exports, 'X', { get: function () { return m_1.X; } })
// and istanbul counts every one of those getters as a FUNCTION. A barrel
// that contains no logic therefore contributes dozens of permanently
// uncovered "functions" that exist only in the emitted JavaScript — there
// is nothing in the source to test. Type-only re-exports are erased and
// cost nothing, which is why the inflation tracks value exports.
//
// Measured on the 2026-07-29 main coverage artifact (run 30456542044):
// 350 functions across these files, 212 of them uncovered, and 0
// branches — none of it untested behaviour. Removing a distortion from
// the denominator beats writing hollow tests that import a barrel and
// assert nothing.
//
// ONLY files with no executable constructs belong here.
// `tests/guards/coverage-barrel-exclusion.test.ts` enforces that — a
// barrel that grows a `const`/`function`/arrow/`class` fails CI rather
// than quietly hiding real code behind this list. That guard also runs a
// real instrumented Jest pass and asserts the exclusion still takes
// EFFECT, because "the pattern is present in the config" and "the file
// left the report" turned out to be very different claims.
//
// Not every barrel qualifies. `src/components/ui/filter/index.ts`
// (`const Filter = { Select, List }`) and `src/components/ui/card-list/
// index.ts` (`Object.assign(...)`) hold real runtime values, so they
// stay in the denominator — the purity rule is the whole safeguard.
const PURE_REEXPORT_BARRELS = [
    'src/app-layer/automation/index.ts',
    'src/app-layer/integrations/providers/sharepoint/index.ts',
    'src/app-layer/libraries/index.ts',
    'src/app-layer/notifications/index.ts',
    'src/app-layer/usecases/audit-readiness/index.ts',
    'src/app-layer/usecases/control/index.ts',
    'src/app-layer/usecases/framework/index.ts',
    'src/components/command-palette/index.ts',
    'src/components/ui/charts/index.ts',
    'src/components/ui/dashboard-widgets/index.ts',
    'src/components/ui/date-picker/index.ts',
    'src/components/ui/icons/nucleo/index.ts',
    'src/components/ui/table/index.ts',
    'src/lib/audit/index.ts',
    'src/lib/hooks/index.ts',
    'src/lib/observability/index.ts',
];

/**
 * `coveragePathIgnorePatterns` entries are REGEXES tested against the
 * ABSOLUTE filename. Anchor both ends so `.../table/index.ts` cannot
 * accidentally match a longer path that merely contains it.
 */
const barrelIgnorePattern = (rel) =>
    `/${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

// Shared by BOTH projects — a barrel excluded from only one still lands
// in the merged report via the other (the UI barrels are loaded by the
// jsdom project, the app-layer ones by node).
//
// `/node_modules/` is restated deliberately: setting this key REPLACES
// jest's default `["/node_modules/"]`, and the ESM transform allowlist
// above means some node_modules files DO get transformed and would
// otherwise be instrumented.
const sharedCoveragePathIgnorePatterns = [
    '/node_modules/',
    '/\\.next/',
    ...PURE_REEXPORT_BARRELS.map(barrelIgnorePattern),
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
    // Project-level — this is the ONLY placement jest honours (see the
    // "which coverage option belongs WHERE" block above).
    coveragePathIgnorePatterns: sharedCoveragePathIgnorePatterns,
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
    //  The calibration convention is PR #233's, and it is the one
    //  `.github/workflows/ci.yml` records next to the gate step:
    //  **measured − 2, capped at 70, never lowering an
    //  already-stricter floor.** The 2-point buffer absorbs
    //  run-to-run jitter and ordinary churn; the cap at 70 is a
    //  brittleness ceiling — a hard gate above 70% blocks merges on
    //  any normal untested-feature dip. A floor already above 70
    //  (`policies/`, `usecases/` lines, …) stays where it is: the
    //  cap prevents RAISING past 70, it never licenses a drop.
    //
    //  Measure, do not guess. This box OOMs on the instrumented
    //  suite, so take the numbers from CI: `gh run download <id> -n
    //  coverage-report` on the newest completed main run and read
    //  `coverage-summary.json`. And compute PER THRESHOLD GROUP —
    //  jest removes a file from `global` the moment it matches a
    //  PATH threshold, so the whole-map `total` in that file is NOT
    //  the number the gate checks against `global`.
    //
    //  How to add a new gated path.
    //  Drop a new key (`'./src/<area>/'`) and run coverage to seed
    //  the floor. The path-prefix match is ~exact: trailing slash
    //  matters. Only add a path if the area has reached a coverage
    //  worth defending — otherwise the floor is noise.
    //
    //  The global floor, and why it is the one that fails.
    //  GAP-15 originally asked for 60/60 globally against measured
    //  br=50/fn=50/ln=62/st=59 — not reachable at the time. It is
    //  now: every global metric clears 60, and the enforced floors
    //  sit at the cap (lines/statements) or just under it
    //  (branches/functions). `global` is nonetheless the group that
    //  reddens the gate, because it is scored over the REMAINDER —
    //  `src/components/**`, `src/app/**` and the parts of
    //  `src/app-layer/**` outside the four path thresholds — which
    //  is where the untested surface concentrates. The durable lever
    //  is unchanged: cover files in that remainder (repositories,
    //  route handlers, components), then lift the floor in the same
    //  PR. Covering something under `src/lib/` moves `./src/lib/`
    //  and leaves `global` exactly where it was.
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
    // Default test timeout is set via `jest.setTimeout()` in
    // tests/rendered/setup.ts (a project-level `testTimeout` here is
    // ignored). That call went missing for a long time, so this project
    // silently ran at Jest's 5s default and produced load-dependent
    // flakes — if you move or delete the setup file, move the timeout
    // with it.
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
    // Same filter as the node project. Load-bearing here specifically:
    // the UI barrels (charts, date-picker, table, …) are pulled in by
    // `tests/rendered/**`, so without this the jsdom project would put
    // them straight back into the merged report.
    coveragePathIgnorePatterns: sharedCoveragePathIgnorePatterns,
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
    // NOTE: there is deliberately NO top-level `coveragePathIgnorePatterns`
    // here. It reads like a global filter and is not one — `readConfigs`
    // normalises each `projects:` entry standalone, so a copy at this level
    // reaches neither project. It lived here for a long time carrying
    // `['/node_modules/', '/.next/', '/tests/']` and filtered nothing; the
    // proof is that `tests/helpers/*.ts`, `scripts/*.ts` and `jest.config.js`
    // itself are all in the published coverage artifact. The real filter is
    // `sharedCoveragePathIgnorePatterns`, set on BOTH projects above.
    //
    // `/tests/` was NOT carried over into the project-level list. Making it
    // effective is a denominator change, not a bug fix: measured on the
    // 2026-07-29 artifact it moves `global` functions by -0.32pp (test
    // helpers are well covered) while leaving `scripts/` and `prisma/` in
    // the report regardless. That belongs in its own PR against its own
    // floor recalibration.
    //
    // `coverageThreshold` IS intentionally on the node project below —
    // jest silently ignores a top-level `coverageThreshold` when
    // `projects:` is set. See the comment block on
    // `nodeProject.coverageThreshold` for the full GAP-15 history.
    // `json-summary` writes coverage/coverage-summary.json — per-file
    // covered/total for every metric. It is the ONLY output that lets you
    // work out WHICH files a threshold failure came from.
    //
    // Why that is not obvious, and why this line matters:
    //
    //   Jest removes a file from the `global` threshold group as soon as it
    //   matches a PATH threshold. `jest.thresholds.json` declares paths for
    //   ./src/app-layer/{usecases,policies,events}/ and ./src/lib/, so the
    //   `global` numbers are computed over EVERYTHING ELSE — chiefly
    //   src/components/**, src/app/**, and the rest of src/app-layer/**.
    //
    //   The consequence is a genuinely confusing failure. `text-summary`
    //   prints the whole-map figure (e.g. "Branches: 66.54%") while the gate
    //   fails with a different, lower one ("Coverage for branches (59.94%)
    //   does not meet global threshold (63%)"). Both are correct; they are
    //   different populations. Without a per-file report there is no way to
    //   reconcile them, and effort gets aimed at files that cannot move the
    //   failing number — covering something under src/lib/ improves the
    //   ./src/lib/ threshold and leaves `global` untouched.
    //
    // Keep `json-summary` here. `coverage/` is uploaded whole by the CI
    // coverage job, so the artifact carries it automatically.
    coverageReporters: ['text-summary', 'lcov', 'json-summary'],
};
