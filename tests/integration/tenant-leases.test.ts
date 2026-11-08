/**
 * Tenant-wide lease register (Rent page, roadmap 3/3) — DB-backed integration.
 *
 * Validates the two functions the Rent page adds on top of the parcel-scoped
 * register: `listTenantLeases` (every lease across the tenant, with parcel +
 * location, optionally scoped to one location) and `listTenantParcelOptions`
 * (the create-modal parcel picker).
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
    createParcelLease,
    listTenantLeases,
    listTenantParcelOptions,
} from '@/app-layer/usecases/parcel-lease';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `tl-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let ownerId = '';
let locAId = '';
let locBId = '';
let parcelAId = '';

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
    const locA = await prisma.location.create({ data: { tenantId: TENANT_ID, name: `Block A ${TAG}` } });
    const locB = await prisma.location.create({ data: { tenantId: TENANT_ID, name: `Block B ${TAG}` } });
    locAId = locA.id;
    locBId = locB.id;
    const pA = await createParcel(ctx(), locAId, { name: 'TL-A1', geometry: square(0.01) });
    const pB = await createParcel(ctx(), locBId, { name: 'TL-B1', geometry: square(0.01) });
    parcelAId = pA.id;
    await createParcelLease(ctx(), pA.id, { lessorName: 'Ivan Petrov', kind: 'ARENDA', rentAmount: 55, rentUnit: '€/дка' });
    await createParcelLease(ctx(), pB.id, { lessorName: 'Maria Georgieva', kind: 'NAEM', rentAmount: 40, rentUnit: '€/дка' });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$disconnect();
});

describeFn('tenant-wide lease register', () => {
    test('listTenantLeases returns every lease with parcel + location', async () => {
        const leases = await listTenantLeases(ctx());
        expect(leases).toHaveLength(2);
        const a = leases.find((l) => l.lessorName === 'Ivan Petrov');
        expect(a).toBeDefined();
        expect(a!.parcel.name).toBe('TL-A1');
        expect(a!.parcel.location.name).toBe(`Block A ${TAG}`);
    });

    test('listTenantLeases scopes to one location', async () => {
        const onlyA = await listTenantLeases(ctx(), { locationId: locAId });
        expect(onlyA).toHaveLength(1);
        expect(onlyA[0].lessorName).toBe('Ivan Petrov');
        const onlyB = await listTenantLeases(ctx(), { locationId: locBId });
        expect(onlyB).toHaveLength(1);
        expect(onlyB[0].lessorName).toBe('Maria Georgieva');
    });

    test('listTenantParcelOptions lists every parcel with its location', async () => {
        const opts = await listTenantParcelOptions(ctx());
        expect(opts).toHaveLength(2);
        const a = opts.find((o) => o.id === parcelAId);
        expect(a).toBeDefined();
        expect(a!.name).toBe('TL-A1');
        expect(a!.locationId).toBe(locAId);
        expect(a!.locationName).toBe(`Block A ${TAG}`);
    });
});
