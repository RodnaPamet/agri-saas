/**
 * Ratchet: every business-logic usecase must have at least one
 * importing test under `tests/unit/` or `tests/integration/`.
 *
 * Why this exists: the existing CI coverage gate
 * (`jest.thresholds.json` via the `--coverageThreshold` CLI flag) is
 * an *aggregate* floor — a new untested usecase with 50 statements
 * barely moves the global percentage and can slip in silently. This
 * guardrail catches it structurally, at PR time, by scanning the
 * test tree for an import of each usecase file.
 *
 * Adding a new usecase?
 *   - Land at least one test in `tests/unit/` (preferred — mocks the
 *     repo seam) or `tests/integration/` (DB-backed) that imports
 *     the usecase via its canonical `@/app-layer/usecases/<name>`
 *     specifier. Importing via the domain barrel
 *     (`@/app-layer/usecases/control`) also counts.
 *
 * Currently untested files are listed in `EXEMPTIONS` with a written
 * reason. The list can only shrink — a CI assertion below enforces
 * that the count never grows. Earning your way off the list happens
 * by landing a test in the same PR that removes the exemption.
 *
 * The ratchet is intentionally case-sensitive on the import path
 * shape and only counts `from '<X>'` imports — the goal is to catch
 * "I touched the usecase but forgot the test," not to police styles.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const USECASE_DIR = path.join(REPO_ROOT, 'src/app-layer/usecases');
const TEST_DIRS = [
    path.join(REPO_ROOT, 'tests/unit'),
    path.join(REPO_ROOT, 'tests/integration'),
];

/**
 * Files we deliberately allow without an importing test today. Each
 * entry has a written reason. Roadmap (`docs/test-coverage-roadmap.md`)
 * tracks the planned Q1/Q2/Q3 work to close the list.
 *
 * The list can only SHRINK — the count assertion below catches any
 * growth. To add a test for one of these files, remove the entry in
 * the same PR as the test lands; CI is happy as long as the count
 * goes down.
 */
const EXEMPTIONS: Record<string, string> = {
    // Q1 — Compliance core targets in roadmap. clause/mapping back the
    // framework + cross-framework projection layer; tested today
    // transitively via control.queries integration tests but the
    // ratchet asks for a direct import.
    'src/app-layer/usecases/clause.ts':
        'Roadmap Q1 — exercised transitively via control/framework tests; direct unit tests pending.',
    'src/app-layer/usecases/framework/catalog.ts':
        'Roadmap Q1 — fixtures-driven catalog loader, currently exercised only via framework.install integration.',
    'src/app-layer/usecases/framework/tree.ts':
        'Roadmap Q1 — pending direct unit tests.',

    // Q2 — Audit + audit-trail
    'src/app-layer/usecases/org-audit.ts':
        'Roadmap Q2 — org-scoped audit feed projection; pending direct tests.',

    // Q3 — Reports + cross-domain
    'src/app-layer/usecases/report.ts':
        'Roadmap Q3 — report rendering orchestration; covered indirectly by PDF/export integration suites.',
    'src/app-layer/usecases/notification.ts':
        'Roadmap Q3 — notification dispatch; covered indirectly by deadline-monitor + automation tests.',

    // Inherited data / vendor-audit / traceability-graph — supporting domains
    'src/app-layer/usecases/inherited-control-data.ts':
        'Roadmap Q3 — vendor → tenant inherited control denormalisation, indirectly exercised by vendor.assessment tests.',
    'src/app-layer/usecases/vendor-audit.ts':
        'Roadmap Q2 — vendor audit cycle, pending direct unit tests in Vendor PR.',
    'src/app-layer/usecases/traceability.ts':
        'Asset ↔ control mapping verbs, exercised end-to-end through the control detail page; pending direct unit tests. (Replaced the traceability-graph.ts entry, which went with the risk register.)',

    // Test-internal hardening — last priority, low blast radius.
};

const EXEMPTION_COUNT = Object.keys(EXEMPTIONS).length;

function walk(dir: string, pred: (name: string) => boolean): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, pred));
        else if (pred(entry.name)) out.push(full);
    }
    return out;
}

function listUsecaseFiles(): string[] {
    return walk(USECASE_DIR, (n) => n.endsWith('.ts'))
        .filter((p) => {
            const base = path.basename(p);
            return base !== 'index.ts' && !base.endsWith('.types.ts') && !base.endsWith('.d.ts');
        })
        .map((p) => path.relative(REPO_ROOT, p).split(path.sep).join('/'));
}

function readAllTestSources(): string {
    const chunks: string[] = [];
    for (const dir of TEST_DIRS) {
        for (const f of walk(dir, (n) => n.endsWith('.test.ts') || n.endsWith('.test.tsx'))) {
            try {
                chunks.push(fs.readFileSync(f, 'utf-8'));
            } catch {
                // ignore — best-effort scan
            }
        }
    }
    return chunks.join('\n');
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isImported(usecaseRel: string, testSource: string): boolean {
    // src/app-layer/usecases/X.ts → @/app-layer/usecases/X
    const noExt = usecaseRel.replace(/\.ts$/, '');
    const modulePath = noExt.replace('src/app-layer/usecases/', '@/app-layer/usecases/');
    // Domain barrel — when the file lives in a folder, an import of
    // the parent (e.g. `@/app-layer/usecases/control` for files under
    // `usecases/control/`) is the canonical re-export channel.
    const lastSlash = modulePath.lastIndexOf('/');
    const parent = lastSlash > 0 ? modulePath.slice(0, lastSlash) : null;

    const patterns = [new RegExp(`from\\s+['"]${escapeRegex(modulePath)}['"]`)];
    if (parent && parent !== '@/app-layer/usecases') {
        patterns.push(new RegExp(`from\\s+['"]${escapeRegex(parent)}['"]`));
    }
    return patterns.some((p) => p.test(testSource));
}

// ─── Tests ────────────────────────────────────────────────────────

describe('every usecase file has an importing test', () => {
    const usecases = listUsecaseFiles();
    const testSource = readAllTestSources();

    // Sanity check — this catches a future refactor that moves the
    // usecase folder or breaks the walker silently.
    test('detector finds a non-trivial number of usecase files', () => {
        expect(usecases.length).toBeGreaterThan(50);
    });

    test('detector finds a non-trivial volume of test source to scan', () => {
        // ~325 unit tests + ~80 integration tests today. Concatenated
        // they're at least ~500 KB — anything dramatically below that
        // means the test walker is broken.
        expect(testSource.length).toBeGreaterThan(500_000);
    });

    test('every usecase is either imported by a test OR explicitly exempt', () => {
        const offenders: string[] = [];
        for (const uc of usecases) {
            if (uc in EXEMPTIONS) continue;
            if (!isImported(uc, testSource)) offenders.push(uc);
        }
        if (offenders.length > 0) {
            throw new Error(
                `Untested usecase file(s) detected:\n${offenders.map((f) => `  - ${f}`).join('\n')}\n\n` +
                    'Land at least one test in tests/unit/ or tests/integration/ that\n' +
                    'imports the file via its @/app-layer/usecases/<path> specifier\n' +
                    '(importing via the domain barrel @/app-layer/usecases/<folder>\n' +
                    'also counts). If the file genuinely cannot be tested yet, add an\n' +
                    'entry to EXEMPTIONS in tests/guardrails/usecase-test-coverage.test.ts\n' +
                    'with a written reason — and aim to remove it in a follow-up PR.',
            );
        }
    });

    test('EXEMPTIONS only shrinks — count never grows above today\'s baseline', () => {
        // Today's baseline. When you add an exemption, you must also
        // lower this floor — i.e. you can't sneak in an additional
        // untested file without explicitly admitting the regression in
        // a separate, visible diff. PR 19 took auditLog.ts off the
        // list, so the ratchet is at 11 now.
        const BASELINE = 10;
        expect(EXEMPTION_COUNT).toBeLessThanOrEqual(BASELINE);
    });

    test('every EXEMPTIONS entry points to an actual file (catches stale entries after refactors)', () => {
        const missing: string[] = [];
        for (const rel of Object.keys(EXEMPTIONS)) {
            if (!fs.existsSync(path.join(REPO_ROOT, rel))) missing.push(rel);
        }
        expect(missing).toEqual([]);
    });

    test('every EXEMPTIONS entry has a non-empty written reason', () => {
        for (const [file, reason] of Object.entries(EXEMPTIONS)) {
            expect(reason.length).toBeGreaterThan(10);
            expect(reason).not.toMatch(/TODO|FIXME|TBD/i);
            // Quiet the unused-variable lint via the assertion above.
            void file;
        }
    });
});
