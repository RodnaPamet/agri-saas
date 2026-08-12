/**
 * R30 — Group nodes ratchet.
 *
 * First slice of the deferred bundle from R29: a parent/child
 * grouping primitive on the Processes canvas. Adds the eighth
 * canonical node kind (`group`) + the `parentNodeKey` round-trip
 * + Group / Ungroup toolbar actions.
 *
 *   1. Schema — `ProcessNode.parentNodeKey String?` + a partial
 *      index on `(processMapId, parentNodeKey)`.
 *   2. Save shape — `ProcessNodeInputSchema` accepts the new
 *      field; the repo carries it through `replaceGraph` and
 *      validates the parent reference points to another node in
 *      the same payload.
 *   3. Taxonomy — `group` kind + `group` NodeCategory.
 *   4. Renderer — branches on `category === 'group'` to render
 *      the translucent labelled container.
 *   5. Canvas wiring — load path round-trips `parentNodeKey` to
 *      xyflow's `parentId`; save path serialises it back; the
 *      parent-before-child reorder runs on rehydration; Group /
 *      Ungroup toolbar actions; "Group" gate disabled when any
 *      of the selection is already grouped or is itself a group.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The WHOLE schema folder, concatenated.
 *
 * These assertions are about what the schema DECLARES, not about which file
 * happens to hold it -- and models do move between files: the GRC teardown
 * relocated the Task, Asset, Evidence and process-map families out of the
 * compliance-owned files in a single commit that changed no column at all.
 * Reading one file by name made this guard fail on that pure move, which is
 * a guard reporting on filing rather than on the property it exists to hold.
 */
const readSchema = (): string =>
    fs
        .readdirSync(path.join(ROOT, 'prisma/schema'))
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => fs.readFileSync(path.join(ROOT, 'prisma/schema', f), 'utf8'))
        .join('\n');


describe("R30 — group nodes", () => {
    describe("schema + migration", () => {
        const prisma = readSchema();
        const migration = read(
            "prisma/migrations/20260525160000_r30_group_nodes/migration.sql",
        );

        it("ProcessNode declares the parentNodeKey field", () => {
            expect(prisma).toMatch(/^\s*parentNodeKey\s+String\?/m);
        });

        it("migration adds the column + a partial index", () => {
            expect(migration).toMatch(
                /ALTER TABLE "ProcessNode" ADD COLUMN "parentNodeKey"/,
            );
            expect(migration).toMatch(
                /CREATE INDEX[\s\S]{0,200}"ProcessNode"[\s\S]{0,200}\(\s*"processMapId",\s*"parentNodeKey"\s*\)[\s\S]{0,200}WHERE "parentNodeKey" IS NOT NULL/,
            );
        });
    });

    describe("save / load contract", () => {
        const schema = read("src/app-layer/schemas/process-map.ts");
        const repo = read(
            "src/app-layer/repositories/ProcessMapRepository.ts",
        );

        it("ProcessNodeInputSchema accepts parentNodeKey", () => {
            expect(schema).toMatch(
                /parentNodeKey:\s*z\.string\(\)\.max\(128\)\.optional\(\)\.nullable\(\)/,
            );
        });

        it("replaceGraph rejects self-reference + unknown parentNodeKey", () => {
            expect(repo).toMatch(/references itself as parentNodeKey/);
            expect(repo).toMatch(/references unknown parentNodeKey/);
        });

        it("replaceGraph persists parentNodeKey", () => {
            expect(repo).toMatch(/parentNodeKey:\s*n\.parentNodeKey \?\? null/);
        });

        it("getByIdWithGraph selects parentNodeKey", () => {
            // Anchor on the nodes-select block so the assertion is
            // narrow enough to fail loudly if the field gets dropped.
            const start = repo.indexOf("nodes: {");
            const slice = repo.slice(start, start + 600);
            expect(slice).toMatch(/parentNodeKey:\s*true/);
        });
    });

    describe("taxonomy + renderer", () => {
        const taxonomy = read("src/components/processes/node-taxonomy.ts");
        const renderer = read("src/components/processes/ProcessTypedNode.tsx");

        it("ProcessNodeKind includes 'group'", () => {
            expect(taxonomy).toMatch(/\|\s*['"]group['"]/);
        });

        it("NodeCategory includes 'group'", () => {
            expect(taxonomy).toMatch(/NodeCategory =[\s\S]{0,200}'group'/);
        });

        it("NODE_TAXONOMY carries the group entry with category 'group' + hasHandles false", () => {
            const start = taxonomy.indexOf("group: {");
            expect(start).toBeGreaterThan(0);
            // Wide slice — the entry includes a multi-line comment
            // block between `shape` and `category` so a tight
            // window misses the assertions.
            const slice = taxonomy.slice(start, start + 1400);
            expect(slice).toMatch(/category:\s*['"]group['"]/);
            expect(slice).toMatch(/hasHandles:\s*false/);
        });

        it("NODE_TAXONOMY_ORDER includes group", () => {
            expect(taxonomy).toMatch(
                /NODE_TAXONOMY_ORDER:[\s\S]{0,400}['"]group['"]/,
            );
        });

        it("typed-node renderer branches on category === 'group'", () => {
            expect(renderer).toMatch(/meta\.category === ["']group["']/);
        });
    });

    describe("canvas wiring", () => {
        const canvas = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("load path round-trips parentNodeKey to xyflow parentId", () => {
            expect(canvas).toMatch(
                /parentId:\s*n\.parentNodeKey,\s*extent:\s*["']parent["']/,
            );
        });

        it("save path serialises parentNodeKey via nodeParent(n)", () => {
            expect(canvas).toMatch(/parentNodeKey:\s*nodeParent\(n\)/);
        });

        it("rehydration reorders parents before children", () => {
            // Without the reorder, xyflow logs a warning and child
            // positions read as absolute. Locked here so a future
            // refactor that removes the sort fails CI loudly.
            expect(canvas).toMatch(/rehydratedNodes\.sort/);
        });

        it("registers handleGroupSelected + handleUngroup", () => {
            expect(canvas).toMatch(/const handleGroupSelected = useCallback/);
            expect(canvas).toMatch(/const handleUngroup = useCallback/);
        });

        it("Group action refuses to nest + refuses to fold an existing group", () => {
            // Two guards inside handleGroupSelected — locked
            // explicitly so a future "remove the gate" PR fails CI.
            expect(canvas).toMatch(/nodeParent\(n\) != null/);
            expect(canvas).toMatch(
                /\(n\.data as \{ kind\?: unknown \}\)\?\.kind === ["']group["']/,
            );
        });

        it("Ungroup makes child positions absolute again", () => {
            // The child's relative position is shifted by the
            // group's absolute position before the parent is
            // removed. Anchor on the canonical math expression.
            expect(canvas).toMatch(
                /position:\s*\{\s*x:\s*n\.position\.x \+ gx,\s*y:\s*n\.position\.y \+ gy\s*\}/,
            );
        });

        it("toolbar carries the Group + Ungroup testids", () => {
            expect(canvas).toMatch(/data-testid="group-selected-btn"/);
            expect(canvas).toMatch(/data-testid="ungroup-btn"/);
        });

        it("Group child save shifts position to relative coordinates", () => {
            // The grouping math: child.x -= group.x; child.y -= group.y.
            // Anchor on the canonical expression so a refactor that
            // forgets the shift fails the ratchet.
            expect(canvas).toMatch(/x:\s*n\.position\.x - minX/);
            expect(canvas).toMatch(/y:\s*n\.position\.y - minY/);
        });
    });
});
