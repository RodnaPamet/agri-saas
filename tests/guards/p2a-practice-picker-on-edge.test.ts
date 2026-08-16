/**
 * Epic P2-PR-A — practice-on-edge ratchet.
 *
 * Originally locked a Combobox over the tenant's Practice rows, writing
 * `ProcessEdgePractice.practiceId`. GRC teardown phase 3 dropped both the
 * Practice model and that column, so there is no row to pick and nowhere
 * to store a pick; the `useTenantPractices` hook it stood on fetched a
 * deleted route and has been removed.
 *
 * What survives is the part that was always the point: an edge can carry
 * practices, and they round-trip through save/load. `ProcessEdgePractice`
 * now holds `practiceKey` + `label`, so the affordance is a free-text
 * label and this ratchet locks THAT wire — plus the absence of the old
 * one, so a re-add has to be deliberate.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Epic P2-PR-A — practice picker on edge", () => {
    describe("ProcessInspector — edge mode mounts the picker", () => {
        const src = read("src/components/processes/ProcessInspector.tsx");

        it("no longer imports the deleted tenant-practices hook", () => {
            // Comments stripped: the source carries a note EXPLAINING that
            // the hook was removed and why, and a bare negative match hits
            // that note rather than an import. Third time in this teardown
            // a guard has fired on its own documentation.
            const code = src
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n')
                .filter((l: string) => !l.trim().startsWith('//'))
                .join('\n');
            expect(code).not.toMatch(/use-tenant-practices/);
            expect(code).not.toMatch(/useTenantPractices/);
        });

        it("imports the Input primitive for the label field", () => {
            expect(src).toMatch(
                /import\s*\{\s*Input\s*\}\s*from\s*["']@\/components\/ui\/input["']/,
            );
        });

        it("exports the EdgePracticeRef type", () => {
            expect(src).toMatch(
                /export interface EdgePracticeRef \{[\s\S]{0,300}practiceKey:\s*string;[\s\S]{0,200}label:\s*string;/,
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

        it("EdgeInspectorBody mounts the label field with testid + aria-label", () => {
            // The field is the user-visible surface — anchor on the
            // testid the rendered test hits AND on the aria-label so a
            // refactor that drops the hint breaks loudly. The testid is
            // unchanged from the Combobox era on purpose: it is the same
            // affordance in the same place, just no longer a picker.
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
                /practices\?:\s*Array<\{[\s\S]{0,400}practiceKey:\s*string;[\s\S]{0,400}label:\s*string/,
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
