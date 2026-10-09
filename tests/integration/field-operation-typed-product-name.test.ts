/**
 * A typed product name resolves to the farm's own product, or creates it.
 *
 * Owner decision, 2026-10-09. The problem it solves, reported by agrent-ios:
 * 22 of 24 catalogue items on the owner's farm are seeded archetypes, so
 * "pick from the catalogue" is in practice "pick something that will be refused
 * at completion" (#1078) — and the refusal lands in the field, at the moment
 * the work is being filed, not when the plan was made.
 *
 * ## The two rulings this encodes
 *
 * **The regulatory fields travel in the same call.** A new PESTICIDE needs
 * `pppRegistrationNo` and `quarantinePeriodDays` — they print in ДНЕВНИК
 * columns 8–9 and produce the earliest-harvest date, so a ПРЗ without them
 * stores a row guaranteed to file badly. They are required only when the name
 * has to CREATE something, which is why they are not validated at the HTTP
 * boundary: whether they are needed depends on whether the name matched.
 *
 * **The category is enforced on both paths.** Previously the item lookup
 * checked only tenant and `deletedAt`, so a fertiliser's id passed as
 * `productItemId` was accepted and filed as a spray — while the usecase's own
 * comment asserted that "the kind is implicit in the Item's category".
 *
 * The rule enforced is the COMPLEMENT one the UI already applies
 * (`ParcelDetailSheet.tsx:172`): fertiliser ⇒ `FERTILIZER`, product ⇒ anything
 * that is not. Not `product ⇒ PESTICIDE`, which was the obvious reading and
 * would have rejected the lime, seed and fuel applications that picker offers
 * today.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createFieldOperation } from '@/app-layer/usecases/field-operation';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `fopname-${randomUUID().slice(0, 8)}`;

let userId = '';
let rateUnitId = '';
let baseUnitId = '';
let tenantId = '';
let locationId = '';
let parcelIds: string[] = [];
let pesticideId = '';
let fertilizerId = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    const user = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'FOp Name User' },
    });
    userId = user.id;

    // The rate key is tagged on its BASE segment — `l-<tag>-per-ha` — so
    // `baseUnitKeyOf` derives `l-<tag>`, which is created below. Using the
    // global `l` would depend on the seed having run and would make this suite
    // pass or fail on another test's setup. `Unit.key` is globally unique, so a
    // bare `l` could not be created here anyway.
    const base = await globalPrisma.unit.create({
        data: { key: `l-${TAG}`, name: 'Litre', symbol: 'L', measure: 'VOLUME' },
    });
    baseUnitId = base.id;
    const rate = await globalPrisma.unit.create({
        data: { key: `l-${TAG}-per-ha`, name: 'Litres per hectare', symbol: 'L/ha', measure: 'RATE' },
    });
    rateUnitId = rate.id;

    const tenant = await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const location = await globalPrisma.location.create({ data: { tenantId, name: `Loc ${TAG}` } });
    locationId = location.id;
    const p1 = await globalPrisma.parcel.create({ data: { tenantId, locationId, name: `P1 ${TAG}` } });
    parcelIds = [p1.id];

    const pesticide = await globalPrisma.item.create({
        data: {
            tenantId,
            name: `Карате Зеон ${TAG}`,
            category: 'PESTICIDE',
            defaultUnitId: baseUnitId,
            pppRegistrationNo: '0123-ПРЗ',
            quarantinePeriodDays: 14,
        },
    });
    pesticideId = pesticide.id;
    const fertilizer = await globalPrisma.item.create({
        data: { tenantId, name: `Амониев нитрат ${TAG}`, category: 'FERTILIZER', defaultUnitId: baseUnitId },
    });
    fertilizerId = fertilizer.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const table of ['OperationParcel', 'TaskLink', 'Task', 'Item', 'Parcel', 'Location']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, tenantId);
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = ANY($1::text[])`, [
            rateUnitId,
            baseUnitId,
        ]);
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId);
    } catch (e) {
        console.warn('[field-operation-typed-product-name] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

const spray = (over: Record<string, unknown> = {}) => ({
    assigneeUserId: userId,
    parcelIds,
    doseValue: 2,
    doseUnitId: rateUnitId,
    ...over,
});

async function itemsNamed(name: string) {
    return globalPrisma.item.findMany({
        where: { tenantId, name: { equals: name, mode: 'insensitive' }, deletedAt: null },
        select: { id: true, name: true, category: true, defaultUnitId: true, isArchetype: true },
    });
}

describeFn('a typed product name (DB-backed)', () => {
    it('matches an existing product CASE-INSENSITIVELY and does not duplicate it', async () => {
        // The unique index is on `(tenantId, lower(name)) WHERE deletedAt IS
        // NULL`, so a case-sensitive find would miss this, attempt a create, and
        // turn a successful match into a 409 for the operator. The find and the
        // constraint have to agree on what "same name" means.
        const typed = `карате зеон ${TAG}`.toUpperCase();

        await createFieldOperation(ctx(), locationId, spray({ productName: typed }));

        const rows = await itemsNamed(`Карате Зеон ${TAG}`);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(pesticideId);
    });

    it('creates the product when nothing matches, with the BASE unit as its default', async () => {
        const name = `Нов Продукт ${TAG}`;

        await createFieldOperation(
            ctx(),
            locationId,
            spray({
                productName: name,
                newProductRegistration: { pppRegistrationNo: '9999-ПРЗ', quarantinePeriodDays: 7 },
            }),
        );

        const rows = await itemsNamed(name);
        expect(rows).toHaveLength(1);
        expect(rows[0].category).toBe('PESTICIDE');
        // The dose unit is a RATE (`L/ha`). Storing it as the stock unit would
        // persist fine and read back as an inventory figure in litres per
        // hectare — so the Item must default to the derived base unit.
        expect(rows[0].defaultUnitId).toBe(baseUnitId);
        expect(rows[0].defaultUnitId).not.toBe(rateUnitId);
        // A product the operator created is not an archetype, which is the
        // whole point: #1078 refuses completing a line against one.
        expect(rows[0].isArchetype).toBe(false);
    });

    it('refuses to create a PESTICIDE without its regulatory fields', async () => {
        const name = `Без Регистрация ${TAG}`;

        await expect(
            createFieldOperation(ctx(), locationId, spray({ productName: name })),
        ).rejects.toMatchObject({ code: 'PESTICIDE_REGULATORY_FIELDS_REQUIRED' });

        // And nothing was written — a refusal that left a half-made product
        // would be worse than the refusal, because the next attempt would then
        // MATCH it and skip the check.
        expect(await itemsNamed(name)).toHaveLength(0);
    });

    it('creates a FERTILIZER from a name alone — no registration required', async () => {
        // `assertPesticideIsFilable` constrains PESTICIDE only, deliberately: a
        // fertiliser has no ЗЗР registration and demanding one would invent a
        // rule the product form does not have.
        const name = `Нов Тор ${TAG}`;

        await createFieldOperation(
            ctx(),
            locationId,
            spray({
                doseValue: undefined,
                doseUnitId: undefined,
                fertilizerName: name,
                fertilizerDoseValue: 100,
                fertilizerDoseUnitId: rateUnitId,
            }),
        );

        const rows = await itemsNamed(name);
        expect(rows).toHaveLength(1);
        expect(rows[0].category).toBe('FERTILIZER');
    });

    it("refuses a fertiliser's ID passed as productItemId", async () => {
        // The defect the category ruling closes. Before it, this was accepted
        // and filed as a SPRAY, with the Task's operationType saying one thing
        // and the Item's category another.
        await expect(
            createFieldOperation(ctx(), locationId, spray({ productItemId: fertilizerId })),
        ).rejects.toMatchObject({ code: 'PRODUCT_EXPECTED' });
    });

    it("refuses a pesticide's ID passed as fertilizerItemId", async () => {
        await expect(
            createFieldOperation(
                ctx(),
                locationId,
                spray({
                    doseValue: undefined,
                    doseUnitId: undefined,
                    fertilizerItemId: pesticideId,
                    fertilizerDoseValue: 100,
                    fertilizerDoseUnitId: rateUnitId,
                }),
            ),
        ).rejects.toMatchObject({ code: 'FERTILIZER_EXPECTED' });
    });

    it('refuses an id AND a name for the same kind', async () => {
        // Not a preference to resolve. Preferring one silently would make the
        // other field look honoured and send the operator's typed name nowhere.
        await expect(
            createFieldOperation(
                ctx(),
                locationId,
                spray({ productItemId: pesticideId, productName: `Нещо ${TAG}` }),
            ),
        ).rejects.toMatchObject({ code: 'OPERATION_INPUT_AMBIGUOUS' });
    });

    it('still refuses neither-kind and both-kinds', async () => {
        await expect(
            createFieldOperation(ctx(), locationId, spray()),
        ).rejects.toMatchObject({ code: 'OPERATION_INPUT_AMBIGUOUS' });

        await expect(
            createFieldOperation(
                ctx(),
                locationId,
                spray({
                    productName: `A ${TAG}`,
                    fertilizerName: `B ${TAG}`,
                    fertilizerDoseValue: 1,
                    fertilizerDoseUnitId: rateUnitId,
                }),
            ),
        ).rejects.toMatchObject({ code: 'OPERATION_INPUT_AMBIGUOUS' });
    });

    it('a typed name never resolves to an ARCHETYPE', async () => {
        // Raised by agrent-ios. The seeded «Generic …» products are still in
        // the table and still in the unique index, and #1078 refuses to
        // COMPLETE a line against one — ДНЕВНИК column 4 wants a trade name.
        // So resolving a typed name to an archetype would hand the operator a
        // job that cannot be filed, which is the exact failure free text was
        // introduced to remove.
        const archetype = await globalPrisma.item.create({
            data: {
                tenantId,
                name: `Generic Chlorothalonil ${TAG}`,
                category: 'PESTICIDE',
                defaultUnitId: baseUnitId,
                isArchetype: true,
                pppRegistrationNo: 'seeded',
                quarantinePeriodDays: 1,
            },
        });

        // Typing its exact name must NOT reuse it. The create then collides
        // with the archetype on `Item_tenantId_name_active_key`, which is a
        // comprehensible 409 rather than an uncompletable job.
        await expect(
            createFieldOperation(
                ctx(),
                locationId,
                spray({
                    productName: `Generic Chlorothalonil ${TAG}`,
                    newProductRegistration: { pppRegistrationNo: '1-ПРЗ', quarantinePeriodDays: 3 },
                }),
            ),
        ).rejects.toMatchObject({ code: 'ITEM_NAME_ALREADY_EXISTS' });

        // And the archetype was not touched — not reused, not soft-deleted.
        const still = await globalPrisma.item.findUnique({
            where: { id: archetype.id },
            select: { isArchetype: true, deletedAt: true },
        });
        expect(still).toMatchObject({ isArchetype: true, deletedAt: null });
    });

    it('control: the same name NOT marked archetype DOES resolve', async () => {
        // Otherwise the case above would pass for the wrong reason — a lookup
        // broken for every name would also "not resolve to an archetype".
        const real = await globalPrisma.item.create({
            data: {
                tenantId,
                name: `Истински Продукт ${TAG}`,
                category: 'PESTICIDE',
                defaultUnitId: baseUnitId,
                isArchetype: false,
                pppRegistrationNo: '2-ПРЗ',
                quarantinePeriodDays: 5,
            },
        });

        await createFieldOperation(
            ctx(),
            locationId,
            spray({ productName: `истински продукт ${TAG}`.toUpperCase() }),
        );

        // Reused, not duplicated.
        expect(await itemsNamed(`Истински Продукт ${TAG}`)).toHaveLength(1);
        expect((await itemsNamed(`Истински Продукт ${TAG}`))[0].id).toBe(real.id);
    });

    it('an existing NON-pesticide product is accepted on the product path', async () => {
        // The complement rule, and the reason it is not `product ⇒ PESTICIDE`.
        // `ParcelDetailSheet.tsx:172` filters that picker to
        // `category !== 'FERTILIZER'`, so an AMENDMENT — lime — is a product
        // the web offers today and must keep working.
        const lime = await globalPrisma.item.create({
            data: { tenantId, name: `Вар ${TAG}`, category: 'AMENDMENT', defaultUnitId: baseUnitId },
        });

        const result = await createFieldOperation(
            ctx(),
            locationId,
            spray({ productItemId: lime.id }),
        );

        expect(result).toBeDefined();
    });
});
