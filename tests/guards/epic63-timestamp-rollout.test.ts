/**
 * Epic 63 — TimestampTooltip rollout ratchet.
 *
 * Locks the per-page state of the rollout so future contributors
 * can't quietly re-introduce ad-hoc `formatDate(...)` JSX on the
 * five primary list/client pages. Each ROLLED_OUT entry asserts:
 *
 *   - the page's source contains NO `formatDate(` JSX call (the
 *     `import { formatDate } …` line stays exempt — pages may keep
 *     the import for non-render uses if any are added later)
 *   - the page imports `TimestampTooltip` from
 *     `@/components/ui/timestamp-tooltip`
 *
 * Risks is in the EXEMPT list with a written reason — its only
 * date field today (`nextReviewAt`) is used for the overdue-count
 * filter, not rendered as a string. If that changes, switch the
 * page to `TimestampTooltip` and move it into ROLLED_OUT.
 *
 * The decision-tree extension in `src/lib/format-date.ts`
 * documents the canonical pattern for future contributors.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const APP = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)');

interface Rolled {
    file: string;
    label: string;
}

const ROLLED_OUT: Rolled[] = [
    {
        file: path.join(APP, 'evidence/EvidenceClient.tsx'),
        label: 'Evidence',
    },
    {
        file: path.join(APP, 'policies/PoliciesClient.tsx'),
        label: 'Policies',
    },
    {
        file: path.join(APP, 'vendors/VendorsClient.tsx'),
        label: 'Vendors',
    },
];

interface Exempt {
    file: string;
    reason: string;
}

// Empty since the risk register was removed — its RisksClient was the
// only exemption. A new exemption goes here with a written reason; the
// tests below are `it.each(EXEMPT)`, so an empty list simply runs none
// of them rather than asserting vacuously.
const EXEMPT: Exempt[] = [];

describe('Epic 63 — TimestampTooltip rollout ratchet', () => {
    for (const { file, label } of ROLLED_OUT) {
        describe(`${label} (${path.relative(ROOT, file)})`, () => {
            it('exists', () => {
                expect(fs.existsSync(file)).toBe(true);
            });

            it('does not call `formatDate(` in JSX', () => {
                const src = fs.readFileSync(file, 'utf-8');
                // Allow the symbol in import / type position by skipping
                // pure import-shape lines. Anything that calls
                // `formatDate(` outside of an import is a rendering
                // call site that should be using TimestampTooltip.
                const violations: { line: number; snippet: string }[] = [];
                const lines = src.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const raw = lines[i];
                    const trimmed = raw.trim();
                    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                    // Skip the lone `import { formatDate } from …` line.
                    if (/^import\s/.test(trimmed)) continue;
                    if (/\bformatDate\s*\(/.test(raw)) {
                        violations.push({
                            line: i + 1,
                            snippet: trimmed.slice(0, 140),
                        });
                    }
                }
                if (violations.length > 0) {
                    const report = violations
                        .map((v) => `  line ${v.line}: ${v.snippet}`)
                        .join('\n');
                    fail(
                        `${label} contains ${violations.length} inline ` +
                            `formatDate() call(s); use <TimestampTooltip> instead:\n${report}`,
                    );
                }
            });

            it('imports TimestampTooltip', () => {
                const src = fs.readFileSync(file, 'utf-8');
                expect(src).toMatch(
                    /from\s+['"]@\/components\/ui\/timestamp-tooltip['"]/,
                );
                expect(src).toMatch(/\bTimestampTooltip\b/);
            });
        });
    }

    describe('exemptions', () => {
        for (const { file, reason } of EXEMPT) {
            it(`${path.relative(ROOT, file)} carries an exemption reason`, () => {
                expect(reason.length).toBeGreaterThan(40);
                expect(fs.existsSync(file)).toBe(true);
            });
        }
    });
});
