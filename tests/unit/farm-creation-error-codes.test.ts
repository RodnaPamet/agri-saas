/**
 * A farm-creation refusal arrives with its code in `code`, not in `message`.
 *
 * ## The defect this pins (found on the wire by agrent-ios)
 *
 * P3.6 threw `badRequest('FARM_NAME_REQUIRED')` and friends, which looks like a
 * machine-readable refusal and is not one. `badRequest(message, details)` passes
 * NO code to `ValidationError`, whose third parameter defaults to
 * `'BAD_REQUEST'`, so the wire carried
 *
 *     { error: { code: 'BAD_REQUEST', message: 'FARM_NAME_REQUIRED' } }
 *
 * Every refusal was therefore indistinguishable to a client switching on
 * `code` — which is exactly what `ErrorResponse`'s own description tells
 * clients to do. The web never noticed because it renders `t('failed')` for any
 * non-OK response; the native client noticed immediately because it has to say
 * something specific in Bulgarian.
 *
 * ## Why it survived review and a green guard
 *
 * `tests/guards/no-server-authored-user-copy.test.ts` exempts "a throw that
 * carries a machine-readable CODE". What was written was a throw whose MESSAGE
 * was a code. Both satisfy that guard — it scans the first string argument for
 * prose — and only one produces a usable response. The guard measured what it
 * measures; the mistake was treating a satisfied guard as a solved problem.
 *
 * So this file asserts the thing the guard cannot see: the shape a client
 * actually receives, taken through `toApiErrorResponse` rather than read off
 * the throw.
 *
 * ## Scope
 *
 * The five refusals below are reachable with no database, because every one of
 * them fires before `createTenantWithOwner` is called. `FARM_SLUG_UNAVAILABLE`
 * needs the retry loop to exhaust and `ACCOUNT_HAS_NO_EMAIL` /
 * `INVALID_FARM_PAYLOAD` live in the route, so they are not covered here —
 * named rather than silently omitted.
 */
import { createFarmForUser, FARM_NAME_MAX } from '@/app-layer/usecases/farm-creation';
import { toApiErrorResponse } from '@/lib/errors/types';
import { isValidEik, looksLikeEgn } from '@/lib/bg-identifiers';

function creator() {
    return { requestId: 'req-codes', userId: 'u-codes', userEmail: 'codes@example.test' };
}

/** The envelope a client receives, not the thrown object. */
async function refusalOf(
    input: { name: string; eik?: string | null },
): Promise<{ status: number; code: string; message: string; params?: unknown }> {
    try {
        await createFarmForUser(creator(), input);
    } catch (err) {
        const { payload, status } = toApiErrorResponse(err);
        return {
            status,
            code: payload.error.code,
            message: payload.error.message,
            params: payload.error.params,
        };
    }
    throw new Error('expected createFarmForUser to refuse, and it did not');
}

/** An ЕГН, found with the real detector rather than hand-written. */
function anEgn(): string {
    for (let n = 7500000000; n < 7600000000; n += 1) {
        const s = String(n);
        if (looksLikeEgn(s)) return s;
    }
    throw new Error('no ЕГН-shaped value found');
}

describe('farm-creation refusals carry a code a client can switch on', () => {
    it('control: the codes are NOT all BAD_REQUEST', async () => {
        // The whole defect in one assertion. Before the fix every one of these
        // was 'BAD_REQUEST' and this would read as a single-element set.
        const codes = new Set(
            await Promise.all(
                [
                    refusalOf({ name: '' }),
                    refusalOf({ name: 'x'.repeat(FARM_NAME_MAX + 1) }),
                    refusalOf({ name: 'Ферма', eik: anEgn() }),
                    refusalOf({ name: 'Ферма', eik: '123456789' }),
                    refusalOf({ name: '!!! ???' }),
                ].map((p) => p.then((r) => r.code)),
            ),
        );
        expect(codes.size).toBe(5);
        expect(codes.has('BAD_REQUEST')).toBe(false);
    });

    it('an absent name is FARM_NAME_REQUIRED', async () => {
        const r = await refusalOf({ name: '' });
        expect(r.code).toBe('FARM_NAME_REQUIRED');
        expect(r.status).toBe(400);
        // The message is the FALLBACK for a client that does not know the code,
        // so it must be prose rather than the code repeated.
        expect(r.message).not.toBe(r.code);
        expect(r.message.split(/\s+/).length).toBeGreaterThan(2);
    });

    it('an over-long name is FARM_NAME_TOO_LONG, with the bound in PARAMS', async () => {
        const r = await refusalOf({ name: 'x'.repeat(FARM_NAME_MAX + 1) });
        expect(r.code).toBe('FARM_NAME_TOO_LONG');
        // The bound travels in `params`, NOT interpolated into `message` — so a
        // client interpolates it into its own translated sentence rather than
        // receiving a half-localised English one. An earlier version of this
        // case asserted `message` contained the number, which is exactly the
        // usage the error module's `params` exists to replace.
        expect(r.params).toEqual({ max: FARM_NAME_MAX });
        expect(r.message).not.toContain(String(FARM_NAME_MAX));
    });

    it('an ЕГН is EIK_LOOKS_LIKE_EGN, distinct from an invalid ЕИК', async () => {
        // The distinction that matters to a farmer: "that is your personal
        // number" is actionable, "invalid" is not. Two codes, not one.
        const egn = await refusalOf({ name: 'Ферма', eik: anEgn() });
        const bad = await refusalOf({ name: 'Ферма', eik: '123456789' });
        expect(egn.code).toBe('EIK_LOOKS_LIKE_EGN');
        expect(bad.code).toBe('EIK_INVALID');
        expect(egn.code).not.toBe(bad.code);
    });

    it('control: the invalid-ЕИК fixture really is invalid', async () => {
        // Otherwise the case above would pass with the two codes swapped, or
        // with a fixture that happens to be valid and refused for some other
        // reason entirely.
        expect(isValidEik('123456789')).toBe(false);
        expect(looksLikeEgn('123456789')).toBe(false);
    });

    it('an unsluggable name is FARM_NAME_NOT_SLUGGABLE', async () => {
        const r = await refusalOf({ name: '!!! ???' });
        expect(r.code).toBe('FARM_NAME_NOT_SLUGGABLE');
    });

    it('every refusal is a 400 with a non-empty message', async () => {
        for (const input of [
            { name: '' },
            { name: 'x'.repeat(FARM_NAME_MAX + 1) },
            { name: 'Ферма', eik: anEgn() },
            { name: 'Ферма', eik: '123456789' },
            { name: '!!! ???' },
        ]) {
            const r = await refusalOf(input);
            expect(r.status).toBe(400);
            expect(r.message.length).toBeGreaterThan(0);
        }
    });
});
