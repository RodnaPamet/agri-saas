/**
 * Epic P2-PR-A — Practice picker on edge ratchet.
 *
 * Closes the brief's #11 🟠 "Domain Entity Linking" gap for the edge
 * surface. Pre-P2 the schema's `ProcessEdgePractice.practiceId` FK was
 * never written from the canvas — the client always sent
 * `practices: []` on save. Now:
 *
 *   1. The edge load includes `practices` in the response shape and
 *      projects them onto `edge.data.practices` so the inspector's
 *      picker mounts with the persisted selection.
 *   2. The three save serialisers (handleSave + the two
 *      duplicate/snapshot-save sites) read the practices back via
 *      the canonical `edgePractices(e)` helper instead of sending
 *      `[]` unconditionally.
 *   3. `handleEdgeUpdate` accepts a `practices` patch field so the
 *      inspector's Combobox commit lands on the edge's `data`.
 *   4. `ProcessInspector` mounts a `Combobox` in edge mode, fed by
 *      the new `useTenantPractices(tenantSlug)` hook.
 *
 * This ratchet locks each touch point so a future refactor that
 * silently reverts to the pre-P2 "always empty" shape gets caught
 * before reviewers do.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Epic P2-PR-A — practice picker on edge", () => {
    describe("useTenantPractices hook", () => {
        const src = read("src/lib/processes/use-tenant-practices.ts");

        it("exports the hook + a formatPracticeLabel helper", () => {
            expect(src).toMatch(/export function useTenantPractices/);
            expect(src).toMatch(/export function formatPracticeLabel/);
        });

        it("returns options shape: { id, ref, title }", () => {
            // Locked because the inspector + future entity-linking
            // surfaces all depend on this triple.
            expect(src).toMatch(
                /interface TenantPracticeOption \{[\s\S]{0,200}id:\s*string;[\s\S]{0,200}ref:\s*string \| null;[\s\S]{0,200}title:\s*string;/,
            );
        });

        it("hits /api/t/<slug>/practices (the canonical tenant route)", () => {
            expect(src).toMatch(/\/api\/t\/\$\{tenantSlug\}\/practices/);
        });

        it("normalises both list-shape AND { practices } wrapper", () => {
            // The Practices API returns one of two shapes depending on
            // pagination — the hook normalises both. Anchor the
            // dispatch so a refactor that drops one branch breaks.
            expect(src).toMatch(/Array\.isArray\(body\)/);
            expect(src).toMatch(/body as \{ practices\?: unknown\[\] \}\)\?\.practices/);
        });
    });

    describe("ProcessInspector — edge mode mounts the picker", () => {
        const src = read("src/components/processes/ProcessInspector.tsx");

        it("imports Combobox + the tenant-practices hook", () => {
            expect(src).toMatch(
                /import\s*\{\s*Combobox,\s*type ComboboxOption\s*\}\s*from\s*["']@\/components\/ui\/combobox["']/,
            );
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useTenantPractices[\s\S]{0,200}\}\s*from\s*["']@\/lib\/processes\/use-tenant-practices["']/,
            );
        });

        it("exports the EdgePracticeRef type", () => {
            expect(src).toMatch(
                /export interface EdgePracticeRef \{[\s\S]{0,300}practiceKey:\s*string;[\s\S]{0,200}practiceId:\s*string \| null;/,
            );
        });

        it("ProcessInspectorProps declares tenantSlug + accepts a practices patch on onEdgeUpdate", () => {
            // `tenantSlug` is optional — node-mode rendered tests
            // don't need it, and the hook short-circuits on empty
            // string for storybook contexts.
            expect(src).toMatch(/tenantSlug\?:\s*string;/);
            expect(src).toMatch(
                /onEdgeUpdate\?:[\s\S]{0,500}practices\?:\s*EdgePracticeRef\[\];/,
            );
        });

        it("EdgeInspectorBody mounts the Combobox with testid + label", () => {
            // The picker is the user-visible surface — anchor on
            // the testid the rendered test will hit AND on the
            // Combobox's aria-label so a refactor that drops the
            // hint breaks loudly.
            expect(src).toMatch(
                /data-testid="inspector-edge-practice-picker"/,
            );
            expect(src).toMatch(/aria-label=\{t\("processInspector\.linkedPractice"\)\}/);
        });

        it("commitLinkedPractice emits patch with a single EdgePracticeRef on pick + empty on clear", () => {
            // The shape of the patch is the contract with the
            // canvas's handleEdgeUpdate; locking it here means a
            // future "send the raw practice id instead" refactor
            // breaks before it ships.
            expect(src).toMatch(
                /onEdgeUpdate\(edge\.id,\s*\{\s*practices:\s*\[\]\s*\}\)/,
            );
            expect(src).toMatch(
                /onEdgeUpdate\(edge\.id,\s*\{\s*practices:\s*\[next\]\s*\}\)/,
            );
        });
    });

    describe("Canvas — round-trips practices on load + save", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );
        const helperSrc = read("src/lib/processes/edge-practices.ts");

        it("declares the canonical edgePracticesForSave save helper", () => {
            // Lives in `src/lib/processes/edge-practices.ts` rather
            // than inline in PersistedProcessCanvas.tsx so the
            // R32-PR10 file-size floor (≤1900 lines on the canvas)
            // keeps holding as features land.
            expect(helperSrc).toMatch(
                /export function edgePracticesForSave\(e:\s*Edge\):[\s\S]{0,400}EdgePracticeWire/,
            );
        });

        it("canvas imports the helper module", () => {
            expect(src).toMatch(
                /import\s*\{\s*edgePracticesForSave\s*\}\s*from\s*["']@\/lib\/processes\/edge-practices["']/,
            );
        });

        it("all three save serialisers route through the helper, not the pre-P2 empty array", () => {
            // The pre-P2 shape was `practices: []` at three call
            // sites (handleSave + duplicate + autosave-snapshot).
            // None of them may remain.
            expect(src).not.toMatch(/practices:\s*\[\],/);
            const matches = src.match(
                /practices:\s*edgePracticesForSave\(e\),?/g,
            );
            expect(matches).not.toBeNull();
            expect(matches!.length).toBeGreaterThanOrEqual(3);
        });

        it("load response shape includes the practices array", () => {
            expect(src).toMatch(
                /practices\?:\s*Array<\{[\s\S]{0,400}practiceKey:\s*string;[\s\S]{0,400}practiceId:\s*string \| null/,
            );
        });

        it("rehydratedEdges projects practices onto data.practices (only when non-empty)", () => {
            // Anchor on the conditional spread — empty arrays
            // shouldn't bloat data.
            expect(src).toMatch(
                /Array\.isArray\(e\.practices\)\s*&&\s*e\.practices\.length\s*>\s*0[\s\S]{0,400}practices:\s*e\.practices\.map/,
            );
        });

        it("handleEdgeUpdate accepts the practices patch field and writes data.practices", () => {
            expect(src).toMatch(
                /patch:\s*\{[\s\S]{0,800}practices\?:\s*Array<\{[\s\S]{0,300}practiceKey:\s*string;/,
            );
            expect(src).toMatch(
                /if\s*\(patch\.practices\s*!==\s*undefined\)[\s\S]{0,400}practices:\s*patch\.practices/,
            );
        });

        it("inspector mount receives tenantSlug", () => {
            expect(src).toMatch(
                /<ProcessInspector[\s\S]{0,300}tenantSlug=\{tenantSlug\}/,
            );
        });
    });
});
