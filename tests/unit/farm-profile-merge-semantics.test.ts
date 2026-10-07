/**
 * An absent field is LEFT ALONE; only an explicit null clears it.
 *
 * ## The defect (#1176)
 *
 * `UpdateFarmProfileSchema` marks all thirteen fields `.optional()`, and
 * `upsertFarmProfile` mapped every one through a normaliser returning `null`
 * for `undefined`. So an ABSENT field was CLEARED:
 *
 *     PUT {"urn": "123"}
 *       -> urn set, and the other twelve NULLED, grainProduced emptied
 *
 * The schema read as a partial update and the usecase behaved as a full
 * replace. Nothing had hit it because the only caller is the web admin page,
 * which GETs the whole profile, holds all thirteen in React state, and PUTs
 * the complete object every time — so the replace semantics were invisible
 * from the one place they could be observed.
 *
 * The native iOS client was about to become the second caller, writing partial
 * bodies against a schema whose every field is optional. The owner's ruling
 * was merge semantics, including `grainProduced`: absent means unchanged, `[]`
 * means clear.
 *
 * ## What this file pins, and why each case is separate
 *
 * Three distinct instructions now share one field, and collapsing any two of
 * them is the bug:
 *
 *     absent         "I said nothing about this"     -> leave stored value
 *     explicit null  "this field is empty"           -> clear
 *     blank string   "this field is empty"           -> clear (as before)
 *
 * The discriminator is `Object.hasOwn`, which works because Zod's
 * `.optional()` omits an absent key rather than materialising it as
 * `undefined`. That is a property of the installed Zod, so the first control
 * below pins it: if a future Zod starts emitting `key: undefined`, merge
 * semantics silently reverts to replace semantics and every assertion about
 * "left alone" quietly becomes false.
 */

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

const mockDb: Record<string, unknown> = {};
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: unknown, cb: (db: unknown) => unknown) =>
            cb(mockDb),
        ),
    };
});

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (s: string) => {
        let prev: string;
        do {
            prev = s;
            s = s.replace(/<[^>]*>/g, '');
        } while (s !== prev);
        return s;
    },
    sanitizeRichTextHtml: (s: string) => s,
}));

import { z } from 'zod';

import { upsertFarmProfile } from '@/app-layer/usecases/farm-profile';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';

function makeCtx(): RequestContext {
    return {
        requestId: 'req-fp-merge',
        userId: 'user-1',
        tenantId: 'tenant-A',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

/** The `update` object the usecase handed Prisma on the last call. */
function lastUpdate(): Record<string, unknown> {
    const upsert = (mockDb.farmProfile as { upsert: jest.Mock }).upsert;
    expect(upsert).toHaveBeenCalled();
    return upsert.mock.calls.at(-1)?.[0].update as Record<string, unknown>;
}

/** The `create` object, for the no-prior-row path. */
function lastCreate(): Record<string, unknown> {
    const upsert = (mockDb.farmProfile as { upsert: jest.Mock }).upsert;
    expect(upsert).toHaveBeenCalled();
    return upsert.mock.calls.at(-1)?.[0].create as Record<string, unknown>;
}

beforeEach(() => {
    mockDb.farmProfile = {
        upsert: jest.fn().mockResolvedValue({ id: 'fp-1', tenantId: 'tenant-A' }),
        // The optimistic lock's no-op path READS when a body mentions nothing,
        // instead of writing a version bump for a request that changed nothing.
        findUnique: jest.fn().mockResolvedValue({ id: 'fp-1', tenantId: 'tenant-A', version: 1 }),
    };
});

describe('farm-profile merge semantics (#1176)', () => {
    it('control: the installed Zod OMITS an absent optional key', () => {
        // The whole mechanism rests on this. `Object.hasOwn` cannot separate
        // "said nothing" from "said undefined" if Zod materialises absent
        // optional keys — and if it ever starts to, this file's other
        // assertions would pass while the behaviour reverted to replace.
        const S = z
            .object({
                a: z.string().nullable().optional(),
                b: z.string().nullable().optional(),
            })
            .strip();
        const parsed = S.parse({ a: 'x' });
        expect(Object.keys(parsed)).toEqual(['a']);
        expect(Object.hasOwn(parsed, 'b')).toBe(false);
        // ...and an explicit null IS present, which is the other half.
        expect(Object.hasOwn(S.parse({ a: 'x', b: null }), 'b')).toBe(true);
    });

    it('an absent field is not in the update at all', async () => {
        // THE REGRESSION TEST. Under the old behaviour `update` carried all
        // thirteen keys with twelve nulls.
        await upsertFarmProfile(makeCtx(), { urn: '123' });

        const update = lastUpdate();
        // `version` is excluded from the USER-FIELD key set: the optimistic
        // lock bumps it on every write, so it is bookkeeping rather than
        // something the caller said. Excluding it cannot hide a merge
        // regression — its presence is asserted on the next line, and a user
        // field leaking in would still fail this.
        expect(Object.keys(update).filter((k) => k !== 'version')).toEqual(['urn']);
        expect(update.version).toEqual({ increment: 1 });
        expect(update.urn).toBe('123');
        // Named explicitly, because "not in the keys" and "present as null"
        // are the two states this change exists to separate.
        expect(Object.hasOwn(update, 'egn')).toBe(false);
        expect(Object.hasOwn(update, 'producerName')).toBe(false);
        expect(Object.hasOwn(update, 'sizeHa')).toBe(false);
        expect(Object.hasOwn(update, 'grainProduced')).toBe(false);
    });

    it('an explicit null DOES clear', async () => {
        await upsertFarmProfile(makeCtx(), { urn: '123', egn: null });

        const update = lastUpdate();
        expect(Object.hasOwn(update, 'egn')).toBe(true);
        expect(update.egn).toBeNull();
    });

    it('a blank string still clears, as it always did', async () => {
        await upsertFarmProfile(makeCtx(), { producerName: '   ' });

        expect(lastUpdate().producerName).toBeNull();
    });

    it('grainProduced: absent leaves it, [] clears it', async () => {
        await upsertFarmProfile(makeCtx(), { urn: '1' });
        expect(Object.hasOwn(lastUpdate(), 'grainProduced')).toBe(false);

        await upsertFarmProfile(makeCtx(), { grainProduced: [] });
        const cleared = lastUpdate();
        expect(Object.hasOwn(cleared, 'grainProduced')).toBe(true);
        expect(cleared.grainProduced).toEqual([]);

        // An explicit null is the same instruction as [].
        await upsertFarmProfile(makeCtx(), { grainProduced: null });
        expect(lastUpdate().grainProduced).toEqual([]);
    });

    it('sizeHa: absent leaves it, null clears it, and 0 is NOT null', async () => {
        await upsertFarmProfile(makeCtx(), { urn: '1' });
        expect(Object.hasOwn(lastUpdate(), 'sizeHa')).toBe(false);

        await upsertFarmProfile(makeCtx(), { sizeHa: null });
        expect(lastUpdate().sizeHa).toBeNull();

        // A farm nobody has measured and a farm of zero hectares are
        // different claims, and the server keeps them different.
        await upsertFarmProfile(makeCtx(), { sizeHa: 0 });
        expect(lastUpdate().sizeHa).toBe(0);
    });

    it('a negative sizeHa is still refused rather than stored', async () => {
        await upsertFarmProfile(makeCtx(), { sizeHa: -5 });
        expect(lastUpdate().sizeHa).toBeNull();
    });

    it('grainProduced is still de-duplicated with order preserved', async () => {
        await upsertFarmProfile(makeCtx(), {
            grainProduced: ['Пшеница', '  ', 'Слънчоглед', 'пшеница'],
        });
        // Case-insensitive de-dupe under bg, blanks dropped, FIRST spelling
        // and original order kept — a declaration, not a set.
        expect(lastUpdate().grainProduced).toEqual(['Пшеница', 'Слънчоглед']);
    });

    it('CREATE is the full shape — nothing to leave alone with no prior row', async () => {
        // Not an inconsistency with the above: on the create branch there is
        // no stored value, so a field the caller did not mention is genuinely
        // undeclared rather than unchanged.
        await upsertFarmProfile(makeCtx(), { urn: '123' });

        const create = lastCreate();
        expect(create.tenantId).toBe('tenant-A');
        expect(create.urn).toBe('123');
        expect(create.egn).toBeNull();
        expect(create.producerName).toBeNull();
        expect(create.sizeHa).toBeNull();
        expect(create.grainProduced).toEqual([]);
        // Twelve editable fields plus tenantId, so Prisma never sees a
        // partial create.
        //
        // 14 → 13 (#1352): `eik` left the create object with the rest of the
        // write path. A create must not accept it either, or the bypass would
        // simply move to the first write for a tenant — which is the one write
        // where "no prior row" means there is nothing to compare against. The
        // column takes its own default (null) and is set later by staff
        // verification (P3.9).
        expect(Object.keys(create).length).toBe(13);
        expect(create).not.toHaveProperty('eik');
    });

    it('an empty body writes nothing and clears nothing', async () => {
        // The degenerate case, and the one most likely to be got wrong: a
        // caller who sends {} has said nothing about anything.
        await upsertFarmProfile(makeCtx(), {});
        // Nothing is written AT ALL — not even the lock's version bump. `{}`
        // says nothing about anything, so the same rule that leaves an absent
        // field alone leaves the row alone. An earlier revision of the
        // optimistic lock bumped `version` here, which claimed the row changed,
        // logged an audit entry for a write that never happened, and
        // invalidated every other holder's If-Match token for a no-op.
        const upsert = (mockDb.farmProfile as { upsert: jest.Mock }).upsert;
        expect(upsert).not.toHaveBeenCalled();
    });
});

// ─── #1352 — `eik` is not tenant-writable, but an unchanged echo is fine ───

describe('eik is refused only when it would CHANGE (#1352)', () => {
    /** Point the stored row's `eik` at a value, for the comparison. */
    function stored(eik: string | null) {
        (mockDb.farmProfile as { findUnique: jest.Mock }).findUnique = jest
            .fn()
            .mockResolvedValue({ id: 'fp-1', tenantId: 'tenant-A', version: 1, eik });
    }

    it('an UNCHANGED eik echoed back is accepted', async () => {
        // The case that matters for real clients. The iOS editor PUTs all
        // thirteen fields on every save — this usecase's own docblock says so
        // — so refusing the KEY would 400 every farm-profile save from the
        // owner's phone with the number unchanged. That is what the first
        // version of this change did.
        stored('831641791');
        await expect(
            upsertFarmProfile(makeCtx(), { eik: '831641791', producerName: 'Иван' }),
        ).resolves.toBeDefined();
    });

    it('a CHANGED eik is refused', async () => {
        stored('831641791');
        await expect(
            upsertFarmProfile(makeCtx(), { eik: '175074752' }),
        ).rejects.toThrow(/FARM_PROFILE_EIK_NOT_EDITABLE/);
    });

    it('CLEARING a stored eik is refused too', async () => {
        // `null` is an attempt to write the field, and wiping a verified
        // identity is no more self-serviceable than setting one.
        stored('831641791');
        await expect(upsertFarmProfile(makeCtx(), { eik: null })).rejects.toThrow(
            /FARM_PROFILE_EIK_NOT_EDITABLE/,
        );
    });

    it('SETTING one on a profile that has none is refused', async () => {
        // The original bypass: a farm self-asserting a company number with no
        // claim and no review.
        stored(null);
        await expect(
            upsertFarmProfile(makeCtx(), { eik: '831641791' }),
        ).rejects.toThrow(/FARM_PROFILE_EIK_NOT_EDITABLE/);
    });

    it('and `eik` never reaches the write object, even when it matched', async () => {
        stored('831641791');
        await upsertFarmProfile(makeCtx(), { eik: '831641791', producerName: 'Иван' });
        // Accepting the echo must not become writing it. The field is absent
        // from both write lists, so a matching value is a no-op rather than a
        // permitted write.
        expect(lastUpdate()).not.toHaveProperty('eik');
    });
});
