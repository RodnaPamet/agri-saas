/**
 * Epic P2-PR-C — Practice reverse-lookup ratchet.
 *
 * Brief gap #11 🟠 closes here for the read direction: "Where is
 * this practice used?". The chain:
 *
 *   1. ProcessMapRepository.listMapsByPractice(ctx, practiceId) —
 *      reads ProcessEdgePractice rows for the (tenant, practiceId)
 *      pair via the existing `@@index([tenantId, practiceId])`,
 *      filters out soft-deleted parents, returns (map, edge) rows.
 *   2. process-map usecase.listMapsUsingPractice(ctx, practiceId) —
 *      thin orchestration; requires canRead.
 *   3. /api/t/<slug>/practices/<id>/process-maps — GET route
 *      wrapped with withApiErrorHandling, returns `{ maps }`.
 *   4. <PracticeReverseLookupModal> — opens from the Practice detail
 *      page's "Where used" button; fetches lazily on open;
 *      groups multi-edge results by map; deep-links to the canvas.
 *
 * Each link in this chain needs the other to function. The ratchet
 * locks each so a future refactor that silently drops one (e.g.
 * the modal stops fetching, the repo loses the soft-delete
 * filter, the route forgets canRead) gets caught.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe("Epic P2-PR-C — practice reverse-lookup", () => {
    describe("Repository — listMapsByPractice", () => {
        const src = read(
            "src/app-layer/repositories/ProcessMapRepository.ts",
        );

        it("declares the method with the canonical signature + return shape", () => {
            expect(src).toMatch(
                /static async listMapsByPractice\(\s*db:\s*PrismaTx,[\s\S]{0,200}ctx:\s*RequestContext,[\s\S]{0,200}practiceId:\s*string,?/,
            );
            // The return shape — (mapId, mapName, mapStatus, edgeKey,
            // edgeLabel) — is the contract the route + modal both
            // depend on. Anchor each field.
            for (const f of [
                "mapId",
                "mapName",
                "mapStatus",
                "edgeKey",
                "edgeLabel",
            ]) {
                expect(src).toMatch(new RegExp(`${f}:\\s*string`));
            }
        });

        it("queries ProcessEdgePractice with the canonical (tenantId, practiceId) filter", () => {
            // This is the seek that the schema's
            // `@@index([tenantId, practiceId])` supports. Anchored
            // here so a future refactor that filters on edge.id or
            // forgets tenantId trips the ratchet.
            expect(src).toMatch(
                /db\.processEdgePractice\.findMany\(\{[\s\S]{0,400}where:\s*\{\s*tenantId:\s*ctx\.tenantId,\s*practiceId\s*\}/,
            );
        });

        it("filters out soft-deleted process maps in-memory", () => {
            // The select pulls `deletedAt` and the filter applies
            // it client-side — necessary because the relation
            // doesn't have a `where` clause for cascading filters.
            expect(src).toMatch(/deletedAt:\s*true/);
            expect(src).toMatch(
                /\.filter\(\(r\)\s*=>\s*r\.edge\.processMap\.deletedAt === null\)/,
            );
        });
    });

    describe("Usecase — listMapsUsingPractice", () => {
        const src = read("src/app-layer/usecases/process-map.ts");

        it("exports the usecase + gates on canRead", () => {
            expect(src).toMatch(
                /export async function listMapsUsingPractice\([\s\S]{0,200}practiceId:\s*string,?\s*\)/,
            );
            // The usecase MUST call assertCanRead — reverse-lookup is
            // an information surface, not a write, but tenant
            // isolation still gates access.
            const fn = src.match(
                /export async function listMapsUsingPractice[\s\S]+?\n\}/,
            );
            expect(fn).not.toBeNull();
            expect(fn![0]).toMatch(/assertCanRead\(ctx\)/);
            expect(fn![0]).toMatch(
                /ProcessMapRepository\.listMapsByPractice\(db,\s*ctx,\s*practiceId\)/,
            );
        });
    });

    describe("Route — /api/t/<slug>/practices/<id>/process-maps", () => {
        const path =
            "src/app/api/t/[tenantSlug]/practices/[practiceId]/process-maps/route.ts";

        it("exists at the canonical Next.js path", () => {
            expect(exists(path)).toBe(true);
        });

        it("exports a withApiErrorHandling-wrapped GET", () => {
            const src = read(path);
            expect(src).toMatch(
                /export const GET = withApiErrorHandling\b/,
            );
            expect(src).toMatch(
                /listMapsUsingPractice\(ctx,\s*params\.practiceId\)/,
            );
            expect(src).toMatch(/jsonResponse\(\s*\{\s*maps\s*\}\s*\)/);
        });
    });

    describe("UI — PracticeReverseLookupModal", () => {
        const src = read(
            "src/components/practices/PracticeReverseLookupModal.tsx",
        );

        it("exports the component with the canonical props", () => {
            expect(src).toMatch(
                /export function PracticeReverseLookupModal\(\{[\s\S]{0,300}practiceId,[\s\S]{0,100}tenantSlug,[\s\S]{0,100}open,[\s\S]{0,100}onOpenChange,?/,
            );
        });

        it("fetches lazily — only when `open` is true", () => {
            // The useEffect MUST gate on `open` first; an
            // unconditional fetch would hit the API on every
            // practice detail page mount.
            expect(src).toMatch(
                /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,200}if\s*\(!open\)\s*return/,
            );
        });

        it("hits the canonical reverse-lookup URL", () => {
            expect(src).toMatch(
                /\/api\/t\/\$\{tenantSlug\}\/practices\/\$\{practiceId\}\/process-maps/,
            );
        });

        it("groups multi-edge results by map (one row per map)", () => {
            // The modal collapses duplicate map IDs into one row
            // with an edge count — verified by anchoring the group
            // accumulator + edgeCount field.
            expect(src).toMatch(/edgeCount:\s*\d+/);
            expect(src).toMatch(/edgeCount\s*\+=\s*1/);
        });

        it("deep-links each row to the canvas's activeId query param", () => {
            // The Link href must use `?activeId=<mapId>` so clicking
            // a map opens it directly in the canvas. The Processes
            // page reads `activeId` to seed the selector.
            expect(src).toMatch(
                /\/t\/\$\{tenantSlug\}\/processes\?activeId=\$\{g\.mapId\}/,
            );
        });

        it("carries the canonical testids for the three states", () => {
            for (const id of [
                "practice-reverse-lookup-body",
                "practice-reverse-lookup-empty",
                "practice-reverse-lookup-row",
                "practice-reverse-lookup-close",
            ]) {
                expect(src).toMatch(new RegExp(`data-testid="${id}"`));
            }
        });
    });

    describe("Practice detail page — wires the modal + button", () => {
        const src = read(
            "src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx",
        );

        it("imports the modal + mounts it with state", () => {
            expect(src).toMatch(
                /import\s*\{\s*PracticeReverseLookupModal\s*\}\s*from\s*['"]@\/components\/practices\/PracticeReverseLookupModal['"]/,
            );
            expect(src).toMatch(/<PracticeReverseLookupModal\b/);
            expect(src).toMatch(/reverseLookupOpen,?/);
        });

        it("the Where-used button is visible to ALL viewers (not gated on canWrite)", () => {
            // The reverse-lookup is informational — auditors (often
            // readers) need it most. The button must NOT live inside
            // the `permissions.canWrite ? (...) : null` group.
            expect(src).toMatch(
                /data-testid="practice-where-used-btn"/,
            );
            // The headerActions block now always renders the button
            // and gates only the write-practices below it.
            expect(src).toMatch(
                /const headerActions = \(\s*<>[\s\S]{0,500}practice-where-used-btn[\s\S]{0,400}permissions\.canWrite\s*&&/,
            );
        });
    });
});
