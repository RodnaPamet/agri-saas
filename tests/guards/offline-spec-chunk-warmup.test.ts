/**
 * The offline journal specs must warm the LAZY CHUNK before cutting the
 * network, not merely open the modal (#730).
 *
 * ## What this is, and what it is NOT
 *
 * CORRECTION. This guard was written believing the ChunkLoadErrors seen on
 * main were these specs failing. They were not, on two counts. The errors
 * belong to `field-op-conflict-resolution.spec.ts` — they precede its `✓` on
 * six runs out of six, green ones included, where that spec clicks a control
 * while offline and pulls the lazily-imported `MapCanvas`. And the eviction
 * spec's own failure trace carries no ChunkLoadError at all; its real cause
 * was the service worker consuming the outbox eviction signal
 * (`tests/unit/offline/sw-outbox-recreation.test.ts`, #730).
 *
 * The original attribution came from reading the log line BEFORE each error
 * rather than after it. Playwright prints `✓` when a spec finishes while
 * console output arrives asynchronously, so adjacency runs the other way.
 *
 * The warm-up this guard enforces is still correct and still worth holding:
 * cutting the network while a ~200KB chunk is in flight is a real hazard, and
 * the wait that looks obvious is the wrong one. It was simply never the bug it
 * was filed against.
 *
 * What CAN be checked deterministically is the shape of the warm-up: that both
 * specs wait on something which only exists once the chunk has landed. The
 * original wait was `#journal-entry-title`, which is the plain title `<input>`
 * — visible while the ~200KB RichTextEditor chunk is still downloading. The
 * comment above it said "so its lazy chunk lands", so the INTENT was right and
 * only the assertion was wrong. That is exactly the kind of mistake a reviewer
 * reads straight past, and exactly what a guard is for.
 *
 * ## What this cannot do
 *
 * Prove the race is gone. It proves the wait is written and that nobody has
 * quietly reverted it to the cheaper-looking form. The behaviour is the specs'
 * own job.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

/** Specs that take the app offline and interact with the journal modal. */
function offlineJournalSpecs(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) {
            throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
        }
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.spec.ts')) {
                const src = blankNonCode(fs.readFileSync(full, 'utf8'));
                if (src.includes('setOffline(true)') && src.includes("name: 'Add entry'")) {
                    out.push(path.relative(ROOT, full));
                }
                // A spec that CALLS the helper counts even if it stops
                // matching the heuristic above. Note `(` — matching the bare
                // identifier would also match the import line, which is how
                // the first version of this guard let a hand-rolled warm-up
                // through: the mutation removed the call and left the import.
                else if (src.includes('openTreatmentFormWarm(')) {
                    out.push(path.relative(ROOT, full));
                }
            }
        }
    };
    walk(path.join(ROOT, 'tests/e2e'));
    return [...new Set(out)].sort();
}

/** Specs that take the app offline on the lazily-mapped field page. */
function offlineFieldSpecs(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) {
            throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
        }
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.spec.ts')) {
                const src = blankNonCode(fs.readFileSync(full, 'utf8'));
                if (src.includes('setOffline(true)') && /goto\(`\/t\/\$\{[^}]*\}\/field\//.test(src)) {
                    out.push(path.relative(ROOT, full));
                }
            }
        }
    };
    walk(path.join(ROOT, 'tests/e2e'));
    return [...new Set(out)].sort();
}

describe('offline FIELD specs warm the lazy map (#732)', () => {
    it('finds the specs it is meant to be guarding', () => {
        // Anti-vacuity, and the reason this is derived rather than listed: the
        // defect is what a NEW offline field spec would repeat.
        expect(offlineFieldSpecs().length).toBeGreaterThanOrEqual(1);
    });

    it.each(offlineFieldSpecs())('%s warms the map before going offline', (rel) => {
        const src = blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        // `(` for the same reason as the journal half — the bare identifier
        // also matches the import line.
        expect(src).toContain('waitForFieldMapWarm(');
        // ORDER is the whole point: warming after the cut warms nothing.
        expect(src.indexOf('waitForFieldMapWarm(')).toBeLessThan(src.indexOf('setOffline(true)'));
    });

    it('the helper waits on the map ROOT, not a control that renders without it', () => {
        const src = blankNonCode(fs.readFileSync(path.join(ROOT, 'tests/e2e/e2e-utils.ts'), 'utf8'));
        const helper = src.slice(src.indexOf('export async function waitForFieldMapWarm'));
        expect(helper).toMatch(/getByRole\('group'/);
    });

    it('the field panel really does load the map lazily', () => {
        // If MapCanvas ever becomes a static import the race is gone and this
        // guard is obsolete — fail here and have that conversation.
        const panel = blankNonCode(fs.readFileSync(
            path.join(ROOT, 'src/components/offline/OfflineFieldPanel.tsx'),
            'utf8',
        ));
        expect(panel).toMatch(/const MapCanvas = dynamic\(/);
        expect(panel).toContain('ssr: false');
    });
});

describe('offline journal specs warm the lazy chunk', () => {
    it('finds the specs it is meant to be guarding', () => {
        // Anti-vacuity. Two today: journal-offline-create and offline-eviction.
        // A heuristic that stopped matching would make every check below pass.
        expect(offlineJournalSpecs().length).toBeGreaterThanOrEqual(2);
    });

    it.each(offlineJournalSpecs())('%s CALLS the shared warm-up helper', (rel) => {
        const src = blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        // `(` is load-bearing: the bare identifier also appears in the import,
        // so a spec that imported it and then hand-rolled the wait anyway
        // satisfied the first version of this assertion. Found by mutation.
        expect(src).toContain('openTreatmentFormWarm(');
    });

    it.each(offlineJournalSpecs())(
        '%s does not hand-roll the warm-up with the title input',
        (rel) => {
            const src = blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
            // The exact regression: clicking Add entry and then waiting only on
            // the title before going offline. The helper is the one place that
            // pairing is allowed to appear.
            const handRolled =
                /getByRole\('button',\s*\{\s*name:\s*'Add entry'\s*\}\)/.test(src) &&
                !src.includes('openTreatmentFormWarm(');
            expect(`${rel}: ${handRolled}`).toBe(`${rel}: false`);
        },
    );

    it('the helper waits on the MAP region, not on the parcel checkboxes', () => {
        // «Нов запис» opens the two-step treatment form now (#1740), so the
        // heavy chunk is MapLibre rather than the rich-text editor. The shape
        // of the mistake is identical: the parcel checkboxes render from data
        // that has already arrived, while the ~200KB map chunk is still in
        // flight — so waiting on them is what `#journal-entry-title` was.
        const src = blankNonCode(fs.readFileSync(path.join(ROOT, 'tests/e2e/e2e-utils.ts'), 'utf8'));
        const helper = src.slice(src.indexOf('export async function openTreatmentFormWarm'));
        expect(helper).toMatch(/getByRole\('group',\s*\{\s*name:\s*\/\^Parcel map\//);
    });

    it('and that label belongs to the REAL map, not to a loading placeholder', () => {
        // The wait is only meaningful if nothing renders that accessible name
        // while the chunk is still loading. `dynamic()` is declared with no
        // `loading` option, so the slot is EMPTY until the real module
        // arrives — assert that, because adding a placeholder carrying the
        // same role and label would satisfy the wait during the very window
        // it exists to close.
        const canvas = blankNonCode(fs.readFileSync(
            path.join(ROOT, 'src/components/ui/map/MapCanvas.tsx'),
            'utf8',
        ));
        expect(canvas).toContain("role=\"group\"");
        expect(canvas).toContain('parcelMap');
        const modal = blankNonCode(fs.readFileSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/journal/TreatmentEntryModal.tsx'),
            'utf8',
        ));
        expect(modal).not.toMatch(/import\('@\/components\/ui\/map\/MapCanvas'\)[\s\S]{0,200}loading:/);
    });

    it('the OLD guard subject is gone, so this is not enforcing a dead wait', () => {
        // The free-form editor warm-up it replaced: if `openJournalEntryModalWarm`
        // comes back, two warm-ups exist and a spec can satisfy the wrong one.
        const utils = blankNonCode(fs.readFileSync(path.join(ROOT, 'tests/e2e/e2e-utils.ts'), 'utf8'));
        expect(utils).not.toContain('export async function openJournalEntryModalWarm');
    });

    it('the skeleton does not claim the editor testid either (kept from #730)', () => {
        const editor = blankNonCode(fs.readFileSync(
            path.join(ROOT, 'src/components/ui/RichTextEditor.tsx'),
            'utf8',
        ));
        expect(editor).toContain("'rich-text-editor'");
        expect(editor).toContain('data-testid={dataTestId}');

        // `SkeletonCard` lives in the shared skeleton module, not a file of
        // its own — the first version of this guard looked for
        // `SkeletonCard.tsx`, found nothing, and skipped silently. A guard
        // that cannot find its subject must fail, not shrug.
        const skeleton = path.join(ROOT, 'src/components/ui/skeleton.tsx');
        expect(fs.existsSync(skeleton)).toBe(true);
        expect(blankNonCode(fs.readFileSync(skeleton, 'utf8'))).not.toContain('rich-text-editor');
    });

    it('the form really does load the map lazily — otherwise none of this matters', () => {
        // If `MapCanvas` ever becomes a static import the race is gone and this
        // guard is obsolete — better to fail here and have that conversation
        // than to keep enforcing a wait for a chunk that no longer exists.
        //
        // It WAS static when the treatment form first landed, which put the
        // whole MapLibre bundle in the journal LIST page's chunk for every
        // farmer; the other three map sites all use `dynamic` with
        // `ssr: false`.
        const modal = blankNonCode(fs.readFileSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/journal/TreatmentEntryModal.tsx'),
            'utf8',
        ));
        expect(modal).toMatch(/const MapCanvas = dynamic\(/);
        expect(modal).toContain('ssr: false');
    });

    it('the editor is still lazy in the EDIT form, which kept it (#730)', () => {
        const modal = blankNonCode(fs.readFileSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/journal/JournalEntryModal.tsx'),
            'utf8',
        ));
        expect(modal).toMatch(/const RichTextEditor = dynamic\(/);
        expect(modal).toContain('ssr: false');
    });
});
