/**
 * Epic 67 — destructive-action rollout ratchet.
 *
 * Each of the 4 destructive flows the prompt called out got wired to
 * `useToastWithUndo` so the actual DELETE only fires after a 5s undo
 * window. This test locks in the wiring so a future refactor can't
 * silently drop the deferred-commit behaviour for any of them.
 *
 * For every required site we assert:
 *   1. The file imports `useToastWithUndo` from the shared barrel.
 *   2. The destructive handler dispatches via the captured trigger
 *      (i.e. there's a `triggerUndoToast(...)` call) — NOT a direct
 *      `fetch(..., { method: 'DELETE' })`.
 *
 * Removing or renaming a wired site fails the test. Adding a new
 * destructive flow that takes the shortcut path (direct fetch) goes
 * undetected by THIS file — extend SITE_CONTRACTS or add a new
 * coverage test for the new surface.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

interface SiteContract {
    /** Path relative to repo root. */
    file: string;
    /** Display name used in error messages. */
    name: string;
    /** Names of handler functions that must dispatch via the trigger. */
    handlers: ReadonlyArray<string>;
}

const SITE_CONTRACTS: ReadonlyArray<SiteContract> = [
    // The cross-entity unlink site (TraceabilityPanel) went with the GRC
    // teardown in phase 2; the remaining sites are unchanged.
    {
        file: 'src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx',
        name: 'Farm task link removal (task detail)',
        handlers: ['removeLink'],
    },
    {
        file: 'src/app/t/[tenantSlug]/(app)/exchange/my-listings/MyListingsClient.tsx',
        name: 'Exchange listing withdraw (my listings)',
        handlers: ['withdrawListing'],
    },
    {
        file: 'src/app/t/[tenantSlug]/(app)/rent/RentClient.tsx',
        name: 'Lease removal (Rent page)',
        handlers: ['remove'],
    },
    {
        // B1 — per-asset soft-delete on the asset detail header. Restorable
        // from the list Trash view, so it uses the undo-toast pattern.
        file: 'src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx',
        name: 'Asset delete (asset detail)',
        handlers: ['handleDeleteAsset'],
    },
    {
        // agrent-ios#481 — the web half of the owner's expense swipe-to-delete
        // ruling (2026-10-31: "Ask, then 5 s «Отмени»", anyone who may write,
        // web too). The flow ALREADY existed and was ungraded, which is how it
        // kept a raw `fetch` whose `!res.ok` treated an already-deleted entry
        // as a failure and restored the row.
        file: 'src/app/t/[tenantSlug]/(app)/grain/costs/CostsClient.tsx',
        name: 'Cost entry delete (grain costs list)',
        handlers: ['handleDelete'],
    },
    {
        // #2175 — swiping a journal row left. The swipe COMMITS nothing on its
        // own: `<SwipeRow>` fires `onAction` and the undo window is the
        // caller's, which is this site. A gesture that deleted on release
        // would be the one destructive control in the product with no undo,
        // and the one hardest to perform by accident-proofing.
        file: 'src/app/t/[tenantSlug]/(app)/journal/JournalClient.tsx',
        name: 'Journal row swipe-to-withdraw',
        handlers: ['withdrawRow'],
    },
];

function loadFile(file: string): string {
    return blankNonCode(readFileSync(join(__dirname, '..', '..', file), 'utf8'));
}

/**
 * Slice the function body of `name` from the source by character
 * matching after `=>` or `function …()`. Imperfect but enough to
 * detect "this handler dispatches via triggerUndoToast" — which is
 * the only assertion we need.
 */
function extractHandlerBody(source: string, name: string): string {
    // Match either:
    //   const name = (... ) => { ... }
    //   const name = async (...) => { ... }
    //   const name = (... ) => /* expression body */
    //   function name(...) { ... }
    //   const name = useCallback(\n    (...) => { ... }        ← #2175
    //
    // The `useCallback` alternative is NOT cosmetic. The original pattern
    // required the `=>` on the SAME line as the declaration (`=[^\n]*=>`),
    // and a hook-wrapped handler puts its arrow on the next one — so the
    // extractor returned '' and the site read as having no handler at all.
    // That direction is at least loud, because `expect(body).not.toBe('')`
    // below refuses an empty extraction rather than regexing over nothing;
    // without that line this guard would have passed over a handler it never
    // found. Journal's `withdrawRow` is the first site to be memoised, and it
    // has to be: the callback is handed to `swipeAction`, which `DataTable`
    // calls per row on every render.
    const re = new RegExp(
        // Group 1 captures from the handler's opening `=>` or `{` to
        // EOF; downstream we balance braces ourselves.
        `(?:const|let|var)\\s+${name}\\s*=\\s*useCallback\\(` +
            `|(?:const|let|var)\\s+${name}\\s*=[^\\n]*=>` +
            `|function\\s+${name}\\s*\\(`,
    );
    const match = re.exec(source);
    if (!match) return '';
    const startIdx = match.index;

    // Pull a generous slice and let the consumer regex over it. We
    // stop at the next sibling `const ... = ` declaration at the
    // same indent so the slice doesn't bleed into the next handler.
    const tail = source.slice(startIdx);
    const nextDecl = tail.search(
        /\n {4}(?:const|function|return|export|interface) /,
    );
    return nextDecl > 0 ? tail.slice(0, nextDecl) : tail;
}

describe('Epic 67 — destructive flow rollout', () => {
    it.each(SITE_CONTRACTS.map((c) => [c.name, c]))(
        '%s — imports useToastWithUndo from the shared barrel',
        (_label, contract) => {
            const source = loadFile(contract.file);
            // The barrel path is the canonical Epic 60 import. The
            // per-file path also satisfies the spirit of the rollout
            // but we lock the canonical path here so the codebase
            // stays consistent with the Epic 60 README.
            const importsBarrel =
                /from ['"]@\/components\/ui\/hooks['"]/.test(source) ||
                /from ['"]@\/components\/ui\/hooks\/use-toast-with-undo['"]/.test(source);
            const usesHook = /useToastWithUndo\s*\(/.test(source);
            expect({ importsBarrel, usesHook }).toEqual({
                importsBarrel: true,
                usesHook: true,
            });
        },
    );

    it.each(
        SITE_CONTRACTS.flatMap((c) =>
            c.handlers.map((h) => [c.name, c.file, h] as const),
        ),
    )(
        '%s — handler "%s" dispatches via triggerUndoToast',
        (_label, file, handler) => {
            const source = loadFile(file);
            const body = extractHandlerBody(source, handler);
            expect(body).not.toBe('');
            // The handler must call the trigger captured from the hook.
            expect(body).toMatch(/triggerUndoToast\s*\(/);
            // …and must NOT directly fire a `method: 'DELETE'` fetch
            // outside of the trigger's `action` callback. The action
            // callback IS allowed to contain the DELETE — but only
            // *inside* the triggerUndoToast(...) argument, which the
            // bare-handler check below catches via context.
            //
            // Heuristic: the handler should not contain a top-level
            // `await fetch(...)` BEFORE the trigger call. We assert by
            // requiring `triggerUndoToast` to come before any
            // `method: 'DELETE'` literal — a direct unguarded delete
            // would put the fetch first.
            const triggerIdx = body.indexOf('triggerUndoToast');
            const bareDeleteIdx = body.search(
                /\bawait\s+fetch\([^)]*\),\s*\{\s*method:\s*['"]DELETE['"]/,
            );
            // -1 means no bare delete; that's good. Otherwise the
            // bare delete must come AFTER the trigger (i.e. inside
            // the action arg).
            if (bareDeleteIdx !== -1) {
                expect(bareDeleteIdx).toBeGreaterThan(triggerIdx);
            }
        },
    );

    it('the foundation hook + UndoToast variant exist', () => {
        const hook = loadFile(
            'src/components/ui/hooks/use-toast-with-undo.ts',
        );
        const variant = loadFile('src/components/ui/undo-toast.tsx');
        expect(hook).toMatch(/export function useToastWithUndo/);
        expect(variant).toMatch(/export function UndoToast/);
    });
});

/**
 * The DERIVED layer (#2193).
 *
 * `SITE_CONTRACTS` above is the deep check: for a named handler it asserts the
 * barrel import, the dispatch through the trigger, and that no bare DELETE
 * precedes it. What it cannot do is notice a destructive flow nobody listed —
 * it answers "are these six still wired", not "is every destructive flow
 * wired", which is the question Epic 67 exists to ask. Measured 2026-10-23 it
 * graded 6 of 36.
 *
 * This layer walks the filesystem instead. A file that performs a destructive
 * write must answer for it in ONE of four ways, and the four are not a
 * ranking — each is correct somewhere:
 *
 *   1. the undo toast — the default for a routine, reversible delete;
 *   2. a confirm dialog — what CLAUDE.md requires for TOP-LEVEL entity
 *      deletion, where cascading consequences make five seconds too short;
 *   3. a permanent PURGE from a trash view, which is the typed-confirmation
 *      case and must never have an undo window: the row is already deleted and
 *      this is the second, final step;
 *   4. an explicit EXEMPT entry with a written reason.
 *
 * Forcing (2) and (3) onto the undo toast would be a regression, which is why
 * the walker accepts them rather than counting them as debt. The population
 * split on 2026-10-23: 15 undo, 10 confirm, 3 purge, 8 answering for nothing.
 */
describe('Epic 67 — every destructive flow answers for itself (#2193)', () => {
    const ROOTS = ['src/app/t', 'src/components'] as const;

    /** A write that removes something a farmer can see. */
    const DESTRUCTIVE = /apiDelete\(|method:\s*['"]DELETE['"]|\/purge|\/withdraw/;

    const UNDO = /useToastWithUndo/;
    const CONFIRM = /ConfirmDialog|typedConfirm|confirmText|requireTyped/;
    const PURGE = /\/purge/;

    /**
     * Files that perform a destructive write and answer for it in none of the
     * three ways, each with a written reason.
     *
     * #2193 brought seven of the eight that were here onto the undo pattern
     * rather than recording them. The one entry is a FALSE POSITIVE of this
     * walker's own detector, kept as an exemption rather than by narrowing the
     * pattern: `apiDelete` on a block resource is the honest shape for
     * "remove the block", and a detector that tried to tell content-removal
     * from restriction-removal by URL would be guessing.
     */
    const EXEMPT: ReadonlyArray<{ file: string; reason: string }> = [
        {
            file: 'src/components/trust-safety/BlockPersonButton.tsx',
            reason:
                'Its only DELETE is an UN-BLOCK — `DELETE /api/social/blocks` removes a ' +
                'restriction, so it RESTORES access rather than destroying anything. An undo ' +
                'window would delay the moment somebody regains contact, and a confirm would ' +
                'ask a person to confirm being less restrictive. Its exchange sibling makes ' +
                'the same call and says so in a comment: blocking is reversible from the same ' +
                'button, so ceremony around it is ceremony around an undoable action.',
        },
    ];

    const classified = (() => {
        const undo: string[] = [];
        const confirm: string[] = [];
        const purge: string[] = [];
        const unanswered: string[] = [];
        // `collectSourceFiles`, not a hand-rolled walk. It refuses a renamed
        // root and an empty result, which a local `readdirSync` recursion does
        // not — and `file-collection-is-not-silently-empty` caught the first
        // draft of this guard doing exactly that. A collector that can return
        // `[]` makes every assertion built on it green for ever, which is the
        // failure this whole file is about one level up.
        // `collectSourceFiles` returns ABSOLUTE paths; `loadFile` prepends the
        // repo root, so passing one straight through doubles it. The first
        // version did, and the suite failed to LOAD — which a batched jest run
        // then reported as "5 passed" from the other file on the command line,
        // so the walker was silently not running at all. Repo-relative for
        // identity (EXEMPT keys, the report), absolute only to read bytes.
        const REPO = join(__dirname, '..', '..');
        for (const abs of collectSourceFiles({ roots: [...ROOTS], extensions: ['.tsx'] })) {
            const file = relative(REPO, abs);
            const src = blankNonCode(readFileSync(abs, 'utf8'));
            if (!DESTRUCTIVE.test(src)) continue;
            if (UNDO.test(src)) undo.push(file);
            else if (PURGE.test(src)) purge.push(file);
            else if (CONFIRM.test(src)) confirm.push(file);
            else unanswered.push(file);
        }
        return { undo, confirm, purge, unanswered };
    })();

    it('reports what it covers', () => {
        const total =
            classified.undo.length +
            classified.confirm.length +
            classified.purge.length +
            classified.unanswered.length;
        console.log(
            `[epic67-derived] ${total} destructive file(s): ` +
                `${classified.undo.length} undo-toast, ` +
                `${classified.confirm.length} confirm-dialog, ` +
                `${classified.purge.length} purge, ` +
                `${classified.unanswered.length} unanswered, ` +
                `${EXEMPT.length} exempt; ${SITE_CONTRACTS.length} under the deep per-handler check`,
        );
        // A floor, so a walker that stops matching fails instead of passing
        // over nothing. 36 measured; well below it means the roots or the
        // pattern have drifted.
        expect(total).toBeGreaterThanOrEqual(30);
    });

    it('every destructive file answers for itself', () => {
        const exempt = new Set(EXEMPT.map((e) => e.file));
        const offenders = classified.unanswered.filter((f) => !exempt.has(f));
        expect(offenders).toEqual([]);
    });

    it('no EXEMPT entry names a file that has stopped being destructive', () => {
        // The #1285 convention: an exemption that outlives its file keeps a
        // path pre-approved for whatever is created there next.
        const stale = EXEMPT.filter(
            (e) => !classified.unanswered.includes(e.file),
        ).map((e) => e.file);
        expect(stale).toEqual([]);
    });

    it('CONTROL: the walker refuses a file that deletes with no answer', () => {
        // Without this the assertion above could be passing because the
        // detector matches nothing — the shape every derived guard here has to
        // disprove about itself.
        const bare = 'const go = async () => { await apiDelete(buildUrl(`/x/${id}`)); };';
        expect(DESTRUCTIVE.test(bare)).toBe(true);
        expect(UNDO.test(bare) || CONFIRM.test(bare) || PURGE.test(bare)).toBe(false);
    });

    it('CONTROL: it accepts each of the three legitimate answers', () => {
        const withUndo = 'const t = useToastWithUndo(); await apiDelete(u);';
        const withConfirm = '<ConfirmDialog tone="danger" /> await apiDelete(u);';
        const withPurge = "await apiPost(buildUrl(`/journal/${id}/purge`));";
        expect(UNDO.test(withUndo)).toBe(true);
        expect(CONFIRM.test(withConfirm)).toBe(true);
        expect(PURGE.test(withPurge)).toBe(true);
    });
});
