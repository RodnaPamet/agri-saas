/**
 * A route's error BODY must match the schema its operation DECLARES (#1447).
 *
 * ## Two shapes exist, and that is not itself a defect
 *
 * `ErrorResponse` is `{ error: { code, message, requestId?, details?, params? } }`
 * and its description tells clients to switch on `error.code`.
 *
 * `RawErrorResponse` is `{ error: "<string>" }`, and the spec says so in terms:
 * "Non-canonical error body used by the spatial-import and cadastre-import
 * routes: a bare message string, with no `code`, `requestId` or `details`."
 *
 * So a route returning a bare string is only wrong when its own operation
 * declares `ErrorResponse`. Where it declares `RawErrorResponse`, the contract
 * and the code agree and a client reading the string is reading the contract.
 * This guard checks the AGREEMENT, not the shape.
 *
 * ## Why an exact ref comparison, stated because I got this wrong
 *
 * The first measurement of #1447 tested `'ErrorResponse' in json.dumps(response)`
 * and reported **9** violations. `'ErrorResponse' in 'RawErrorResponse'` is
 * true, so every correctly-documented route scored as a violation. The real
 * count was **2**.
 *
 * A substring test cannot separate the two worlds it exists to separate, which
 * is why `declaresCanonicalError` compares the dereferenced schema NAME and the
 * fixture below asserts that `RawErrorResponse` is not mistaken for
 * `ErrorResponse`. That fixture is the positive control the original probe
 * lacked — a case it is known to reject — and without one a detector that
 * matches everything looks identical to a tree that is entirely broken.
 *
 * ## Ratchet, not a clean sweep
 *
 * 26 bare-string bodies sit on paths that are not in the spec yet. They are
 * neither agreement nor contradiction — there is nothing to disagree with. They
 * become violations the day someone documents those paths, which is precisely
 * how #1447 was found, so the documenting PR is where they get fixed.
 *
 * Counting them here keeps the number visible instead of letting it reach 69
 * again unnoticed, and the ceiling is the only honest way to do that while they
 * exist.
 *
 * ## SCOPE: tenant routes only, and the zero below means less than it looks
 *
 * The root is `src/app/api/t`. Everything else is invisible to this file —
 * measured at **28 files and 78 occurrences**, of which `/api/auth/` is 14
 * files and 44 occurrences, carrying **34 per-status contradictions right now.**
 *
 * So "contradicting: 0" is 0 AMONG TENANT ROUTES, not 0 in the codebase, and a
 * reader who took it for the latter would be badly wrong. The scope is printed
 * beside the number for that reason — a coverage figure that does not name its
 * axis scores everything off-axis as nonexistent.
 *
 * It is deliberately not widened yet. agrent backend-2 is documenting the auth
 * family's bare shape as `RawErrorResponse` — correctly: `invalid_grant` and
 * `invalid_request` are RFC 6749 §5.2, so a conforming OAuth client expects
 * exactly that body at a token endpoint, and converging them would break
 * conformance to chase consistency. Widening the root before that lands would
 * make this guard red for 34 bodies that are about to become correct, and a
 * guard that is red for work already in flight is a guard people learn to
 * ignore. Widen the root to `src/app/api` once that is in; the expected result
 * is 0.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = process.cwd();
const SPEC = JSON.parse(readFileSync(join(REPO_ROOT, 'src/generated/openapi.json'), 'utf8'));

/**
 * Undocumented bare-string bodies on tenant routes, as of #1447. Set to the
 * LIVE count, not a round number above it — a ratchet with headroom silently
 * admits the next one.
 *
 * Lower it when a documenting PR fixes one; never raise it.
 */
const UNDOCUMENTED_BARE_BODIES_CEILING = 25;

const TENANT_ROUTES = join(REPO_ROOT, 'src/app/api/t');

function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) out.push(...routeFiles(p));
        else if (entry === 'route.ts') out.push(p);
    }
    return out;
}

/** Comments stripped — a file DISCUSSING the shape is not a file returning it. */
function codeOf(file: string): string {
    return blankNonCode(readFileSync(file, 'utf8'));
}

/** `src/app/api/t/[tenantSlug]/x/[id]/route.ts` → `/api/t/{tenantSlug}/x/{id}` */
function specPathOf(file: string): string {
    const rel = relative(join(REPO_ROOT, 'src/app'), file)
        .split(sep)
        .slice(0, -1)
        .join('/');
    return `/${rel}`.replace(/\[/g, '{').replace(/\]/g, '}');
}

/**
 * The schema name a path+status declares, or null.
 *
 * PER STATUS, and that granularity is the second thing #1447 got wrong. An
 * "any 4xx" test is true for almost every route, because `op()` registers the
 * common 401/403/404/426/429/500 as `ErrorResponse` while a route's own
 * `extraResponses` override 400/413/415 with `RawErrorResponse`. So
 * spatial-import declares BOTH envelopes, on different statuses, deliberately
 * — and a path-level question cannot express that.
 *
 * The only coherent question is: for the status this body is actually returned
 * with, which schema did the operation declare?
 */
function declaredSchemaFor(specPath: string, status: string): string | null {
    const ops = SPEC.paths?.[specPath];
    if (!ops) return null;
    for (const [method, op] of Object.entries(ops) as [string, Record<string, unknown>][]) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
        const res = responses[status];
        if (!res) continue;
        const content = (res.content ?? {}) as Record<string, { schema?: { $ref?: string } }>;
        const ref = content['application/json']?.schema?.$ref;
        if (ref) return ref.split('/').pop() ?? null;
    }
    return null;
}

interface Row {
    file: string;
    specPath: string;
    status: string;
    documented: boolean;
    /** The operation declares the canonical envelope for THIS status. */
    contradicts: boolean;
}

/** Every bare-string body, paired with the status it is returned with. */
function audit(): Row[] {
    const out: Row[] = [];
    for (const file of routeFiles(TENANT_ROUTES)) {
        const code = codeOf(file);
        const specPath = specPathOf(file);
        const re = /\{\s*error:\s*'[^']*'[^}]*\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
            // The status accompanying this body, from the same return.
            const tail = code.slice(m.index, m.index + m[0].length + 140);
            const status = /status:\s*(\d{3})/.exec(tail)?.[1] ?? '400';
            out.push({
                file: relative(REPO_ROOT, file),
                specPath,
                status,
                documented: Boolean(SPEC.paths?.[specPath]),
                contradicts: declaredSchemaFor(specPath, status) === 'ErrorResponse',
            });
        }
    }
    return out;
}

describe("a route's error body matches the schema its operation declares", () => {
    const rows = audit();

    it('found the bare-string bodies at all', () => {
        // Positive control on the population. A renamed pattern or a broken
        // walk reports zero rows, and zero rows makes everything below
        // vacuously true.
        expect(rows.length).toBeGreaterThan(5);
    });

    it('no route contradicts an operation that declares ErrorResponse', () => {
        const bad = rows.filter((r) => r.contradicts);
        if (bad.length > 0) {
            throw new Error(
                `${bad.length} route(s) return a bare-string error body on a path whose ` +
                    `4xx/5xx declares ErrorResponse:\n` +
                    bad.map((r) => `  ${r.file}\n      ${r.specPath} — status ${r.status}`).join('\n') +
                    `\n\nThe spec promises { error: { code, message } } and the code returns a ` +
                    `string, so a client switching on error.code reads undefined. Use a coded ` +
                    `helper and keep the existing prose as the message.\n\n` +
                    `Population: ${rows.length} bare-string bodies under src/app/api/t; ` +
                    `${rows.filter((r) => r.documented).length} on documented paths. ` +
                    `Routes OUTSIDE src/app/api/t are not measured by this file.`,
            );
        }
        expect(bad).toEqual([]);
    });

    it('the undocumented count does not grow — RATCHET', () => {
        const undocumented = rows.filter((r) => !r.documented);
        const total = undocumented.length;
        expect(total).toBeLessThanOrEqual(UNDOCUMENTED_BARE_BODIES_CEILING);
    });

    it('reports its denominator', () => {
        const documented = rows.filter((r) => r.documented);
        const canonical = rows.filter((r) => r.contradicts);
        console.log(
            `    SCOPE: src/app/api/t only — /api/auth and the rest are NOT measured\n` +
                `           (28 files / 78 occurrences outside, 34 contradictions; see docblock)\n` +
                `    bare-string error bodies (path+status): ${rows.length}\n` +
                `    on a DOCUMENTED path                 : ${documented.length}\n` +
                `    contradicting that status's schema   : ${canonical.length}  (must be 0)\n` +
                `    occurrences on undocumented paths   : ${
                    rows.filter((r) => !r.documented).length
                }  (ceiling ${UNDOCUMENTED_BARE_BODIES_CEILING})`,
        );
        expect(rows.length).toBeGreaterThan(0);
    });
});

describe('the detector distinguishes the two schemas — the control the first probe lacked', () => {
    it('RawErrorResponse exists and is a bare string', () => {
        const raw = SPEC.components?.schemas?.RawErrorResponse;
        expect(raw).toBeDefined();
        expect(raw.properties.error.type).toBe('string');
    });

    it('ErrorResponse nests code and message under `error`', () => {
        const canon = SPEC.components?.schemas?.ErrorResponse;
        expect(canon).toBeDefined();
        expect(Object.keys(canon.properties.error.properties)).toEqual(
            expect.arrayContaining(['code', 'message']),
        );
    });

    it('a path declaring ONLY RawErrorResponse is not treated as canonical', () => {
        // The exact case the substring test got wrong, asserted against the
        // real spec rather than a fixture — spatial-import declares
        // RawErrorResponse on its 400/413/415 and nothing else.
        const p = '/api/t/{tenantSlug}/locations/{id}/spatial-import';
        expect(SPEC.paths[p]).toBeDefined();
        // Its 400/413/415 declare RawErrorResponse — PER STATUS, which is the
        // question that can be answered. Its 401/403/404 declare
        // ErrorResponse, as `op()` registers for every route, so a path-level
        // test would call this canonical and be useless.
        expect(declaredSchemaFor(p, '400')).toBe('RawErrorResponse');
        expect(declaredSchemaFor(p, '415')).toBe('RawErrorResponse');
        expect(declaredSchemaFor(p, '403')).toBe('ErrorResponse');
        expect(JSON.stringify(SPEC.paths[p])).toContain('RawErrorResponse');
    });
});
