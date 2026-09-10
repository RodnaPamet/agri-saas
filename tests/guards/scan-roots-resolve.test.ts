/**
 * Every scan root in tests/guards resolves to tracked files.
 *
 * A guard that lists files under a directory and then asserts the result is
 * empty has two ways to be green: nothing is wrong, or it looked at nothing.
 * `git ls-files -z <missing-path>` returns empty with exit 0, so a directory
 * rename retires the scan silently — see the reproduction in the docblock of
 * `_helpers/scan-roots.ts`.
 *
 * This is a META-guard: it does not scan the repo for violations, it scans the
 * GUARDS for roots that no longer resolve. That covers the two known instances
 * and every future one without each author having to remember.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const GUARD_DIR = path.join(ROOT, 'tests', 'guards');

/**
 * Roots that are SUPPOSED to match nothing, with the reason. `no-tracked-node-modules`
 * asserts node_modules is not tracked, so zero files IS the healthy answer and a
 * floor would invert the guard.
 */
/**
 * Guards that already swallow a missing scan root, recorded 2026-09-10. This
 * list may only SHRINK — see the ratchet test. Tracked in #875.
 */
const KNOWN_SWALLOWERS: readonly string[] = [
    'action-label-vocabulary.test.ts',
    'admin-cell-text-size.test.ts',
    'admin-datatable-no-double-card.test.ts',
    'animation-language-lock.test.ts',
    'audit-structured-events.test.ts',
    'badge-density.test.ts',
    'bg-projection-single-source.test.ts',
    'button-label-centering.test.ts',
    'button-variant-cull.test.ts',
    'cancel-button-size-parity.test.ts',
    'card-density-discipline.test.ts',
    'card-elevation-discipline.test.ts',
    'card-pretender-eradication.test.ts',
    'cardvariants-server-import.test.ts',
    'columns-dropdown-coverage.test.ts',
    'create-button-uniformity.test.ts',
    'csp-nonce-component-scripts-patch.test.ts',
    'dashboard-anatomy.test.ts',
    'datatable-fillbody-coverage.test.ts',
    'datatable-mobile-fallback.test.ts',
    'datatable-selection-default-on.test.ts',
    'destructive-migration-has-inverse.test.ts',
    'detail-page-back-prop-ban.test.ts',
    'detail-page-breadcrumbs.test.ts',
    'detail-page-metastrip-adoption.test.ts',
    'detail-page-tabs-slot.test.ts',
    'download-route-gate-reachability.test.ts',
    'empty-loading-primitive-only.test.ts',
    'empty-state-coverage.test.ts',
    'entity-detail-shell-coverage.test.ts',
    'error-state-adoption.test.ts',
    'eyebrow-discipline.test.ts',
    'filter-toolbar-coverage.test.ts',
    'focus-ring-discipline.test.ts',
    'form-drift.test.ts',
    'formfield-coverage.test.ts',
    'heromemtric-canonical-home.test.ts',
    'hover-state-language.test.ts',
    'i18n-coverage.test.ts',
    'i18n-key-exists.test.ts',
    'i18n-use-client-directive.test.ts',
    'icon-size-discipline.test.ts',
    'inline-notice-discipline.test.ts',
    'inline-subtitle-budget.test.ts',
    'invite-email-locale-wiring.test.ts',
    'invite-no-json-redeem.test.ts',
    'legacy-badge-eradication.test.ts',
    'list-page-shell-coverage.test.ts',
    'metadatabar-detail-coverage.test.ts',
    'metric-typography.test.ts',
    'modal-action-order.test.ts',
    'modal-width-tokens.test.ts',
    'motion-language-discipline.test.ts',
    'motion-language.test.ts',
    'multi-select-facet-route-parity.test.ts',
    'no-horizontal-drift-patterns.test.ts',
    'no-inline-pills.test.ts',
    'no-inline-tab-strip.test.ts',
    'no-lucide.test.ts',
    'no-nested-cards.test.ts',
    'no-raw-palette-greys.test.ts',
    'no-raw-skeleton-pulse.test.ts',
    'no-raw-tables-in-app-pages.test.ts',
    'no-raw-white-foreground.test.ts',
    'offline-spec-chunk-warmup.test.ts',
    'page-actions-discipline.test.ts',
    'page-breadcrumbs-coverage.test.ts',
    'payload-url-scheme.test.ts',
    'primary-action-budget.test.ts',
    'primary-secondary-ratio.test.ts',
    'promotions-drift.test.ts',
    'public-routes-self-authenticate.test.ts',
    'r14-no-page-searchbars.test.ts',
    'raw-color-eradication.test.ts',
    'regression-scanner.test.ts',
    'search-placeholder-vocabulary.test.ts',
    'single-h1-per-page.test.ts',
    'single-tab-pattern.test.ts',
    'skeleton-shimmer-adoption.test.ts',
    'spacing-cadence.test.ts',
    'spacing-scale-discipline.test.ts',
    'state-coverage.test.ts',
    'state-language.test.ts',
    'state-primitives-discipline.test.ts',
    'status-badge-discipline.test.ts',
    'status-badge-no-brand.test.ts',
    'toast-vocabulary.test.ts',
    'typography-eradication.test.ts',
    'ux-foundation-ratchets.test.ts',
];

const EXPECTED_EMPTY: Record<string, string> = {
    'node_modules': 'no-tracked-node-modules asserts these are NOT tracked; zero is the pass condition',
    '*/node_modules': 'same',
};

interface Root {
    file: string;
    root: string;
}

/** String literals inside a `SCAN_ROOTS = [...]` declaration, and `git ls-files` path args. */
export function declaredRoots(src: string, file: string): Root[] {
    const out: Root[] = [];
    const push = (r: string) => {
        if (r && !r.startsWith('-') && r !== '--') out.push({ file, root: r });
    };
    for (const m of src.matchAll(/SCAN_ROOTS\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/g)) {
        // A literal inside `path.join(SRC_ROOT, 'app')` is a FRAGMENT, not a
        // root — 'app' matches nothing on its own while `src/app` is fine.
        // Computed arrays are handled by the import rule below instead.
        if (/path\.join|join\(/.test(m[1])) continue;
        for (const lit of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) push(lit[1]);
    }
    for (const m of src.matchAll(/\[\s*['"]ls-files['"]([\s\S]{0,200}?)\]/g)) {
        for (const lit of m[1].matchAll(/['"]([^'"]+)['"]/g)) push(lit[1]);
    }
    return out;
}

/**
 * Does this file guard a DIRECTORY WALK with an existence check that returns
 * instead of throwing? Only that combination is the defect. An `existsSync`
 * early-return around an optional file read is ordinary and fine — 93 guards do
 * it — so proximity to `readdirSync` is what separates the two.
 */
export function swallowsMissingRoot(src: string): boolean {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/readdirSync\s*\(/.test(lines[i])) continue;
        // the guard clause sits at the top of walk(), a line or two above
        for (let j = Math.max(0, i - 6); j < i; j++) {
            // `continue` skips the root just as silently as `return` — found
            // in the sibling shell guard, which used the shape it polices.
            if (
                /!\s*(fs\.)?existsSync\s*\(/.test(lines[j]) &&
                /\b(return|continue)\b/.test(lines.slice(j, j + 3).join(' '))
            ) {
                return true;
            }
        }
    }
    return false;
}

/** Guards whose roots are built at runtime — a static reader cannot see them. */
export function hasComputedRoots(src: string): boolean {
    // Must stop at the array's own `]`. A lazy `[\s\S]*?` runs past it and
    // finds a `path.join` further down the file, which put four guards with
    // purely literal roots into the computed bucket.
    for (const m of src.matchAll(/SCAN_ROOTS\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g)) {
        if (/path\.join|\bjoin\(/.test(m[1])) return true;
    }
    return false;
}

function readGuard(f: string): string {
    return fs.readFileSync(path.join(GUARD_DIR, f), 'utf-8');
}

function guardFiles(): string[] {
    return fs
        .readdirSync(GUARD_DIR)
        .filter((f) => f.endsWith('.test.ts'))
        .sort();
}

function tracked(rel: string): number {
    try {
        return execFileSync('git', ['ls-files', '-z', '--', rel], {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        })
            .split('\0')
            .filter(Boolean).length;
    } catch {
        return 0;
    }
}

describe('scan roots in tests/guards still resolve', () => {
    const files = guardFiles();

    it('the meta-guard found guards to read', () => {
        // Without this, a directory rename empties THIS selection too and the
        // assertion below passes over nothing — the very bug it exists to catch.
        expect(files.length).toBeGreaterThan(400);
        expect(files).toContain('no-legacy-brand.test.ts');
    });

    it('...and it extracts roots from both spellings — a control on the emptiness below', () => {
        const a = declaredRoots(`const SCAN_ROOTS = ['src', 'deploy', 'messages'];`, 'x.ts');
        expect(a.map((r) => r.root)).toEqual(['src', 'deploy', 'messages']);
        const b = declaredRoots(`execFileSync('git', ['ls-files', '-z', 'src', 'public'])`, 'y.ts');
        expect(b.map((r) => r.root)).toEqual(['src', 'public']);
        // ...and it sees roots it cannot statically resolve, rather than missing them
        expect(hasComputedRoots(`const SCAN_ROOTS = [path.join(SRC, 'app')];`)).toBe(true);
        expect(hasComputedRoots(`const SCAN_ROOTS = ['src'];`)).toBe(false);
        // ...and the array's own `]` bounds the search — a `path.join` further
        // down the file must not drag a literal-root guard into the other bucket
        expect(hasComputedRoots(`const SCAN_ROOTS = ['src'];\nconst X = path.join(a, b);`)).toBe(false);

        // ...and the swallowing detector separates a WALK guard from an
        // ordinary optional-file read, which 93 guards legitimately do
        expect(
            swallowsMissingRoot('function walk(d, out) {\n  if (!fs.existsSync(d)) return out;\n  for (const e of fs.readdirSync(d)) {}\n}'),
        ).toBe(true);
        expect(
            swallowsMissingRoot('function read(p) {\n  if (!fs.existsSync(p)) return null;\n  return fs.readFileSync(p);\n}'),
        ).toBe(false);
        expect(
            swallowsMissingRoot('function walk(d) {\n  for (const e of fs.readdirSync(d)) {}\n}'),
        ).toBe(false);
        // `continue` is the same silence as `return`
        expect(
            swallowsMissingRoot('for (const d of DIRS) {\n  if (!fs.existsSync(d)) continue;\n  fs.readdirSync(d);\n}'),
        ).toBe(true);
    });

    it('...and a renamed root really does make it fire', () => {
        // A control that only reads a fixture proves nothing about the path that
        // executes. Take a REAL guard's source and rename one of its roots.
        const real = fs.readFileSync(path.join(GUARD_DIR, 'no-legacy-brand.test.ts'), 'utf-8');
        const renamed = real.replace(`'messages'`, `'i18n-messages'`);
        expect(renamed).not.toEqual(real);
        const roots = declaredRoots(renamed, 'no-legacy-brand.test.ts');
        const broken = roots.filter((r) => tracked(r.root) === 0 && !(r.root in EXPECTED_EMPTY));
        expect(broken.map((r) => r.root)).toEqual(['i18n-messages']);
    });

    it('the swallowing list does not grow — RATCHET', () => {
        // 89 guards in this repo open their walk with
        //     if (!fs.existsSync(dir)) return out;
        // A defensive line that makes the guard unable to fail: a renamed root
        // yields zero files, zero files yield zero violations, and the
        // assertion passes over nothing.
        //
        // This is a RATCHET, not a fix. Failing all 99 today would get this
        // guard deleted rather than the 89 repaired. New guards must not join
        // the list; the existing ones are tracked in #875 and come off as they
        // are touched. Take entries OUT of KNOWN_SWALLOWERS as you fix them —
        // the test below fails if a name here no longer swallows, so the list
        // cannot rot into a permanent allowlist.
        const current = files.filter(
            (f) => f !== 'scan-roots-resolve.test.ts' && swallowsMissingRoot(readGuard(f)),
        );
        const added = current.filter((f) => !KNOWN_SWALLOWERS.includes(f));
        expect({ added }).toEqual({ added: [] });

        const fixed = KNOWN_SWALLOWERS.filter((f) => !current.includes(f));
        expect({
            message: 'these were fixed — delete them from KNOWN_SWALLOWERS so the list keeps shrinking',
            fixed,
        }).toEqual({ message: 'these were fixed — delete them from KNOWN_SWALLOWERS so the list keeps shrinking', fixed: [] });
    });

    it('no NEW directory walk turns a missing root into an empty result', () => {
        // `path.join(SRC_ROOT, 'app')` cannot be resolved by reading the file,
        // so the literal check above cannot see it. What CAN be checked is the
        // mechanism: `readdirSync` on a missing directory throws, which is
        // loud and correct — until someone adds
        //     if (!fs.existsSync(dir)) return out;
        // to be safe. That one defensive line converts a loud failure into a
        // silent pass, and it is how two guards in this repo became unable to
        // fail. Using resolveScanRoots() is the other acceptable answer.
        const swallowing: string[] = [];
        for (const f of files) {
            if (f === 'scan-roots-resolve.test.ts') continue;
            const src = fs.readFileSync(path.join(GUARD_DIR, f), 'utf-8');
            if (/_helpers\/scan-roots/.test(src)) continue;
            if (KNOWN_SWALLOWERS.includes(f)) continue;
            if (swallowsMissingRoot(src)) {
                swallowing.push(`${f}: a missing scan root returns empty instead of failing`);
            }
        }
        expect(swallowing).toEqual([]);
    });

    it('every declared scan root matches at least one tracked file', () => {
        const broken: string[] = [];
        for (const f of files) {
            const src = fs.readFileSync(path.join(GUARD_DIR, f), 'utf-8');
            for (const { root } of declaredRoots(src, f)) {
                if (root in EXPECTED_EMPTY) continue;
                if (tracked(root) === 0) broken.push(`${f}: '${root}' matches no tracked file`);
            }
        }
        expect(broken).toEqual([]);
    });
});
