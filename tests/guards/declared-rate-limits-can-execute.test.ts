/**
 * A rate limit the wrapper CANNOT execute may not be declared — #3155.
 *
 * `resolveRateLimitScope` (`src/lib/errors/api.ts`) opens with
 * `if (!MUTATION_METHODS.has(req.method)) return null`, so a
 * `rateLimit: { config }` passed to `withApiErrorHandling` on a GET or HEAD
 * handler is discarded. The declaration reads as a control and is one line of
 * dead configuration.
 *
 * ## Why a guard and not just the eight fixes
 *
 * P5.6a already found and fixed this once — CLAUDE.md records it: *"A rate
 * limit on a GET must be enforced INLINE... I shipped exactly that first, with
 * a docblock explaining the budget."* The account-export route was corrected
 * and nothing stopped the next one. Measured 2026-11-17: **seven** more had
 * accumulated. Measured again on 2026-11-26, nine days later: **eight** —
 * `admin/agro-calendar/overrides` had been written in between with the same
 * shape. A defect class that reproduces while its first instance sits fixed in
 * the operating manual needs a gate, not another fix.
 *
 * What made it costly rather than merely untidy: `publicReadRateLimit.ts`
 * excluded `/api/admin/*` from the Edge read tier **citing** one of these
 * declarations as its reason — "Platform-key gated and LOGIN_LIMIT'd at the
 * handler". Half of that was false, so one layer was waived on the strength of
 * another that never ran, and those routes were throttled nowhere.
 *
 * ## Two things this guard must not get wrong
 *
 * **Comments.** The fixed routes now EXPLAIN the trap, and several quote the
 * offending shape verbatim. A naive scan reports every one of them — measured
 * while writing this: the detector found all 8 "still present" after they were
 * fixed, matching its own explanatory prose. So the source is run through
 * `blankNonCode(src, { strings: true })` first, which is also the right option
 * for a guard whose subject is code STRUCTURE rather than message text.
 *
 * **The population.** It comes from `routeFiles()`, the one derivation shared
 * with the inventory generator and `openapi-paths-complete`, which carries its
 * own floor so a renamed root throws instead of reporting nothing to check.
 *
 * The live population is EMPTY by design, so the detector is proved against
 * crafted sources instead — including the comment case above, and the
 * `rateLimit: false` form, which must NOT be flagged.
 */
import { blankNonCode } from '../helpers/blank-non-code';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, routeFiles } from '../../scripts/lib/api-routes';

/**
 * Platform-admin GETs that are deliberately throttled at NO layer — #3260.
 *
 * `/api/admin/*` is excluded from the Edge read tier and the wrapper cannot
 * limit a GET, so an admin GET is throttled only if its handler does it
 * itself. Six are deliberately not, and the reason is the same one
 * `publicReadRateLimit` already gives for the health probes:
 *
 *   > An operator needs these to answer WHILE an attacker hammers the API;
 *   > throttling them makes the monitoring fail together with the thing it
 *   > monitors.
 *
 * These are the surfaces somebody reaches for *because* something is already
 * going wrong, and several are ones they may legitimately hammer — a rotation
 * sweep polled to completion, a flag console during an incident. A
 * ten-per-fifteen-minutes lockout there could turn a bad hour into a worse
 * one. They are platform-key gated, so this is a decision about a key-holder's
 * ceiling, not an open door.
 *
 * Shrink-only in spirit: an entry here is a decision, and the existence test
 * below removes its cover the moment the route is deleted or renamed.
 */
const DELIBERATELY_UNTHROTTLED: ReadonlyArray<readonly [string, string]> = [
    [
        'src/app/api/admin/diagnostics/route.ts',
        'The diagnostics read itself — the probe-shaped case the exclusion '
            + 'comment in `publicReadRateLimit` is written about. Throttling it '
            + 'makes the instrument fail with the thing it measures.',
    ],
    [
        'src/app/api/admin/key-rotation/route.ts',
        'Master-KEK rotation: the sweep is polled to completion, so the read is '
            + 'expected to be called repeatedly and fast, by the one person '
            + 'holding the key, during an operation that must not stall.',
    ],
    [
        'src/app/api/admin/key-rotation/repair-v2/route.ts',
        'Repairs misplaced `v2:` ciphertext. Same polling shape as its parent, '
            + 'and it runs when rows are already encrypted under the wrong key — '
            + 'the worst moment to meet a 15-minute lockout.',
    ],
    [
        'src/app/api/admin/lookup-rehash/route.ts',
        'The P1.3 rehash sweep, inspected while it runs. A migration surface, '
            + 'polled, and not reachable without the platform key.',
    ],
    [
        'src/app/api/admin/feature-flags/route.ts',
        'The kill-switch console. `FEATURE_FLAGS_FORCE_OFF` exists for the case '
            + 'where the application is the thing going wrong, and this is the '
            + 'screen an operator reads to find out which flag to flip. Throttling '
            + 'the way out of an incident is the shape `slow-mode-escape-is-not-'
            + 'throttled` refuses one level over.',
    ],
    [
        'src/app/api/admin/feature-flags/cohorts/route.ts',
        'Cohort membership behind the same console, read in the same breath as '
            + 'the flag table — a flag naming a cohort with zero members reads as '
            + 'a live rollout and is off for everyone, so this is part of the same '
            + 'diagnosis.',
    ],
];

/** Methods the wrapper's rate limiter structurally cannot act on. */
const UNLIMITABLE = ['GET', 'HEAD'] as const;

/**
 * Every `export const GET|HEAD = withApiErrorHandling(...)` block in a source,
 * found by balancing parentheses from the opening one.
 *
 * `blankNonCode` preserves offsets — it overwrites with spaces and keeps
 * newlines — so the scan below can run on the blanked text and still describe
 * the real file.
 */
function unlimitableHandlerBlocks(src: string): { method: string; body: string }[] {
    const code = blankNonCode(src, { strings: true });
    const out: { method: string; body: string }[] = [];
    const re = new RegExp(
        `export const (${UNLIMITABLE.join('|')})\\s*=\\s*withApiErrorHandling\\(`,
        'g',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
        let depth = 0;
        let end = -1;
        for (let i = re.lastIndex - 1; i < code.length; i++) {
            if (code[i] === '(') depth++;
            else if (code[i] === ')') {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        // An unbalanced block would silently contribute nothing, which is the
        // failure mode this guard is about. Take the rest of the file instead.
        out.push({ method: m[1]!, body: code.slice(m.index, end === -1 ? code.length : end) });
    }
    return out;
}

/** Does this handler block declare a rate-limit CONFIG the wrapper will drop? */
function declaresUnreachableLimit(body: string): boolean {
    return /rateLimit\s*:\s*\{/.test(body) && /config\s*:/.test(body);
}

describe('a declared rate limit can execute', () => {
    const files = routeFiles();

    it('prints its denominator', () => {
        let handlers = 0;
        for (const rel of files) {
            handlers += unlimitableHandlerBlocks(
                readFileSync(join(ROOT, rel), 'utf8'),
            ).length;
        }
        console.log(
            `[declared-rate-limits] route files=${files.length} `
                + `GET/HEAD handlers through the wrapper=${handlers}`,
        );
        // Floors: an empty selection, or a scanner that stopped matching the
        // wrapper's name, would otherwise report nothing to check.
        expect(files.length).toBeGreaterThanOrEqual(400);
        expect(handlers).toBeGreaterThanOrEqual(100);
    });

    it('no GET or HEAD handler declares a rateLimit config', () => {
        const offenders: string[] = [];
        for (const rel of files) {
            const src = readFileSync(join(ROOT, rel), 'utf8');
            for (const { method, body } of unlimitableHandlerBlocks(src)) {
                if (declaresUnreachableLimit(body)) offenders.push(`${rel}  [${method}]`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every platform-admin GET limits itself, or is listed as deliberately not', () => {
        // The other half of #3155. That issue fixed the GETs that CLAIMED a
        // limit; this covers the ones that never did, and the Edge covers
        // neither — `apiReadRateLimit` reaches `/api/t/**` plus person paths,
        // and `/api/admin/*` is excluded from the public read tier. So an
        // admin GET is throttled only if its handler does it.
        const exempt = new Set(DELIBERATELY_UNTHROTTLED.map(([f]) => f));
        const unprotected: string[] = [];
        let limited = 0;
        for (const rel of files) {
            if (!rel.startsWith('src/app/api/admin/')) continue;
            const src = readFileSync(join(ROOT, rel), 'utf8');
            for (const { method, body } of unlimitableHandlerBlocks(src)) {
                // The HANDLER's body, never the whole file. A file whose POST
                // calls `enforceRateLimit` while its GET does not would
                // otherwise read as protected — and that is the exact shape
                // here: five of these routes carry a GET and a POST, and the
                // POST's limit works because the wrapper enforces it.
                if (/\benforceRateLimit\s*\(/.test(body)) limited += 1;
                else if (!exempt.has(rel)) unprotected.push(`${rel}  [${method}]`);
            }
        }
        console.log(
            `[declared-rate-limits] admin GETs limited inline=${limited} `
                + `deliberately unthrottled=${exempt.size}`,
        );
        expect(unprotected).toEqual([]);
        // A floor, so an admin tree that stopped being walked fails here.
        expect(limited).toBeGreaterThanOrEqual(8);
    });

    it('every deliberately-unthrottled entry names a route that EXISTS', () => {
        // Removes the exemption's cover as soon as the route is deleted or
        // renamed, which is what stops this list becoming a place old
        // decisions hide. Same rule as every other exemption map here.
        const known = new Set(files);
        for (const [file, reason] of DELIBERATELY_UNTHROTTLED) {
            expect(known.has(file)).toBe(true);
            expect(reason.length).toBeGreaterThan(60);
        }
    });

    describe('the detector, proved against crafted sources', () => {
        const wrap = (method: string, options: string) =>
            `export const ${method} = withApiErrorHandling(\n`
            + `    async (req) => jsonResponse({}),\n`
            + `    ${options},\n`
            + `);\n`;

        it('FLAGS the shape it exists to catch', () => {
            const src = wrap('GET', "{ rateLimit: { config: LOGIN_LIMIT, scope: 'x' } }");
            const [block] = unlimitableHandlerBlocks(src);
            expect(block).toBeDefined();
            expect(declaresUnreachableLimit(block!.body)).toBe(true);
        });

        it('does NOT flag `rateLimit: false`, which is the fix', () => {
            const src = wrap('GET', '{ rateLimit: false }');
            const [block] = unlimitableHandlerBlocks(src);
            expect(declaresUnreachableLimit(block!.body)).toBe(false);
        });

        it('does NOT flag the shape quoted inside a COMMENT', () => {
            // Earned: the real routes now explain this trap and quote it, and
            // the first version of this detector reported all eight fixed
            // routes as still broken on the strength of their own prose.
            const src = wrap(
                'GET',
                '{\n        // was `rateLimit: { config: LOGIN_LIMIT }` until #3155\n'
                    + '        rateLimit: false,\n    }',
            );
            const [block] = unlimitableHandlerBlocks(src);
            expect(declaresUnreachableLimit(block!.body)).toBe(false);
        });

        it('reads the HANDLER body, not the file — a POST\'s call does not cover a GET', () => {
            // The flaw this replaced: scanning the whole file for
            // `enforceRateLimit` marks an unprotected GET as protected
            // whenever a sibling POST happens to call it.
            const src =
                'export const GET = withApiErrorHandling(async (req) => jsonResponse({}));\n'
                + 'export const POST = withApiErrorHandling(async (req) => {\n'
                + '    const limited = await enforceRateLimit(req, { scope: "x", config: C });\n'
                + '    return jsonResponse({});\n'
                + '});\n';
            const blocks = unlimitableHandlerBlocks(src);
            expect(blocks).toHaveLength(1);
            expect(blocks[0]!.method).toBe('GET');
            expect(/\benforceRateLimit\s*\(/.test(blocks[0]!.body)).toBe(false);
        });

        it('does NOT flag a POST, where the wrapper does enforce it', () => {
            const src = wrap('POST', "{ rateLimit: { config: LOGIN_LIMIT, scope: 'x' } }");
            expect(unlimitableHandlerBlocks(src)).toHaveLength(0);
        });

        it('finds a HEAD handler too, not only GET', () => {
            const src = wrap('HEAD', "{ rateLimit: { config: LOGIN_LIMIT, scope: 'x' } }");
            expect(unlimitableHandlerBlocks(src)).toHaveLength(1);
        });

        it('CONTROL — the wrapper name it anchors on is the real one', () => {
            // If `withApiErrorHandling` were renamed, every block above would
            // stop matching and the main assertion would pass over nothing.
            const api = readFileSync(join(ROOT, 'src/lib/errors/api.ts'), 'utf8');
            expect(api).toContain('export function withApiErrorHandling');
            expect(api).toMatch(/MUTATION_METHODS\.has\(req\.method\)/);
        });
    });
});
