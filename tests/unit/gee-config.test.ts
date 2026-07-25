/**
 * Unit test — the GEE credential seam (`src/lib/agro/gee-config.ts`).
 *
 * Two things worth locking:
 *
 *   1. **`isGeeConfigured` requires BOTH keys.** One key alone is a
 *      misconfiguration, not a half-working deployment — Earth Engine cannot
 *      authenticate without the pair, so it must read as "off".
 *
 *   2. **`geeConfigStatus` names what's missing.** This is the operator-facing
 *      half: the startup WARN and `/api/readyz`'s `capabilities.satellite` both
 *      report it, which is the only signal that an otherwise-healthy prod
 *      deployment has gone dark on satellite. If it stopped naming the absent
 *      keys, "why are the satellite pages empty" becomes unanswerable from the
 *      outside.
 *
 * The module is deliberately EE-free (env reads only) so a page shell, a health
 * probe, and a startup hook can import it without dragging in the heavy
 * `@google/earthengine` client — asserted here by importing it in a plain unit
 * test with no EE mock in sight.
 */
const mockEnv: { GEE_PROJECT_ID?: string; GEE_SERVICE_ACCOUNT_KEY?: string } = {};
jest.mock('@/env', () => ({
    env: mockEnv,
}));

import { geeConfigStatus, isGeeConfigured } from '@/lib/agro/gee-config';

beforeEach(() => {
    delete mockEnv.GEE_PROJECT_ID;
    delete mockEnv.GEE_SERVICE_ACCOUNT_KEY;
});

describe('isGeeConfigured', () => {
    it('true only when both the project id and the service-account key are set', () => {
        mockEnv.GEE_PROJECT_ID = 'my-ee-project';
        mockEnv.GEE_SERVICE_ACCOUNT_KEY = '{"type":"service_account"}';
        expect(isGeeConfigured()).toBe(true);
    });

    it('false when neither is set', () => {
        expect(isGeeConfigured()).toBe(false);
    });

    it('false with only the project id — EE cannot authenticate', () => {
        mockEnv.GEE_PROJECT_ID = 'my-ee-project';
        expect(isGeeConfigured()).toBe(false);
    });

    it('false with only the service-account key', () => {
        mockEnv.GEE_SERVICE_ACCOUNT_KEY = '{"type":"service_account"}';
        expect(isGeeConfigured()).toBe(false);
    });

    it('false for empty-string values (an unset var that reached env as "")', () => {
        mockEnv.GEE_PROJECT_ID = '';
        mockEnv.GEE_SERVICE_ACCOUNT_KEY = '';
        expect(isGeeConfigured()).toBe(false);
    });
});

describe('geeConfigStatus — the operator signal', () => {
    it('configured with nothing missing when both keys are present', () => {
        mockEnv.GEE_PROJECT_ID = 'my-ee-project';
        mockEnv.GEE_SERVICE_ACCOUNT_KEY = '{"type":"service_account"}';
        expect(geeConfigStatus()).toEqual({ configured: true, missing: [] });
    });

    it('names BOTH absent keys so an operator knows what to set', () => {
        expect(geeConfigStatus()).toEqual({
            configured: false,
            missing: ['GEE_PROJECT_ID', 'GEE_SERVICE_ACCOUNT_KEY'],
        });
    });

    it('names only the genuinely-absent key on a half-configured deploy', () => {
        mockEnv.GEE_PROJECT_ID = 'my-ee-project';
        expect(geeConfigStatus()).toEqual({
            configured: false,
            missing: ['GEE_SERVICE_ACCOUNT_KEY'],
        });
    });

    it('never leaks the key VALUE — only the variable names', () => {
        mockEnv.GEE_PROJECT_ID = 'my-ee-project';
        const serialised = JSON.stringify(geeConfigStatus());
        expect(serialised).not.toContain('my-ee-project');
    });
});
