/**
 * The fail-closed tier has an operator kill switch, and it is read at CALL time.
 *
 * ## Why it exists
 *
 * The tier aborts a caller's write when a compliance-critical audit row cannot
 * be appended. That is right for a PER-ROW failure: a membership or credential
 * change nobody can audit should not commit.
 *
 * A whole-SUBSYSTEM failure is a different shape. Measured 2026-10-03: the
 * audit writer failed on 275 of 275 attempts under the E2E runtime, which took
 * tenant creation and invite creation down with it (three `POST /admin/invites`
 * became 500s). Production was unaffected — see #1287 — but the shape is real,
 * and the only lever was a code change plus a deploy. `AUDIT_FAIL_CLOSED_ENABLED=0`
 * lets an operator trade an audited outage for an unaudited service during an
 * incident, the same way `AUDIT_STREAM_RETRY_ENABLED=0` works.
 *
 * ## What these tests are actually defending
 *
 * Two properties, and both are the kind that look fine while being useless:
 *
 *   1. **Read at call time.** Hoisting the read to module scope would compile,
 *      pass a naive test, and require a RESTART to take effect — defeating the
 *      entire point of a mid-incident switch.
 *   2. **Only `'0'` disables.** An audit control must not be disarmed by a
 *      typo, so `'false'`, `'no'`, `''` and `'00'` all leave it enforcing.
 *      A truthiness check would disarm on `'0'` AND enforce on `'false'`,
 *      which is the wrong half of the contract.
 */
import {
    shouldFailClosed,
    isFailClosedAuditEntity,
    failClosedEnforcementDisabled,
    failClosedAuditEntities,
    __resetFailClosedWarningForTests,
} from '@/lib/audit/fail-closed-entities';

const KEY = 'AUDIT_FAIL_CLOSED_ENABLED';
const ORIGINAL = process.env[KEY];

function setSwitch(v: string | undefined): void {
    if (v === undefined) delete process.env[KEY];
    else process.env[KEY] = v;
}

beforeEach(() => {
    setSwitch(undefined);
    __resetFailClosedWarningForTests();
});

afterAll(() => setSwitch(ORIGINAL));

describe('the fail-closed kill switch', () => {
    it('control: the tier is non-empty and a known entity is in it', () => {
        // Without this, every assertion below could pass on an empty set.
        expect(failClosedAuditEntities().length).toBeGreaterThan(10);
        expect(isFailClosedAuditEntity('TenantInvite')).toBe(true);
        expect(isFailClosedAuditEntity('LogEntry')).toBe(false);
    });

    it('enforces by default, with the variable unset', () => {
        expect(failClosedEnforcementDisabled()).toBe(false);
        expect(shouldFailClosed('TenantInvite')).toBe(true);
        expect(shouldFailClosed('TenantMembership')).toBe(true);
    });

    it('degrades a fail-closed entity when set to exactly "0"', () => {
        setSwitch('0');
        expect(failClosedEnforcementDisabled()).toBe(true);
        expect(shouldFailClosed('TenantInvite')).toBe(false);
        expect(shouldFailClosed('User')).toBe(false);
    });

    it('is read at CALL time, not at module load', () => {
        // THE REGRESSION TEST. A module-scope read would compile, would pass
        // the two tests above, and would need a restart to take effect — which
        // is precisely what a switch for use mid-incident cannot require.
        expect(shouldFailClosed('Tenant')).toBe(true);
        setSwitch('0');
        expect(shouldFailClosed('Tenant')).toBe(false);
        setSwitch(undefined);
        expect(shouldFailClosed('Tenant')).toBe(true);
    });

    it('only the exact string "0" disarms it', () => {
        for (const v of ['false', 'no', 'off', '', '00', ' 0', '0 ', 'FALSE', '1']) {
            setSwitch(v);
            expect(failClosedEnforcementDisabled()).toBe(false);
            expect(shouldFailClosed('TenantApiKey')).toBe(true);
        }
    });

    it('never makes a non-fail-closed entity fail closed, either way', () => {
        for (const v of [undefined, '0']) {
            setSwitch(v);
            expect(shouldFailClosed('LogEntry')).toBe(false);
            expect(shouldFailClosed('Location')).toBe(false);
            expect(shouldFailClosed(null)).toBe(false);
            expect(shouldFailClosed(undefined)).toBe(false);
            expect(shouldFailClosed('')).toBe(false);
        }
    });

    it('leaves isFailClosedAuditEntity PURE — it answers a different question', () => {
        // The entity's tier is a property of the ENTITY. The switch is a
        // property of today's runtime. Collapsing the two would make every
        // test and enumeration of the tier depend on an env var.
        setSwitch('0');
        expect(isFailClosedAuditEntity('TenantInvite')).toBe(true);
        expect(failClosedAuditEntities()).toContain('TenantInvite');
        expect(shouldFailClosed('TenantInvite')).toBe(false);
    });
});
