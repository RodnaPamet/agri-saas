/**
 * Seed the GLOBAL agriculture-events catalogue (#15) with DEMO rows.
 *
 * Exported as `seedAgriEvents(prisma)` so the composed seeds can call it (the
 * `importUnits(prisma)` shape), and runnable standalone:
 *
 *   npx tsx scripts/seed-agri-events.ts
 *
 * Idempotent — keyed by a fixed id per row, so re-running updates rather than
 * duplicating. Dates are relative to "now" so the feed always shows upcoming
 * items.
 *
 * **These rows are demo fixtures and must never reach production.** The dates
 * are synthetic — in particular "CAP direct payments — application deadline" is
 * a plausible-looking but INVENTED regulatory date, and a farmer who trusted it
 * could miss the real one. Callers are therefore `prisma/seed.ts` (local dev),
 * `seed:demo`, and `seed:staging` only. Production is curated exclusively
 * through the platform-admin API (`POST /api/admin/agri-events`).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AgriEventCategory } from '@/app-layer/schemas/agri-event.schemas';

function inDays(days: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
}

interface AgriEventSeed {
    id: string;
    title: string;
    description: string | null;
    category: AgriEventCategory;
    startsAt: Date;
    endsAt: Date | null;
    place: string | null;
    url: string | null;
}

/**
 * `category` is typed, not free string — a typo here is a compile error rather
 * than a row that silently reads back as a fair.
 */
const EVENTS: AgriEventSeed[] = [
    {
        id: 'demo-agri-event-agra',
        title: 'AGRA — International Agricultural Exhibition (Plovdiv)',
        description: 'The largest agricultural fair in Bulgaria — machinery, inputs, and services.',
        category: 'fair',
        startsAt: inDays(20),
        endsAt: inDays(24),
        place: 'International Fair Plovdiv',
        url: 'https://www.fair.bg/en/agra',
    },
    {
        id: 'demo-agri-event-ipm-webinar',
        title: 'Integrated Pest Management — online training',
        description: 'Practical IPM for arable crops: scouting, thresholds, and spray windows.',
        category: 'webinar',
        startsAt: inDays(7),
        endsAt: null,
        place: 'Online',
        url: null,
    },
    {
        id: 'demo-agri-event-capsubsidy',
        title: 'CAP direct payments — application deadline (demo)',
        description:
            'DEMO ROW — the date is synthetic. Final day to submit the campaign direct-payment application.',
        category: 'subsidy-deadline',
        startsAt: inDays(35),
        endsAt: null,
        place: null,
        url: null,
    },
    {
        id: 'demo-agri-event-soil-training',
        title: 'Soil health & precision fertilisation — field day',
        description:
            'Hands-on session on soil sampling, interpretation, and variable-rate fertilisation.',
        category: 'training',
        startsAt: inDays(12),
        endsAt: null,
        place: 'Dobrich region',
        url: null,
    },
];

/** Upsert every demo event; returns {created, updated}. Exported for the composed seeds + tests. */
export async function seedAgriEvents(
    prisma: Pick<PrismaClient, 'agriEvent'>,
    seeds: AgriEventSeed[] = EVENTS,
): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    for (const e of seeds) {
        const { id, ...data } = e;
        const existing = await prisma.agriEvent.findUnique({ where: { id } });
        await prisma.agriEvent.upsert({ where: { id }, create: { id, ...data }, update: data });
        if (existing) updated += 1;
        else created += 1;
    }
    return { created, updated };
}

async function main(): Promise<void> {
    const prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
    });
    try {
        const { created, updated } = await seedAgriEvents(prisma);
        console.log(`Seeded agriculture events — created ${created}, updated ${updated}.`);
    } finally {
        await prisma.$disconnect();
    }
}

// Only run when invoked directly, so importing the helper doesn't open a client.
if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
