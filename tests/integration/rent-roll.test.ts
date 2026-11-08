/**
 * Rent roll (roadmap 3/3) — DB-backed integration.
 *
 * Validates the tenant aggregation over the lease register: leased area, rent
 * per lessor (rentAmount × dca), and the expiry scan. Also satisfies the
 * usecase-test-coverage ratchet by importing `@/app-layer/usecases/rent-roll`.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import type { Polygon } from 'geojson';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createParcel } from '@/app-layer/usecases/parcel';
import { createParcelLease } from '@/app-layer/usecases/parcel-lease';
import { getRentRoll } from '@/app-layer/usecases/rent-roll';
import { recordLeasePayment, listLeasePayments } from '@/app-layer/usecases/lease-payment';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `rr-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let ownerId = '';
let locationId = '';
let leaseIdMoney = '';

const ctx = () => makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });
function square(size: number): Polygon {
    return { type: 'Polygon', coordinates: [[[0, 0], [0, size], [size, size], [size, 0], [0, 0]]] };
}
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: TENANT_ID, slug: TAG } });
    const u = await prisma.user.create({ data: { email: `${TAG}@example.test`, emailHash: hashForLookup(`${TAG}@example.test`) } });
    ownerId = u.id;
    await prisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
    const loc = await prisma.location.create({ data: { tenantId: TENANT_ID, name: `Block ${TAG}` } });
    locationId = loc.id;
    const p1 = await createParcel(ctx(), locationId, { name: 'RR-1', geometry: square(0.01) });
    const p2 = await createParcel(ctx(), locationId, { name: 'RR-2', geometry: square(0.01) });
    const p3 = await createParcel(ctx(), locationId, { name: 'RR-3', geometry: square(0.01) });
    // Priced lease ending soon (in the expiry window) + a second for the same lessor.
    const l1 = await createParcelLease(ctx(), p1.id, { lessorName: 'Агро ЕООД', lessorEik: '203045511', kind: 'ARENDA', rentAmount: 60, rentUnit: '€/дка', endDate: inDays(20) });
    await createParcelLease(ctx(), p2.id, { lessorName: 'Агро ЕООД', lessorEik: '203045511', kind: 'ARENDA', rentAmount: 60, rentUnit: '€/дка', endDate: inDays(400) });
    // MIXED UNIT — the SAME lessor also rents a parcel for grain, not money.
    // The roll must never blend this into the лв figure.
    await createParcelLease(ctx(), p3.id, { lessorName: 'Агро ЕООД', lessorEik: '203045511', kind: 'ARENDA', rentAmount: 80, rentUnit: 'кг/дка', endDate: inDays(400) });
    leaseIdMoney = l1.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$disconnect();
});

describeFn('rent roll aggregation', () => {
    test('aggregates leased area + rent by lessor', async () => {
        const rr = await getRentRoll(ctx(), { expiringWithinDays: 60 });
        // One LESSOR, but three leases across two units.
        expect(rr.lessorCount).toBe(1);
        expect(rr.activeLeaseCount).toBe(3);
        expect(rr.totalLeasedDca).toBeGreaterThan(0);
        // Rows are per (lessor × unit) — the money row holds only the лв leases.
        const money = rr.byLessor.find((l) => l.rentUnit === '€/дка');
        const kg = rr.byLessor.find((l) => l.rentUnit === 'кг/дка');
        expect(money).toBeDefined();
        expect(kg).toBeDefined();
        expect(money!.leaseCount).toBe(2);
        expect(kg!.leaseCount).toBe(1);
        expect(money!.rentTotal).toBeGreaterThan(0);
        expect(kg!.rentTotal).toBeGreaterThan(0);
    });

    test('never blends кг into money — totals are per unit', async () => {
        const rr = await getRentRoll(ctx());
        const units = rr.totals.map((t) => t.unit).sort();
        // `€/дка` since #2793: the lease fixtures moved off `лв/дка`, which
        // the write path now refuses. The property is unchanged — a mass and
        // a currency are different dimensions and never share a total.
        expect(units).toEqual(['кг/дка', '€/дка']);
        const money = rr.totals.find((t) => t.unit === '€/дка')!;
        const kg = rr.totals.find((t) => t.unit === 'кг/дка')!;
        // Each unit's total equals the sum of ITS OWN rows, nothing else.
        const sumFor = (u: string) =>
            rr.byLessor.filter((l) => l.rentUnit === u).reduce((s, l) => s + (l.rentTotal ?? 0), 0);
        expect(money.total).toBeCloseTo(sumFor('€/дка'), 6);
        expect(kg.total).toBeCloseTo(sumFor('кг/дка'), 6);
        expect(money.total).not.toBeCloseTo(money.total + kg.total, 6);
    });

    test('payments settle against the roll as paid/outstanding', async () => {
        const season = new Date().getUTCFullYear();
        const before = await getRentRoll(ctx(), { seasonYear: season });
        const moneyBefore = before.totals.find((t) => t.unit === '€/дка')!;
        expect(moneyBefore.paid).toBe(0);
        expect(moneyBefore.outstanding).toBeCloseTo(moneyBefore.total, 6);

        await recordLeasePayment(ctx(), leaseIdMoney, { seasonYear: season, amountPaid: 100 });
        expect(await listLeasePayments(ctx(), leaseIdMoney)).toHaveLength(1);

        const after = await getRentRoll(ctx(), { seasonYear: season });
        const moneyAfter = after.totals.find((t) => t.unit === '€/дка')!;
        expect(moneyAfter.paid).toBeCloseTo(100, 6);
        expect(moneyAfter.outstanding).toBeCloseTo(moneyAfter.total - 100, 6);
        // The grain books are untouched by a money payment.
        const kgAfter = after.totals.find((t) => t.unit === 'кг/дка')!;
        expect(kgAfter.paid).toBe(0);
    });

    test('lists contracts expiring within the window', async () => {
        const rr = await getRentRoll(ctx(), { expiringWithinDays: 60 });
        // only the lease ending in ~20 days is within 60; the 400-day one is not.
        expect(rr.expiringSoon).toHaveLength(1);
        expect(rr.expiringSoon[0].daysLeft).toBeGreaterThan(0);
        expect(rr.expiringSoon[0].daysLeft).toBeLessThanOrEqual(60);
    });

    test('scopes to a location when locationId is given', async () => {
        const rr = await getRentRoll(ctx(), { locationId });
        expect(rr.activeLeaseCount).toBe(3);
        const other = await getRentRoll(ctx(), { locationId: 'nonexistent-location' });
        expect(other.activeLeaseCount).toBe(0);
    });

    /*
     * The #2793 refusal, on the PAYMENT path.
     *
     * A payment's unit defaults to the lease's own, so there are two questions
     * here and they get opposite answers. `lease-payment.ts` carries the
     * reasoning; these are the two directions.
     */
    test('refuses a TYPED lev payment unit, and still books the LEASE\'s own one', async () => {
        const season = new Date().getUTCFullYear();

        // Typing лв/дка on a euro lease is refused by the same function the
        // lease write path uses — a payment must not be bookable in a unit no
        // lease could be written in.
        const err = await recordLeasePayment(ctx(), leaseIdMoney, {
            seasonYear: season,
            amountPaid: 50,
            unit: 'лв/дка',
        }).then(() => null, (e: unknown) => e as { code?: string; params?: Record<string, unknown> });
        expect(err?.code).toBe('LEASE_RENT_UNIT_NOT_EUR');
        expect(err?.params).toMatchObject({ unit: 'лв/дка', expected: '€/дка' });

        // A LEGACY lev lease stays payable, because the obligation is still
        // owed and the default comes from the row rather than from input.
        // Refusing here would lose a real settlement to a currency rule and
        // leave the lessor reported unpaid for ever. Written directly through
        // Prisma: the usecase refuses this shape, which is the point.
        const legacy = await prisma.parcelLease.create({
            data: {
                tenantId: TENANT_ID,
                parcelId: (await prisma.parcelLease.findFirstOrThrow({
                    where: { id: leaseIdMoney },
                    select: { parcelId: true },
                })).parcelId,
                lessorName: 'Стар Лев ЕООД',
                kind: 'ARENDA',
                rentAmount: 60,
                rentUnit: 'лв/дка',
                rentUnitRaw: 'лв/дка',
            },
            select: { id: true },
        });
        const paid = await recordLeasePayment(ctx(), legacy.id, {
            seasonYear: season,
            amountPaid: 120,
        });
        expect(paid.unit).toBe('лв/дка');

        // And restating that unit explicitly is accepted too, for the same
        // reason the lease update path accepts it: an unchanged value is not a
        // change, and a prefilled form posts what it was given.
        const again = await recordLeasePayment(ctx(), legacy.id, {
            seasonYear: season,
            amountPaid: 30,
            unit: 'лв/дка',
        });
        expect(again.unit).toBe('лв/дка');

        await prisma.parcelLease.update({ where: { id: legacy.id }, data: { deletedAt: new Date() } });
    });
});
