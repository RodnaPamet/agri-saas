/**
 * Guard: the way OUT of an erasure is not gated on being suspended, and
 * nothing else is exempt (#1667).
 *
 * ## The rule, which this repo already wrote once
 *
 * P5.5a: *"The way OUT of slow mode must never sit on the default tier. An
 * unverified account throttled on the route that verifies it cannot escape."*
 * `tests/guards/slow-mode-escape-is-not-throttled.test.ts` pins it.
 *
 * This is the same shape with a different control. `ACCOUNT_TERMINATED` sets
 * `suspendedAt` as well as `deletionRequestedAt`, so the suspension check was
 * refusing `DELETE /api/account/deletion` — the one route a terminated person
 * is entitled to use — while agrent-ios's recovery screen (#282, installed)
 * offered them the button. Owner ruling on #1667: they may cancel.
 *
 * ## Why a guard rather than a comment
 *
 * `allowSuspended` is an option that turns OFF a security check, and those
 * spread. The honest form is one named exception with its count held, so a
 * second caller costs a visible line and a reason rather than arriving as a
 * convenience.
 *
 * Note what the exception does NOT do. The caller still needs a valid session;
 * `cancelAccountDeletion` clears one column on the CALLER's own row; and
 * cancelling does not lift the suspension, so the person stops the erasure and
 * remains locked out. `POST /api/account/deletion` — requesting a deletion —
 * keeps the refusal, which is the asymmetry worth pinning: a suspended account
 * may stop an erasure and may not start one.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/** Passing the option, in any spelling an object literal allows. */
const PASSES_OPTION = /allowSuspended\s*:\s*(?:true|!0)/;

/**
 * The routes allowed to pass it, with what they let a suspended account do.
 *
 * An entry is a hole in P5.9's enforcement, so the reason has to name the
 * action and why withholding it would be worse than allowing it.
 */
const ALLOWED: Readonly<Record<string, string>> = {
    'src/app/api/account/deletion/route.ts':
        'DELETE only, and it admits a SELF-requested erasure only. The option ' +
        'lets the request reach `cancelAccountDeletion`, which then refuses a ' +
        'MODERATION-initiated erasure with `ACCOUNT_TERMINATED` — so what this ' +
        'exemption actually buys is that a person who asked to leave and was ' +
        'LATER suspended can still change their mind, which the suspension ' +
        'check was denying them. It clears one column on the caller own row, ' +
        'does not lift the suspension, and does not widen what they can read. ' +
        'POST on the same route keeps the refusal, so a suspended account may ' +
        'stop an erasure and may not start one.',
};

describe('the suspension escape is one named route (#1667)', () => {
    const files = collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 1500,
    });

    const callers = files
        .map((abs) => relative(REPO_ROOT, abs))
        .filter((rel) =>
            PASSES_OPTION.test(blankNonCode(readFileSync(`${REPO_ROOT}/${rel}`, 'utf8'))),
        )
        // the definitions that DECLARE the option are not callers of it
        .filter(
            (rel) =>
                rel !== 'src/lib/auth.ts' && rel !== 'src/app-layer/context.ts',
        );

    it('prints the denominator', () => {
        console.log(
            `[suspension-escape-is-not-gated] ${files.length} file(s) scanned; ` +
                `${callers.length} pass allowSuspended; ` +
                `${Object.keys(ALLOWED).length} allowed.`,
        );
        // The option has to be REACHABLE, or "no unexpected callers" is
        // satisfied by a tree where the escape does not exist and the phone's
        // button still 403s.
        expect(callers.length).toBeGreaterThanOrEqual(1);
    });

    it('has no caller that is not named here', () => {
        const unexpected = callers.filter((c) => !(c in ALLOWED));
        if (unexpected.length > 0) {
            throw new Error(
                `${unexpected.length} file(s) pass allowSuspended without being ` +
                    `named:\n\n${unexpected.map((c) => `  ${c}`).join('\n')}\n\n` +
                    `That option turns OFF the P5.9 suspension check. Add an ALLOWED ` +
                    `entry saying what it lets a suspended account do and why ` +
                    `withholding it would be worse — "it is convenient" is not a ` +
                    `reason, and neither is "the route is read-only".`,
            );
        }
        expect(unexpected).toEqual([]);
    });

    it('carries a substantive reason, and no stale entries', () => {
        for (const [path, reason] of Object.entries(ALLOWED)) {
            expect(reason.trim().length).toBeGreaterThan(150);
            expect(callers).toContain(path);
        }
    });

    it('the escape is on DELETE and the request path keeps the refusal', () => {
        // The asymmetry is the point: a suspended account may STOP an erasure
        // and may not START one. Both verbs live in the same file, so a future
        // "hoist the ctx resolution" refactor would silently open the second.
        const src = blankNonCode(
            readFileSync(`${REPO_ROOT}/src/app/api/account/deletion/route.ts`, 'utf8'),
        );
        const del = src.indexOf('export const DELETE');
        const post = src.indexOf('export const POST');
        expect(del).toBeGreaterThan(-1);
        expect(post).toBeGreaterThan(-1);
        // exactly one occurrence, and it is after DELETE begins
        const hits = [...src.matchAll(/allowSuspended/g)].map((m) => m.index!);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toBeGreaterThan(del);
    });

    describe('the detector', () => {
        const hit = (s: string) => PASSES_OPTION.test(blankNonCode(s));
        it('finds the option being passed', () => {
            expect(hit('await getUserCtx(req, { allowSuspended: true });')).toBe(true);
            expect(hit('getUserCtx(req, {allowSuspended:true})')).toBe(true);
        });
        it('does not fire on the declaration or on a false value', () => {
            expect(hit('allowSuspended?: boolean;')).toBe(false);
            expect(hit('{ allowSuspended: false }')).toBe(false);
            expect(hit('const x = 1;')).toBe(false);
        });
        it('ignores a comment that names it', () => {
            expect(hit('// pass allowSuspended: true here')).toBe(false);
        });
    });
});
