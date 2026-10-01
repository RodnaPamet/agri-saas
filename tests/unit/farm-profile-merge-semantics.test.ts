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
        // All thirteen plus tenantId, so Prisma never sees a partial create.
        expect(Object.keys(create).length).toBe(14);
    });

    it('an empty body writes nothing and clears nothing', async () => {
        // The degenerate case, and the one most likely to be got wrong: a
        // caller who sends {} has said nothing about anything.
        await upsertFarmProfile(makeCtx(), {});
        // Only the lock's own bump. "Said nothing about anything" still means no
        // user field is written — `version` is the write itself being counted,
        // not a value the caller supplied.
        expect(lastUpdate()).toEqual({ version: { increment: 1 } });
    });
});
