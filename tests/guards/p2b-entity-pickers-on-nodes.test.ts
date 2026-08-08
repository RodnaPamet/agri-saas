/**
 * Epic P2-PR-B — Entity pickers on nodes (control / asset).
 *
 * Brief gap #11 🟠 "Domain Entity Linking" — P2-PR-A wired the
 * edge-mode control picker (#733); P2-PR-B wires the node-mode
 * pickers for the three compliance-entity node kinds:
 *
 *   - `control` node → picks a tenant Control (the same picker
 *     primitive as the edge mode, different mount).
 *   - `asset` node → picks a tenant Asset.
 *
 * The selection writes to `data.linkedEntityId` (one shared field;
 * the node's `data.kind` disambiguates on read). The canvas's
 * `nodeDataJson` serialiser persists it via the existing
 * ProcessNode `dataJson` column — no schema migration.
 *
 * This ratchet locks the chain across all the touch points so a
 * future refactor that silently drops one (a forgotten dataJson
 * field, a hook that stops fetching, a kind that no longer mounts
 * the picker) gets caught before reviewers do.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("Epic P2-PR-B — entity pickers on nodes", () => {
    describe("useTenantAssets hook (P2-PR-B sibling)", () => {
        const src = read("src/lib/processes/use-tenant-assets.ts");

        it("exports the hook + a formatAssetLabel helper", () => {
            // PR-D polish added the optional second arg
            // (`options?: { pollMs?: number }`).
            expect(src).toMatch(
                /export function useTenantAssets\(\s*tenantSlug:\s*string,\s*options\?:\s*UseTenantAssetsOptions,?\s*\):\s*TenantAssetsState/,
            );
            expect(src).toMatch(/export function formatAssetLabel/);
        });

        it("returns options shape: { id, key, name }", () => {
            expect(src).toMatch(
                /interface TenantAssetOption \{[\s\S]{0,300}id:\s*string;[\s\S]{0,200}key:\s*string \| null;[\s\S]{0,200}name:\s*string;/,
            );
        });

        it("hits /api/t/<slug>/assets", () => {
            expect(src).toMatch(/\/api\/t\/\$\{tenantSlug\}\/assets/);
        });

        it("formatAssetLabel prefers `<key> · <name>` when key is present", () => {
            // The format is locked because the picker option labels
            // need to read consistently — a refactor that flips the
            // separator to ` - ` or drops the key gets caught here.
            expect(src).toMatch(
                /opt\.key\s*\?\s*`\$\{opt\.key\}\s*·\s*\$\{opt\.name\}`\s*:\s*opt\.name/,
            );
        });
    });

    describe("ProcessInspector — node mode mounts the picker on control/asset", () => {
        const src = read("src/components/processes/ProcessInspector.tsx");

        it("imports the sibling hooks", () => {
            // Was a pair (risks + assets) until the risk register was
            // removed. The regex accepts a single-import OR a
            // multi-import form so a future rename doesn't lock the
            // import shape too tight.
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useTenantControls[\s\S]{0,200}\}\s*from\s*["']@\/lib\/processes\/use-tenant-controls["']/,
            );
            expect(src).toMatch(
                /import\s*\{[\s\S]{0,200}useTenantAssets[\s\S]{0,200}\}\s*from\s*["']@\/lib\/processes\/use-tenant-assets["']/,
            );
        });

        it("declares the NodeLinkedEntityPicker child component", () => {
            expect(src).toMatch(/function NodeLinkedEntityPicker/);
        });

        it("the picker mounts only on control/asset kinds", () => {
            // The early-return guard is the contract that says
            // "other kinds get NO picker block". A refactor that
            // moves the picker to processStep / decision / external
            // would have to update this assertion.
            expect(src).toMatch(
                /if\s*\(nodeKind !== "control" && nodeKind !== "asset"\)/,
            );
        });

        it("picker carries the canonical testid + entity-kind attribute", () => {
            expect(src).toMatch(
                /data-testid="inspector-node-entity-picker"/,
            );
            expect(src).toMatch(/data-entity-kind=\{nodeKind\}/);
        });

        it("ProcessInspectorProps `onUpdate` patch accepts linkedEntityId: string | null", () => {
            expect(src).toMatch(
                /linkedEntityId\?:\s*string \| null;/,
            );
        });
    });

    describe("Canvas — round-trips linkedEntityId on load + save", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("nodeDataJson emits linkedEntityId when present", () => {
            // The canvas's save serialiser MUST include the field;
            // the pre-P2-B shape only emitted size + width + height.
            expect(src).toMatch(
                /linkedEntityId\?:\s*string;[\s\S]{0,2000}out\.linkedEntityId\s*=\s*linkedEntityId/,
            );
        });

        it("rehydration projects linkedEntityId onto data when present", () => {
            // Anchor on the conditional spread — empty strings
            // shouldn't bloat data.
            expect(src).toMatch(
                /linkedEntityId\s*=\s*typeof json\?\.linkedEntityId === "string"/,
            );
            expect(src).toMatch(
                /\.\.\.\(linkedEntityId\s*\?\s*\{\s*linkedEntityId\s*\}/,
            );
        });

        it("handleInspectorUpdate accepts the linkedEntityId patch field", () => {
            expect(src).toMatch(
                /patch:\s*\{[\s\S]{0,800}linkedEntityId\?:\s*string \| null;/,
            );
            // null clears, string sets, undefined skips — anchor on
            // the three-state spread-ternary predicate.
            expect(src).toMatch(
                /patch\.linkedEntityId\s*!==\s*undefined[\s\S]{0,300}patch\.linkedEntityId\s*===\s*null/,
            );
        });
    });
});
