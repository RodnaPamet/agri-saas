/**
 * Roadmap-3 PR-5 — `<CardHeader>` discipline.
 *
 * The product had every card hand-rolling its own heading row.
 * Different `<Heading level=…>` (some 2, some 3), different
 * `mb-N` margins, different action placements. The user reads
 * the rhythm as moving even though the cards visually look the
 * same.
 *
 * `<CardHeader>` is the canonical primitive — locked rhythm
 * (eyebrow → 4 → title → 4 → description → 16 → body), locked
 * heading level (3 by default — cards live inside pages, the
 * page H1 is level 1, major page sections are level 2, cards
 * therefore start at 3 for a coherent document outline).
 *
 * What this ratchet locks
 *
 *   1. The primitive exists at the canonical path.
 *   2. The primitive exposes the documented props.
 *   3. The primitive forwards stable test ids per slot.
 *   4. The curated adopters import + mount it.
 *
 * Future migrations
 *   When more card headers across the product migrate (controls
 *   detail "Overview" cards, vendor detail panels, audit pack
 *   sections, dashboard cards), extend the ADOPTERS list. The
 *   ratchet's coverage grows; silent rollback fails CI.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PRIMITIVE_PATH = 'src/components/ui/card-header.tsx';

// The risks detail page was the original proof-of-pattern adopter,
// but its CardHeader sat on an Overview-tab Traceability section that
// has since been removed (risk traceability now lives only on the
// dedicated Traceability tab). B4 (2026-06-07) removed the controls
// DETAIL page's only CardHeader (the legacy 'Control tasks' table) when
// the Tasks tab was aligned to Asset/Risk, so the anchor moved to the
// control TEST-PLAN detail page — a stable CardHeader adopter (Test
// Procedure section header, R9-PR2).
// Compliance uproot (2026-08-07): the control TEST-PLAN detail page was
// deleted with the test-plan feature, emptying this list. An empty ADOPTERS
// array makes the "curated adopters mount CardHeader" test vacuously green,
// so the anchor moves to the audits list — a surviving CardHeader adopter.
const ADOPTERS = [
    'src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx',
];

describe('CardHeader discipline (Roadmap-3 PR-5)', () => {
    it('the CardHeader primitive exists at the canonical path', () => {
        expect(fs.existsSync(path.join(ROOT, PRIMITIVE_PATH))).toBe(true);
    });

    it('the primitive exposes the documented props', () => {
        const src = read(PRIMITIVE_PATH);
        expect(src).toMatch(/export\s+function\s+CardHeader/);
        for (const prop of [
            'eyebrow',
            'title',
            'titleLevel',
            'description',
            'actions',
        ]) {
            expect(src).toMatch(new RegExp(`\\b${prop}\\??:`));
        }
    });

    it('the primitive defaults to <Heading level={3}>', () => {
        const src = read(PRIMITIVE_PATH);
        // Cards live inside pages; page H1 is level 1, major
        // section H2 is reserved, cards default to H3.
        expect(src).toMatch(/titleLevel\s*=\s*3/);
    });

    it('the primitive forwards stable test ids per slot', () => {
        const src = read(PRIMITIVE_PATH);
        for (const id of [
            'card-header',
            'card-header-eyebrow',
            'card-header-title',
            'card-header-description',
            'card-header-actions',
        ]) {
            expect(src).toMatch(new RegExp(`['"]${id}['"]`));
        }
    });

    it('the curated adopters import AND mount CardHeader', () => {
        const offenders: string[] = [];
        for (const rel of ADOPTERS) {
            const src = read(rel);
            const importsIt = /from\s+['"]@\/components\/ui\/card-header['"]/.test(
                src,
            );
            const mountsIt = /<CardHeader\b/.test(src);
            if (!importsIt || !mountsIt) {
                offenders.push(
                    `${rel} (import: ${importsIt}, mount: ${mountsIt})`,
                );
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `These curated CardHeader adopters are missing the import or mount:\n  ${offenders.join('\n  ')}\n\nRestore the CardHeader adoption or remove the file from this ratchet's curated list with a written reason.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
