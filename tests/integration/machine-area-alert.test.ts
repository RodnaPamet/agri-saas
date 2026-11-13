/**
 * #2948 stage 5 — the leaving-the-area alert, against real PostGIS.
 *
 * ## The two assertions this suite exists for
 *
 * **One push per EVENT.** The owner ruled one alert per departure rather than
 * one per interval while a machine is away, which means the second run over
 * an unchanged situation must send NOTHING. A suite that only proved "leaving
 * sends an alert" would pass just as happily against a job that notifies every
 * five minutes for as long as a tractor sits at a dealership — the behaviour
 * the ruling moved away from.
 *
 * **A farm with no parcels is skipped, not alerted.** `ST_Union` over zero
 * rows is NULL, and a `COALESCE(..., true)` written for tidiness turns "this
 * farm has no area" into "every machine has left" — one push per machine per
 * run, at the farm least equipped to understand why.
 *
 * ## Geometry in degrees, thresholds in metres
 *
 * The parcel sits at ~43.1°N / 26.6°E where a degree of longitude is about
 * 81 km. The "far" fixture is 0.05° east, roughly 4 km out, comfortably past
 * the 2 km buffer; the "near" one is inside the parcel. Both are written in
 * degrees because the column is SRID 4326, and every distance the job computes
 * goes through EPSG:32635 first — which is the bug this would otherwise hide.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

const mockEnqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));

/*
 * The subject is imported AFTER `jest.mock`, which is the house pattern for a
 * mocked dependency and is what `import/order` would normally object to. It
 * does not object here — the rule is not enabled for this root — so the
 * `eslint-disable-next-line import/order` this line carried was INERT, and
 * `lint-ceiling` holds inert directives at zero: a directive that suppresses
 * nothing is either stale or misplaced, and either way it reads as a settled
 * question that nothing is actually asking.
 */
import { runMachineAreaAlert, AREA_BUFFER_M } from '@/app-layer/jobs/machine-area-alert';
import { hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const TENANT = `t-maa-${TAG}`;
/** A farm with machines and NO parcels drawn. */
const BARE_TENANT = `t-maa-bare-${TAG}`;
/** A SECOND mapped farm, so one run can have departures in two of them. */
const FARM2 = `t-maa-two-${TAG}`;
const OWNER2 = `u-maa-owner2-${TAG}`;
const OWNER = `u-maa-owner-${TAG}`;
const ADMIN = `u-maa-admin-${TAG}`;
const EDITOR = `u-maa-editor-${TAG}`;
const MECHANISATOR = `u-maa-mech-${TAG}`;

const LON0 = 26.6;
const LAT0 = 43.1;
const SPAN = 0.01;
/** Inside the parcel. */
const INSIDE = { lat: LAT0 + SPAN / 2, lon: LON0 + SPAN / 2 };
/** ~4 km east of the parcel's edge — past the 2 km buffer. */
const FAR = { lat: LAT0 + SPAN / 2, lon: LON0 + 0.06 };
/*
 * FARM2's block sits 0.1° west — about 8 km at this latitude, where a degree
 * of longitude is ~81 km and NOT the ~111 km a degree of latitude is. So the
 * single `FAR` point above (≈4.9 km east of the first block) is ~13 km from
 * this one, outside both 2 km buffers, and one position departs either farm.
 */
const LON2 = LON0 - 0.1;

let assetId = '';
let bareAssetId = '';
let farm2AssetId = '';
let keylessAssetId = '';
const NOW = '2026-11-13T10:00:00.000Z';

async function fix(asset: string, tenant: string, at: Date, p: { lat: number; lon: number }) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "MachinePosition"
           ("id","tenantId","assetId","recordedAt","lat","lon","speedKph","ignition","source","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,10,true,'TRACKER',NOW())`,
        randomUUID(), tenant, asset, at, p.lat, p.lon,
    );
}

const minutesBefore = (m: number) => new Date(new Date(NOW).getTime() - m * 60_000);

async function clearRuntime() {
    for (const t of [TENANT, BARE_TENANT, FARM2]) {
        await prisma.$executeRawUnsafe(`DELETE FROM "MachinePosition" WHERE "tenantId" = $1`, t);
        await prisma.machineAreaState.deleteMany({ where: { tenantId: t } });
    }
    mockEnqueue.mockClear();
}

describeFn('#2948 stage 5 — the leaving-the-area alert', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.createMany({
            data: [
                { id: TENANT, name: 'ЗК Хоризонт', slug: TENANT },
                { id: BARE_TENANT, name: 'ЗК Без карта', slug: BARE_TENANT },
                { id: FARM2, name: 'ЗК Съседна', slug: FARM2 },
            ],
        });
        for (const [id, role] of [
            [OWNER, 'OWNER'], [ADMIN, 'ADMIN'],
            [EDITOR, 'EDITOR'], [MECHANISATOR, 'MECHANISATOR'],
        ] as const) {
            const email = `${id}@example.test`;
            await prisma.user.create({
                data: { id, email, emailHash: hashForLookup(email), uiLanguage: 'bg' },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: TENANT, userId: id, role, status: 'ACTIVE' },
            });
        }
        /*
         * BARE_TENANT gets an OWNER of its own, and it is not decoration.
         *
         * Pass 2 batches every read, so the recipient list is resolved for
         * ALL departing farms at once and then looked up per farm. With one
         * farm holding every member, the per-farm lookup and the flattened
         * union are the SAME SET — measured: replacing
         * `recipientsByTenant.get(d.tenantId)` with the union left all eleven
         * cases green. That mutation is a cross-tenant disclosure (farm A's
         * departure pushed to farm B's owner, carrying a link into farm A),
         * and nothing could see it until a second farm had somebody in it.
         *
         * `equal-once-is-not-always-equal`: one sample of two values agreeing
         * does not make the comparison vacuous — but here the sample was the
         * only one there was.
         */
        const BARE_OWNER = `u-bare-${TAG}`;
        const bareEmail = `${BARE_OWNER}@example.test`;
        await prisma.user.create({
            data: {
                id: BARE_OWNER,
                email: bareEmail,
                emailHash: hashForLookup(bareEmail),
                uiLanguage: 'bg',
            },
        });
        await prisma.tenantMembership.create({
            data: { tenantId: BARE_TENANT, userId: BARE_OWNER, role: 'OWNER', status: 'ACTIVE' },
        });

        const a = await prisma.asset.create({
            // `key` is set deliberately: the push body names the KEY and never
            // `name` (#1999), so an asset with no key cannot distinguish "the
            // body is composed correctly" from "the body is empty". The
            // key-less case is its own test below.
            data: { tenantId: TENANT, name: 'Трактор 3', key: 'AST-31', type: 'VEHICLE' },
            select: { id: true },
        });
        assetId = a.id;
        /*
         * Its OWN asset rather than nulling `key` on the one above: a test
         * that mutates a shared fixture makes every LATER test depend on
         * its order, and this file found that out — the two-farm case below
         * read an empty body for a machine whose key a previous test had
         * cleared and not put back.
         */
        const k = await prisma.asset.create({
            data: { tenantId: TENANT, name: 'Трактор без ключ', key: null, type: 'VEHICLE' },
            select: { id: true },
        });
        keylessAssetId = k.id;
        const b = await prisma.asset.create({
            data: { tenantId: BARE_TENANT, name: 'Комбайн 1', type: 'VEHICLE' },
            select: { id: true },
        });
        bareAssetId = b.id;

        /*
         * The second MAPPED farm. Pass 2 resolves recipients for every
         * departing farm in one query and then looks them up per farm, and
         * that lookup is only falsifiable when a single run has departures in
         * TWO farms with members: with one, the per-farm list and the
         * flattened union are the same set, and replacing one with the other
         * leaves every case green — measured twice while building this.
         */
        const owner2Email = `${OWNER2}@example.test`;
        await prisma.user.create({
            data: {
                id: OWNER2,
                email: owner2Email,
                emailHash: hashForLookup(owner2Email),
                uiLanguage: 'bg',
            },
        });
        await prisma.tenantMembership.create({
            data: { tenantId: FARM2, userId: OWNER2, role: 'OWNER', status: 'ACTIVE' },
        });
        const c = await prisma.asset.create({
            data: { tenantId: FARM2, name: 'Трактор съседен', key: 'AST-77', type: 'VEHICLE' },
            select: { id: true },
        });
        farm2AssetId = c.id;
        const loc2 = await prisma.location.create({
            data: { tenantId: FARM2, name: `Блок втори ${TAG}` },
            select: { id: true },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Parcel" ("id","tenantId","locationId","name","areaHa","geometry","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5, ST_Multi(ST_SetSRID(ST_GeomFromText($6), 4326)), NOW(), NOW())`,
            randomUUID(), FARM2, loc2.id, `Парцел втори ${TAG}`, 40,
            `POLYGON((${LON2} ${LAT0}, ${LON2 + SPAN} ${LAT0}, ${LON2 + SPAN} ${LAT0 + SPAN}, ${LON2} ${LAT0 + SPAN}, ${LON2} ${LAT0}))`,
        );

        const loc = await prisma.location.create({
            data: { tenantId: TENANT, name: `Блок ${TAG}` },
            select: { id: true },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Parcel" ("id","tenantId","locationId","name","areaHa","geometry","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5, ST_Multi(ST_SetSRID(ST_GeomFromText($6), 4326)), NOW(), NOW())`,
            randomUUID(), TENANT, loc.id, `Парцел ${TAG}`, 80,
            `POLYGON((${LON0} ${LAT0}, ${LON0 + SPAN} ${LAT0}, ${LON0 + SPAN} ${LAT0 + SPAN}, ${LON0} ${LAT0 + SPAN}, ${LON0} ${LAT0}))`,
        );
    });

    afterAll(async () => {
        await clearRuntime();
        await prisma.$executeRawUnsafe(
            `DELETE FROM "Parcel" WHERE "tenantId" = ANY($1::text[])`,
            [TENANT, FARM2],
        );
        await prisma.asset.deleteMany({
            where: { tenantId: { in: [TENANT, BARE_TENANT, FARM2] } },
        });
        await prisma.location.deleteMany({ where: { tenantId: { in: [TENANT, FARM2] } } });
        /*
         * The MEMBERSHIPS, USERS and TENANTS all stay, and chasing them was a
         * real failure rather than laziness: deleting them raised
         * `P0001 LAST_OWNER_GUARD: tenant … would have zero active OWNERs` —
         * the database trigger CLAUDE.md describes, which exists so a tenant
         * cannot be left ownerless, and which a test tidying up has no
         * business defeating.
         *
         * `apns-environment-write` records the same conclusion after three
         * attempts at its own leftovers, and the audit chain's rows carry no
         * cascade either. Every identifier here is TAG-scoped to one run, so
         * the leftovers collide with nothing and accumulate under no name
         * another suite reads.
         */
        await prisma.$disconnect();
    });

    beforeEach(clearRuntime);

    const pushes = () =>
        mockEnqueue.mock.calls
            .filter((c) => c[0] === 'push-send')
            .map((c) => c[1] as Record<string, unknown>);

    it('a machine INSIDE the area raises nothing, and records that it is inside', async () => {
        await fix(assetId, TENANT, minutesBefore(2), INSIDE);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ evaluated: 1, departures: 0, pushesEnqueued: 0 });
        expect(pushes()).toHaveLength(0);
        const st = await prisma.machineAreaState.findUniqueOrThrow({
            where: { assetId }, select: { outside: true, alertedAt: true },
        });
        expect(st.outside).toBe(false);
        expect(st.alertedAt).toBeNull();
    }, 60_000);

    it('a machine OUTSIDE raises one push per OWNER and ADMIN — and nobody else', async () => {
        await fix(assetId, TENANT, minutesBefore(2), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ departures: 1 });
        const sent = pushes();
        // OWNER + ADMIN only. EDITOR is not an audience and MECHANISATOR is
        // the SUBJECT — §7's reason, kept verbatim in the job.
        expect(sent.map((p) => p.recipientUserId).sort()).toEqual([ADMIN, OWNER].sort());
        expect(sent.map((p) => p.recipientUserId)).not.toContain(EDITOR);
        expect(sent.map((p) => p.recipientUserId)).not.toContain(MECHANISATOR);
        // The link is root-relative and tenant-prefixed — #2932 is what a
        // bare path cost.
        expect(sent[0].link).toBe(`/t/${TENANT}/machines/${assetId}`);
        expect(sent[0].collapseKey).toBe(`machine-area-${assetId}`);
        /*
         * THE BODY NAMES THE KEY AND NOT THE NAME — #1999, and asserted in
         * BOTH directions because only the second one is the property.
         *
         * An APNs payload is not end-to-end encrypted, so `Трактор 3` in the
         * body is farm prose Apple reads. A test that only asserted the key
         * was present would pass just as happily with the name appended, which
         * is exactly the regression the owner's 2026-11-01 ruling is about.
         */
        expect(String(sent[0].body)).toContain('AST-31');
        expect(String(sent[0].body)).not.toContain('Трактор 3');
        // In Bulgarian, because both recipients carry `uiLanguage: 'bg'`.
        expect(String(sent[0].body)).toContain('излезе');
        expect(String(sent[0].title)).toBe('Машина извън стопанството');
    }, 60_000);

    it('a machine with NO key pushes its title and an EMPTY body — never the name', async () => {
        await fix(keylessAssetId, TENANT, minutesBefore(2), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ departures: 1 });
        const sent = pushes();
        expect(sent).not.toHaveLength(0);
        /*
         * `Asset.key` is nullable, and the fallback is NOTHING rather than the
         * name. Falling back to `name` is the whole defect #1999 names and is
         * exactly how it would come back — the assignment producer carries the
         * same note at its own empty-string fallback. The title still says a
         * machine left, and the link opens the machine, so the name is one
         * authenticated REST read away.
         */
        expect(sent[0].body).toBe('');
        expect(String(sent[0].title)).toBe('Машина извън стопанството');
        expect(String(sent[0].body)).not.toContain('без ключ');
    }, 60_000);

    it('TWO farms departing in one run each get their OWN recipients and link', async () => {
        /*
         * Runs platform-wide (no `tenantId`), which is how the schedule runs
         * it, and is the only shape in which the per-farm recipient lookup can
         * be wrong: pass 2 resolves recipients for every departing farm in one
         * query, so a lookup that reached for the flattened union instead
         * would push farm A's departure to farm B's owner — carrying a link
         * into farm A's tenant path. That mutation passes every other case in
         * this file.
         *
         * Assertions are per RECIPIENT rather than on the global counters: the
         * run covers every tenant, and another suite's leftover positions in
         * the same worker database are legitimately targets too.
         */
        await fix(assetId, TENANT, minutesBefore(2), FAR);
        await fix(farm2AssetId, FARM2, minutesBefore(2), FAR);
        await runMachineAreaAlert({ now: NOW });

        const mine = pushes().filter((p) =>
            [OWNER, ADMIN, OWNER2].includes(String(p.recipientUserId)),
        );
        const to = (u: string) => mine.filter((p) => p.recipientUserId === u);

        // Farm 1's two recipients hear about farm 1's machine, and only it.
        for (const u of [OWNER, ADMIN]) {
            expect(to(u)).toHaveLength(1);
            expect(to(u)[0].link).toBe(`/t/${TENANT}/machines/${assetId}`);
            expect(String(to(u)[0].body)).toContain('AST-31');
            expect(String(to(u)[0].body)).not.toContain('AST-77');
        }
        // Farm 2's owner hears about farm 2's, and is NOT on farm 1's.
        expect(to(OWNER2)).toHaveLength(1);
        expect(to(OWNER2)[0].link).toBe(`/t/${FARM2}/machines/${farm2AssetId}`);
        expect(String(to(OWNER2)[0].body)).toContain('AST-77');
        expect(String(to(OWNER2)[0].body)).not.toContain('AST-31');
    }, 60_000);

    it('STAYING outside sends nothing on the next run — one push per EVENT', async () => {
        await fix(assetId, TENANT, minutesBefore(10), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(pushes()).toHaveLength(2);

        // A newer fix, still outside: the situation has not changed, so a
        // second notification would be the per-interval behaviour the ruling
        // rejected.
        mockEnqueue.mockClear();
        await fix(assetId, TENANT, minutesBefore(1), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ departures: 0, pushesEnqueued: 0 });
        expect(pushes()).toHaveLength(0);
    }, 60_000);

    it('RETURNING is silent, and flips the stored verdict', async () => {
        await fix(assetId, TENANT, minutesBefore(10), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        mockEnqueue.mockClear();

        await fix(assetId, TENANT, minutesBefore(1), INSIDE);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        // A farm is told when a machine leaves, not when it comes back: the
        // second is not a risk, and the first loses force in a pair.
        expect(pushes()).toHaveLength(0);
        const st = await prisma.machineAreaState.findUniqueOrThrow({
            where: { assetId }, select: { outside: true },
        });
        expect(st.outside).toBe(false);
    }, 60_000);

    it('leaving AGAIN after a return is a NEW event, and alerts', async () => {
        // The control for "staying outside is silent": that silence must come
        // from the verdict being unchanged, not from a machine being alerted
        // at most once ever.
        await fix(assetId, TENANT, minutesBefore(20), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        await fix(assetId, TENANT, minutesBefore(10), INSIDE);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        mockEnqueue.mockClear();

        await fix(assetId, TENANT, minutesBefore(1), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ departures: 1 });
        expect(pushes()).toHaveLength(2);
    }, 60_000);

    it('a farm with NO parcels is SKIPPED, never alerted', async () => {
        // The loudest possible failure if it were wrong: one push per machine
        // per run, at the farm least able to explain it.
        await fix(bareAssetId, BARE_TENANT, minutesBefore(2), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: BARE_TENANT, now: NOW });

        expect(result.details).toMatchObject({
            skippedNoArea: 1, evaluated: 0, departures: 0, pushesEnqueued: 0,
        });
        expect(pushes()).toHaveLength(0);
        // And no verdict is stored — "no area" is not "inside".
        expect(await prisma.machineAreaState.count({ where: { tenantId: BARE_TENANT } })).toBe(0);
    }, 60_000);

    it('a STALE fix is not a verdict', async () => {
        // A machine switched off in a shed last week must not keep producing
        // verdicts from its final fix.
        await fix(assetId, TENANT, minutesBefore(120), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.itemsScanned).toBe(0);
        expect(pushes()).toHaveLength(0);
        expect(await prisma.machineAreaState.count({ where: { tenantId: TENANT } })).toBe(0);
    }, 60_000);

    it('the SAME fix re-evaluated sends nothing — idempotence', async () => {
        await fix(assetId, TENANT, minutesBefore(2), FAR);
        await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(pushes()).toHaveLength(2);

        mockEnqueue.mockClear();
        // No new fix: a job that wakes twice before the tracker reports again.
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(result.details).toMatchObject({ departures: 0 });
        expect(pushes()).toHaveLength(0);
    }, 60_000);

    it("a machine ALREADY outside at its first verdict counts as a departure", async () => {
        /*
         * Deliberate: a farm fitting a tracker to a machine that is away wants
         * to know it is away. Treating an absent prior row as "inside" would
         * stay silent on exactly the case somebody fitted the tracker to find.
         */
        expect(await prisma.machineAreaState.count({ where: { assetId } })).toBe(0);
        await fix(assetId, TENANT, minutesBefore(2), FAR);
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });
        expect(result.details).toMatchObject({ departures: 1 });
    }, 60_000);

    it('the buffer is TWO KILOMETRES, in metres', async () => {
        // A fix ~1 km out: outside the parcel, inside the buffer, so not a
        // departure. This is the assertion that fails if the buffer is ever
        // applied in degrees — 2000 degrees contains the planet, and every
        // machine would read as inside for ever.
        expect(AREA_BUFFER_M).toBe(2_000);
        await fix(assetId, TENANT, minutesBefore(2), { lat: LAT0 + SPAN / 2, lon: LON0 + SPAN + 0.012 });
        const { result } = await runMachineAreaAlert({ tenantId: TENANT, now: NOW });

        expect(result.details).toMatchObject({ evaluated: 1, departures: 0 });
        const st = await prisma.machineAreaState.findUniqueOrThrow({
            where: { assetId }, select: { outside: true },
        });
        expect(st.outside).toBe(false);
    }, 60_000);
});
