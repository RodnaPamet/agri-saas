/**
 * Every route that mints an invite must consume the invite rate limit.
 *
 * ## The defect this pins (#1448)
 *
 * `TENANT_INVITE_CREATE_LIMIT` is 20/hr, and its definition states the threat
 * model it was built for: "a tight audit trail for abuse", keyed by
 * (tenant, IP) so "a multi-browser attacker with one session still burns the
 * same budget".
 *
 * `POST /admin/invites` enforced it. `POST /admin/members` created the SAME
 * invite through the same usecase, sent the SAME email, and enforced nothing.
 * So the control was bypassed by changing the path — no second IP and no
 * second browser needed, and the careful keying never consulted.
 *
 * The inversion is what makes it worth a guard rather than a one-line fix: the
 * handler's own comment records that the admin UI calls `/admin/members`, so
 * the UNGUARDED path was the one in everyday use. The usual reassurance that
 * an unprotected route is the obscure one did not hold.
 *
 * ## Why the population is derived, not listed
 *
 * The two handlers are near-duplicates today. A third copy — a bulk invite, an
 * onboarding wizard, an SSO auto-provision path — is how this recurs, and a
 * guard naming the two known paths would pass while the third shipped
 * unguarded. So the population is every route file that calls
 * `createInviteToken`, found by reading the files. A new caller is covered the
 * day it is written rather than the day somebody remembers this file.
 *
 * ## What it cannot see
 *
 * That the limit is the RIGHT one, or that the scope key matches. A route
 * could call `enforceRateLimit` with some unrelated config and pass here. The
 * shared-budget property — both paths keyed `invite-create:${tenantId}` so
 * they consume ONE allowance rather than 20 each — is asserted separately
 * below, by reading the scope string.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** Route files under the API tree. The floor guards against an empty sweep. */
function apiRouteFiles(): string[] {
    return collectSourceFiles({
        roots: ['src/app/api'],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith(`${path.sep}route.ts`),
        floor: 150,
    });
}

interface Caller {
    file: string;
    enforces: boolean;
    scope: string | null;
}

function inviteCallers(): Caller[] {
    const out: Caller[] = [];
    for (const abs of apiRouteFiles()) {
        const src = fs.readFileSync(abs, 'utf8');
        // Comments stripped: a file DISCUSSING the usecase is not a caller,
        // and this guard's own prose would otherwise match.
        const code = blankNonCode(src);
        if (!/\bcreateInviteToken\s*\(/.test(code)) continue;
        const scope = /scope:\s*`([^`]+)`/.exec(code)?.[1] ?? null;
        out.push({
            file: path.relative(REPO_ROOT, abs),
            enforces: /\benforceRateLimit\s*\(/.test(code),
            scope,
        });
    }
    return out;
}

describe('invite creation is rate limited on every path that mints one', () => {
    const callers = inviteCallers();

    it('found the invite-minting routes at all', () => {
        // The positive control. A renamed usecase, a changed import style or a
        // broken sweep would report zero callers — and zero callers makes
        // every assertion below vacuously true.
        expect(callers.length).toBeGreaterThanOrEqual(2);
    });

    it('every route that mints an invite enforces a rate limit', () => {
        const unguarded = callers.filter((c) => !c.enforces).map((c) => c.file);
        if (unguarded.length > 0) {
            throw new Error(
                `${unguarded.length} route(s) call createInviteToken without ` +
                    `enforceRateLimit:\n` +
                    unguarded.map((f) => `  ${f}`).join('\n') +
                    `\n\nTENANT_INVITE_CREATE_LIMIT exists to bound outbound invite ` +
                    `email and to throttle the abuse audit trail. A guard on one of ` +
                    `several identical doors delivers neither (#1448). Copy the block ` +
                    `from admin/invites/route.ts, keeping the scope string identical ` +
                    `so the paths share one budget.\n\n` +
                    `Population: ${callers.length} invite-minting route(s) examined.`,
            );
        }
        expect(unguarded).toEqual([]);
    });

    it('they share ONE budget — the scope key is identical across paths', () => {
        // Not merely "each is limited". Different scope strings would give each
        // path its own 20/hr, so two doors would mean 40 — which is not the
        // ceiling the config describes.
        const scopes = new Set(callers.map((c) => c.scope));
        expect(scopes.size).toBe(1);
        expect([...scopes][0]).toContain('invite-create:');
    });
});
