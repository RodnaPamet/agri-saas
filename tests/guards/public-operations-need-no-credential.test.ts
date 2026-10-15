/**
 * Guard: every documented operation under `/api/public/` declares
 * `security: []` (#1843).
 *
 * ## The defect
 *
 * `op()` applies `input.security ?? [{sessionCookie}, {bearerToken}]` per
 * operation at registration — there is no document-level `security` in this
 * spec — so an anonymous route that omits `security` is DOCUMENTED as
 * requiring a session it does not require.
 *
 * That was live for two routes whose own descriptions said "ANONYMOUS" or
 * "without an account":
 *
 *   • `GET /api/public/farms` (`searchPublicFarms`)
 *   • `POST /api/public/notices` (`fileAnonymousNotice`)
 *
 * The cost is not cosmetic. A client generated from the spec sends credentials
 * it does not need; a reader trusting the block over the prose concludes the
 * endpoint is unreachable signed out; and a stranger's browser or a signed-out
 * phone cannot send them at all. Each also documented a 401 it cannot return
 * for a missing session. Found from the phone's side — agrent-ios #323 calls
 * `searchPublicFarms` signed out — and first raised on #1840 after it was
 * green, which is why it merged without the change.
 *
 * `fileAnonymousNotice` is the one that matters most: a DSA Art 16 notice form
 * that any person must be able to use. #1745 is the same obligation 401'ing at
 * the EDGE for seven weeks; documenting it as credentialed is the quieter
 * version of the same mistake, and the repo had already argued in writing that
 * the route is "anonymous by design, and by LEGAL DUTY".
 *
 * ## The population is the `/api/public/` SEGMENT, from the filesystem
 *
 * And NOT `isPublicPath`, which I tried first and which is wrong here.
 * `isPublicPath` answers "does the EDGE let this through" — a different
 * question from "does this need no credential", as CLAUDE.md says in terms.
 * Under it, `GET /api/auth/me`, the native sign-in family and every
 * `/api/admin/moderation/*` route are "public", because the Edge understands
 * only a NextAuth cookie and those surfaces authenticate themselves in the
 * handler: the moderation console needs `x-platform-admin-key`, which the Edge
 * would 401 before the handler ran.
 *
 * Deriving from it reported 23 operations and demanded `security: []` on
 * routes that genuinely require a credential — which would have documented the
 * platform-admin surface as anonymous. That is a worse defect than the one
 * being fixed, in the same file, so the wrong population is recorded here
 * rather than just replaced.
 *
 * `src/app/api/public/**` is the segment reserved for surfaces reachable by a
 * person with no account. Three routes today, and covered the moment a fourth
 * exists.
 *
 * ## What it does NOT check
 *
 * Whether the route is CORRECTLY public. That is
 * `public-routes-self-authenticate` (does the handler need no credential by
 * design) and `public-route-exemptions-are-edge-reachable` (does the Edge
 * admit it). This asks only whether the SPEC agrees — a third thing neither of
 * them looks at.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

import { isPublicPath } from '@/lib/auth/guard';

interface Operation {
    operationId?: string;
    security?: unknown[];
}
interface Spec {
    security?: unknown[];
    paths: Record<string, Record<string, Operation>>;
}

const spec = JSON.parse(
    readFileSync(join(REPO_ROOT, 'src/generated/openapi.json'), 'utf8'),
) as Spec;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Spec-shaped paths for every route file under `src/app/api/public/`. */
function publicRouteFiles(): string[] {
    const root = join(REPO_ROOT, 'src/app/api/public');
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            // `[param]` on disk is `{param}` in the spec.
            else if (entry.name === 'route.ts') {
                const rel = full.slice(root.length, full.length - '/route.ts'.length);
                out.push(`/api/public${rel.replace(/\[([^\]]+)\]/g, '{$1}')}`);
            }
        }
    };
    walk(root);
    return out.sort();
}

function publicOperations(): Array<{ path: string; method: string; op: Operation }> {
    const paths = new Set(publicRouteFiles());
    const out: Array<{ path: string; method: string; op: Operation }> = [];
    for (const [specPath, ops] of Object.entries(spec.paths)) {
        if (!paths.has(specPath)) continue;
        for (const method of METHODS) {
            const op = ops[method];
            if (op && typeof op === 'object') out.push({ path: specPath, method, op });
        }
    }
    return out;
}

describe('a documented anonymous operation needs no credential (#1843)', () => {
    const ops = publicOperations();

    it('ranges over the /api/public segment — the denominator', () => {
        const files = publicRouteFiles();
        const documented = Object.values(spec.paths).reduce(
            (n, o) => n + METHODS.filter((m) => o[m]).length,
            0,
        );
        console.log(
            `[public-op-security] ${files.length} route file(s) under /api/public, `
                + `${ops.length} documented operation(s) of ${documented} in the spec: `
                + ops.map((o) => `${o.method.toUpperCase()} ${o.path}`).join(', '),
        );
        // A floor: the assertion below passes for free over an empty
        // population, which is what a renamed segment or an unparseable spec
        // would produce.
        expect(files.length).toBeGreaterThanOrEqual(3);
        expect(ops.length).toBeGreaterThanOrEqual(3);
    });

    it('op() DEFAULTS to a credential, which is what makes this matter', () => {
        // The control, and the mechanism I had wrong at first: there is NO
        // document-level `security`. `op()` applies the default per operation,
        // so an omitted `security` is a CREDENTIALED operation rather than an
        // absent field. If that default were `[]` this guard would assert
        // nothing.
        expect(spec.security).toBeUndefined();
        // Comments blanked (#1774), and the shrink-only cap in
        // `guards-blank-comments-before-matching` caught this guard's first
        // version for omitting it — correctly, and it is the trap in
        // miniature: the NO_AUTH docblock I added to helpers.ts in this very
        // change discusses `input.security ??` and the credentialed default
        // at length, so an unblanked read is matching prose about the
        // mechanism alongside the mechanism. Comments only, not strings: the
        // pattern below is code.
        const helpers = blankNonCode(
            readFileSync(join(REPO_ROOT, 'src/lib/openapi/paths/helpers.ts'), 'utf8'),
        );
        expect(helpers).toMatch(/security:\s*input\.security\s*\?\?\s*\[\{\s*sessionCookie/);
    });

    it('every /api/public route file is also admitted by the EDGE', () => {
        // The relation CLAUDE.md asserts between the two populations: a route
        // under this segment that `isPublicPath` refuses is unreachable, so
        // documenting it as anonymous would describe a surface nobody can
        // call — #1745's shape.
        const refused = publicRouteFiles().filter((p) => !isPublicPath(p.replace(/\{[^}]+\}/g, 'x')));
        expect(refused).toEqual([]);
    });

    it('every /api/public route file HAS a documented operation', () => {
        // Otherwise this guard passes by the route being undocumented, which
        // is a different defect wearing the same green.
        const documented = new Set(publicOperations().map((o) => o.path));
        const undocumented = publicRouteFiles().filter((p) => !documented.has(p));
        expect(undocumented).toEqual([]);
    });

    it.each(publicOperations().map((o) => [`${o.method.toUpperCase()} ${o.path}`, o.path, o.method] as const))(
        '%s declares security: []',
        (_label, path, method) => {
            const op = spec.paths[path]?.[method];
            const declared = op?.security;
            if (!Array.isArray(declared) || declared.length !== 0) {
                throw new Error(
                    `${method.toUpperCase()} ${path} (${op?.operationId ?? 'no operationId'}) is under\n`
                        + `the /api/public segment but the spec says it needs a credential:\n`
                        + `  security: ${JSON.stringify(declared)}\n\n`
                        + `op() defaults to [{sessionCookie}, {bearerToken}] unless told otherwise, so\n`
                        + `a client generated from this spec sends credentials it does not have — and a\n`
                        + `signed-out browser or phone cannot send them at all.\n\n`
                        + `Pass \`security: NO_AUTH\` to op() (exported from\n`
                        + `src/lib/openapi/paths/helpers.ts) and regenerate with\n`
                        + `\`npm run openapi:generate\`.\n\n`
                        + `If the route is NOT meant to be anonymous it does not belong under\n`
                        + `/api/public — and that is a security question, not a documentation one.`,
                );
            }
            expect(declared).toEqual([]);
        },
    );

    it('a TENANT operation still declares a credential — the other direction', () => {
        // Without this, a change that blanket-emptied every operation's
        // security would satisfy every case above while documenting the whole
        // API as anonymous.
        const tenantOps = Object.entries(spec.paths)
            .filter(([p]) => p.startsWith('/api/t/'))
            .flatMap(([p, o]) => METHODS.filter((m) => o[m]).map((m) => ({ p, m, op: o[m] })));
        expect(tenantOps.length).toBeGreaterThan(50);
        const anonymous = tenantOps.filter(
            (o) => Array.isArray(o.op.security) && o.op.security.length === 0,
        );
        expect(anonymous.map((o) => `${o.m.toUpperCase()} ${o.p}`)).toEqual([]);
    });
});
