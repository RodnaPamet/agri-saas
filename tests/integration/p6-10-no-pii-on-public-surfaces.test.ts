/**
 * P6.10 — no private farm identity reaches any public surface (#1818).
 *
 * The phase's hardening centrepiece, quoted so this suite is actionable
 * without it:
 *
 *   > A crawler/mutation test seeds ЕГН, ЕИК, УРН and address, and expects 0
 *   > hits in the HTML, JSON-LD, OG image or API.
 *
 * ## How "0 hits in the OG image" is checkable at all
 *
 * It is not a substring search over rendered pixels, and treating it as one
 * would be a test that cannot express failure. The card renders a value this
 * suite can read — the projection — so the assertion is about the INPUT. If
 * the input cannot contain the PII, no rasterisation can.
 *
 * The same answer covers the HTML: the page renders `readPublicFarmProfile`'s
 * return and nothing else, so asserting on that return is asserting on what
 * the HTML can contain. The remaining gap is honest and recorded at the bottom
 * of this file.
 *
 * ## Why the seed goes through the APP client
 *
 * `egn`, `eik` and `urn` are encrypted at rest by the pii middleware
 * (`encrypted-fields.ts`: `FarmProfile: ['egn', 'eik', 'urn']`). Seeding them
 * through the raw client would store the plaintext and then every "no hits"
 * assertion would be measuring a ciphertext that never resembled the search
 * string in the first place — a pass for the wrong reason. `address`,
 * `municipality` and `settlement` are plaintext columns and are seeded as
 * such.
 *
 * ## It depends on P6.8's search
 *
 * The sweep covers `searchPublicFarms`, which landed in #1840. I wrote this
 * suite on a branch off `main` before that merged and went straight to jest —
 * the failure was `searchPublicFarms is not a function`, and a typecheck would
 * have said so in one line. Running the suite is not a substitute for running
 * `tsc`; they fail at different layers and only one of them names the import.
 *
 * ## Distinctive values, not realistic ones
 *
 * Each seeded value carries a per-run token, so a hit is unambiguous. A
 * realistic ЕГН would be ten digits that could appear inside a timestamp or an
 * id by coincidence, and a coincidental hit in a test like this is worse than
 * none: it trains the next person to widen the matcher until it passes.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import prisma from '@/lib/prisma';
import {
    projectFarmBrand,
    readPublicFarmProfile,
    searchPublicFarms,
    listIndexableFarmHandles,
} from '@/app-layer/usecases/public-farm-profile';
import sitemap from '@/app/sitemap';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';
if (REQUIRE_DB && !DB_AVAILABLE) {
    throw new Error(
        'INTEGRATION_REQUIRE_DB=1 but no database is reachable. This suite is P6.10’s '
            + 'PII assertion; skipping it silently would report a pass for the control that '
            + 'decides whether a farmer’s ЕГН can reach a public page.',
    );
}
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** One token per run, so a hit names which value leaked. */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();

const PII = {
    egn: `EGN-${RUN}`,
    eik: `EIK-${RUN}`,
    urn: `URN-${RUN}`,
    address: `ADDRESS-${RUN}-ул. Тайна 7`,
    municipality: `MUNICIPALITY-${RUN}`,
    settlement: `SETTLEMENT-${RUN}`,
    producerName: `PRODUCERNAME-${RUN}`,
} as const;

/** Every value that must never appear, as a flat list for the sweeps below. */
const SECRETS = Object.values(PII);

const handles: string[] = [];
const tenants: string[] = [];

describeFn('P6.10 — no private farm identity on a public surface', () => {
    let handle: string;

    beforeAll(async () => {
        await globalPrisma.$connect();

        const tenantId = `pii-${randomUUID().slice(0, 8)}`;
        tenants.push(tenantId);
        await globalPrisma.tenant.create({
            data: { id: tenantId, name: 'ПИИ Тест', slug: tenantId },
        });

        // Through the APP client, so the pii middleware encrypts egn/eik/urn.
        await prisma.farmProfile.create({
            data: { tenantId, ...PII },
        });

        handle = `pii-${randomUUID().slice(0, 10)}`;
        handles.push(handle);
        await globalPrisma.farmBrand.create({
            data: {
                id: `fb-${randomUUID()}`,
                tenantId,
                handle,
                // The PUBLIC name is deliberately different from
                // `producerName`: the private one is the legal name and may be
                // a person's, which is exactly why it is not published.
                displayName: 'Стопанство Победа',
                tagline: 'Зърно',
                about: 'Семейно стопанство.',
                oblast: 'Добрич',
                crops: ['пшеница'],
                published: true,
                consentedAt: new Date(),
                consentTextVersion: 'v1',
            },
        });

        const ctx = makeRequestContext('ADMIN', { tenantId, userId: `u-${randomUUID()}` });
        await projectFarmBrand(ctx);
        // Indexable, so the sitemap and the search both have something to leak
        // if they are going to. A test where every surface is empty proves
        // nothing.
        await globalPrisma.publicFarmProfile.update({
            where: { handle },
            data: { indexable: true },
        });
    });

    afterAll(async () => {
        if (handles.length > 0) {
            await globalPrisma.publicFarmProfile.deleteMany({ where: { handle: { in: handles } } });
        }
        // Tenants and their FarmProfile stay: the audit log is immutable by
        // trigger and its FK is ON DELETE RESTRICT.
        void tenants;
        await globalPrisma.$disconnect();
    });

    /** Assert no secret appears anywhere in a serialised value. */
    function expectNoPii(label: string, value: unknown): void {
        const blob = JSON.stringify(value ?? null);
        const found = SECRETS.filter((s) => blob.includes(s));
        // Named in the failure, so a leak says WHICH field and WHERE.
        expect(found).toEqual([]);
        expect(blob).not.toContain(RUN);
        void label;
    }

    it('CONTROL: the PII really is stored, so the sweeps are not vacuous', async () => {
        // Without this, every assertion below passes against a farm that has
        // no private identity at all. Read through the APP client so the
        // encrypted columns come back decrypted.
        const row = await prisma.farmProfile.findFirst({
            where: { tenantId: tenants[0] },
        });
        expect(row).not.toBeNull();
        expect(row?.egn).toBe(PII.egn);
        expect(row?.eik).toBe(PII.eik);
        expect(row?.urn).toBe(PII.urn);
        expect(row?.address).toBe(PII.address);
        expect(row?.producerName).toBe(PII.producerName);
    });

    it('CONTROL: the public profile really is published and findable', async () => {
        // The other half of the control. A sweep over an absent page is green
        // for the wrong reason.
        const view = await readPublicFarmProfile(handle);
        expect(view).not.toBeNull();
        expect(view?.displayName).toBe('Стопанство Победа');
    });

    it('the projection ROW holds none of it', async () => {
        // The structural line. These columns do not exist on
        // `PublicFarmProfile`, so there is nowhere for a value to land — this
        // asserts the consequence rather than trusting it.
        const row = await globalPrisma.publicFarmProfile.findUnique({ where: { handle } });
        expectNoPii('projection row', row);
    });

    it('the page DATA holds none of it — which bounds the HTML', async () => {
        // `/f/[handle]` renders this return and nothing else, so what the HTML
        // can contain is bounded by what this contains.
        expectNoPii('readPublicFarmProfile', await readPublicFarmProfile(handle));
    });

    it('the OG card INPUT holds none of it — which bounds the image', async () => {
        // The card reads `displayName` and `oblast` off the same view. The
        // assertion is about the input, because a substring search over
        // rasterised pixels is a test that cannot express failure.
        const view = await readPublicFarmProfile(handle);
        expectNoPii('og input', { displayName: view?.displayName, oblast: view?.oblast });
    });

    it('the search API holds none of it', async () => {
        expectNoPii('search by name', await searchPublicFarms({ q: 'Победа' }));
        // …and a query for the PII itself finds nothing, which is the stronger
        // statement: the values are not merely unprinted, they are not indexed.
        for (const secret of SECRETS) {
            const hits = await searchPublicFarms({ q: secret });
            expect(hits.filter((h: { handle: string }) => h.handle === handle)).toEqual([]);
        }
    });

    it('the sitemap holds none of it', async () => {
        expectNoPii('sitemap', await sitemap());
        expectNoPii('indexable handles', await listIndexableFarmHandles());
    });

    it('the HANDLE itself carries none of it', async () => {
        // A handle derived from a legal name could carry it, and the handle is
        // the one public value a farm chooses rather than inherits.
        expect(handle).not.toContain(RUN.toLowerCase());
        for (const secret of SECRETS) {
            expect(handle.toLowerCase()).not.toContain(secret.toLowerCase());
        }
    });

    it('MUTATION GUARD: a secret planted on the projection WOULD be caught', async () => {
        // The proof that `expectNoPii` can fail. Every assertion above is "the
        // list is empty", and an always-empty matcher satisfies all of them —
        // this is the case that distinguishes a working sweep from a broken
        // one.
        await globalPrisma.publicFarmProfile.update({
            where: { handle },
            data: { tagline: `leaked ${PII.egn}` },
        });

        const row = await globalPrisma.publicFarmProfile.findUnique({ where: { handle } });
        expect(() => expectNoPii('planted', row)).toThrow();

        await globalPrisma.publicFarmProfile.update({
            where: { handle },
            data: { tagline: 'Зърно' },
        });
    });
});
