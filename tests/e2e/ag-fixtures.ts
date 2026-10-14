/**
 * Shared ag E2E seeding helpers — the HTTP/Prisma twin of
 * `prisma/fixtures/ag-demo.ts`.
 *
 * The in-process `seedAgDemo` (used by the ag integration tests + dev
 * seed) drives the usecases directly. Playwright specs can't cleanly
 * import the `@/`-aliased app layer into the browser-test runner, so the
 * ag E2E suite seeds the SAME shapes through the authenticated HTTP API
 * (and raw Prisma for the two entities without a create-API: catalog
 * Items + global Units). Every ag-*.spec.ts references these helpers so
 * the seed surface stays in one place.
 *
 * All helpers take the cookie-authenticated `authedPage.request` context
 * (`APIRequestContext`) and the URL `slug`; the Item/Unit helpers take a
 * Prisma client (open one with `agPrisma()`, always `$disconnect()` it).
 */
import type { APIRequestContext } from '@playwright/test';
import { expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/** A fresh Prisma client against the test DB (caller must $disconnect). */
export function agPrisma(): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
}

/** A small valid WGS84 square polygon at the given lon/lat origin. */
export function square(ox: number, oy: number, size = 0.01) {
    return {
        type: 'Polygon' as const,
        coordinates: [[[ox, oy], [ox + size, oy], [ox + size, oy + size], [ox, oy + size], [ox, oy]]],
    };
}

async function postOk(api: APIRequestContext, url: string, data: unknown, label: string) {
    const res = await api.post(url, { data });
    expect(res.ok(), `${label} (${res.status()}): ${await res.text().catch(() => '')}`).toBeTruthy();
    return res.json();
}

/** Create a Location (field). */
export async function createField(api: APIRequestContext, slug: string, name: string): Promise<string> {
    const body = await postOk(api, `/api/t/${slug}/locations`, { name }, `create field ${name}`);
    return body.id as string;
}

/** Add a parcel (with geometry) to a field. */
export async function addParcel(
    api: APIRequestContext,
    slug: string,
    locationId: string,
    name: string,
    ox: number,
    oy: number,
): Promise<string> {
    const body = await postOk(
        api,
        `/api/t/${slug}/locations/${locationId}/parcels`,
        { name, geometry: square(ox, oy) },
        `add parcel ${name}`,
    );
    return body.id as string;
}

/** Resolve the global dose/stock units by canonical key (seeded by import-units). */
export async function resolveUnits(prisma: PrismaClient): Promise<{ lPerHa: string; litre: string; kg: string }> {
    const [lPerHa, litre, kg] = await Promise.all([
        prisma.unit.findUnique({ where: { key: 'l-per-ha' }, select: { id: true } }),
        prisma.unit.findUnique({ where: { key: 'l' }, select: { id: true } }),
        prisma.unit.findUnique({ where: { key: 'kg' }, select: { id: true } }),
    ]);
    const anyUnit = await prisma.unit.findFirst({ select: { id: true } });
    if (!anyUnit) throw new Error('no global Unit seeded — run import-units / prisma seed');
    return {
        lPerHa: lPerHa?.id ?? anyUnit.id,
        litre: litre?.id ?? anyUnit.id,
        kg: kg?.id ?? anyUnit.id,
    };
}

/** Create a catalog product (Item has no create-API; seed via Prisma). */
export async function createProduct(
    prisma: PrismaClient,
    tenantId: string,
    name: string,
    defaultUnitId: string,
    category: 'PESTICIDE' | 'FERTILIZER' | 'AMENDMENT' = 'PESTICIDE',
    reorderLevel?: number,
): Promise<string> {
    const item = await prisma.item.create({
        data: { tenantId, name, category, defaultUnitId, reorderLevel: reorderLevel ?? null },
        select: { id: true },
    });
    return item.id;
}

/**
 * The minimum farm a TREATMENT can be recorded against (#1740): one field,
 * one parcel carrying a crop, and one product priced in a dose unit.
 *
 * The crop is set through Prisma because `addParcel` does not take one, and
 * step two of the treatment form groups parcels BY crop — a parcel with no
 * crop appears in no crop's list, so a spec that forgets this finds an empty
 * picker and no way to continue.
 */
export async function seedTreatmentBasics(
    api: APIRequestContext,
    prisma: PrismaClient,
    tenantId: string,
    slug: string,
    opts: { product: string; crop?: string } = { product: 'Aphid spray' },
): Promise<{ product: string; crop: string; parcelId: string; locationId: string }> {
    const crop = opts.crop ?? 'Wheat';
    const locationId = await createField(api, slug, `Block ${crop}`);
    const parcelId = await addParcel(api, slug, locationId, '1', 0, 0);
    await prisma.parcel.update({ where: { id: parcelId }, data: { cropType: crop } });
    const units = await resolveUnits(prisma);
    await createProduct(prisma, tenantId, opts.product, units.lPerHa);
    return { product: opts.product, crop, parcelId, locationId };
}

/** Create an inventory lot with opening stock (RECEIPT). */
export async function createLot(
    api: APIRequestContext,
    slug: string,
    itemId: string,
    lotCode: string,
    initialQuantity: number,
): Promise<string> {
    const body = await postOk(
        api,
        `/api/t/${slug}/inventory/lots`,
        { itemId, lotCode, initialQuantity },
        `create lot ${lotCode}`,
    );
    return body.id as string;
}

/** Create a SPRAY field-operation job over the given parcels. */
export async function createSprayJob(
    api: APIRequestContext,
    slug: string,
    locationId: string,
    input: { assigneeUserId: string; parcelIds: string[]; productItemId: string; doseValue: number; doseUnitId: string },
): Promise<string> {
    const body = await postOk(
        api,
        `/api/t/${slug}/locations/${locationId}/operations`,
        { operationType: 'SPRAY', ...input },
        'create spray job',
    );
    return body.taskId as string;
}

export interface SprayScenario {
    locationId: string;
    parcelIds: string[];
    productItemId: string;
    lotId: string;
    taskId: string;
    units: { lPerHa: string; litre: string; kg: string };
    doseValue: number;
}

/**
 * Seed a complete spray scenario the financial/regulatory paths assert
 * against: one field, three parcels, one pesticide product with an
 * opening-stock lot, and one SPRAY job (dose in L/ha) over the parcels.
 * Mirrors a single field of the `ag-demo` fixture.
 */
export async function seedSprayScenario(
    api: APIRequestContext,
    prisma: PrismaClient,
    slug: string,
    tenantId: string,
    assigneeUserId: string,
    opts: { dose?: number; opening?: number; lotCode?: string } = {},
): Promise<SprayScenario> {
    const units = await resolveUnits(prisma);
    const locationId = await createField(api, slug, 'North Farm');
    const parcelIds = [
        await addParcel(api, slug, locationId, 'North 40', 0, 0),
        await addParcel(api, slug, locationId, 'North 41', 0.012, 0),
        await addParcel(api, slug, locationId, 'North 42', 0.024, 0),
    ];
    const productItemId = await createProduct(prisma, tenantId, 'Glyphosate 360 SL', units.litre, 'PESTICIDE', 50);
    const lotId = await createLot(api, slug, productItemId, opts.lotCode ?? 'GLY-2026-01', opts.opening ?? 1000);
    const dose = opts.dose ?? 2;
    const taskId = await createSprayJob(api, slug, locationId, {
        assigneeUserId,
        parcelIds,
        productItemId,
        doseValue: dose,
        doseUnitId: units.lPerHa,
    });
    return { locationId, parcelIds, productItemId, lotId, taskId, units, doseValue: dose };
}
