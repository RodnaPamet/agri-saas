/**
 * Epic P5-PR-A — ProcessMapSnapshot + version-history sidebar.
 *
 * Closes the brief's #5 🟡 "Version History / Diffing" gap for
 * the LIST direction. P5-PR-B will add the "view this version"
 * + visual diff renderers.
 *
 * The chain locked here:
 *
 *   1. Prisma schema — `ProcessMapSnapshot` model with composite
 *      FK to `(processMapId, tenantId)` + a (processMapId, version)
 *      unique that guards against duplicate snapshots on save
 *      retry.
 *   2. Migration — table creation + the 3-policy RLS shape that
 *      mirrors the rest of the process-map family (which the GRC
 *      teardown moved into automation.prisma).
 *   3. Repository — `replaceGraph` writes a snapshot inside the
 *      same outer tx as the version bump (atomic guarantee);
 *      `listSnapshots` returns descending by version.
 *   4. Usecase + route — `listProcessMapSnapshots` /
 *      `GET /api/t/<slug>/processes/<id>/snapshots`.
 *   5. UI — `<CanvasHistorySidebar>` mounts via the canonical
 *      AsidePanel primitive.
 *
 * If one link breaks the ratchet catches it before reviewers do.
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

const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe("Epic P5-PR-A — process map snapshots + version-history sidebar", () => {
    describe("Prisma schema — ProcessMapSnapshot model", () => {
        const src = readSchema();

        it("declares the model with the canonical column set", () => {
            // The graphJson Json column carries the full per-
            // version archive. Locking each canonical column here
            // means a future schema refactor that drops one trips
            // CI before the migration even runs.
            expect(src).toMatch(/model ProcessMapSnapshot \{/);
            expect(src).toMatch(/graphJson\s+Json/);
            expect(src).toMatch(/version\s+Int/);
            expect(src).toMatch(/createdAt\s+DateTime/);
            expect(src).toMatch(/createdByUserId\s+String/);
        });

        it("has the (processMapId, version) unique guard", () => {
            // Guards against retry-induced duplicate snapshots —
            // the contract that `replaceGraph` writes EXACTLY one
            // row per committed version.
            expect(src).toMatch(
                /@@unique\(\[processMapId,\s*version\]\)/,
            );
        });

        it("cascades on parent delete via the composite FK", () => {
            expect(src).toMatch(
                /processMap\s+ProcessMap\s+@relation\(fields:\s*\[processMapId,\s*tenantId\][\s\S]{0,300}onDelete:\s*Cascade/,
            );
        });

        it("Tenant + User carry the back-relations", () => {
            const authSrc = readSchema();
            expect(authSrc).toMatch(/processMapSnapshots\s+ProcessMapSnapshot\[\]/);
            expect(authSrc).toMatch(
                /processMapSnapshotsCreated\s+ProcessMapSnapshot\[\]\s+@relation\("ProcessMapSnapshotCreatedBy"\)/,
            );
        });
    });

    describe("Migration — RLS + FK + indexes", () => {
        const migrationPath =
            "prisma/migrations/20260526100000_p5_pra_process_map_snapshot/migration.sql";

        it("exists at the canonical timestamped path", () => {
            expect(exists(migrationPath)).toBe(true);
        });

        const src = read(migrationPath);

        it("creates the table + the unique constraint + indexes", () => {
            expect(src).toMatch(/CREATE TABLE "ProcessMapSnapshot"/);
            expect(src).toMatch(
                /CREATE UNIQUE INDEX "ProcessMapSnapshot_processMapId_version_key"/,
            );
            expect(src).toMatch(
                /CREATE INDEX "ProcessMapSnapshot_tenantId_processMapId_version_idx"/,
            );
        });

        it("wires the composite FK to ProcessMap with cascade delete", () => {
            expect(src).toMatch(
                /FOREIGN KEY \("processMapId",\s*"tenantId"\)[\s\S]{0,200}REFERENCES "ProcessMap"\("id",\s*"tenantId"\)\s+ON DELETE CASCADE/,
            );
        });

        it("ships the canonical 3-policy RLS shape + FORCE", () => {
            expect(src).toMatch(/ENABLE ROW LEVEL SECURITY/);
            expect(src).toMatch(/FORCE ROW LEVEL SECURITY/);
            for (const policy of [
                "tenant_isolation",
                "tenant_isolation_insert",
                "superuser_bypass",
            ]) {
                expect(src).toMatch(
                    new RegExp(
                        `CREATE POLICY ${policy} ON "ProcessMapSnapshot"`,
                    ),
                );
            }
        });
    });

    describe("Repository — replaceGraph writes a snapshot, listSnapshots reads", () => {
        const src = read(
            "src/app-layer/repositories/ProcessMapRepository.ts",
        );

        it("replaceGraph appends a snapshot.create after the version bump", () => {
            // The snapshot.create MUST live AFTER the conditional
            // updateMany (so it never writes for a stale-version
            // throw path). Anchor that ordering by checking the
            // snapshot.create lives between the version bump's
            // count-check + the final getByIdWithGraph return.
            expect(src).toMatch(
                /db\.processMapSnapshot\.create\(\{[\s\S]{0,400}processMapId:\s*id,[\s\S]{0,200}graphJson:\s*graphJsonPayload/,
            );
            // Belt-and-braces: the snapshot.create must occur
            // AFTER the conditional version bump's count-check
            // (so a stale-version throw skips it). Check by
            // anchoring updateMany before the snapshot create.
            const updateManyIdx = src.indexOf("processMap.updateMany");
            const snapshotIdx = src.indexOf("processMapSnapshot.create");
            expect(updateManyIdx).toBeGreaterThan(-1);
            expect(snapshotIdx).toBeGreaterThan(updateManyIdx);
        });

        it("snapshot's version matches `existing.version + 1` (the bumped value)", () => {
            // Reads the PRE-bump version + adds one rather than
            // re-fetching the row — fewer round-trips, matches
            // the conditional-bump shape.
            expect(src).toMatch(
                /const newVersion\s*=\s*\(existing\.version\s*\?\?\s*0\)\s*\+\s*1/,
            );
        });

        it("listSnapshots orders desc by version + caps at 200", () => {
            expect(src).toMatch(
                /static async listSnapshots\([\s\S]{0,500}orderBy:\s*\{\s*version:\s*['"]desc['"]/,
            );
            expect(src).toMatch(/take:\s*200/);
        });

        it("listSnapshots returns the canonical { id, version, createdAt, createdByUserId, createdByName } row shape", () => {
            expect(src).toMatch(
                /Array<\s*\{[\s\S]{0,400}id:\s*string;[\s\S]{0,100}version:\s*number;[\s\S]{0,200}createdAt:\s*Date;[\s\S]{0,200}createdByName:\s*string \| null;/,
            );
        });
    });

    describe("Usecase + route", () => {
        it("usecase listProcessMapSnapshots gates on canRead + calls the repo", () => {
            const src = read("src/app-layer/usecases/process-map.ts");
            const fn = src.match(
                /export async function listProcessMapSnapshots[\s\S]+?\n\}/,
            );
            expect(fn).not.toBeNull();
            expect(fn![0]).toMatch(/assertCanRead\(ctx\)/);
            expect(fn![0]).toMatch(
                /ProcessMapRepository\.listSnapshots\(db,\s*ctx,\s*mapId\)/,
            );
        });

        it("route exists at the canonical path + jsonResponse({ snapshots })", () => {
            const routePath =
                "src/app/api/t/[tenantSlug]/processes/[id]/snapshots/route.ts";
            expect(exists(routePath)).toBe(true);
            const src = read(routePath);
            expect(src).toMatch(/export const GET = withApiErrorHandling/);
            expect(src).toMatch(/jsonResponse\(\s*\{\s*snapshots\s*\}/);
        });
    });

    describe("UI — CanvasHistorySidebar", () => {
        const src = read(
            "src/components/processes/CanvasHistorySidebar.tsx",
        );

        it("exports the component with the canonical props", () => {
            expect(src).toMatch(
                /export function CanvasHistorySidebar\(\{[\s\S]{0,300}tenantSlug,[\s\S]{0,100}mapId,[\s\S]{0,100}currentVersion,?/,
            );
        });

        it("fetches from the canonical snapshots URL", () => {
            expect(src).toMatch(
                /\/api\/t\/\$\{tenantSlug\}\/processes\/\$\{mapId\}\/snapshots/,
            );
        });

        it("flags the current version via a `Current` badge", () => {
            expect(src).toMatch(
                /isCurrent\s*=\s*r\.version === currentVersion/,
            );
            expect(src).toMatch(/data-testid="canvas-history-current"/);
        });

        it("renders snapshot rows with version + author + timestamp", () => {
            for (const id of [
                "canvas-history-sidebar",
                "canvas-history-row",
            ]) {
                expect(src).toMatch(new RegExp(`data-testid="${id}"`));
            }
            // Each row exposes its version on a data attribute so
            // E2E + rendered tests can pick a specific row.
            expect(src).toMatch(/data-version=\{r\.version\}/);
            // Timestamp flows through the canonical formatter.
            expect(src).toMatch(/formatDateTime\(r\.createdAt\)/);
        });

        it("re-fetches when currentVersion changes (so a new save lands at the top)", () => {
            expect(src).toMatch(
                /\}\,\s*\[tenantSlug,\s*mapId,\s*currentVersion\]\)/,
            );
        });
    });

    describe("PersistedProcessCanvas — mounts the sidebar (visibility fix)", () => {
        const src = read(
            "src/components/processes/PersistedProcessCanvas.tsx",
        );

        it("imports the sidebar component", () => {
            expect(src).toMatch(
                /import\s*\{\s*CanvasHistorySidebar\s*\}\s*from\s*["']\.\/CanvasHistorySidebar["']/,
            );
        });

        it("renders <CanvasHistorySidebar> when a map is active", () => {
            // The pre-fix P5-PR-A shipped the component but never
            // mounted it — the version-history feature was
            // invisible to users. This anchor locks the wire so
            // a future refactor can't silently drop it again.
            expect(src).toMatch(
                /\{\s*activeId\s*&&\s*\(?\s*<CanvasHistorySidebar/,
            );
            expect(src).toMatch(/tenantSlug=\{tenantSlug\}/);
            expect(src).toMatch(/mapId=\{activeId\}/);
            expect(src).toMatch(
                /currentVersion=\{loadedMap\?\.version\s*\?\?\s*null\}/,
            );
        });
    });
});
