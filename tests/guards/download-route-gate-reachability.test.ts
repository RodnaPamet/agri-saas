/**
 * Every route that streams a STORED object must gate on AV + tenant key.
 *
 * This is the EGRESS half of the convention CLAUDE.md documents under
 * "Uploaded bytes always reach a scanner". The ingest half has two guards
 * derived from two different roots — `upload-scan-explicitness` (from
 * `markStored` call sites) and `upload-route-scan-reachability` (from routes
 * that read `formData()`) — deliberately, "because each is blind to the
 * other's class".
 *
 * Neither is blind to the same class. BOTH are blind to the same DIRECTION.
 * There was no guard at all over downloads, and that is how four of five
 * byte-serving routes came to have no AV gate:
 *
 *   - `/api/t/:slug/files/:name/download`   — assertCanRead only
 *   - `/api/t/:slug/files/:name`            — assertCanRead only, and served
 *                                             `Content-Disposition: inline`
 *   - `/api/files/:name`                    — no tenant in the path at all
 *   - `/api/t/:slug/access-reviews/:id/evidence` — selected neither `status`
 *                                             nor `scanStatus`, so it could
 *                                             not have gated if asked
 *
 * The first three are deleted (they had zero callers). This guard is what
 * stops the fourth shape reappearing.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. `src/lib/upload/ingest.ts` justifies
 * writing bytes BEFORE scanning them with: "every read of those bytes goes
 * through a download route that asks `isDownloadAllowed` first." That
 * sentence is the soundness argument for the entire ingest design. It was
 * false. A download route with no gate does not just leak one file — it
 * retroactively invalidates the reason uploads are allowed to hit disk
 * unscanned.
 *
 * DERIVED ROOT: routes that call a byte-reading storage primitive
 * (`readStream` / `getSignedUrl` / `createSignedDownloadUrl`) directly, or
 * that call a usecase which does. A route that streams via a usecase is
 * covered through `USECASE_SEAMS` below.
 *
 * WHAT THIS IS BLIND TO, stated so the next reader does not over-trust it:
 * a NEW usecase that streams bytes and is not listed in `USECASE_SEAMS`.
 * That is why the seam list is asserted non-empty and why each entry must
 * still exist — a rename empties the list rather than silently passing.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const API = join(ROOT, 'src', 'app', 'api');

/** Byte-reading primitives. A route reaching one of these serves bytes. */
const BYTE_PRIMITIVES = ['readStream', 'createSignedDownloadUrl', 'getSignedUrl'];

/**
 * Usecases that stream STORED objects and own the gate on the route's
 * behalf. A route delegating to one of these is covered.
 */
const USECASE_SEAMS: ReadonlyArray<{ fn: string; file: string; reason: string }> = [
    {
        fn: 'downloadEvidenceFile',
        file: 'src/app-layer/usecases/evidence.ts',
        reason:
            'Owns the STORED check, the AV status check, assertTenantKey on the RESOLVED pathKey, the soft-delete check and the READER/AUDITOR provenance rule.',
    },
];

/**
 * Routes that serve bytes which were NEVER a stored object — generated in
 * the request (CSV, PDF, an upstream tile proxied through). There is no
 * scanStatus to consult because there is no FileRecord.
 */
const GENERATED_BYTES: ReadonlyArray<{ route: string; reason: string }> = [];

function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (entry === 'route.ts') out.push(full);
    }
    return out;
}

/** Exported for the mutation proof. */
export function findUngatedRoutes(
    routes: ReadonlyArray<{ rel: string; text: string }>,
    seamFns: readonly string[],
    exempt: readonly string[],
): string[] {
    return routes
        .filter((r) => !exempt.includes(r.rel))
        // Serves bytes: touches a primitive directly, or delegates to a seam.
        .filter((r) => BYTE_PRIMITIVES.some((p) => r.text.includes(p)))
        // …and does NOT delegate to a seam that owns the gate.
        .filter((r) => !seamFns.some((fn) => r.text.includes(fn)))
        // …and does not gate inline.
        .filter(
            (r) =>
                !r.text.includes('isDownloadAllowed') ||
                !r.text.includes('assertTenantKey'),
        )
        .map((r) => r.rel);
}

describe('download routes reach the AV + tenant-key gate', () => {
    const routes = walk(API).map((full) => ({
        rel: full.replace(ROOT + '/', ''),
        text: readFileSync(full, 'utf8'),
    }));

    it('the route scan found a plausible tree', () => {
        // Guards the guard. A broken walk makes every list look clean.
        expect(routes.length).toBeGreaterThan(50);
    });

    it('every seam in USECASE_SEAMS still exists and still gates', () => {
        // A rename would silently empty the seam list, and an empty seam
        // list makes the main assertion below trivially strict rather than
        // trivially loose — but the reason matters, so pin it.
        expect(USECASE_SEAMS.length).toBeGreaterThan(0);
        for (const s of USECASE_SEAMS) {
            const p = join(ROOT, s.file);
            expect(existsSync(p)).toBe(true);
            const src = readFileSync(p, 'utf8');
            expect(src).toContain(`export async function ${s.fn}`);
            expect(src).toContain('assertTenantKey');
            expect(s.reason.trim().length).toBeGreaterThan(20);
        }
    });

    it('no route serves stored bytes without a gate', () => {
        const ungated = findUngatedRoutes(
            routes,
            USECASE_SEAMS.map((s) => s.fn),
            GENERATED_BYTES.map((g) => g.route),
        );
        expect({ ungated }).toEqual({ ungated: [] });
    });

    it('the generated-bytes carve-out carries a reason per entry', () => {
        for (const g of GENERATED_BYTES) {
            expect(g.reason.trim().length).toBeGreaterThan(20);
        }
    });

    // ── Mutation proof ────────────────────────────────────────────────
    // A guard that cannot fail is decoration. These drive the detector with
    // a corpus wrong in the exact way the real one was.
    describe('the detector actually detects', () => {
        it('flags a route that streams with only assertCanRead', () => {
            const corpus = [{
                rel: 'src/app/api/t/[tenantSlug]/files/[fileName]/download/route.ts',
                text: `assertCanRead(ctx);\nconst stream = provider.readStream(file.pathKey);`,
            }];
            expect(findUngatedRoutes(corpus, ['downloadEvidenceFile'], [])).toHaveLength(1);
        });

        it('accepts a route that delegates to a gating seam', () => {
            const corpus = [{
                rel: 'src/app/api/t/[tenantSlug]/evidence/files/[fileId]/download/route.ts',
                text: `const res = await downloadEvidenceFile(ctx, fileId); // readStream lives in the usecase`,
            }];
            expect(findUngatedRoutes(corpus, ['downloadEvidenceFile'], [])).toEqual([]);
        });

        it('accepts a route that gates inline with BOTH checks', () => {
            const corpus = [{
                rel: 'src/app/api/x/route.ts',
                text: `if (!isDownloadAllowed(f.scanStatus)) throw forbidden();\nassertTenantKey(f.pathKey, ctx.tenantId);\nprovider.readStream(f.pathKey);`,
            }];
            expect(findUngatedRoutes(corpus, [], [])).toEqual([]);
        });

        it('flags a route with only HALF the inline gate', () => {
            // The access-reviews shape: an AV thought without a tenant
            // assert is not a gate.
            const corpus = [{
                rel: 'src/app/api/y/route.ts',
                text: `if (!isDownloadAllowed(f.scanStatus)) throw forbidden();\nprovider.readStream(f.pathKey);`,
            }];
            expect(findUngatedRoutes(corpus, [], [])).toHaveLength(1);
        });

        it('ignores a route that serves no bytes', () => {
            const corpus = [{ rel: 'src/app/api/z/route.ts', text: `return jsonResponse({ ok: true });` }];
            expect(findUngatedRoutes(corpus, [], [])).toEqual([]);
        });
    });
});
