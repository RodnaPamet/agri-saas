/**
 * P3.6 — creating a farm, and the one response field that must not talk.
 *
 * ## What this is really guarding
 *
 * `createFarmForUser` accepts an optional ЕИК and files a `FarmIdentityClaim`
 * for it. An ЕИК is PUBLIC — it is in the Търговски регистър — so the secret is
 * never the number, it is **whether that farm is already in Agrent**. The
 * creation endpoint is the easiest place to leak that, because the caller
 * supplies an arbitrary ЕИК and reads a response.
 *
 * So the centrepiece below is a single comparison: a free ЕИК and one already
 * held by another farm's VERIFIED claim must produce a **byte-identical**
 * `identityVerification`. Everything else in this file exists to stop that
 * comparison passing for the wrong reason — a value that is constant because
 * nothing works would satisfy it too.
 *
 * ## Why the claim row is checked separately from the response
 *
 * The two must DISAGREE, and that is the design: the row records the truth
 * (PENDING, or DISPUTED on collision) while the response says the same thing
 * either way. A test that only read the response could not tell that apart from
 * a build that never files a claim at all, and a test that only read the row
 * would miss the leak entirely.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { createFarmForUser } from '@/app-layer/usecases/farm-creation';
import { isValidEik, looksLikeEgn } from '@/lib/bg-identifiers';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const APP_DB_URL = process.env.DATABASE_URL ?? DB_URL;
/** Bare client: no audit or PII extension, so fixtures write no audit rows. */
const verifier = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const CREATOR_ID = `u-fc6-${randomUUID()}`;
const CREATOR_EMAIL = `fc6-${RUN}@example.test`;

function creator() {
    return {
        requestId: `req-fc6-${randomUUID()}`,
        userId: CREATOR_ID,
        userEmail: CREATOR_EMAIL,
    };
}

/**
 * A checksum-valid 9-digit ЕИК, found by SEARCH using the real validator.
 *
 * Deliberately not a reimplementation of the mod-11 algorithm. A second copy
 * of the checksum in a test can drift from `bg-identifiers.ts` and then this
 * file would be asserting against its own arithmetic — green while the product
 * rejected every number it generated. Using `isValidEik` as the oracle means
 * the fixture cannot disagree with the implementation by construction.
 *
 * `looksLikeEgn` is excluded too: an ЕГН must be refused, so a fixture that
 * happened to be one would make a valid-ЕИК case fail for the wrong reason.
 */
/**
 * Per-run offset for every ЕИК this suite mints (#1561).
 *
 * `FarmIdentityClaim`'s uniqueness is `(eikHash) WHERE status = 'VERIFIED'` —
 * GLOBAL, not tenant-scoped — so one verified claim per hash is all the
 * database will ever hold. With a constant ЕИК the first run wrote that row,
 * `afterAll` correctly declined to remove it (see its comment), and every
 * later run on the same database died in the fixture before reaching an
 * assertion. CI never saw it because each CI run migrates a fresh database, so
 * run 1 was always the only run; a developer saw it from their second run on,
 * where it looks like local breakage.
 *
 * Bounded deliberately. `RUN` is 8 hex characters, so `% 1000` gives 0–999 and
 * `* 100` leaves room for the case seeds below without the search start
 * exceeding the 9-digit space: the largest reachable start is
 * `100000000 + 99978 * 7919 = 891725782`, with ~108M of headroom before the
 * loop's own bound.
 */
const EIK_RUN_OFFSET = (parseInt(RUN, 16) % 1000) * 100;

/**
 * @param caseSeed distinguishes the ЕИКs WITHIN one run; the run offset
 *                 distinguishes them BETWEEN runs. Both are needed — a shared
 *                 case seed would make two cases fight over one hash, and a
 *                 shared run offset is the defect above.
 */
function validEik(caseSeed: number): string {
    const seed = EIK_RUN_OFFSET + caseSeed;
    for (let n = 100000000 + seed * 7919; n < 999999999; n += 1) {
        const s = String(n);
        if (isValidEik(s) && !looksLikeEgn(s)) return s;
    }
    throw new Error('no checksum-valid ЕИК found');
}

/** An ЕГН, found the same way and for the same reason. */
function anEgn(): string {
    for (let n = 7500000000; n < 7600000000; n += 1) {
        const s = String(n);
        if (looksLikeEgn(s)) return s;
    }
    throw new Error('no ЕГН-shaped value found');
}

describeFn('P3.6 createFarmForUser', () => {
    beforeAll(async () => {
        await verifier.$connect();
        await verifier.user.create({
            data: {
                id: CREATOR_ID,
                email: CREATOR_EMAIL,
                emailHash: hashForLookup(CREATOR_EMAIL, 'email'),
                name: 'P3.6 creator',
            },
        });
    });

    afterAll(async () => {
        // Tenants and audit rows stay: `AuditLog` is immutable by trigger and
        // `AuditLog_tenantId_fkey` is ON DELETE RESTRICT, so a suite that
        // writes through the audited client cannot delete its own tenants. Same
        // trade `audit-fail-closed-atomicity.test.ts` accepts.
        //
        // This comment used to end "names carry a per-run id so nothing
        // collides" (#1561). That was true of every field EXCEPT the one with a
        // global constraint: `name` and `slug` carried `RUN`, `eikHash` did
        // not — so the suite stated a correct collision-safety argument that
        // did not cover the single column where a collision is fatal, and read
        // as though it did. `EIK_RUN_OFFSET` is what makes the sentence true
        // now.
        //
        // The claims ARE deleted, unlike the tenants. `FarmIdentityClaim` has
        // no audit trigger and no FK to `Tenant` (a plain `tenantId` column),
        // so nothing blocks it — and without this the table grows one leaked
        // VERIFIED row per developer per checkout for ever. Scoped to
        // `claimedByUserId`, which is per-run, so a concurrent run's rows are
        // untouched; deleting by `eikHash` would be the wider blast radius.
        await verifier.farmIdentityClaim
            .deleteMany({ where: { claimedByUserId: CREATOR_ID } })
            .catch(() => {
                /* best effort: a failed cleanup must not fail a green suite */
            });
        await verifier.$disconnect();
    });

    it('control: the fixture mints DISTINCT ЕИКs, and ones a rerun will not reuse', () => {
        // The property the suite depended on and never checked. Two case seeds
        // resolving to one ЕИК would make the "held elsewhere" case fight its
        // own control for the single VERIFIED row the index permits — and the
        // failure would look like the product leaking, not like a fixture bug.
        const eiks = [validEik(31), validEik(77), validEik(78)];

        expect(new Set(eiks).size).toBe(3);
        // Every one is checksum-valid and not an ЕГН — asserted here rather
        // than trusted, because `validEik` now composes two seeds and an
        // off-by-one in that arithmetic would be invisible otherwise.
        for (const e of eiks) {
            expect(isValidEik(e)).toBe(true);
            expect(looksLikeEgn(e)).toBe(false);
        }
        // And the run offset is actually applied: with it ignored, these would
        // be the same three numbers on every run for ever, which is the defect.
        expect(EIK_RUN_OFFSET).toBeGreaterThanOrEqual(0);
        expect(eiks).not.toEqual([validEik(31 + 100), validEik(77 + 100), validEik(78 + 100)]);
    });

    // ── it works at all ──────────────────────────────────────────────

    it('creates a farm with the caller as OWNER', async () => {
        const res = await createFarmForUser(creator(), { name: `Победа ${RUN}-a` });

        expect(res.farm.id).toBeTruthy();
        expect(res.farm.slug).toBeTruthy();

        // The OWNER membership is what makes this a farm the caller holds
        // rather than an orphan tenant. Written by `createTenantWithOwner`,
        // which is the allowlisted site — asserted here because "the farm was
        // created" and "the caller owns it" are different claims.
        const membership = await verifier.tenantMembership.findFirst({
            where: { tenantId: res.farm.id, userId: CREATOR_ID },
            select: { role: true, status: true },
        });
        expect(membership?.role).toBe('OWNER');
        expect(membership?.status).toBe('ACTIVE');
    });

    it('a second farm for the same person is allowed', async () => {
        // The multi-farm ruling. A one-farm-per-account guard would fail here,
        // which is the point of asserting it rather than leaving it implied.
        const first = await createFarmForUser(creator(), { name: `Ферма ${RUN}-b1` });
        const second = await createFarmForUser(creator(), { name: `Ферма ${RUN}-b2` });

        expect(second.farm.id).not.toBe(first.farm.id);
        const count = await verifier.tenantMembership.count({
            where: { userId: CREATOR_ID, role: 'OWNER' },
        });
        expect(count).toBeGreaterThanOrEqual(2);
    });

    it('two farms with the SAME name get different slugs', async () => {
        const name = `Еднакво име ${RUN}`;
        const a = await createFarmForUser(creator(), { name });
        const b = await createFarmForUser(creator(), { name });

        expect(a.farm.slug).not.toBe(b.farm.slug);
        // ...and both are transliterated, not raw Cyrillic in a URL.
        expect(a.farm.slug).toMatch(/^[a-z0-9-]+$/);
        expect(b.farm.slug).toMatch(/^[a-z0-9-]+$/);
    });

    // ── the ЕИК paths ────────────────────────────────────────────────

    it('no ЕИК: not_requested, and NO claim row', async () => {
        const res = await createFarmForUser(creator(), { name: `Без ЕИК ${RUN}` });

        expect(res.identityVerification).toBe('not_requested');
        expect(
            await verifier.farmIdentityClaim.count({ where: { tenantId: res.farm.id } }),
        ).toBe(0);
    });

    it('a free ЕИК: pending_review, and a PENDING row', async () => {
        const eik = validEik(31);
        const res = await createFarmForUser(creator(), { name: `С ЕИК ${RUN}`, eik });

        expect(res.identityVerification).toBe('pending_review');
        const rows = await verifier.farmIdentityClaim.findMany({
            where: { tenantId: res.farm.id },
            select: { status: true, eikHash: true, claimedByUserId: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('PENDING');
        expect(rows[0].claimedByUserId).toBe(CREATOR_ID);
        // The blind index, never the plaintext.
        expect(rows[0].eikHash).toBe(hashForLookup(eik, 'eik'));
        expect(rows[0].eikHash).not.toContain(eik);
    });

    // ── THE PROPERTY ─────────────────────────────────────────────────

    it('an ЕИК held elsewhere is INDISTINGUISHABLE — same value AND same row', async () => {
        const eik = validEik(77);

        // Another farm already holds it, VERIFIED. Seeded with the bare client
        // so the fixture is not subject to the policies under test.
        const incumbent = `t-fc6-inc-${randomUUID()}`;
        await createTenantWithDek({ id: incumbent, name: 'incumbent', slug: incumbent });
        await verifier.farmIdentityClaim.create({
            data: {
                tenantId: incumbent,
                eikHash: hashForLookup(eik, 'eik'),
                status: 'VERIFIED',
                verifiedAt: new Date(),
                claimedByUserId: CREATOR_ID,
            },
        });

        // A free ЕИК, for the comparison. Taken FIRST so the two calls differ
        // only in which ЕИК they carry.
        const free = await createFarmForUser(creator(), {
            name: `Свободен ${RUN}`,
            eik: validEik(78),
        });
        const taken = await createFarmForUser(creator(), { name: `Зает ${RUN}`, eik });

        // THE LEAK TEST. Not "taken is pending_review" — that would pass on a
        // constant. The two must be INDISTINGUISHABLE.
        expect(taken.identityVerification).toBe(free.identityVerification);
        expect(Object.keys(taken).sort()).toEqual(Object.keys(free).sort());

        // The row is PENDING, not DISPUTED — and this assertion is the whole
        // reason the case is worth having.
        //
        // The partial unique index is `(eikHash) WHERE status = 'VERIFIED'`, so
        // a PENDING insert on an ЕИК another farm holds VERIFIED violates
        // nothing. Creation therefore CANNOT detect the collision, and the
        // first version of `fileIdentityClaim` had a `P2002 -> DISPUTED` branch
        // that could never fire. The dispute is raised at VERIFICATION (P3.9),
        // when a reviewer tries to promote a second claim and the index
        // refuses.
        //
        // That makes the enumeration property UNCONDITIONAL rather than
        // carefully maintained: there is no branch at creation time that could
        // differ by whether the ЕИК is taken. Same code path, same row shape,
        // same response.
        const rows = await verifier.farmIdentityClaim.findMany({
            where: { tenantId: taken.farm.id },
            select: { status: true, disputedAt: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('PENDING');
        expect(rows[0].disputedAt).toBeNull();

        // ...and the free case produced the same row shape, which is what
        // "indistinguishable" actually requires. Asserting only the response
        // would miss a build that recorded the two differently.
        const freeRows = await verifier.farmIdentityClaim.findMany({
            where: { tenantId: free.farm.id },
            select: { status: true, disputedAt: true },
        });
        expect(freeRows).toEqual(rows);

        // ...and the incumbent is untouched, which is the griefing case: a
        // later claimant must never be able to demote a verified farm. Still
        // worth asserting even though creation cannot dispute anything —
        // precisely because a future change that DID dispute at creation would
        // have to decide which row loses, and this says which.
        const inc = await verifier.farmIdentityClaim.findFirst({
            where: { tenantId: incumbent },
            select: { status: true },
        });
        expect(inc?.status).toBe('VERIFIED');
    });

    // ── refusals, which are NOT uniformity-constrained ───────────────

    it('an ЕГН is refused, and nothing is written', async () => {
        // A valid-looking ЕГН. Refusing it is the whole point: it is a personal
        // identifier and must never be persisted, hashed or otherwise.
        const before = await verifier.farmIdentityClaim.count();
        await expect(
            createFarmForUser(creator(), { name: `ЕГН ${RUN}`, eik: anEgn() }),
            // The CODE, not the message. `toThrow(regex)` matches the
            // MESSAGE, which #1388 deliberately changed to English prose when
            // it moved the code into `code` — so the old assertion passed only
            // while the code was (wrongly) the message. Asserting `code` is
            // both correct now and the thing a client actually switches on.
        ).rejects.toMatchObject({ code: 'EIK_LOOKS_LIKE_EGN' });
        expect(await verifier.farmIdentityClaim.count()).toBe(before);
    });

    it('an invalid ЕИК is refused BEFORE the farm is created', async () => {
        // Checksum failure is a statement about the number, not about who holds
        // it, so this one may speak plainly. It must also refuse before any
        // tenant exists — otherwise a typo leaves a farm behind.
        const before = await verifier.tenant.count();
        await expect(
            createFarmForUser(creator(), { name: `Невалиден ${RUN}`, eik: '123456789' }),
        ).rejects.toMatchObject({ code: 'EIK_INVALID' });
        expect(await verifier.tenant.count()).toBe(before);
    });

    it('a name that cannot be slugged is refused', async () => {
        await expect(createFarmForUser(creator(), { name: '!!! ???' })).rejects.toThrow();
    });
});
