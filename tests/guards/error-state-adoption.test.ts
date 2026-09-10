/**
 * Roadmap-11 PR-3 — ErrorState adoption on route-level boundaries.
 *
 * Every Next.js `error.tsx` route file now routes its recovery
 * chrome through the shared `<ErrorState>` primitive. Without this
 * rule, page-level error boundaries silently drift away from the
 * canonical shape — different icons, different button hierarchy,
 * different vocabulary. The `<ErrorState>` primitive enforces the
 * tokens, the layout, and the action shape in one place.
 *
 * The ratchet locks two invariants:
 *
 *   1. `<ErrorState>` primitive in `src/components/ui/error-state.tsx`
 *      stays canonical (alert role, content-error icon tint, retry
 *      button via `onRetry` prop).
 *
 *   2. Every `error.tsx` under `src/app/**` either mounts
 *      `<ErrorState>` OR appears in EXEMPTIONS with a written reason.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Files that intentionally do NOT use `<ErrorState>`. None today.
 * A future global error.tsx that has a completely different shape
 * (e.g. an offline page) could land here with a written reason.
 */
const EXEMPTIONS: Record<string, string> = {};

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            walk(full, results);
        } else if (entry.name === 'error.tsx') {
            results.push(full);
        }
    }
    return results;
}

describe('ErrorState adoption (R11-PR3)', () => {
    test('the shared ErrorState primitive preserves its canonical shape', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/error-state.tsx'),
            'utf-8',
        );
        // alert role for accessibility
        expect(src).toMatch(/role="alert"/);
        // content-error tint on the icon
        expect(src).toMatch(/text-content-error/);
        // bg-bg-error wrap on the icon
        expect(src).toMatch(/bg-bg-error/);
        // onRetry → primary button labelled retryLabel (default 'Try again')
        expect(src).toMatch(/onRetry/);
        expect(src).toMatch(/retryLabel/);
    });

    test('every error.tsx route file imports + mounts <ErrorState>', () => {
        const offenders: string[] = [];
        for (const file of walk(path.resolve(ROOT, 'src/app'))) {
            const rel = path.relative(ROOT, file);
            if (EXEMPTIONS[rel]) continue;
            const src = fs.readFileSync(file, 'utf-8');
            const imports = /from\s+['"]@\/components\/ui\/error-state['"]/.test(src);
            const mounts = /<ErrorState\b/.test(src);
            if (!imports || !mounts) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} error.tsx file(s) don't route through <ErrorState>:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: import ErrorState from `@/components/ui/error-state` and mount it inside the error boundary. The primitive owns the alert role, icon tint, retry button shape, and secondary action.\n' +
                    'OR add the file path to EXEMPTIONS with a reason if the boundary intentionally renders a different surface.',
            );
        }
    });
});
