/**
 * A role refused a write says so in a code a client can switch on (#1767).
 *
 * ## What was wrong, and what it cost
 *
 * `assertCanWrite` — 106 call sites, measured — raised an UNCODED 403. Every
 * other 403 in this API carries a code (`PAST_DUE_RESTRICTED`,
 * `PLAN_LIMIT_EXCEEDED`, `AI_BUDGET_EXCEEDED`, `ADMIN_REQUIRED`); the one
 * meaning "your role may not write" was the generic one.
 *
 * `agrent-ios` asked for it directly. With no code the phone falls back to its
 * own «Нямате права за това действие.» — correct and useless, because the
 * operator cannot tell "this farm's role does not allow it, ask an
 * administrator" from "this action is not available here". Only the first is
 * actionable by the person holding the phone.
 *
 * ## The ladder is asserted here, not assumed
 *
 * `canWrite` is `level >= 3`. Which roles that refuses is the whole contract
 * the code communicates, so every one of the six is driven through it rather
 * than three being spot-checked — and the PASSING roles are asserted too,
 * because a change that refused everybody would satisfy every refusal case
 * below.
 */
import { assertCanWrite, assertCanRead } from '@/app-layer/policies/common';
import { computePermissions } from '@/lib/tenant-context';
import { ForbiddenError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';

const ALL_ROLES: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'MECHANISATOR'];

/** A context as `resolveTenantContext` builds one: permissions DERIVED from the role. */
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

function refusalFor(role: Role): ForbiddenError {
    try {
        assertCanWrite(ctxFor(role));
    } catch (err) {
        return err as ForbiddenError;
    }
    throw new Error(`${role} was NOT refused — this case cannot test the refusal`);
}

describe('the three roles that cannot write', () => {
    // Derived from the real ladder rather than listed, so a change to
    // ROLE_ORDER or to the `level >= 3` threshold moves this set instead of
    // silently disagreeing with it.
    const refused = ALL_ROLES.filter((r) => !computePermissions(r).canWrite);

    it('is exactly READER, MECHANISATOR and AUDITOR', () => {
        // The denominator, printed. If the ladder changed so that nothing was
        // refused, every case below would become vacuous — and `assertCanRead`
        // is the live example of that failure mode (#1766), which is why it is
        // asserted here too.
        expect(refused.sort()).toEqual(['AUDITOR', 'MECHANISATOR', 'READER']);
        expect(refused.length).toBe(3);
    });

    it.each(ALL_ROLES.filter((r) => !computePermissions(r).canWrite))(
        '%s is refused with WRITE_FORBIDDEN_FOR_ROLE',
        (role) => {
            const err = refusalFor(role);
            expect(err.code).toBe('WRITE_FORBIDDEN_FOR_ROLE');
            expect(err.status).toBe(403);
        },
    );

    it.each(ALL_ROLES.filter((r) => !computePermissions(r).canWrite))(
        '%s gets its own role in params, so a client can name it',
        (role) => {
            // ONE code with `params.role`, not three per-role codes: the three
            // refused roles differ only in which screens they otherwise see,
            // so the refusal is one condition. The param is what lets a client
            // say "your role here is AUDITOR" without the server asserting a
            // distinction no client needs.
            expect(refusalFor(role).params).toMatchObject({ role });
        },
    );

    it('keeps an English sentence, so a client with no entry still shows something', () => {
        // `coded-message-is-displayed-copy`: a bare code with no message
        // regresses a Bulgarian farmer to an untranslated string on any client
        // that has not shipped an entry for this code yet. The sentence is
        // unchanged from before it was coded, so nothing is taken away.
        const err = refusalFor('READER');
        expect(typeof err.message).toBe('string');
        expect(err.message.length).toBeGreaterThan(20);
        expect(err.message).toMatch(/permission to modify/i);
    });
});

describe('the three roles that CAN write are not refused', () => {
    it.each(ALL_ROLES.filter((r) => computePermissions(r).canWrite))(
        '%s passes',
        (role) => {
            // The control. Without it, a change that refused every role would
            // satisfy every assertion above — the exact shape of
            // `a-control-that-cannot-express-failure`.
            expect(() => assertCanWrite(ctxFor(role))).not.toThrow();
        },
    );

    it('and the passing set is not empty', () => {
        expect(ALL_ROLES.filter((r) => computePermissions(r).canWrite).sort())
            .toEqual(['ADMIN', 'EDITOR', 'OWNER']);
    });
});

describe('the code is distinct from the Edge admin refusal', () => {
    it('is not ADMIN_REQUIRED', () => {
        // `ADMIN_REQUIRED` comes from `src/middleware.ts` and means the ROUTE
        // is admin-only. This comes from a usecase and means the OPERATION
        // needs write. A role can pass the Edge and still meet this one, so a
        // client that collapsed them would tell an EDITOR they lack admin
        // rights for an operation no admin tier governs.
        expect(refusalFor('READER').code).not.toBe('ADMIN_REQUIRED');
        expect(refusalFor('READER').code).not.toBe('FORBIDDEN');
    });
});

describe('assertCanRead is deliberately NOT coded (#1766)', () => {
    it('refuses none of the six roles, so a code would advertise nothing', () => {
        // Recorded as an executing assertion rather than a comment, because it
        // is the reason only ONE of the two helpers changed. If a future
        // restricted role lands below READER this fails, which is exactly when
        // the decision on #1766 has to be made.
        const refusedByRead = ALL_ROLES.filter((r) => !computePermissions(r).canRead);
        expect(refusedByRead).toEqual([]);
        for (const role of ALL_ROLES) {
            expect(() => assertCanRead(ctxFor(role))).not.toThrow();
        }
    });
});
