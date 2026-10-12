/**
 * Every invite-ACCEPTANCE route records its suspended refusal (#1656).
 *
 * ## Why this is structural rather than a behaviour test
 *
 * The unit test next to it proves the gate records when asked. What it cannot
 * prove is that every route that should ask, does — and the population is the
 * part that moves. There are two accept surfaces today, tenant and
 * organisation, and the organisation one was added as "the same hole" after the
 * tenant one; a third would be added the same way.
 *
 * The failure mode is quiet in both directions. A new accept route that calls
 * the bare gate refuses correctly and records nothing, and nobody notices
 * because there is no moderation UI to show the absence (agrent backend-2
 * measured that: the suspensions route is POST and DELETE only, no GET
 * anywhere). So the record's absence is invisible at every layer except this
 * one.
 *
 * ## What counts as an acceptance route
 *
 * A route under an invite token path that REDEEMS — `redeemInvite` or
 * `redeemOrgInvite`. Deliberately not "every route that calls the gate": the
 * GET previews and `start-signin` reach it too and must not record, because
 * reading an invite preview is not an attempt to join and an entry per page
 * load would flood the chain the suspension history lives in.
 *
 * ## Four, not two — which this guard found
 *
 * I wrote it expecting the two `POST` routes and it failed, naming the two
 * `accept-redirect` routes as well. They redeem too, and they refuse a
 * suspended account before redeeming — but through `authWithSuspension` and a
 * REDIRECT, because they are bare `GET`s a browser navigates to and a thrown
 * 403 would render as raw JSON.
 *
 * So a route records in one of two shapes, and both are accepted here:
 *
 *   throwing   `authRefusingSuspended({ attempted: … })`
 *   redirecting `recordSuspendedRefusal(userId, { attempted: … })`
 *
 * The shared piece is the recorder; the gate's parameter is a convenience for
 * callers that throw. Accepting only the first would have pushed the redirect
 * routes into throwing, which would have broken the browser surface to satisfy
 * a guard.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const root = path.resolve(__dirname, '../..');

/**
 * Every `route.ts` under a path with an invite token segment.
 *
 * Through `collectSourceFiles` rather than a hand-rolled `readdirSync` walk —
 * `tests/guards/file-collection-is-not-silently-empty.test.ts` requires it,
 * and caught the first draft of this file. The shared collector is what
 * supplies the `floor`, so a renamed directory names itself instead of
 * scanning zero files and reporting the tree clean (#875).
 */
function inviteRouteFiles(): string[] {
    return collectSourceFiles({
        roots: ['src/app/api'],
        extensions: ['.ts'],
        // 270+ route files today; a floor well under that still catches a
        // moved or renamed `src/app/api`.
        floor: 100,
    })
        .filter((abs) => path.basename(abs) === 'route.ts')
        .filter((abs) => /invit/i.test(path.relative(root, abs)))
        .sort();
}

const REDEEMS = /\bredeem(Invite|OrgInvite)\s*\(/;

describe('invite acceptance records a refusal (#1656)', () => {
    const all = inviteRouteFiles();

    const accepting = all.filter((abs) =>
        REDEEMS.test(blankNonCode(fs.readFileSync(abs, 'utf8'))),
    );

    it('prints the denominator', () => {
        // Per `a-gate-narrow-enough-to-always-pass`: an `accepting` list that
        // silently emptied — a renamed redeem function, a moved directory —
        // would satisfy the assertion below for free.
        console.log(
            `[invite-acceptance-records-a-refusal] ${all.length} invite route(s); ` +
                `${accepting.length} redeem: ` +
                accepting.map((a) => path.relative(root, a)).join(', '),
        );
        expect(all.length).toBeGreaterThanOrEqual(6);
        // FOUR today — two POSTs and two accept-redirects. A floor rather than
        // an equality, so adding a fifth surface is not itself a failure;
        // failing to RECORD on it is.
        expect(accepting.length).toBeGreaterThanOrEqual(4);
        expect(accepting.length).toBeLessThan(all.length);
    });

    it.each([
        ['src/app/api/invites/[token]/route.ts', 'TENANT'],
        ['src/app/api/org/invite/[token]/route.ts', 'ORG'],
        ['src/app/api/invites/[token]/accept-redirect/route.ts', 'TENANT'],
        ['src/app/api/org/invite/[token]/accept-redirect/route.ts', 'ORG'],
    ])('%s is one of them, with surface %s', (rel, surface) => {
        // Named explicitly as well as derived: a derivation that stopped
        // finding these two would pass the `.each` below over an empty list,
        // and the denominator test cannot tell WHICH two it found.
        const abs = path.join(root, rel);
        expect(accepting).toContain(abs);
        expect(blankNonCode(fs.readFileSync(abs, 'utf8'))).toContain(`'${surface}'`);
    });

    it('every redeeming route passes a refusal record to the gate', () => {
        const offenders: string[] = [];
        for (const abs of accepting) {
            const src = blankNonCode(fs.readFileSync(abs, 'utf8'));
            // The record is an argument, so the call must not be bare. Matching
            // the argument's own field rather than "has a brace", because a
            // route could pass some other object.
            const records =
                (/authRefusingSuspended\s*\(\s*\{/.test(src) ||
                    /recordSuspendedRefusal\s*\(/.test(src)) &&
                /attempted:\s*'INVITE_ACCEPTANCE'/.test(src);
            if (!records) offenders.push(path.relative(root, abs));
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} invite-acceptance route(s) refuse a suspended ` +
                    `account without recording it (#1656):\n\n` +
                    offenders.map((o) => `  ${o}`).join('\n') +
                    `\n\nA route that THROWS passes the record to the gate:\n` +
                    `  authRefusingSuspended({ attempted: 'INVITE_ACCEPTANCE', ` +
                    `surface: 'TENANT' | 'ORG', token })\n` +
                    `A route that REDIRECTS calls the recorder directly:\n` +
                    `  await recordSuspendedRefusal(userId, { attempted: ` +
                    `'INVITE_ACCEPTANCE', surface, token })\n\n` +
                    `The refusal is correct without it; the entry is the only ` +
                    `durable trace, and there is no UI that would show its absence.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the PREVIEW routes record nothing — reading is not attempting', () => {
        // The other direction. A gate that recorded unconditionally, or a route
        // that passed a record on its GET, would put an entry in the moderation
        // chain for every page load of an invite link.
        const previewOnly = all.filter((abs) => !accepting.includes(abs));
        expect(previewOnly.length).toBeGreaterThan(0);
        for (const abs of previewOnly) {
            const src = blankNonCode(fs.readFileSync(abs, 'utf8'));
            expect(src).not.toMatch(/attempted:\s*'INVITE_ACCEPTANCE'/);
        }
    });

    it('the detector can tell a recording call from a bare one — positive control', () => {
        // `a-probe-with-no-discriminating-power`: both assertions above pass
        // identically when the regexes are broken and when the code is right.
        const bare = blankNonCode('const s = await authRefusingSuspended();\n');
        const recording = blankNonCode(
            "const s = await authRefusingSuspended({ attempted: 'INVITE_ACCEPTANCE', surface: 'TENANT', token });\n",
        );
        const redirecting = blankNonCode(
            "await recordSuspendedRefusal(id, { attempted: 'INVITE_ACCEPTANCE', surface: 'ORG', token });\n",
        );
        const matches = (src: string) =>
            (/authRefusingSuspended\s*\(\s*\{/.test(src) ||
                /recordSuspendedRefusal\s*\(/.test(src)) &&
            /attempted:\s*'INVITE_ACCEPTANCE'/.test(src);
        expect(matches(bare)).toBe(false);
        expect(matches(recording)).toBe(true);
        // Both shapes, so the alternation is not passing on one branch alone.
        expect(matches(redirecting)).toBe(true);
        // And a comment mentioning it does not count as the call.
        expect(matches(blankNonCode("// attempted: 'INVITE_ACCEPTANCE' in prose\n"))).toBe(false);
    });
});
