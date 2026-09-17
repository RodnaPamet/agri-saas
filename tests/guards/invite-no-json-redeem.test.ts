/**
 * Guard — the invite preview pages must NEVER navigate the browser to the
 * bare invite *redeem* API endpoint.
 *
 * The bug this locks (prod 2026-07): the tenant invite page rendered a native
 * `<form action="/api/invites/:token" method="POST">`. `/api/invites/:token`
 * (GET preview / POST redeem) returns JSON — with no client JS to intercept,
 * clicking "Accept" did a full-page navigation and dumped raw JSON in the
 * invitee's browser (`{"tenantId":…,"slug":"agrent","role":"READER"}`) instead
 * of landing them in the app.
 *
 * The accept action MUST go through a REDIRECTING route — `…/accept-redirect`
 * (redeem → 303 to the dashboard) or `…/start-signin` (cookie → /login). Those
 * carry a `/accept-redirect` or `/start-signin` suffix; the bare endpoint does
 * not. So: any invite page that references a `/api/invites/${…}` or
 * `/api/org/invite/${…}` URL with NO sub-path after the token is navigating to
 * the JSON endpoint — fail.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const INVITE_PAGES_ROOT = 'src/app/invite';

// A backtick template literal that is EXACTLY `/api/invites/${…}` or
// `/api/org/invite/${…}` — i.e. the bare redeem endpoint with no
// `/accept-redirect` or `/start-signin` suffix before the closing backtick.
const BARE_REDEEM_RE = /`\/api\/(?:invites|org\/invite)\/\$\{[^}]+\}`/g;

/**
 * The invite pages, absolute (the report below relativises against ROOT).
 *
 * `collectSourceFiles` throws on a missing root (#875) AND on an empty result
 * (#865) — the second is the one that matters here. The existence check this
 * replaces proved the DIRECTORY was there and said nothing about whether the
 * walk found any pages, and `expect(offenders).toEqual([])` is satisfied by a
 * walk that found none.
 *
 * The floor is 2 on purpose. This guard covers exactly two entry points — the
 * tenant invite page (`/api/invites/:token`) and the org one
 * (`/api/org/invite/:token`), both named in the docblock above. If one of them
 * disappears from the selection, half the guard is gone, and a floor of 1 would
 * not say so.
 */
function invitePageFiles(): string[] {
    return collectSourceFiles({ roots: [INVITE_PAGES_ROOT], floor: 2 });
}

describe('Invite flow never navigates to the raw-JSON redeem endpoint', () => {
    it('no invite page form/link targets the bare /api/invites/:token (JSON) endpoint', () => {
        const offenders: string[] = [];
        for (const file of invitePageFiles()) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                for (const m of line.matchAll(BARE_REDEEM_RE)) {
                    offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${m[0]}`);
                }
            });
        }
        if (offenders.length > 0) {
            throw new Error(
                'Invite page navigates to the bare redeem API (returns JSON → raw-JSON in the ' +
                    "browser). Route the accept action through `…/accept-redirect` instead:\n" +
                    offenders.join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the detector catches a bare-redeem reference but allows the redirect routes', () => {
        // Bare endpoints (JSON) — must be flagged.
        expect('action={`/api/invites/${token}`}'.match(BARE_REDEEM_RE)).not.toBeNull();
        expect('href={`/api/org/invite/${token}`}'.match(BARE_REDEEM_RE)).not.toBeNull();
        // Redirecting routes — must NOT be flagged.
        expect('`/api/invites/${token}/accept-redirect`'.match(BARE_REDEEM_RE)).toBeNull();
        expect('`/api/invites/${token}/start-signin`'.match(BARE_REDEEM_RE)).toBeNull();
        expect('`/api/org/invite/${token}/accept-redirect`'.match(BARE_REDEEM_RE)).toBeNull();
    });
});
