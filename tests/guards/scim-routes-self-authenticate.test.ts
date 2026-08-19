/**
 * Every SCIM route authenticates itself — the guard that makes the Edge
 * carve-out safe.
 *
 * ## Why this exists
 *
 * `/api/scim/` is in `PUBLIC_PATH_PREFIXES` (src/lib/auth/guard.ts), so the
 * middleware lets these requests through WITHOUT authenticating them. That is
 * not laxity: a SCIM bearer is an opaque, hashed, tenant-scoped token, the Edge
 * has no database, and so the Edge physically cannot verify one. Before the
 * carve-out, `getToken()` returned null for every SCIM request and the
 * middleware 401'd it — SCIM had never worked, for anyone, since the feature
 * shipped.
 *
 * The carve-out moves the entire authentication burden onto the route handlers.
 * A handler that forgets `authenticateScimRequest` is not "missing a check" —
 * it is an unauthenticated, tenant-scoped write endpoint open to the internet.
 *
 * So this guard is FAIL-CLOSED and derives its inventory from the FILESYSTEM.
 * A new file under `src/app/api/scim/` is covered the moment it is created; a
 * new exported method in an existing file is covered the moment it is added.
 * Nothing has to be remembered, and no list has to be updated.
 *
 * ## Why a source-text guard rather than a runtime test
 *
 * A runtime test can only prove the routes that exist TODAY reject an
 * anonymous request. This has to hold for routes that do not exist yet, which
 * is exactly what a structural scan is for. The runtime half — that a real
 * request with a real header reaches a real handler — is
 * `tests/integration/scim-edge-reachability.test.ts`. Neither substitutes for
 * the other: this one cannot prove the wiring works, and that one cannot
 * prove the NEXT route will be safe.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCIM_DIR = path.join(ROOT, 'src/app/api/scim');

/** The HTTP verbs Next treats as route handlers. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * The ONE documented exception, and the reason it is safe.
 *
 * RFC 7644 §4 defines `/ServiceProviderConfig` as service-discovery metadata
 * that "MAY be returned without authentication" — an IdP reads it BEFORE it
 * has been given a token, to learn which auth schemes exist. The handler
 * touches no database and returns only static capability flags plus a URL
 * built from the request's own host, so there is no tenant data to leak.
 *
 * Adding anything to this list means deliberately exposing an endpoint to the
 * internet. The reason must say what it returns and why that is harmless.
 */
const UNAUTHENTICATED_BY_SPEC: Record<string, string> = {
    'v2/ServiceProviderConfig/route.ts':
        'RFC 7644 §4 discovery metadata — static capability flags only, no DB access, ' +
        'no tenant data, read by an IdP before it holds a token.',
};

function routeFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) routeFiles(full, acc);
        else if (entry.name === 'route.ts' || entry.name === 'route.tsx') acc.push(full);
    }
    return acc;
}

/** Exported handler names, in source order, with the body that follows each. */
function exportedHandlers(src: string): { method: string; body: string }[] {
    const out: { method: string; body: string }[] = [];
    const re = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+(${METHODS.join('|')})\\b`,
        'g',
    );
    const starts: { method: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) starts.push({ method: m[1], at: m.index });
    for (let i = 0; i < starts.length; i++) {
        const from = starts[i].at;
        const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
        out.push({ method: starts[i].method, body: src.slice(from, to) });
    }
    return out;
}

describe('SCIM routes authenticate themselves (the Edge does not)', () => {
    const files = routeFiles(SCIM_DIR);

    it('finds SCIM route files at all — a zero-length scan must not pass vacuously', () => {
        // Without this, deleting or moving the SCIM tree turns every assertion
        // below into a no-op and the suite goes green on an empty inventory.
        if (files.length < 5) {
            throw new Error(
                `Found ${files.length} SCIM route file(s) under ${SCIM_DIR}; expected at ` +
                    `least 5. Either the tree moved (update SCIM_DIR) or SCIM was removed ` +
                    `— in which case remove '/api/scim/' from PUBLIC_PATH_PREFIXES in the ` +
                    `same change, or an unauthenticated prefix outlives the routes it was ` +
                    `opened for.`,
            );
        }
        expect(files.length).toBeGreaterThanOrEqual(5);
    });

    it('the Edge carve-out this guard protects is actually in place', () => {
        // If the carve-out is reverted, these routes are unreachable again and
        // this guard is protecting nothing — which is worth knowing loudly,
        // because a green guard would otherwise imply SCIM is fine.
        const guardSrc = fs.readFileSync(path.join(ROOT, 'src/lib/auth/guard.ts'), 'utf8');
        expect(guardSrc).toContain("'/api/scim/'");
    });

    it.each(files.map((f) => [path.relative(SCIM_DIR, f).split(path.sep).join('/'), f]))(
        '%s — every exported handler calls authenticateScimRequest',
        (rel, full) => {
            const src = fs.readFileSync(full as string, 'utf8');
            const handlers = exportedHandlers(src);

            if (handlers.length === 0) {
                throw new Error(
                    `${rel} exports no recognised HTTP handler — either it is dead code ` +
                        `sitting under a PUBLIC prefix, or this guard's parser missed a ` +
                        `form it should recognise (e.g. \`export const GET = …\`). Both ` +
                        `need a human.`,
                );
            }

            const exemption = UNAUTHENTICATED_BY_SPEC[rel as string];

            for (const handler of handlers) {
                const authenticates = /authenticateScimRequest\s*\(/.test(handler.body);
                if (exemption) {
                    // Exempt files must STAY trivial. If one grows a database
                    // call it is no longer discovery metadata and the exemption
                    // silently becomes an open tenant endpoint.
                    if (/prisma|repository|Repository/.test(handler.body)) {
                        throw new Error(
                            `${rel} ${handler.method} is exempt from SCIM auth as spec ` +
                                `discovery metadata, but now touches the database. The ` +
                                `exemption no longer holds — authenticate it, or move the ` +
                                `data access out.\nReason on file: ${exemption}`,
                        );
                    }
                    // An exemption is only as good as its written reason.
                    expect(exemption.length).toBeGreaterThan(40);
                    continue;
                }
                if (!authenticates) {
                    throw new Error(
                        `${rel} ${handler.method} does NOT call authenticateScimRequest.\n\n` +
                            `/api/scim/ is in PUBLIC_PATH_PREFIXES, so the middleware does ` +
                            `NOT authenticate it — this handler is reachable ANONYMOUSLY ` +
                            `from the internet. Call authenticateScimRequest at the top of ` +
                            `the handler, or (only if it returns no tenant data at all) add ` +
                            `it to UNAUTHENTICATED_BY_SPEC with a written reason.`,
                    );
                }
                expect(authenticates).toBe(true);
            }
        },
    );

    it('a handler that authenticates AFTER touching the database would still fail', () => {
        // Mutation proof: the assertion above is a presence check, so show it
        // actually discriminates. A body with no call must be rejected.
        const withoutCall = 'export async function GET(req: NextRequest) { return prisma.user.findMany(); }';
        const withCall = 'export async function GET(req: NextRequest) { await authenticateScimRequest(req); }';
        expect(/authenticateScimRequest\s*\(/.test(withoutCall)).toBe(false);
        expect(/authenticateScimRequest\s*\(/.test(withCall)).toBe(true);
    });
});
