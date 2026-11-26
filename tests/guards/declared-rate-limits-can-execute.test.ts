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
