/**
 * Parcel lease register (roadmap 2/3) — DB-backed integration (RLS).
 *
 * Covers the аренда/наем CRUD usecase: create → list → update → soft-delete,
 * tenant-scoped. Also satisfies the usecase-test-coverage ratchet by importing
 * via the canonical `@/app-layer/usecases/parcel-lease`.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import type { Polygon } from 'geojson';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createParcel } from '@/app-layer/usecases/parcel';
import {
    listParcelLeases,
    createParcelLease,
    updateParcelLease,
    deleteParcelLease,
} from '@/app-layer/usecases/parcel-lease';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `lease-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let ownerId = '';
let locationId = '';
let parcelId = '';

const ctx = () => makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });
function square(size: number): Polygon {
    return { type: 'Polygon', coordinates: [[[0, 0], [0, size], [size, size], [size, 0], [0, 0]]] };
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: TENANT_ID, slug: TAG } });
    const u = await prisma.user.create({ data: { email: `${TAG}@example.test`, emailHash: hashForLookup(`${TAG}@example.test`) } });
    ownerId = u.id;
    await prisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
    const loc = await prisma.location.create({ data: { tenantId: TENANT_ID, name: `Block ${TAG}` } });
    locationId = loc.id;
    const p = await createParcel(ctx(), locationId, { name: 'Lease parcel', geometry: square(0.01) });
    parcelId = p.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$disconnect();
});

describeFn('parcel lease register (RLS)', () => {
    let leaseId = '';

    test('creates + lists a lease', async () => {
        const lease = await createParcelLease(ctx(), parcelId, {
            lessorName: 'Агро ЕООД',
            lessorEik: '203045511',
            kind: 'ARENDA',
            rentAmount: 60,
            rentUnit: '€/дка',
            startDate: '2026-01-01',
            endDate: '2031-01-01',
        });
        leaseId = lease.id;
        expect(lease.lessorName).toBe('Агро ЕООД');
        expect(lease.kind).toBe('ARENDA');

        const leases = await listParcelLeases(ctx(), parcelId);
        expect(leases).toHaveLength(1);
        expect(String(leases[0].rentAmount)).toBe('60');
        expect(leases[0].lessorEik).toBe('203045511');
    });

    test('updates a lease (аренда → наем, new rent)', async () => {
        const updated = await updateParcelLease(ctx(), leaseId, {
            lessorName: 'Агро ЕООД',
            kind: 'NAEM',
            rentAmount: 75,
            rentUnit: '€/дка',
        });
        expect(updated.kind).toBe('NAEM');
        expect(String(updated.rentAmount)).toBe('75');
    });

    test('soft-deletes a lease (drops from the list)', async () => {
        await deleteParcelLease(ctx(), leaseId);
        expect(await listParcelLeases(ctx(), parcelId)).toHaveLength(0);
    });

    test('rejects an empty lessor name', async () => {
        await expect(
            createParcelLease(ctx(), parcelId, { lessorName: '   ', kind: 'ARENDA' }),
        ).rejects.toThrow(/lessor/i);
    });
});

/*
 * The #2793 rent-unit refusal.
 *
 * The lev peg is gone, so a `лв/дка` lease has no honest per-hectare figure
 * anywhere in the product (`resolveRentBasis` reports it unresolved). Refusing
 * it at the WRITE is what stops a lease saving, listing, and then being
 * excluded from every cost figure with nobody told why.
 *
 * Three properties, and the second and third are what keep the refusal from
 * being a trap rather than a rule.
 */
describeFn('parcel lease — a lev rent unit is refused on write (#2793)', () => {
    const levInput = {
        lessorName: 'Лев ЕООД',
        kind: 'ARENDA' as const,
        rentAmount: 60,
        rentUnit: 'лв/дка',
    };

    test('refuses a лв/дка rent on CREATE, with the coded refusal and its params', async () => {
        const err = await createParcelLease(ctx(), parcelId, levInput).then(
            () => null,
            (e: unknown) => e as { code?: string; params?: Record<string, unknown>; status?: number },
        );
        // Asserted as a captured error rather than `rejects.toThrow(/…/)`: the
        // MESSAGE is server prose the client replaces with its own copy, so
        // the code and the params are the contract. `expected` is what the
        // form needs to offer, and a refusal naming no alternative leaves the
        // operator guessing.
        expect(err).not.toBeNull();
        expect(err?.code).toBe('LEASE_RENT_UNIT_NOT_EUR');
        expect(err?.params).toMatchObject({ unit: 'лв/дка', currency: 'BGN', expected: '€/дка' });
    });

    test('refuses a lev ALIAS too, not only the canonical spelling', async () => {
        // The refusal is keyed on the CANONICAL unit, so every alias
        // `canonicalRentUnit` folds onto `лв/дка` is covered by construction —
        // which is the reason it is not a string comparison on the raw text.
        // `rentUnitRaw` preserves what was typed, so `params.unit` reports it.
        for (const typed of ['lv/dka', 'ЛВ / ДКА', 'лв./дка']) {
            const err = await createParcelLease(ctx(), parcelId, { ...levInput, rentUnit: typed }).then(
                () => null,
                (e: unknown) => e as { code?: string; params?: Record<string, unknown> },
            );
            expect({ typed, code: err?.code, unit: err?.params?.unit })
                .toEqual({ typed, code: 'LEASE_RENT_UNIT_NOT_EUR', unit: typed });
        }
    });

    test('ACCEPTS €/дка and кг/дка — the refusal is not a ban on the field', async () => {
        // The positive control, and it is doing real work: a refusal that
        // fired on every unit would pass both cases above while making the
        // lease register unusable. `кг/дка` is here because produce rent has
        // no currency at all and must never be judged by a currency rule.
        for (const unit of ['€/дка', 'кг/дка', 'eur/dka', 'кг./дка']) {
            const lease = await createParcelLease(ctx(), parcelId, { ...levInput, rentUnit: unit });
            expect({ unit, saved: lease.rentUnitRaw }).toEqual({ unit, saved: unit });
            await deleteParcelLease(ctx(), lease.id);
        }
    });

    test('a LEGACY lev lease still edits, as long as its unit is not changed', async () => {
        // The half that makes this safe to ship, and it mirrors
        // `COST_ENTRY_LEGACY_CURRENCY_LOCKED` exactly: restating a row's own
        // value verbatim is not a change. The form posts every field, so an
        // operator correcting the LESSOR'S NAME resubmits the stored `лв/дка`
        // — and a flat check would refuse that edit, leaving a legacy lease
        // permanently uncorrectable.
        //
        // Written DIRECTLY through Prisma because the usecase now refuses this
        // shape: there is no way to create the row the test needs through the
        // API, which is the point. Production has 0 leases (measured
        // 2026-11-06), so this row exists nowhere but here.
        const legacy = await prisma.parcelLease.create({
            data: {
                tenantId: TENANT_ID,
                parcelId,
                lessorName: 'Стар Лев ЕООД',
                kind: 'ARENDA',
                rentAmount: 60,
                rentUnit: 'лв/дка',
                rentUnitRaw: 'лв/дка',
            },
            select: { id: true },
        });

        const updated = await updateParcelLease(ctx(), legacy.id, {
            lessorName: 'Нов Лев ЕООД',
            kind: 'ARENDA',
            rentAmount: 60,
            rentUnit: 'лв/дка',
        });
        expect(updated.lessorName).toBe('Нов Лев ЕООД');
        expect(updated.rentUnit).toBe('лв/дка');

        // The way OUT is `€/дка`, and it is accepted — so the exemption is a
        // grandfather clause rather than a dead end.
        const toEuro = await updateParcelLease(ctx(), legacy.id, {
            lessorName: 'Нов Лев ЕООД',
            kind: 'ARENDA',
            rentAmount: 30,
            rentUnit: '€/дка',
        });
        expect(toEuro.rentUnit).toBe('€/дка');

        // And the door shuts behind it: the exemption is keyed on the row's
        // OWN stored unit, so the same lease can no longer be moved BACK to
        // lev. This is what stops "legacy" being a hole — without it, any
        // lease could reach `лв/дка` in two edits.
        const err = await updateParcelLease(ctx(), legacy.id, {
            lessorName: 'Нов Лев ЕООД',
            kind: 'ARENDA',
            rentAmount: 30,
            rentUnit: 'лв/дка',
        }).then(() => null, (e: unknown) => e as { code?: string });
        expect(err?.code).toBe('LEASE_RENT_UNIT_NOT_EUR');

        await deleteParcelLease(ctx(), legacy.id);
    });
});
