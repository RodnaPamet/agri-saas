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

const ROOT = path.resolve(__dirname, '../..');

/** Specs that take the app offline and interact with the journal modal. */
function offlineJournalSpecs(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.spec.ts')) {
                const src = fs.readFileSync(full, 'utf8');
                if (src.includes('setOffline(true)') && src.includes("name: 'Add entry'")) {
                    out.push(path.relative(ROOT, full));
                }
                // A spec that CALLS the helper counts even if it stops
                // matching the heuristic above. Note `(` — matching the bare
                // identifier would also match the import line, which is how
                // the first version of this guard let a hand-rolled warm-up
                // through: the mutation removed the call and left the import.
                else if (src.includes('openJournalEntryModalWarm(')) {
                    out.push(path.relative(ROOT, full));
                }
            }
        }
    };
    walk(path.join(ROOT, 'tests/e2e'));
    return [...new Set(out)].sort();
}

describe('offline journal specs warm the lazy chunk', () => {
    it('finds the specs it is meant to be guarding', () => {
        // Anti-vacuity. Two today: journal-offline-create and offline-eviction.
        // A heuristic that stopped matching would make every check below pass.
        expect(offlineJournalSpecs().length).toBeGreaterThanOrEqual(2);
    });

    it.each(offlineJournalSpecs())('%s CALLS the shared warm-up helper', (rel) => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        // `(` is load-bearing: the bare identifier also appears in the import,
        // so a spec that imported it and then hand-rolled the wait anyway
        // satisfied the first version of this assertion. Found by mutation.
        expect(src).toContain('openJournalEntryModalWarm(');
    });

    it.each(offlineJournalSpecs())(
        '%s does not hand-roll the warm-up with the title input',
        (rel) => {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            // The exact regression: clicking Add entry and then waiting only on
            // the title before going offline. The helper is the one place that
            // pairing is allowed to appear.
            const handRolled =
                /getByRole\('button',\s*\{\s*name:\s*'Add entry'\s*\}\)/.test(src) &&
                !src.includes('openJournalEntryModalWarm(');
            expect(`${rel}: ${handRolled}`).toBe(`${rel}: false`);
        },
    );

    it('the helper waits on the RichTextEditor testid, not the title input', () => {
        const src = fs.readFileSync(path.join(ROOT, 'tests/e2e/e2e-utils.ts'), 'utf8');
        const helper = src.slice(src.indexOf('export async function openJournalEntryModalWarm'));
        expect(helper).toContain("getByTestId('rich-text-editor')");
    });

    it('and that testid is on the REAL component, not its loading skeleton', () => {
        // The wait is only meaningful because `SkeletonCard` carries no such
        // attribute — otherwise it would be satisfied during the very window
        // it exists to close. If someone adds a testid to the skeleton, this
        // fails rather than the guard quietly becoming a no-op.
        const editor = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/RichTextEditor.tsx'),
            'utf8',
        );
        expect(editor).toContain("'rich-text-editor'");
        expect(editor).toContain('data-testid={dataTestId}');

        // `SkeletonCard` lives in the shared skeleton module, not a file of
        // its own — the first version of this guard looked for
        // `SkeletonCard.tsx`, found nothing, and skipped silently. A guard
        // that cannot find its subject must fail, not shrug.
        const skeleton = path.join(ROOT, 'src/components/ui/skeleton.tsx');
        expect(fs.existsSync(skeleton)).toBe(true);
        expect(fs.readFileSync(skeleton, 'utf8')).not.toContain('rich-text-editor');
    });

    it('the modal really does load the editor lazily — otherwise none of this matters', () => {
        // If `RichTextEditor` ever becomes a static import, the race is gone
        // and this whole guard is obsolete. Better to fail here and have that
        // conversation than to keep enforcing a wait for a chunk that no
        // longer exists.
        const modal = fs.readFileSync(
            path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/journal/JournalEntryModal.tsx'),
            'utf8',
        );
        expect(modal).toMatch(/const RichTextEditor = dynamic\(/);
        expect(modal).toContain('ssr: false');
    });
});
