/**
 * Every field a PUBLIC route serialises is recorded as publicly readable. P1.7.
 *
 * ── the two halves, and why both are needed ──
 *
 * `PUBLIC_TEXT_FIELDS` says which COLUMNS may reach a stranger.
 * `PUBLIC_RESPONSE_FIELDS` says what each public ROUTE actually returns, and
 * maps each key to the column it discloses.
 *
 * The first alone is a list anyone can agree with and nobody checks. The teeth
 * are in the second: this file reads the real route files, extracts the keys
 * they serialise, and fails when a key is not accounted for. So adding a field
 * to an unauthenticated response fails CI until somebody writes down what it
 * exposes to someone holding nothing but a URL.
 *
 * ── why a source scan rather than driving the routes ──
 *
 * Stated plainly because the weaker choice should be visible. Driving
 * `/api/invites/[token]` needs a session double, a token fixture and a seeded
 * tenant, and would assert the shape of ONE response — the happy path. The
 * question here is "what can this route ever return", which is a property of
 * the code, so the source is the right subject. The cost is that a key
 * computed dynamically would be missed; the `derived` marker exists so a
 * non-column value is still declared rather than silently exempt.
 */
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import {
    PUBLIC_TEXT_FIELDS,
    PUBLIC_RESPONSE_FIELDS,
} from '@/lib/security/public-text-fields';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Strip comments before asserting a construct is PRESENT.
 *
 * Found by mutation: the session-gate control below asserted
 * `toMatch(/unauthorized\(/)` against the raw source, and replacing
 * `throw unauthorized(...)` with `return ...; // was: unauthorized(` left the
 * text in a comment and the assertion passed. A guard that proves a security
 * construct exists must read CODE, not prose about code — otherwise deleting
 * the construct and mentioning it in the commit is enough.
 */
function codeOf(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => {
            // TRAILING comments too, not just whole-line ones. My first
            // version stripped only `^\s*//`, and the mutation that slipped
            // past was `return ...; // was: throw unauthorized(` — a trailing
            // comment on a code line. Found by this file's own proof case.
            //
            // `(?<!:)` so a URL's `//` survives: `https://x` must not be cut
            // at the slashes and leave `https:` looking like code.
            const cut = line.search(/(?<!:)\/\//);
            return cut === -1 ? line : line.slice(0, cut);
        })
        .join('\n');
}

/** The `Model.field` pairs the Prisma schema actually declares. */
const SCHEMA_PAIRS: ReadonlySet<string> = new Set(
    Prisma.dmmf.datamodel.models.flatMap((m) => m.fields.map((f) => `${m.name}.${f.name}`)),
);

/**
 * The GET handler's source only.
 *
 * On its FIRST run this guard flagged five keys I had not recorded —
 * `tenantId`, `slug`, `organizationId`, `provisioned` — and every one came
 * from the POST (accept) handler in the same file. POST is session-gated
 * (`throw unauthorized(...)` when there is no session), so its response is not
 * an unauthenticated disclosure and belongs outside this registry.
 *
 * Scoping to GET is therefore correct and NOT a convenience, but it is only
 * correct while POST really does require a session — so
 * `the POST handlers are session-gated` asserts exactly that. Without it, this
 * narrowing would be indistinguishable from excluding the keys that were
 * inconvenient.
 */
function getHandlerSource(source: string): string {
    const i = source.indexOf('export const GET');
    if (i < 0) return '';
    const j = source.indexOf('export const POST', i);
    return source.slice(i, j < 0 ? source.length : j);
}

/**
 * Keys a route hands to `jsonResponse({...})` / `NextResponse.json({...})`.
 *
 * Deliberately only the FIRST object literal of each call and only its
 * top-level keys: a nested object would need a parser, and if one ever appears
 * the `unaccounted` check below fails on its parent key rather than quietly
 * walking past it.
 */
function responseKeys(source: string): string[] {
    const keys: string[] = [];
    for (const m of source.matchAll(/(?:jsonResponse|NextResponse\.json)\(\s*\{/g)) {
        let i = m.index! + m[0].length - 1;
        let depth = 0;
        const start = i;
        for (; i < source.length; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') {
                depth--;
                if (depth === 0) break;
            }
        }
        const body = source.slice(start + 1, i);
        // top level only: strip nested braces before reading keys
        let flat = body, prev = '';
        while (flat !== prev) {
            prev = flat;
            flat = flat.replace(/\{[^{}]*\}/g, '');
        }
        for (const k of flat.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
            keys.push(k[1]);
        }
    }
    return [...new Set(keys)];
}

describe('PUBLIC_TEXT_FIELDS is honest', () => {
    it('reports the population, so a zero would be visible', () => {
        expect(Object.keys(PUBLIC_TEXT_FIELDS).length).toBeGreaterThanOrEqual(8);
        expect(Object.keys(PUBLIC_RESPONSE_FIELDS).length).toBeGreaterThanOrEqual(2);
        expect(SCHEMA_PAIRS.size).toBeGreaterThan(500);
    });

    it('every entry names a field the SCHEMA actually declares', () => {
        // The stale half. A renamed column leaves an entry that reads as a
        // considered decision about something that no longer exists.
        const ghosts = Object.keys(PUBLIC_TEXT_FIELDS).filter((p) => !SCHEMA_PAIRS.has(p));
        expect(ghosts).toEqual([]);
    });

    it('every entry carries a real reason', () => {
        for (const [pair, reason] of Object.entries(PUBLIC_TEXT_FIELDS)) {
            expect(`${pair}: ${reason}`.length).toBeGreaterThan(70);
        }
    });

    it('every declared route file EXISTS', () => {
        // Guards the guard: a renamed route would otherwise leave this file
        // scanning nothing and passing.
        for (const rel of Object.keys(PUBLIC_RESPONSE_FIELDS)) {
            expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
        }
    });

    it('every key a public route SERIALISES is accounted for', () => {
        // The assertion with teeth. Add a field to an unauthenticated response
        // and this fails until its exposure is recorded.
        const problems: string[] = [];
        for (const [rel, declared] of Object.entries(PUBLIC_RESPONSE_FIELDS)) {
            const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            const keys = responseKeys(getHandlerSource(src));
            // Non-empty FIRST: an extractor that found nothing would make the
            // loop below pass over an empty set.
            expect(keys.length).toBeGreaterThan(0);
            for (const k of keys) {
                // Error envelopes are not disclosures of a column.
                if (k === 'error') continue;
                if (!(k in declared)) {
                    problems.push(`${rel} returns '${k}' with no entry in PUBLIC_RESPONSE_FIELDS`);
                }
            }
        }
        if (problems.length > 0) {
            throw new Error(
                `An unauthenticated route serialises something nobody recorded:\n  ` +
                    problems.join('\n  ') +
                    `\n\nAdd it to PUBLIC_RESPONSE_FIELDS mapping it to the ` +
                    `'Model.field' it discloses (or 'derived' if it reads no ` +
                    `column), and add that pair to PUBLIC_TEXT_FIELDS with a reason.`,
            );
        }
    });

    it('every mapped column is declared publicly readable', () => {
        const unmapped: string[] = [];
        for (const [rel, declared] of Object.entries(PUBLIC_RESPONSE_FIELDS)) {
            for (const [key, pair] of Object.entries(declared)) {
                if (pair === 'derived') continue;
                if (!(pair in PUBLIC_TEXT_FIELDS)) {
                    unmapped.push(`${rel}.${key} -> ${pair} is not in PUBLIC_TEXT_FIELDS`);
                }
                if (!SCHEMA_PAIRS.has(pair)) {
                    unmapped.push(`${rel}.${key} -> ${pair} is not a schema field`);
                }
            }
        }
        expect(unmapped).toEqual([]);
    });

    it('the invite EMAIL is neither declared nor returned', () => {
        // The deliberate absence, asserted. The routes answer `matchesSession`
        // — a boolean — so a caller holding only the link cannot confirm WHO
        // was invited. If that ever changes, this fails and somebody has to
        // decide it on purpose.
        expect(PUBLIC_TEXT_FIELDS['TenantInvite.email']).toBeUndefined();
        expect(PUBLIC_TEXT_FIELDS['OrgInvite.email']).toBeUndefined();
        for (const rel of Object.keys(PUBLIC_RESPONSE_FIELDS)) {
            const keys = responseKeys(
                getHandlerSource(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
            );
            expect(keys).not.toContain('email');
            expect(keys).toContain('matchesSession');
        }
    });
});

describe('the GET-only scoping is legitimate', () => {
    it('the POST handlers are session-gated', () => {
        // The control for scoping this guard to GET. If POST ever stopped
        // requiring a session its response WOULD be an unauthenticated
        // disclosure, and excluding it would silently become wrong.
        for (const rel of Object.keys(PUBLIC_RESPONSE_FIELDS)) {
            const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            const post = codeOf(src.slice(src.indexOf('export const POST')));
            expect(post.length).toBeGreaterThan(0);
            // `throw`, and comment-stripped: a mention is not a gate.
            expect(post).toMatch(/throw\s+unauthorized\(/);
        }
    });

    it('GET is NOT session-gated — it is the unauthenticated surface', () => {
        // The other direction: if GET started requiring a session there would
        // be no public disclosure here at all, and this whole registry would be
        // describing a surface that no longer exists.
        for (const rel of Object.keys(PUBLIC_RESPONSE_FIELDS)) {
            const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            expect(getHandlerSource(src)).not.toMatch(/throw unauthorized\(/);
        }
    });
});

describe('the comment-stripper has teeth', () => {
    it('a construct that survives only in a comment does NOT count', () => {
        // The exact mutation that slipped past: the call deleted, the name
        // left behind in a trailing comment.
        const gutted = `export const POST = h(async () => {
            return jsonResponse({ ok: false }); // was: throw unauthorized('...')
        });`;
        expect(gutted).toMatch(/throw\s+unauthorized\(/);       // raw source: fooled
        expect(codeOf(gutted)).not.toMatch(/throw\s+unauthorized\(/); // stripped: caught
    });

    it('a real gate still counts', () => {
        const real = `export const POST = h(async () => {
            if (!session) throw unauthorized('You must be signed in.');
        });`;
        expect(codeOf(real)).toMatch(/throw\s+unauthorized\(/);
    });
});

describe('the extractor has teeth', () => {
    it('finds top-level keys and ignores nested ones', () => {
        // `responseKeys` directly, NOT through `getHandlerSource`: this
        // synthetic source has no `export const GET`, so the scoper would
        // return '' and the extractor would be asserted against nothing. A
        // blanket replacement of mine did exactly that and the case failed
        // with an empty array — which is the right failure for a test whose
        // subject had been scoped away.
        const src = `return jsonResponse({ a: 1, b: { c: 2 }, d: x.y });`;
        const keys = responseKeys(src);
        expect(keys).toContain('a');
        expect(keys).toContain('b');
        expect(keys).toContain('d');
        // `c` is nested; the parent `b` is what gets flagged if undeclared.
        expect(keys).not.toContain('c');
    });

    it('finds nothing in a file with no response', () => {
        // A detector whose live side is a constant proves nothing, so the
        // empty case is pinned too.
        expect(responseKeys('const x = 1;')).toEqual([]);
    });

    it('sees NextResponse.json as well as jsonResponse', () => {
        expect(responseKeys('NextResponse.json({ zz: 1 }, { status: 410 })')).toContain('zz');
    });
});
