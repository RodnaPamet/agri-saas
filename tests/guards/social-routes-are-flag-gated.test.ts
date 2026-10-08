import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * Every social route is behind a runtime feature flag.
 *
 * ── the hard part is that there are ZERO social routes today ──
 *
 * This guard ships in P0.4, before the surfaces it governs exist. A sweep over
 * an empty population passes trivially, so the guard would be green and worth
 * nothing — and would STAY green when the first ungated social route lands,
 * because nobody would notice that the thing it protects had never been
 * exercised. That is the failure this file is written around.
 *
 * So it asserts three different things:
 *
 *   1. the DETECTOR works, proved against inline fixtures — an ungated source is
 *      flagged and a gated one is not. This has teeth on day one, with no social
 *      routes in the tree.
 *   2. the WALK works, proved by pointing it at a directory that does contain
 *      routes and getting a non-empty answer. A walk that silently returns
 *      nothing is how an empty population becomes invisible.
 *   3. the real sweep over the social directories, which is empty today and
 *      becomes load-bearing the moment one of them gets a file.
 *
 * Assertion 3 alone would be a guard that cannot fail. 1 and 2 are what make it
 * a guard rather than a placeholder.
 */

/**
 * Where social surfaces will live. Listed rather than inferred: a prefix like
 * `src/app/api` would pull in every existing route and make this guard about
 * the whole API.
 */
const SOCIAL_API_DIRS = [
    'src/app/api/social',
    'src/app/api/me',
];

/** The gate a social route must call. */
const GATE = /assertFeatureEnabled|isFeatureEnabled|requireFeature/;

/** Source with comments stripped, so prose about the gate cannot satisfy it. */
function codeOf(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Every API `route.ts`, via the house collector.
 *
 * NOT a hand-rolled walk, and that is the point of using it: a bespoke walk can
 * be gutted to return `[]` with every assertion built on it still green —
 * measured at 81% of the guards an automated sweep could audit
 * (tests/guards/file-collection-is-not-silently-empty.test.ts). `collectSourceFiles`
 * throws on a missing root and refuses a result below its floor.
 *
 * The floor is on the WHOLE API population, which is large and known. The social
 * subset is then a filter over a guarded base, so "zero social routes" is a
 * legitimate filter result rather than an unnoticed broken walk.
 */
function allApiRouteFiles(): string[] {
    return collectSourceFiles({
        roots: ['src/app/api'],
        exclude: (rel) => !rel.endsWith('/route.ts'),
        // ~369 route files today. A floor well under that still catches an
        // exclude predicate that ate the population, without breaking on growth.
        floor: 200,
    }).map((abs) => path.relative(REPO_ROOT, abs));
}

const isSocialPath = (rel: string): boolean =>
    SOCIAL_API_DIRS.some((d) => rel.startsWith(`${d}/`));

const isGated = (src: string): boolean => GATE.test(codeOf(src));

// ─── Per-HANDLER gating (#1395) ──────────────────────────────────────
//
// `isGated` is per FILE, so one gated handler satisfies the whole file and any
// number of ungated siblings pass silently. That is not hypothetical:
// `src/app/api/me/farms/route.ts` exports a gated POST and a DELIBERATELY
// ungated GET, so this guard reported "every social route is flag-gated" while
// a social route was — correctly — not. Right about the file, wrong about what
// it claimed.
//
// The failure is silent and lands on the dark-launch rail, which is the one
// place "I thought the guard covered that" is expensive: an ungated handler on
// a flagged surface is reachable before the feature is meant to exist.

/** The HTTP methods Next treats as route handlers. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Split a route file into one span per exported handler.
 *
 * Returns `[method, body]` pairs, where the body runs from the export to the
 * next handler export (or EOF). Deliberately a span rather than a parse: the
 * handlers in this codebase are `export const POST = withApiErrorHandling(…)`,
 * `export const GET = requirePermission(…)(…)` and
 * `export async function DELETE(…)`, and a brace-matcher would have to
 * understand all three wrappers to find the real body.
 *
 * The span is the risk, so it is tested directly below: an extraction that
 * silently returns an EMPTY body would make `GATE.test(body)` false and the
 * guard would fail loudly — but one that returned the WHOLE FILE for every
 * method would make it true for all of them and restore the exact defect this
 * is fixing. Both directions are pinned.
 */
function handlerSpans(src: string): Array<[string, string]> {
    const code = codeOf(src);
    const starts: Array<{ method: string; at: number }> = [];
    for (const m of HTTP_METHODS) {
        const re = new RegExp(`^export\\s+(?:const\\s+${m}\\s*=|async\\s+function\\s+${m}\\b|function\\s+${m}\\b)`, 'm');
        const hit = re.exec(code);
        if (hit && hit.index >= 0) starts.push({ method: m, at: hit.index });
    }
    starts.sort((a, b) => a.at - b.at);
    return starts.map((s, i) => [
        s.method,
        code.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : code.length),
    ]);
}

/**
 * Handlers that are ungated ON PURPOSE, keyed `path#METHOD`, each with the
 * reason.
 *
 * An exemption map rather than a looser check, because the entry below SHOULD
 * be ungated — and a guard that cannot express "ungated on purpose" gets
 * waived rather than fixed. Same style as `ALLOWED_API_DIRS` and `KNOWN_EMPTY`.
 */
const UNGATED_SOCIAL_HANDLERS: Readonly<Record<string, string>> = {
    'src/app/api/me/farms/route.ts#GET':
        'Switching between farms you already hold must keep working while ADDING one is switched off. Agreed with agrent-ios: being unable to reach a farm you are a member of is a worse failure than being unable to create one. The POST on this route IS gated on social.farm-registration.',
};

describe('the detector has teeth before any social route exists', () => {
    const UNGATED = `
        export const GET = withApiErrorHandling(async () => {
            return jsonResponse({ posts: [] });
        });
    `;
    const GATED = `
        export const GET = withApiErrorHandling(async () => {
            await assertFeatureEnabled('social.feed', ctx.userId);
            return jsonResponse({ posts: [] });
        });
    `;
    const GATED_IN_PROSE_ONLY = `
        // This route will call assertFeatureEnabled once the flag exists.
        export const GET = withApiErrorHandling(async () => {
            return jsonResponse({ posts: [] });
        });
    `;

    it('flags an ungated route', () => {
        expect(isGated(UNGATED)).toBe(false);
    });

    it('accepts a gated route', () => {
        expect(isGated(GATED)).toBe(true);
    });

    it('is NOT satisfied by a comment promising the gate', () => {
        // The failure mode that has bitten this repo repeatedly: a text guard
        // matching the prose ABOUT the thing rather than the thing. Masking at
        // the read seam is what makes the difference.
        expect(isGated(GATED_IN_PROSE_ONLY)).toBe(false);
    });
});

describe('the collector is guarded, so an empty social set means empty and not broken', () => {
    it('POSITIVE CONTROL: the API population is large and real', () => {
        // If this ever returned a handful, the filter below would report zero
        // social routes for the wrong reason. The collector throws rather than
        // returning a short list, so this is belt and braces on its floor.
        const all = allApiRouteFiles();
        expect(all.length).toBeGreaterThan(200);
        expect(all).toContain('src/app/api/auth/me/route.ts');
    });

    it('the social filter actually selects — proved on a synthetic path', () => {
        // Without this, `isSocialPath` could return false for everything and the
        // sweep would be empty forever, including after social routes land.
        expect(isSocialPath('src/app/api/social/feed/route.ts')).toBe(true);
        expect(isSocialPath('src/app/api/me/flags/route.ts')).toBe(true);
        expect(isSocialPath('src/app/api/auth/me/route.ts')).toBe(false);
    });
});

describe('the per-handler span extraction can be wrong in both directions (#1395)', () => {
    // Column-0 exports, because a TypeScript `export` is always top-level and
    // `^export` under the `m` flag is therefore correct. The first draft of
    // these fixtures was INDENTED inside the template literal, so every span
    // test failed while the live sweep found both handlers of the real route
    // correctly — the fixtures were unrealistic, not the extractor.
    const TWO_HANDLERS = [
        "import { assertFeatureEnabled } from '@/lib/feature-flags';",
        'export const POST = withApiErrorHandling(async (req) => {',
        "    await assertFeatureEnabled('social.x', uid);",
        '    return jsonResponse({ ok: true });',
        '});',
        'export const GET = withApiErrorHandling(async () => {',
        '    return jsonResponse({ farms: [] });',
        '});',
    ].join('\n');

    it('finds every exported handler, not just the first', () => {
        const spans = handlerSpans(TWO_HANDLERS);
        expect(spans.map(([m]) => m).sort()).toEqual(['GET', 'POST']);
    });

    it('does NOT return the whole file for each method — the defect being fixed', () => {
        // The direction that silently restores the per-file behaviour: if each
        // span were the entire file, the POST's gate would satisfy the GET and
        // this guard would pass exactly as it did before.
        const spans = new Map(handlerSpans(TWO_HANDLERS));
        expect(GATE.test(spans.get('POST')!)).toBe(true);
        expect(GATE.test(spans.get('GET')!)).toBe(false);
    });

    it('does not return an EMPTY span — which would fail loudly but for the wrong reason', () => {
        for (const [method, body] of handlerSpans(TWO_HANDLERS)) {
            expect(body.length).toBeGreaterThan(20);
            expect(body).toContain(method);
        }
    });

    it('handles `export async function` as well as `export const`', () => {
        const fnForm = [
            'export async function DELETE(req) { return new Response(null); }',
            'export const GET = () => jsonResponse({});',
        ].join('\n');
        expect(handlerSpans(fnForm).map(([m]) => m).sort()).toEqual(['DELETE', 'GET']);
    });

    it('ignores a method name that is not an export', () => {
        // `const POST = …` inside a helper, or the string 'POST' in a comment,
        // must not create a phantom handler whose span is then searched for a
        // gate it was never meant to have.
        const noise = [
            "const POST = 'post';",
            "function helper() { return 'GET'; }",
            'export const GET = withApiErrorHandling(async () => jsonResponse({}));',
        ].join('\n');
        expect(handlerSpans(noise).map(([m]) => m)).toEqual(['GET']);
    });
});

describe('every social route is flag-gated', () => {
    const social = allApiRouteFiles().filter(isSocialPath);

    it('reports the population it is covering', () => {
        // Printed rather than implied: a reader of a green run should be able to
        // see whether this swept 0 files or 40. The count is 0 today by design.
        console.log(`social route files swept: ${social.length} (${SOCIAL_API_DIRS.join(', ')})`);
        expect(Array.isArray(social)).toBe(true);
    });

    it.each(social.length ? social : [['__none_yet__']].flat())(
        '%s calls the feature gate',
        (rel) => {
            if (rel === '__none_yet__') {
                // No social routes exist yet. The detector and walk above are
                // what carry this file's weight until one does.
                expect(social).toEqual([]);
                return;
            }
            expect(isGated(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))).toBe(true);
        },
    );
});

describe('every social HANDLER is flag-gated, or recorded as deliberately not (#1395)', () => {
    const social = allApiRouteFiles().filter(isSocialPath);

    /** `[path#METHOD, body]` for every handler on every social route. */
    const handlers: Array<[string, string]> = social.flatMap((rel) =>
        handlerSpans(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).map(
            ([method, body]) => [`${rel}#${method}`, body] as [string, string],
        ),
    );

    it('reports the handler-level population', () => {
        // The number that matters, and the one the per-file sweep could not
        // show: a file counts once, a file with four handlers counts four
        // times. A reader of a green run should see which.
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(
            `social HANDLERS swept: ${handlers.length} across ${social.length} file(s)\n  ` +
                handlers.map(([k]) => k).join('\n  '),
        );
        expect(Array.isArray(handlers)).toBe(true);
    });

    it.each(handlers.length ? handlers.map(([k]) => k) : ['__none_yet__'])(
        '%s',
        (key) => {
            if (key === '__none_yet__') {
                expect(handlers).toEqual([]);
                return;
            }
            const body = new Map(handlers).get(key)!;
            const gated = GATE.test(body);
            const exempt = key in UNGATED_SOCIAL_HANDLERS;

            if (!gated && !exempt) {
                throw new Error(
                    `${key} is a social route handler with no feature gate in its own body.\n\n` +
                        `A sibling handler being gated does NOT cover it — that is exactly the\n` +
                        `per-file gap #1395 fixed. Either gate this handler, or add\n` +
                        `'${key}' to UNGATED_SOCIAL_HANDLERS with the reason it must stay open.\n` +
                        `An ungated handler on a dark-launch rail is reachable before the\n` +
                        `feature is meant to exist.`,
                );
            }
            // Not both: an exemption for a handler that gates anyway is a stale
            // reason nobody will re-read.
            expect(gated && exempt).toBe(false);
        },
    );
});

describe('the handler exemption list has no stale entries', () => {
    const social = allApiRouteFiles().filter(isSocialPath);
    const live = new Set(
        social.flatMap((rel) =>
            handlerSpans(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).map(
                ([method]) => `${rel}#${method}`,
            ),
        ),
    );

    it.each(Object.keys(UNGATED_SOCIAL_HANDLERS))('%s still exists', (key) => {
        expect(live.has(key)).toBe(true);
    });

    it('every entry carries a real reason', () => {
        for (const [key, reason] of Object.entries(UNGATED_SOCIAL_HANDLERS)) {
            expect(reason.length).toBeGreaterThan(40);
            expect(reason).not.toMatch(/TODO|TBD|FIXME/i);
            expect(key).toMatch(/#(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/);
        }
    });
});
