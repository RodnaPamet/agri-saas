/**
 * Five `notFound()` refusals gained codes (#1712, this batch).
 *
 * ## Why a code and not a translation
 *
 * An uncoded `notFound('…')` sends its English prose to the iOS app, which
 * displays it verbatim: `UserMessage.httpText` resolves through the phone's own
 * code table, that table has no `NOT_FOUND` entry, and so it falls through to
 * `message` — which `isHumanSentence` passes because "Lease not found" has a
 * space in it. `badRequest` and `forbidden` map to codes the table DOES carry,
 * which is why only the 404s leaked English.
 *
 * Translating the message alone would not have fixed the web either:
 * `localizeErrorPayload` keys on `code`, so all of them sharing `NOT_FOUND`
 * would mean one catalogue key for every case.
 *
 * ## The anti-enumeration property is the assertion that matters
 *
 * `resolveTenantContext` refuses a missing farm and a soft-deleted one with the
 * SAME message, deliberately — its own comment calls that "the same
 * anti-enumeration shape as not found". Giving them distinct codes would have
 * undone exactly that: a caller could then tell "no such farm" from "a farm you
 * may not see", which is a slug oracle. So the test asserts they are
 * INDISTINGUISHABLE rather than merely that each is coded.
 */
const findUnique = jest.fn();
const findFirst = jest.fn();
jest.mock('@/lib/prisma', () => {
    const client = {
        tenant: {
            findUnique: (...a: unknown[]) => findUnique(...a),
            findFirst: (...a: unknown[]) => findFirst(...a),
        },
        tenantMembership: { findFirst: jest.fn(async () => null) },
    };
    return { __esModule: true, default: client, prisma: client };
});

import { resolveTenantContext } from '@/lib/tenant-context';
import type { NotFoundError } from '@/lib/errors/types';

async function refusal(fn: () => Promise<unknown>): Promise<NotFoundError> {
    try {
        await fn();
    } catch (err) {
        return err as NotFoundError;
    }
    throw new Error('expected a refusal — this case cannot test one');
}

beforeEach(() => {
    findUnique.mockReset();
    findFirst.mockReset();
});

describe('the tenant resolver, reachable from every /api/t route', () => {
    it('codes a missing farm as TENANT_NOT_FOUND', async () => {
        findUnique.mockResolvedValue(null);

        const err = await refusal(() => resolveTenantContext({ tenantSlug: 'nope' }, 'u-1'));

        expect(err.code).toBe('TENANT_NOT_FOUND');
        expect(err.status).toBe(404);
    });

    it('codes a SOFT-DELETED farm identically — the anti-enumeration property', async () => {
        // THE case. Distinct codes here would let a caller tell a farm that
        // does not exist from one they may not see, which is a slug oracle on
        // the single gate every tenant request passes through.
        findUnique.mockResolvedValue(null);
        const missing = await refusal(() => resolveTenantContext({ tenantSlug: 'a' }, 'u-1'));

        findUnique.mockResolvedValue({ id: 't-1', slug: 'b', deletedAt: new Date() });
        const deleted = await refusal(() => resolveTenantContext({ tenantSlug: 'b' }, 'u-1'));

        expect(deleted.code).toBe(missing.code);
        expect(deleted.message).toBe(missing.message);
        expect(deleted.status).toBe(missing.status);
    });

    it('codes a request that reached the resolver with no identifier', async () => {
        // Reachable: a caller passing `{ tenantId: session.tenantId }` where
        // the session carries no tenant makes both branches falsy.
        const err = await refusal(() => resolveTenantContext({}, 'u-1'));

        expect(err.code).toBe('TENANT_IDENTIFIER_REQUIRED');
        // A DIFFERENT code from TENANT_NOT_FOUND, because the remedy differs:
        // re-authenticate or pick a farm, rather than check the address.
        expect(err.code).not.toBe('TENANT_NOT_FOUND');
        // And no database read happened — it refused before looking.
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('keeps the English sentence as a fallback', async () => {
        // `coded-message-is-displayed-copy`: a bare code regresses a farmer to
        // an untranslated string on any client with no entry for it yet. The
        // sentence is unchanged, so this adds something switchable without
        // taking anything away.
        findUnique.mockResolvedValue(null);
        const err = await refusal(() => resolveTenantContext({ tenantSlug: 'x' }, 'u-1'));

        expect(err.message).toBe('Tenant not found');
    });
});

describe('the two codes are not the same code', () => {
    it('a slug miss and a missing identifier are distinguishable', async () => {
        findUnique.mockResolvedValue(null);
        const a = await refusal(() => resolveTenantContext({ tenantSlug: 'x' }, 'u-1'));
        const b = await refusal(() => resolveTenantContext({}, 'u-1'));

        // The control for the sameness assertion above: that one requires two
        // cases to MATCH, so without this a single constant code for every
        // refusal would satisfy it.
        expect(a.code).not.toBe(b.code);
    });
});
