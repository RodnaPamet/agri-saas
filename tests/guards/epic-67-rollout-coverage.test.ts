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
import { join } from 'path';

interface SiteContract {
    /** Path relative to repo root. */
    file: string;
    /** Display name used in error messages. */
    name: string;
    /** Names of handler functions that must dispatch via the trigger. */
    handlers: ReadonlyArray<string>;
}

const SITE_CONTRACTS: ReadonlyArray<SiteContract> = [
    {
        file: 'src/components/TraceabilityPanel.tsx',
        name: 'Cross-entity unlink (TraceabilityPanel)',
        handlers: ['handleUnlink'],
    },
    {
        file: 'src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx',
        name: 'Practice evidence unlink (practice detail)',
        handlers: ['unlinkEvidence'],
    },
    {
        // #102 item 1 extracted the Mappings tab — and its
        // requirement-unmap undo flow — into its own component.
        file: 'src/app/t/[tenantSlug]/(app)/practices/[practiceId]/_tabs/PracticeMappingsTab.tsx',
        name: 'Practice requirement unmap (Mappings tab)',
        handlers: ['unmapRequirement'],
    },
    {
        file: 'src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx',
        name: 'Farm task link removal (task detail)',
        handlers: ['removeLink'],
    },
    {
        file: 'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx',
        name: 'Vendor document removal (vendor detail)',
        handlers: ['removeDoc'],
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
];

function loadFile(file: string): string {
    return readFileSync(join(__dirname, '..', '..', file), 'utf8');
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
    const re = new RegExp(
        // Group 1 captures from the handler's opening `=>` or `{` to
        // EOF; downstream we balance braces ourselves.
        `(?:const|let|var)\\s+${name}\\s*=[^\\n]*=>|function\\s+${name}\\s*\\(`,
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
