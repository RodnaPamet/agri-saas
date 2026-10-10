/**
 * Ratchet: a request body is declared ONCE, not twice (#1555).
 *
 * ## The shape
 *
 * A route can parse a body schema it declares itself, while
 * `src/lib/openapi/paths/*.ts` declares a second schema for the same path's
 * `body:`. Both are hand-written Zod, neither imports the other, and nothing
 * compares them — so a change to one is invisible to the other.
 *
 * Four of these were byte-identical duplicates, and `locations.paths.ts` said
 * so in its own published description: "Mirrors the schema declared inside the
 * bulk-delete route handler." A mirror nobody checks is the problem.
 *
 * ## Why a cap and not a comparison
 *
 * I first proposed a contract test comparing the two declarations' property
 * sets. It was withdrawn, and the reason is worth keeping: extracting "the
 * route's body schema" needs the right schema out of the file, and declaration
 * order does not give it. On 2 of 64 route files the first `z.object({` is a
 * QUERY schema, and on 5 more the local schema is a query schema while the
 * body comes from an imported shared one — the pattern this guard wants.
 * A comparator built on "the first local schema" would have compared query
 * schemas against request bodies and produced confident false alarms.
 *
 * It also mis-sized the problem. The population was filed as 23 by counting
 * routes with ANY local schema whose path the spec documents; asking instead
 * which schema the route parses the BODY with gives 14 — and 5 of the 23 were
 * working examples counted as instances of the defect.
 *
 * So this guard does the simpler, more robust thing: one structural rule over
 * a DERIVED population. Not duplicating a declaration beats detecting drift in
 * a duplicated one, and 14 is small enough to convert rather than monitor.
 *
 * ## Shrink-only
 *
 * `MAX_DUAL` is a floor to drive down, not a budget to spend. Converting a
 * route lowers it; adding one fails. The list is printed on failure so the
 * diff is actionable rather than just a number.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

interface SpecDoc {
    paths: Record<string, Record<string, { requestBody?: unknown } | unknown>>;
}

const spec = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src/generated/openapi.json'), 'utf8'),
) as SpecDoc;

/** `src/app/api/t/[tenantSlug]/x/route.ts` -> `/api/t/{tenantSlug}/x` */
function specPathFor(rel: string): string {
    return rel.replace(/^src\/app/, '').replace(/\/route\.ts$/, '').replace(/\[([^\]]*)\]/g, '{$1}');
}

function specDeclaresBody(path: string): boolean {
    const ops = spec.paths[path];
    if (!ops) return false;
    return Object.values(ops).some(
        (op) => typeof op === 'object' && op !== null && 'requestBody' in op,
    );
}

interface Finding {
    file: string;
    path: string;
    schema: string;
}

const routeFiles = collectSourceFiles({
    roots: ['src/app/api'],
    extensions: ['.ts'],
    exclude: (rel) => !rel.endsWith('/route.ts'),
    // 370+ at the time of writing. A floor near reality catches an exclude
    // predicate that ate the tree rather than reporting it clean — the
    // empty-selection failure this whole file is a ratchet against.
    floor: 300,
});

const dual: Finding[] = [];
const shared: Finding[] = [];

for (const full of routeFiles) {
    const rel = relative(REPO_ROOT, full);
    const code = blankNonCode(readFileSync(full, 'utf8'));

    const local = new Set([...code.matchAll(/const\s+(\w*Schema\w*)\s*=\s*z/g)].map((m) => m[1]));

    // Which schema does this route parse the BODY with? Derived from the call
    // site, never from declaration order — that distinction is the whole
    // reason the earlier property comparator was withdrawn.
    const bodyUsed = new Set<string>([
        ...[...code.matchAll(/withValidatedBody\(\s*(\w+)/g)].map((m) => m[1]),
        ...[...code.matchAll(/(\w+Schema)\s*\.\s*(?:safeP|p)arse\(\s*(?:await\s+)?req(?:uest)?\.json\(\)/g)].map(
            (m) => m[1],
        ),
        ...[...code.matchAll(/(\w+Schema)\s*\.\s*(?:safeP|p)arse\(\s*body/g)].map((m) => m[1]),
    ]);

    const path = specPathFor(rel);
    if (!specDeclaresBody(path)) continue;

    for (const name of bodyUsed) {
        if (local.has(name)) dual.push({ file: rel, path, schema: name });
        else shared.push({ file: rel, path, schema: name });
    }
}

/**
 * Live count. LOWER this when a route is converted; never raise it.
 *
 *     14  before #1555
 *     10  batch 1 — the four bulk-ids schemas
 *      5  batch 2 — admin members/invites/certificates and the field-op review
 *      1  batch 3 — ingest, me/farms, farm-tasks, agro/data-streams
 *      0  batch 4 — locations/{id}/farm-record
 *
 * ZERO, and the cap stays there. Every request body with a published contract
 * is now declared once and imported by both sides, so the class this guard
 * detects cannot exist without the count moving off 0 — which is a much
 * sharper signal than a floor with headroom.
 *
 * farm-record was held back from batch 3 on purpose: #1577 was editing that
 * route's `BodySchema` in place to fix an unvalidated period (#1575), and
 * converting it in the same window would have been two changes fighting over
 * one declaration. It landed first, and its validated `from`/`to` came across
 * with the schema.
 *
 * The drift assertion below is what forced this down each time: with the cap
 * left at 10 and five live, `MAX_DUAL - dual.length` was 5 and the suite
 * failed. A cap that silently kept its old headroom would have left room for a
 * regression to land unnoticed, which is the whole failure mode a ratchet
 * exists to prevent.
 */
const MAX_DUAL = 0;

describe('a request body is declared once (#1555)', () => {
    it('the population is real — the denominator', () => {
        // Without this, "no dual declarations" is satisfied by scanning no
        // routes, or by a spec whose paths stopped matching the route tree.
        expect(routeFiles.length).toBeGreaterThan(300);
        expect(Object.keys(spec.paths).length).toBeGreaterThan(100);
    });

    it('body-schema resolution WORKS — the shared routes prove it', () => {
        // The control the cap cannot provide. If the resolver found nothing,
        // `dual` would be empty and this guard would pass while measuring
        // nothing. These five parse an IMPORTED schema the spec also uses, so
        // finding them proves the detector resolves body schemas at all — and
        // that it tells "imported" from "local", which is the distinction the
        // whole rule rests on.
        expect(shared.length).toBeGreaterThanOrEqual(5);
        const paths = shared.map((s) => s.path);
        expect(paths).toContain('/api/t/{tenantSlug}/tasks');
        expect(paths).toContain('/api/t/{tenantSlug}/journal');
    });

    it('every route converted so far is NOT dual any more', () => {
        // Pins the conversions, so re-inlining any one fails here with the
        // reason rather than only moving a number. Grouped by batch because
        // the batches had different hazards: batch 1 was byte-identical
        // duplicates, batch 2 carried published DESCRIPTIONS on the spec side
        // and none on the route side, so the move had to bring the prose with
        // it or the contract would have silently lost documentation.
        const dualPaths = dual.map((d) => d.path);
        const converted = [
            // batch 1 — bulk id lists
            '/api/t/{tenantSlug}/admin/members/bulk/remove',
            '/api/t/{tenantSlug}/admin/members/bulk/delete',
            '/api/t/{tenantSlug}/admin/invites/bulk/delete',
            '/api/t/{tenantSlug}/locations/bulk/delete',
            // batch 2 — admin members / invites / field-op review
            '/api/t/{tenantSlug}/admin/members',
            '/api/t/{tenantSlug}/admin/members/{membershipId}',
            '/api/t/{tenantSlug}/admin/members/{membershipId}/certificates',
            '/api/t/{tenantSlug}/admin/invites',
            '/api/t/{tenantSlug}/field-operations/{taskId}/review',
            // batch 3 — the agro / farm bodies. The ingest one had ACTIVE
            // drift rather than latent: the route enforced
            // `.min(1).max(1000)` on `readings` and the spec published no
            // bounds at all, so the limit existed only in its prose.
            '/api/agro/data-streams/{streamId}/ingest',
            '/api/me/farms',
            '/api/t/{tenantSlug}/farm-tasks',
            '/api/t/{tenantSlug}/agro/data-streams',
            // batch 4 — the last one. Its spec copy admitted the duplication
            // in its own published description: "Mirrors the schema declared
            // inside the farm-record route handler."
            '/api/t/{tenantSlug}/locations/{id}/farm-record',
        ];
        for (const p of converted) {
            expect(dualPaths).not.toContain(p);
        }
        expect(converted).toHaveLength(14);
    });

    it('no NEW route declares its body twice', () => {
        if (dual.length > MAX_DUAL) {
            throw new Error(
                `${dual.length} routes declare their request body twice, cap ${MAX_DUAL}:\n\n` +
                    dual
                        .map((d) => `    ${d.path}\n        ${d.file}  (local ${d.schema})`)
                        .join('\n') +
                    `\n\nThe route parses a schema it declares ITSELF, while ` +
                    `src/lib/openapi/paths/*.ts declares a second one for the same path's ` +
                    `body:. Both are hand-written Zod, neither imports the other, and ` +
                    `nothing compares them (#1555).\n\n` +
                    `Declare it ONCE in src/lib/schemas/ with its own .openapi('Name') ` +
                    `registration and import it from both sides — the pattern ` +
                    `/tasks, /journal, /locations and the planning routes already use. ` +
                    `Keep the published component NAME identical or the spec gains a ` +
                    `renamed component, which is a contract change.\n\n` +
                    `If you are converting one, LOWER the cap in this file. It is a floor ` +
                    `to drive to zero, not a budget.`,
            );
        }
    });

    it('the cap tracks reality — lower it after a conversion', () => {
        // Without this the cap rots upward-looking: a conversion that is never
        // reflected leaves headroom for a silent regression. Mirrors the
        // drift-allowance pattern the other ratchets in this directory use.
        expect(dual.length).toBeLessThanOrEqual(MAX_DUAL);
        expect(MAX_DUAL - dual.length).toBeLessThanOrEqual(2);
    });
});
