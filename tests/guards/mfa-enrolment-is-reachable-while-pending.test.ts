/**
 * A member who must enrol can actually reach the page that lets them.
 *
 * Under a REQUIRED policy, a member who has never enrolled gets a pending
 * session. The middleware's §4 sends every tenant path to
 * `/t/:slug/auth/mfa`, and that page's not-enrolled branch offers exactly one
 * way out: a link to `/t/:slug/security/mfa` (`mfa-go-enroll-btn`).
 *
 * That path was not on `isMfaAllowedPath`, so §4 bounced it back to
 * `/auth/mfa` and the person could not enrol AT ALL — not on the web, and not
 * through Google or Microsoft in the phone's sign-in sheet, which is where
 * #1646's `otpauth://` hand-off link lives. A lockout rather than a bypass,
 * and invisible to every other test because each half is correct on its own:
 * the gate redirects what it should, and the page links where it should.
 *
 * So this guard checks the two halves AGREE. It is the join that was wrong.
 */
import fs from 'node:fs';
import path from 'node:path';

import { isMfaAllowedPath } from '@/lib/auth/guard';
import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const CHALLENGE_PAGE = 'src/app/t/[tenantSlug]/(app)/auth/mfa/page.tsx';

describe('MFA enrolment is reachable while a factor is pending', () => {
    it('allows the enrolment page', () => {
        expect(isMfaAllowedPath('/t/my-farm/security/mfa')).toBe(true);
        expect(isMfaAllowedPath('/t/my-farm/security/mfa/')).toBe(true);
    });

    it('allows the challenge page and the enrolment APIs it calls', () => {
        expect(isMfaAllowedPath('/t/my-farm/auth/mfa')).toBe(true);
        expect(isMfaAllowedPath('/api/t/my-farm/security/mfa')).toBe(true);
        expect(isMfaAllowedPath('/api/t/my-farm/security/mfa/enroll/start')).toBe(true);
    });

    it('does NOT open the rest of the security area', () => {
        // The narrow fix. A pending session has an outstanding security
        // control; letting it roam `/security/*` would be a far wider hole
        // than the lockout being closed.
        expect(isMfaAllowedPath('/t/my-farm/security')).toBe(false);
        expect(isMfaAllowedPath('/t/my-farm/security/sessions')).toBe(false);
        expect(isMfaAllowedPath('/t/my-farm/security/mfa/../sessions')).toBe(false);
        expect(isMfaAllowedPath('/t/my-farm/security/mfa-other')).toBe(false);
    });

    it('does not open unrelated tenant paths', () => {
        expect(isMfaAllowedPath('/t/my-farm/dashboard')).toBe(false);
        expect(isMfaAllowedPath('/api/t/my-farm/locations')).toBe(false);
    });

    it('the challenge page still links to a path the gate allows', () => {
        // The join. If somebody changes where `mfa-go-enroll-btn` points, this
        // fails rather than silently re-creating the loop — which is how the
        // original defect was invisible: both halves looked right alone.
        const src = blankNonCode(
            fs.readFileSync(path.join(REPO_ROOT, CHALLENGE_PAGE), 'utf8'),
        );
        // Anchored on the BUTTON's id, not the first `tenantHref` in the
        // file — that one is `/dashboard` (the post-challenge destination),
        // which the gate correctly bounces. Matching it made this test fail
        // for the right reason on the wrong link, and had `/dashboard` been
        // allowed it would have passed while checking nothing.
        const button = src.slice(0, src.indexOf('mfa-go-enroll-btn'));
        const href = button.match(/tenantHref\('(\/[^']+)'\)[^]]*$/)?.[1]
            ?? [...button.matchAll(/tenantHref\('(\/[^']+)'\)/g)].pop()?.[1];
        expect(href).toBeTruthy();
        // `tenantHref` prefixes `/t/:slug`, so reconstruct what the browser
        // actually requests rather than testing the suffix in isolation.
        expect(isMfaAllowedPath(`/t/my-farm${href}`)).toBe(true);
    });

    it('control: the join check FAILS for a link the gate would bounce', () => {
        // Teeth. Without this, the assertion above passes on any href that
        // happens to be allowed, including one unrelated to enrolment.
        expect(isMfaAllowedPath('/t/my-farm/security/sessions')).toBe(false);
    });
});
