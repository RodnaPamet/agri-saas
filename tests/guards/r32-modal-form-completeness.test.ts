/**
 * R32-task-63 — Modal-form completeness verification.
 *
 * The memory-tracked "modal-form migration" roadmap (3 phases —
 * architecture / execution / hardening) called out tasks /
 * policies / vendors / assets as needing their full-page create
 * flows moved into contextual modals. Verification at the start of
 * R32-task-63 found ALL THREE PHASES already shipped on main:
 *
 *   • P1 (architecture, 2026-05-24 implementation note) — the
 *     `useNewXForm` hook family + `_form/NewXFields` extraction.
 *   • P2 (execution) — every `/{tasks,policies,vendors,assets}/new`
 *     route is now a redirect shim to `?create=1`; the modals
 *     themselves live in `New{Task,Policy,Vendor,Asset}Modal.tsx`
 *     on the list pages.
 *   • P3 (hardening) — every modal carries a `guardedSetOpen`
 *     handler that gates close on `form.isDirty` with a
 *     `window.confirm('Discard … Any details you entered will be
 *     lost.')` prompt, plus a `form.submitting` guard.
 *
 * This ratchet locks the completeness state so a future PR that
 * removes the guard / regresses any of the four migrations fails
 * CI loudly. The earlier `assets-audits-modal-form.test.ts` ratchet
 * carries a narrower assets-and-audits assertion; this file widens
 * the assertion family to the canonical four entities.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

/**
 * The four canonical entities the memory-tracked roadmap targeted.
 * Each row maps to ONE redirect shim, ONE NewXModal, ONE
 * useNewXForm hook. Adding a fifth entity to the modal family
 * means adding a row here + adopting the canonical pattern.
 */
const ENTITIES = [
    {
        slug: "tasks",
        modal: "NewTaskModal",
        formHook: "useNewTaskForm",
        // mobile-forms PR-3 — migrated to the <Modal isDirty> native guard.
        guard: "native",
        // /tasks compliance UI retired 2026-07-25. The shared create modal +
        // form hook relocated to src/components/tasks (LinkedTasksPanel and the
        // farm-tasks list both mount it). The list page — and therefore the
        // `/tasks/new` redirect shim — was deleted, so this row overrides the
        // slug-templated paths and opts out of the /new-shim assertion.
        modalPath: "src/components/tasks/NewTaskModal.tsx",
        formHookPath: "src/components/tasks/_form/useNewTaskForm.ts",
        noRedirectShim: true,
    },
    {
        slug: "policies",
        modal: "NewPolicyModal",
        formHook: "useNewPolicyForm",
    },
    {
        slug: "vendors",
        modal: "NewVendorModal",
        formHook: "useNewVendorForm",
    },
    {
        slug: "assets",
        modal: "NewAssetModal",
        formHook: "useNewAssetForm",
    },
] as const;

describe("R32-task-63 — modal-form completeness", () => {
    for (const entity of ENTITIES) {
        describe(`${entity.slug} entity`, () => {
            const redirectPath = `src/app/t/[tenantSlug]/(app)/${entity.slug}/new/page.tsx`;
            const modalPath =
                "modalPath" in entity
                    ? entity.modalPath
                    : `src/app/t/[tenantSlug]/(app)/${entity.slug}/${entity.modal}.tsx`;
            const formHookPath =
                "formHookPath" in entity
                    ? entity.formHookPath
                    : `src/app/t/[tenantSlug]/(app)/${entity.slug}/_form/${entity.formHook}.ts`;

            const hasRedirectShim = !("noRedirectShim" in entity && entity.noRedirectShim);
            (hasRedirectShim ? it : it.skip)("ships the /new redirect shim (P2 contract)", () => {
                // Bookmarks, deep links, and E2E
                // `page.goto('/{slug}/new')` continue to work — they
                // land on `/{slug}?create=1`, which the list-page
                // client detects on mount and opens the modal.
                expect(exists(redirectPath)).toBe(true);
                const src = read(redirectPath);
                expect(src).toMatch(
                    /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/,
                );
                // The redirect path must contain the entity slug
                // immediately followed by a query string. The
                // `create=1` flag is the canonical bootstrap; for
                // policies it's composed via a `query` variable
                // (template/non-template branch), so accept
                // either inline `create=1` OR a substitution that
                // resolves to it (we lock the variable
                // declaration separately below).
                expect(src).toMatch(
                    new RegExp(`/t/\\$\\{tenantSlug\\}/${entity.slug}\\?`),
                );
                expect(src).toMatch(/create=1/);
            });

            it("ships the NewXModal", () => {
                expect(exists(modalPath)).toBe(true);
            });

            it("ships the useNewXForm hook with an isDirty return field (P1 contract)", () => {
                expect(exists(formHookPath)).toBe(true);
                const src = read(formHookPath);
                // The hook's return shape MUST expose `isDirty` —
                // that's the foundation the P3 guard reads.
                expect(src).toMatch(/isDirty:\s*boolean/);
            });

            it("modal close is dirty-state guarded (P3 contract)", () => {
                const src = read(modalPath);
                // mobile-forms PR-3 — `tasks` migrated to the Modal
                // primitive's NATIVE `isDirty` guard: a styled "Discard
                // changes?" on every dismiss (X / Escape / outside-click /
                // mobile drag), replacing the hand-rolled
                // `guardedSetOpen` + `window.confirm`. Same intent (no
                // unsaved loss); other entities migrate over time.
                if ("guard" in entity && entity.guard === "native") {
                    expect(src).toMatch(/isDirty=\{[^}]*isDirty[^}]*\}/);
                    expect(src).not.toMatch(/window\.confirm\(/);
                    return;
                }
                // The canonical `guardedSetOpen` shape: a wrapper
                // around `setOpen` that refuses to close on a
                // dirty form unless the user confirms via the
                // browser's native confirm prompt. Submitting
                // forms also block close (a separate guard).
                expect(src).toMatch(/guardedSetOpen/);
                expect(src).toMatch(/form\.isDirty/);
                expect(src).toMatch(/form\.submitting/);
                // The "Discard … will be lost" copy is the
                // canonical prompt; locked here so a future copy
                // change has to land deliberately.
                // T09 i18n — policies/vendors modals pass a next-intl key
                // to window.confirm (`t('newModal.discardConfirm')`); the
                // literal lives in messages/en.json (namespace = slug).
                const confirmArg = src.match(
                    /window\.confirm\(\s*\w+\(['"]([a-zA-Z0-9_.]+)['"]\)/,
                );
                if (confirmArg) {
                    const en = JSON.parse(read("messages/en.json")) as Record<
                        string,
                        unknown
                    >;
                    let resolved: unknown = en[entity.slug];
                    for (const part of confirmArg[1].split(".")) {
                        resolved = (resolved as Record<string, unknown> | undefined)?.[part];
                    }
                    expect(typeof resolved).toBe("string");
                    expect(resolved as string).toMatch(/lost\.$/);
                } else {
                    expect(src).toMatch(/window\.confirm\([\s\S]{0,200}lost\./);
                }
            });
        });
    }
});
