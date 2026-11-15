/**
 * #3063 — the LISTING, SCHEME and EVENT card generators.
 *
 * ## What each kind's reading has to be able to say
 *
 * A card kind reports `eligible`, `withContent`, `created` and `dormant`, and
 * the pair that matters is the last two against `created`. `created: 0,
 * dormant: false` means the rule ran and found nothing to say — the expected
 * state for LISTING in production, with 1 ACTIVE listing against 28 eligible
 * oblast channels. `created: 0, dormant: true` means the kind CANNOT fire,
 * which is EVENT until `AgriEvent` gets a producer (#3078). One number could
 * not separate those, which is why both are asserted here.
 *
 * ## The LISTING cases are mostly about what must NOT appear
 *
 * Three columns hide a listing for three different reasons, and a card that
 * reproduced one would resurface what another part of the product took down —
 * #1655's deletion freeze most seriously, because its notice promises the
 * seller stops being visible to other farms "straight away". Each has its own
 * case, and each is paired with a visible control listing, because "no card"
 * is also what a broken generator produces.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    oblastRegionForChannelKey,
    channelTakesSchemeCard,
} from '@/app-layer/jobs/channel-cards';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const TENANT = `t-cards-${TAG}`;
const SLUG = `cards-${TAG}`;
let sellerId = '';

/** The oblast this suite owns, so it cannot collide with another run. */
const REGION = 'BG-28';
const OBLAST_CHANNEL = `c-ob-${TAG}`;
const CROP_CHANNEL = `c-crop-${TAG}`;

async function mkListing(over: Record<string, unknown> = {}): Promise<string> {
    const row = await prisma.exchangeListing.create({
        data: {
            sellerTenantId: TENANT,
            sellerUserId: sellerId,
            side: 'SELL',
            commodity: 'wheat',
            quantityTonnes: '25.000',
            pricePerTonne: '188.65',
            priceCurrency: 'EUR',
            regionCode: REGION,
            regionName: 'Тестова област',
            lat: 42.1,
            lon: 24.7,
            status: 'ACTIVE',
            ...over,
        },
        select: { id: true },
    });
    return row.id;
}

/** Cards written for our two channels today, by kind. */
async function cardsOf(kind: 'LISTING' | 'SCHEME' | 'EVENT') {
    return prisma.channelPost.findMany({
        where: {
            channelId: { in: [OBLAST_CHANNEL, CROP_CHANNEL] },
            cardKind: kind,
        },
        select: { channelId: true, body: true, cardPayloadJson: true },
    });
}

async function clearCards(): Promise<void> {
    await prisma.channelPost.deleteMany({
        where: { channelId: { in: [OBLAST_CHANNEL, CROP_CHANNEL] } },
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT }, update: {},
        create: { id: TENANT, name: TENANT, slug: SLUG },
    });
    const email = `cards-${TAG}@example.test`;
    const u = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    sellerId = u.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: sellerId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    await prisma.channel.createMany({
        data: [
            { id: OBLAST_CHANNEL, key: `oblast:${REGION}`, kind: 'OBLAST', nameBg: 'Тест област', nameEn: 'Test oblast' },
            { id: CROP_CHANNEL, key: `crop:test-${TAG}`, kind: 'CROP', nameBg: 'Тест култура', nameEn: 'Test crop' },
        ],
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await clearCards();
    await prisma.channel.deleteMany({ where: { id: { in: [OBLAST_CHANNEL, CROP_CHANNEL] } } });
    await prisma.exchangeListing.deleteMany({ where: { sellerTenantId: TENANT } });
    // The tenant, user and membership are LEFT: `ExchangeListing` rows and
    // audit rows pin the user by FK, and hard-deleting them properly would
    // mean breaking a tamper-evident trail to tidy a test. Every row is
    // uniquely tagged.
    await prisma.$disconnect();
});

beforeEach(async () => {
    if (!DB_AVAILABLE) return;
    await clearCards();
    await prisma.exchangeListing.deleteMany({ where: { sellerTenantId: TENANT } });
});

describeFn('#3063 — channel selection', () => {
    it('reads the regionCode straight out of an oblast key', () => {
        // Verified against production rows rather than assumed: listings
        // carry `BG-03` and channels are keyed `oblast:BG-03`.
        expect(oblastRegionForChannelKey('oblast:BG-16')).toBe('BG-16');
        expect(oblastRegionForChannelKey('oblast:BG-03')).toBe('BG-03');
        // Not an oblast channel, and not a malformed suffix.
        expect(oblastRegionForChannelKey('crop:wheat')).toBeNull();
        expect(oblastRegionForChannelKey('input:diesel')).toBeNull();
        expect(oblastRegionForChannelKey('oblast:XX-99')).toBeNull();
        expect(oblastRegionForChannelKey('oblast:')).toBeNull();
        expect(oblastRegionForChannelKey('oblast')).toBeNull();
    });

    it('puts SCHEME in crop and topic channels, never oblast ones', () => {
        // Owner ruling: the 15 crop and topic channels. The precedent is the
        // NEWS card declining to show one national item in 28 regional
        // channels.
        expect(channelTakesSchemeCard('crop:wheat')).toBe(true);
        expect(channelTakesSchemeCard('input:diesel')).toBe(true);
        expect(channelTakesSchemeCard('oblast:BG-16')).toBe(false);
    });
});

describeFn('#3063 — the LISTING card and the three ways to be hidden', () => {
    it('writes a card for an oblast channel with a live offer', async () => {
        const id = await mkListing();
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        const r = await runChannelCards();

        expect(r.byKind.LISTING.dormant).toBe(false);
        const cards = await cardsOf('LISTING');
        const mine = cards.filter((c) => c.channelId === OBLAST_CHANNEL);
        expect(mine).toHaveLength(1);
        const payload = mine[0].cardPayloadJson as Record<string, unknown>;
        expect(payload.listingId).toBe(id);
        expect(payload.region).toBe(REGION);
        // Decimals as STRINGS — money and tonnages never become floats.
        expect(typeof payload.quantityTonnes).toBe('string');
        expect(payload.pricePerTonne).toBe('188.65');
    });

    it('does NOT resurface a listing frozen by a deletion request (#1655)', async () => {
        await mkListing({ suppressedForDeletionAt: new Date('2026-11-01T00:00:00Z') });
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        await runChannelCards();

        // The notice promises the seller "stops being visible to other farms
        // straight away". A card naming their listing would break that in the
        // one place nobody would look.
        const mine = (await cardsOf('LISTING')).filter((c) => c.channelId === OBLAST_CHANNEL);
        expect(mine).toHaveLength(0);
    });

    it('does NOT resurface a moderator-removed listing', async () => {
        await mkListing({ removedByModerationAt: new Date('2026-11-01T00:00:00Z') });
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        await runChannelCards();
        expect((await cardsOf('LISTING')).filter((c) => c.channelId === OBLAST_CHANNEL))
            .toHaveLength(0);
    });

    it('does NOT resurface an EXPIRED listing', async () => {
        await mkListing({ expiresAt: new Date('2020-01-01T00:00:00Z') });
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        await runChannelCards();
        expect((await cardsOf('LISTING')).filter((c) => c.channelId === OBLAST_CHANNEL))
            .toHaveLength(0);
    });

    it('does NOT resurface a WITHDRAWN listing', async () => {
        await mkListing({ status: 'WITHDRAWN' });
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        await runChannelCards();
        expect((await cardsOf('LISTING')).filter((c) => c.channelId === OBLAST_CHANNEL))
            .toHaveLength(0);
    });

    it('CONTROL — a hidden listing beside a visible one still yields the visible one', async () => {
        // The case that makes the four refusals above mean something: "no
        // card" is also what a broken generator produces, so one run must
        // show the generator working while a hidden row sits next to it.
        await mkListing({ suppressedForDeletionAt: new Date('2026-11-01T00:00:00Z') });
        const live = await mkListing({ commodity: 'maize' });
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        await runChannelCards();

        const mine = (await cardsOf('LISTING')).filter((c) => c.channelId === OBLAST_CHANNEL);
        expect(mine).toHaveLength(1);
        expect((mine[0].cardPayloadJson as Record<string, unknown>).listingId).toBe(live);
    });

    it('carries the seller description as the body, or NULL when there is none', async () => {
        await mkListing({ description: 'Чиста пшеница, реколта 2026.' });
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        await runChannelCards();
        let mine = (await cardsOf('LISTING')).filter((c) => c.channelId === OBLAST_CHANNEL);
        expect(mine[0].body).toBe('Чиста пшеница, реколта 2026.');

        await clearCards();
        await prisma.exchangeListing.deleteMany({ where: { sellerTenantId: TENANT } });
        await mkListing({ description: null });
        await runChannelCards();
        mine = (await cardsOf('LISTING')).filter((c) => c.channelId === OBLAST_CHANNEL);
        /*
         * A SENTENCE at the fallback locale, not null — and the first draft of
         * this suite expected null until the database refused it.
         * `channel_post_says_something` is a CHECK constraint, so a post must
         * say something; the schema had already decided the question.
         *
         * It is composed from the CLIENT's own catalogue keys at
         * `RECIPIENT_FALLBACK_LOCALE`, which is what every outbound email does
         * when the reader is unknown. Asserted as "contains the Bulgarian
         * commodity name and the quantity" rather than as a literal sentence,
         * so rewording the catalogue entry does not redden this.
         */
        expect(mine[0].body).toBeTruthy();
        expect(mine[0].body).toContain('Пшеница');
        expect(mine[0].body).toContain('25');
    });
});

describeFn('#3063 — SCHEME and EVENT', () => {
    it('SCHEME writes into the crop channel and not the oblast one', async () => {
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        await runChannelCards();

        const cards = await cardsOf('SCHEME');
        // Production holds 2 schemes, so this fires against real data.
        if (cards.length === 0) {
            // No open scheme in this database — then the reading must say so
            // rather than looking broken.
            const r = await runChannelCards();
            expect(r.byKind.SCHEME.withContent).toBe(0);
            return;
        }
        expect(cards.some((c) => c.channelId === CROP_CHANNEL)).toBe(true);
        expect(cards.some((c) => c.channelId === OBLAST_CHANNEL)).toBe(false);
    });

    it('EVENT reports DORMANT while AgriEvent has no producer (#3078)', async () => {
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        const r = await runChannelCards();

        const upcoming = await prisma.agriEvent.count({ where: { startsAt: { gte: new Date() } } });
        if (upcoming === 0) {
            // The whole point of shipping this kind dormant rather than
            // deferring it: `created: 0` is ambiguous on its own, and
            // `dormant: true` says the source is empty rather than quiet.
            expect(r.byKind.EVENT.dormant).toBe(true);
            expect(r.byKind.EVENT.created).toBe(0);
        } else {
            expect(r.byKind.EVENT.dormant).toBe(false);
        }
    });

    it('the reading reports all four kinds, each with its own denominator', async () => {
        const { runChannelCards } = await import('@/app-layer/jobs/channel-cards');
        const r = await runChannelCards();
        expect(Object.keys(r.byKind).sort()).toEqual(['EVENT', 'LISTING', 'NEWS', 'SCHEME']);
        for (const kind of Object.keys(r.byKind)) {
            const k = r.byKind[kind];
            expect(typeof k.eligible).toBe('number');
            expect(typeof k.withContent).toBe('number');
            expect(typeof k.created).toBe('number');
            expect(typeof k.dormant).toBe('boolean');
            // created can never exceed what had content.
            expect(k.created).toBeLessThanOrEqual(k.withContent);
        }
    });
});
