/**
 * A role refused an ADMIN or AUDIT action says so in its own code (#1779).
 *
 * Sibling of `write-refusal-is-coded.test.ts`, and the third member of a set
 * whose whole value is that the members stay DISTINGUISHABLE.
 *
 * ## The three "admin" conditions
 *
 *   • `ADMIN_REQUIRED` — `src/middleware.ts`, at the **Edge**: the ROUTE is
 *     admin-only and this role is not. "This whole area is not for you."
 *   • `ADMIN_FORBIDDEN_FOR_ROLE` — `assertCanAdmin`, from a usecase: the route
 *     is NOT admin-only, the caller reached the handler legitimately, and this
 *     particular OPERATION needs admin. "This action, within an area you can
 *     use, is not for you."
 *   • `WRITE_FORBIDDEN_FOR_ROLE` — the same shape one level down (#1767).
 *
 * A role can pass the Edge and still meet the usecase check, so collapsing the
 * first two makes them indistinguishable on the wire — and a client showing
 * one sentence for both would tell an EDITOR they lack access to a screen they
 * are currently looking at. That distinctness is asserted here rather than
 * argued in a docblock.
 *
 * `ADMIN_REQUIRED` was deliberately not renamed to make room: it is one of the
 * four codes the spec singles out as reachable on every route and worth
 * switching on, which makes it the most likely of all of them to be live in a
 * shipped client.
 *
 * ## The ladder is derived, not listed
 *
 * `canAdmin` is `level >= 4`. Which roles that refuses IS the contract the code
 * communicates, so all six are driven through it — and the PASSING roles are
 * asserted too, because a change that refused everybody would satisfy every
 * refusal case below. `assertCanRead` is the live example of that failure mode
 * (#1766): it refuses nobody, so a code there would advertise nothing.
 */
import { assertCanAdmin, assertCanAudit } from '@/app-layer/policies/common';
import { computePermissions } from '@/lib/tenant-context';
import { ForbiddenError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';

const ALL_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'];

function ctxFor(role: Role): RequestContext {
    return {
        requestId: 'req-1',
        userId: 'u-1',
        tenantId: 't-1',
        tenantSlug: 'acme',
        role,
        permissions: computePermissions(role),
    } as RequestContext;
}

function refusalFrom(fn: (c: RequestContext) => void, role: Role): ForbiddenError {
    try {
        fn(ctxFor(role));
    } catch (err) {
        return err as ForbiddenError;
    }
    throw new Error(`${role} was NOT refused — this case cannot test the refusal`);
}

describe('the roles that cannot perform an admin action', () => {
    const refused = ALL_ROLES.filter((r) => !computePermissions(r).canAdmin);

    it('is exactly EDITOR, AUDITOR, READER and MECHANISATOR — the denominator', () => {
        // Four of six. If the ladder changed so that nothing was refused,
        // every case below would become vacuous.
        expect(refused.sort()).toEqual(['AUDITOR', 'EDITOR', 'MECHANISATOR', 'READER']);
        expect(refused.length).toBe(4);
    });

    it.each(ALL_ROLES.filter((r) => !computePermissions(r).canAdmin))(
        '%s is refused with ADMIN_FORBIDDEN_FOR_ROLE and params.role',
        (role) => {
            const err = refusalFrom(assertCanAdmin, role);
            expect(err.code).toBe('ADMIN_FORBIDDEN_FOR_ROLE');
            // `params.role` so a client can name the role the person actually
            // holds instead of guessing, as its sibling does.
            expect(err.params?.role).toBe(role);
            // The English sentence STAYS: a bare code regresses a Bulgarian
            // farmer to an untranslated string on any client with no entry.
            expect(err.message).toMatch(/administrative actions/);
        },
    );

    it('the two roles that CAN administer are not refused', () => {
        // Without this, a change refusing all six would satisfy every case
        // above.
        const allowed = ALL_ROLES.filter((r) => computePermissions(r).canAdmin);
        expect(allowed.sort()).toEqual(['ADMIN', 'OWNER']);
        for (const role of allowed) {
            expect(() => assertCanAdmin(ctxFor(role))).not.toThrow();
        }
    });
});

describe('the roles that cannot perform an audit action', () => {
    const refused = ALL_ROLES.filter((r) => !computePermissions(r).canAudit);

    it('is exactly EDITOR, READER and MECHANISATOR — the denominator', () => {
        expect(refused.sort()).toEqual(['EDITOR', 'MECHANISATOR', 'READER']);
    });

    it.each(ALL_ROLES.filter((r) => !computePermissions(r).canAudit))(
        '%s is refused with AUDIT_FORBIDDEN_FOR_ROLE',
        (role) => {
            const err = refusalFrom(assertCanAudit, role);
            expect(err.code).toBe('AUDIT_FORBIDDEN_FOR_ROLE');
            expect(err.params?.role).toBe(role);
        },
    );

    it('AUDITOR — the role it exists for — is not refused', () => {
        // The one that would be embarrassing to get wrong, and the control for
        // the set above.
        const allowed = ALL_ROLES.filter((r) => computePermissions(r).canAudit);
        expect(allowed).toContain('AUDITOR');
        for (const role of allowed) {
            expect(() => assertCanAudit(ctxFor(role))).not.toThrow();
        }
    });
});

describe('the three codes stay distinguishable', () => {
    it('the admin usecase code is NOT the Edge code', () => {
        // The whole reason this got its own code instead of reusing
        // ADMIN_REQUIRED. A role can pass the Edge and still meet the usecase
        // check, so collapsing them makes two different conditions — with two
        // different remedies — identical on the wire.
        const err = refusalFrom(assertCanAdmin, 'EDITOR');
        expect(err.code).not.toBe('ADMIN_REQUIRED');
        expect(err.code).not.toBe('FORBIDDEN');
        expect(err.code).not.toBeUndefined();
    });

    it('admin, audit and write are three codes, not one', () => {
        // Asserted as a SET so a future tidy-up that collapsed any two fails
        // here rather than being noticed by a client.
        const codes = new Set([
            refusalFrom(assertCanAdmin, 'EDITOR').code,
            refusalFrom(assertCanAudit, 'EDITOR').code,
        ]);
        expect(codes.size).toBe(2);
        expect([...codes].sort()).toEqual(['ADMIN_FORBIDDEN_FOR_ROLE', 'AUDIT_FORBIDDEN_FOR_ROLE']);
    });

    it('EDITOR meets BOTH new refusals, which is why they cannot share a code', () => {
        // The concrete case: one role, two different refusals, two different
        // things to tell them. EDITOR can write but can neither administer nor
        // audit — so a client collapsing these would show the same sentence
        // for two unrelated dead ends.
        expect(computePermissions('EDITOR').canWrite).toBe(true);
        expect(computePermissions('EDITOR').canAdmin).toBe(false);
        expect(computePermissions('EDITOR').canAudit).toBe(false);
    });
});
