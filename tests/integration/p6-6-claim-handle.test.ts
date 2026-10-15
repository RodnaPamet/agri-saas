/**
 * P6.6 (#1815) — claiming the public address, against a real database.
 *
 * The collision path is the reason this is an integration test rather than a
 * unit one. The owner ruling is refuse-with-suggestions, and the refusal is
 * raised by the GLOBAL unique index on `FarmBrand.handle` — a pre-check
 * cannot be authoritative because two owners can ask in the same second. So
 * the behaviour under test only exists when a second tenant genuinely holds
 * the name, which no mock can produce honestly.
 *
 * Per-test tenants throughout. `FarmBrand.tenantId` is `@unique`, so a shared
 * tenant pair makes the suite order-dependent — and worse, a collision test
 * written against a shared tenant can pass by hitting the WRONG unique
 * constraint. An earlier test of mine asserted `/Unique constraint|23505/`,
 * which a `tenantId` violation satisfies exactly as well as a `handle` one,
 * and so passed while proving nothing. Here the assertion is on the refusal
 * CODE, which only the handle index produces.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    claimFarmBrandHandle,
    readPublicFarmProfile,
    projectFarmBrand,
} from '@/app-layer/usecases/public-farm-profile';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeIfDb = DB_AVAILABLE ? describe : describe.skip;

describeIfDb('claimFarmBrandHandle', () => {
    const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
    const createdTenants: string[] = [];
    const createdHandles: string[] = [];

    const uniqueHandle = () => `t${randomUUID().slice(0, 8).replace(/-/g, '')}`;

    beforeAll(async () => {
        await globalPrisma.$connect();
    });

    afterAll(async () => {
        if (createdHandles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({
                where: { handle: { in: createdHandles } },
            });
        }
        // Brands too. The handle namespace is GLOBAL and `@unique`, so a
        // suite that leaves its brands behind quietly reserves names for
        // every future run. The tenants themselves stay — `AuditLog` has an
        // ON DELETE RESTRICT reference to them and this suite writes audit
        // rows — but nothing restricts deleting the brand.
        if (createdTenants.length > 0) {
            await globalPrisma.farmBrand.deleteMany({
                where: { tenantId: { in: createdTenants } },
            });
        }
        // Tenants STAY — the audit log is immutable by trigger and
        // `AuditLog_tenantId_fkey` is ON DELETE RESTRICT, so a suite writing
        // through a tenant context cannot delete its own. Ids are per-run.
        await globalPrisma.$disconnect();
    });

    /** A farm with a brand row. `handle: null` unless one is given. */
    async function aFarm(
        over: Partial<{
            handle: string | null;
            published: boolean;
            oblast: string | null;
            displayName: string | null;
            withBrand: boolean;
        }> = {},
    ) {
        const tenantId = `ch-${randomUUID().slice(0, 8)}`;
        createdTenants.push(tenantId);
        await globalPrisma.tenant.create({
            data: { id: tenantId, name: 'Избор на адрес', slug: tenantId },
        });

        const handle = over.handle ?? null;
        if (handle) createdHandles.push(handle);

        if (over.withBrand !== false) {
            await globalPrisma.farmBrand.create({
                data: {
                    id: `fb-${randomUUID()}`,
                    tenantId,
                    handle,
                    displayName: over.displayName === undefined ? 'Стопанство Победа' : over.displayName,
                    oblast: over.oblast === undefined ? 'Добрич' : over.oblast,
                    crops: ['пшеница'],
                    published: over.published ?? false,
                    consentedAt: new Date(),
                    consentTextVersion: 'v1',
                },
            });
        }

        return {
            tenantId,
            ctx: makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` }),
        };
    }

    async function caught(fn: () => Promise<unknown>): Promise<{ code?: string; details?: unknown }> {
        try {
            await fn();
        } catch (e) {
            return e as { code?: string; details?: unknown };
        }
        throw new Error('expected a refusal, got none');
    }

    it('claims a free address and NORMALISES it', async () => {
        const farm = await aFarm();
        // The suffix is per-run, and that is not decoration. `FarmBrand` rows
        // outlive this suite — the tenants cannot be deleted, so neither are
        // their brands — and a FIXED input would be claimed permanently by
        // the first run and collide on every one after it. The first version
        // of this test used a literal `Победа-Тест` and passed exactly once.
        const suffix = randomUUID().slice(0, 8).replace(/-/g, '');
        const result = await claimFarmBrandHandle(farm.ctx, `Победа-${suffix}`);

        // Transliterated and lower-cased. The owner typed Cyrillic; the URL
        // is ASCII, and `normalised` is how the editor can say so.
        expect(result.handle).toBe(`pobeda-${suffix.toLowerCase()}`);
        expect(result.normalised).toBe(true);
        expect(result.reprojected).toBe(false);
        createdHandles.push(result.handle);

        const row = await globalPrisma.farmBrand.findFirst({
            where: { tenantId: farm.tenantId },
            select: { handle: true },
        });
        // The STORED value is the normalised one, which is the whole point:
        // the `@unique` index is case-sensitive and the public reader
        // lower-cases, so storing the raw input would make `Pobeda` a
        // reservation that serves nothing.
        expect(row?.handle).toBe(result.handle);
    });

    it('is idempotent — re-submitting the address you hold is a success', async () => {
        const mine = uniqueHandle();
        const farm = await aFarm({ handle: mine });

        const again = await claimFarmBrandHandle(farm.ctx, mine);
        expect(again.handle).toBe(mine);
        expect(again.reprojected).toBe(false);
    });

    it('REFUSES an address another farm holds, with derived suggestions', async () => {
        const contested = uniqueHandle();
        await aFarm({ handle: contested });

        // A second farm in the same oblast wants the same name.
        const second = await aFarm({ oblast: 'Добрич' });
        const err = await caught(() => claimFarmBrandHandle(second.ctx, contested));

        expect(err.code).toBe('FARM_HANDLE_TAKEN');
        const suggestions = (err.details as { suggestions?: string[] })?.suggestions ?? [];
        // Derived from what the farm already declared, per the ruling:
        // `-dobrich` is the transliterated oblast. `pobeda-2` is what the
        // ruling refused, so no suggestion is a bare counter.
        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions.some((s) => s.endsWith('-dobrich'))).toBe(true);
        for (const s of suggestions) expect(s).not.toMatch(/-\d+$/);
    });

    it('a refusal does not poison the connection — the next claim succeeds', async () => {
        // This is the test for the one design decision that is easy to get
        // wrong. `runInTenantContext` opens an interactive transaction, and a
        // thrown P2002 aborts it in PostgreSQL; a caught JS error does not
        // un-poison an aborted PG transaction. So the catch is OUTSIDE the
        // transaction and the suggestions come from a fresh query. If that
        // were done inside, this second call would fail on a dead transaction
        // and the suite above would still have passed.
        const contested = uniqueHandle();
        await aFarm({ handle: contested });
        const second = await aFarm();

        await caught(() => claimFarmBrandHandle(second.ctx, contested));

        const free = uniqueHandle();
        const ok = await claimFarmBrandHandle(second.ctx, free);
        expect(ok.handle).toBe(free);
        createdHandles.push(free);
    });

    it('refuses a reserved address, including its Cyrillic spelling', async () => {
        const farm = await aFarm();
        expect((await caught(() => claimFarmBrandHandle(farm.ctx, 'support'))).code).toBe(
            'FARM_HANDLE_RESERVED',
        );
        // `toSlug('АДМИН') === 'admin'`, so the reserved check runs on the
        // transliterated form and the other script is not a way around it.
        expect((await caught(() => claimFarmBrandHandle(farm.ctx, 'АДМИН'))).code).toBe(
            'FARM_HANDLE_RESERVED',
        );
    });

    it.each([
        ['ab', 'FARM_HANDLE_TOO_SHORT'],
        ['!!!', 'FARM_HANDLE_UNUSABLE'],
        ['a'.repeat(41), 'FARM_HANDLE_TOO_LONG'],
    ])('refuses %j with %s', async (input, code) => {
        const farm = await aFarm();
        expect((await caught(() => claimFarmBrandHandle(farm.ctx, input))).code).toBe(code);
    });

    it('a rename on a PUBLISHED farm moves the page and the old address stops answering', async () => {
        const first = uniqueHandle();
        const farm = await aFarm({ handle: first, published: true });
        await projectFarmBrand(farm.ctx);
        expect(await readPublicFarmProfile(first)).not.toBeNull();

        const renamed = uniqueHandle();
        const result = await claimFarmBrandHandle(farm.ctx, renamed);
        createdHandles.push(renamed);

        expect(result.reprojected).toBe(true);
        // Both halves asserted. Without the first, a rename that only ADDED
        // the new row would pass — and `/f/{old}` would keep serving a page
        // the owner believes they have moved.
        expect(await readPublicFarmProfile(first)).toBeNull();
        expect(await readPublicFarmProfile(renamed)).not.toBeNull();
    });

    it('refuses a farm with no brand record', async () => {
        const farm = await aFarm({ withBrand: false });
        expect((await caught(() => claimFarmBrandHandle(farm.ctx, uniqueHandle()))).code).toBe(
            'FARM_BRAND_NOT_FOUND',
        );
    });

    it('refuses a non-admin', async () => {
        const farm = await aFarm();
        const editor = makeRequestContext('EDITOR', {
            tenantId: farm.tenantId,
            userId: `u-${randomUUID()}`,
        });
        await expect(claimFarmBrandHandle(editor, uniqueHandle())).rejects.toThrow();
    });
});
