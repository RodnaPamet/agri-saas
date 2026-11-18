/**
 * #3185 — under a REQUIRED policy, the enrolment routes are reachable while
 * the farm is still owed a second factor, and nothing else is.
 *
 * The enrol routes resolved through `getTenantCtx`, whose factor check threw
 * MFA_REQUIRED for a member who had never enrolled — refusing the calls that
 * would satisfy it. `allowOwedSecondFactor` is the way out, so where it may be
 * used is pinned here: three handlers (status, start, verify). Removing an
 * enrolment must NOT pass it, or a password alone could strip the factor.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';

const getSessionOrThrow = jest.fn();
jest.mock('@/lib/auth', () => ({
    ...jest.requireActual('@/lib/auth'),
    getSessionOrThrow: (...a: unknown[]) => getSessionOrThrow(...a),
}));
const resolveTenantContext = jest.fn();
jest.mock('@/lib/tenant-context', () => ({
    ...jest.requireActual('@/lib/tenant-context'),
    resolveTenantContext: (...a: unknown[]) => resolveTenantContext(...a),
}));

import { getTenantCtx } from '@/app-layer/context';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const ENROL = 'src/app/api/t/[tenantSlug]/security/mfa/enroll';

describe('getTenantCtx — allowOwedSecondFactor (#3185)', () => {
    beforeEach(() => {
        getSessionOrThrow.mockResolvedValue({ userId: 'u1', tenantId: 't1', mfaPendingTenantIds: ['t1'] });
        resolveTenantContext.mockResolvedValue({
            tenant: { id: 't1', slug: 'farm' }, role: 'READER', permissions: {}, appPermissions: {},
        });
    });
    const req = () => new NextRequest('http://localhost/api/t/farm/security/mfa/enroll/start', { method: 'POST' });

    it('refuses a pending farm by default', async () => {
        await expect(getTenantCtx({ tenantSlug: 'farm' }, req())).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    });

    it('resolves it for an enrolment route', async () => {
        await expect(getTenantCtx({ tenantSlug: 'farm' }, req(), { allowOwedSecondFactor: true }))
            .resolves.toMatchObject({ tenantId: 't1' });
    });
});

describe('where the escape may be used (#3185)', () => {
    // The shared helpers: a collector that refuses an empty result, and
    // comment blanking so a docblock naming the option is not read as a use.
    const read = (f: string) => blankNonCode(fs.readFileSync(f, 'utf8'));

    it('is passed by exactly the three enrolment handlers', () => {
        const users = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'] })
            .filter((f) => !f.endsWith(path.join('app-layer', 'context.ts')))
            .filter((f) => read(f).includes('allowOwedSecondFactor'))
            .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
            .sort();
        expect(users).toEqual([
            `${ENROL}/route.ts`,
            `${ENROL}/start/route.ts`,
            `${ENROL}/verify/route.ts`,
        ]);
    });

    it('is NOT passed by the handler that REMOVES an enrolment', () => {
        const src = read(path.join(ROOT, ENROL, 'route.ts'));
        const del = src.slice(src.indexOf('export const DELETE'));
        expect(src.indexOf('export const DELETE')).toBeGreaterThan(-1);
        expect(del).toContain('getTenantCtx(params, req)');
        expect(del).not.toContain('allowOwedSecondFactor');
    });
});
