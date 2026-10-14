/**
 * The public read path (P6.5, #1814).
 *
 * Driven against a real database, because the property that matters is that a
 * WITHDRAWN farm and a farm that never existed are the same absence — and that
 * is a statement about rows, not about branches in a function.
 *
 * Run with `INTEGRATION_REQUIRE_DB=1` so a skipped run is red.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    readPublicFarmProfile,
    setFarmBrandPublication,
} from '@/app-layer/usecases/public-farm-profile';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';
if (REQUIRE_DB && !DB_AVAILABLE) {
    throw new Error(
        'INTEGRATION_REQUIRE_DB=1 but no database is reachable. This suite proves a '
            + 'withdrawn farm is indistinguishable from a missing one; skipping it silently '
            + 'would report a pass for the anti-enumeration property.',
    );
}
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const createdTenants: string[] = [];
const createdHandles: string[] = [];

describeFn('readPublicFarmProfile', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
    });

    afterAll(async () => {
        if (createdHandles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({
                where: { handle: { in: createdHandles } },
            });
        }
        // Tenants stay — the audit log is immutable by trigger and its FK is
        // ON DELETE RESTRICT, so a suite writing through `withTenantDb` cannot
        // delete its own. Ids are per-run UUID fragments.
        void createdTenants;
        await globalPrisma.$disconnect();
    });

    /** A published farm, by the real writer rather than a hand-inserted row. */
    async function aPublishedFarm(handleText?: string) {
        const tenantId = `pr-${randomUUID().slice(0, 8)}`;
        createdTenants.push(tenantId);
        await globalPrisma.tenant.create({
            data: { id: tenantId, name: 'Публично', slug: tenantId },
        });
        const raw = handleText ?? `farm-${randomUUID().slice(0, 12)}`;
        createdHandles.push(raw, raw.trim().toLowerCase());
        await globalPrisma.farmBrand.create({
            data: {
                id: `fb-${randomUUID()}`,
                tenantId,
                handle: raw,
                displayName: 'Стопанство Победа',
                tagline: 'Зърно и слънчоглед',
                about: 'Семейно стопанство в Добруджа.',
                oblast: 'Добрич',
                crops: ['пшеница', 'слънчоглед'],
                published: true,
                consentedAt: new Date(),
                consentTextVersion: 'v1',
            },
        });
        const ctx = makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });
        await setFarmBrandPublication(ctx, true);
        return { tenantId, raw, ctx };
    }

    it('a published farm is readable with no principal at all', async () => {
        const farm = await aPublishedFarm();

        // No ctx argument — that is the whole point. An anonymous visitor has
        // no session, no tenant and no membership.
        const view = await readPublicFarmProfile(farm.raw);

        expect(view).not.toBeNull();
        expect(view?.displayName).toBe('Стопанство Победа');
        expect(view?.oblast).toBe('Добрич');
        expect(view?.crops).toEqual(['пшеница', 'слънчоглед']);
    });

    it('the view carries NO PII keys — structurally, not by filtering', async () => {
        const farm = await aPublishedFarm();
        const view = await readPublicFarmProfile(farm.raw);

        // P6.10 asks for zero hits of these in the HTML. They never reach the
        // process: the columns do not exist on the projection.
        for (const pii of ['egn', 'eik', 'address', 'municipality', 'settlement', 'tenantId']) {
            expect(Object.keys(view as object)).not.toContain(pii);
        }
        // …and the key set is exactly what the page may render, so a new
        // projection column shows up here rather than on a page.
        expect(Object.keys(view as object).sort()).toEqual(
            ['about', 'crops', 'displayName', 'handle', 'indexable', 'oblast', 'projectedAt', 'tagline'].sort(),
        );
    });

    describe('a withdrawn farm and a missing one are the SAME absence', () => {
        it('both read null', async () => {
            const farm = await aPublishedFarm();
            expect(await readPublicFarmProfile(farm.raw)).not.toBeNull();

            await setFarmBrandPublication(farm.ctx, false);

            const withdrawn = await readPublicFarmProfile(farm.raw);
            const neverExisted = await readPublicFarmProfile(`farm-${randomUUID().slice(0, 12)}`);

            // Identical, and asserted as identical rather than as two nulls:
            // the point is that a caller cannot tell them apart.
            expect(withdrawn).toBeNull();
            expect(neverExisted).toBeNull();
            expect(withdrawn).toEqual(neverExisted);
        });

        it('and the row is GONE, not flagged — which is why there is one code path', async () => {
            const farm = await aPublishedFarm();
            await setFarmBrandPublication(farm.ctx, false);

            // Read through the global client, which bypasses nothing and sees
            // everything. If the writer had flagged instead of deleting, this
            // would find a row and the read above would be relying on a filter
            // somebody could forget.
            const rows = await globalPrisma.publicFarmProfile.findMany({
                where: { handle: farm.raw.toLowerCase() },
            });
            expect(rows).toHaveLength(0);
        });
    });

    describe('a handle off printed paper still resolves', () => {
        it('trailing whitespace', async () => {
            const farm = await aPublishedFarm();
            expect(await readPublicFarmProfile(`  ${farm.raw}  `)).not.toBeNull();
        });

        it('upper case', async () => {
            const farm = await aPublishedFarm();
            expect(await readPublicFarmProfile(farm.raw.toUpperCase())).not.toBeNull();
        });

        it('a handle CHOSEN in mixed case is reachable in lower case', async () => {
            // The inconsistency this caught: the reader normalises, so the
            // writer must store normalised too or a farm publishes
            // successfully and cannot be found — presenting as a 404 that is
            // deliberately indistinguishable from "no such farm".
            const mixed = `Farm-${randomUUID().slice(0, 8)}`;
            const farm = await aPublishedFarm(mixed);

            expect(await readPublicFarmProfile(mixed.toLowerCase())).not.toBeNull();
            expect(await readPublicFarmProfile(mixed)).not.toBeNull();
        });

        it('an empty or whitespace handle is null without querying', async () => {
            expect(await readPublicFarmProfile('')).toBeNull();
            expect(await readPublicFarmProfile('   ')).toBeNull();
        });
    });

    it('indexable is false, so nothing is opted into search by default', async () => {
        const farm = await aPublishedFarm();
        const view = await readPublicFarmProfile(farm.raw);
        expect(view?.indexable).toBe(false);
    });
});
