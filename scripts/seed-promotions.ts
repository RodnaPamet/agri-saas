/**
 * Seed the GLOBAL supplier + promotions catalogue (#12) with DEMO rows.
 *
 * Exported as `seedPromotions(prisma)` so the composed seeds can call it (the
 * `importUnits(prisma)` shape), and runnable standalone:
 *
 *   npx tsx scripts/seed-promotions.ts
 *
 * Idempotent — keyed by a fixed id per row, so re-running updates rather than
 * duplicating. `validTo` is relative to "now" so the feed always shows active
 * offers.
 *
 * **Demo fixtures — never production.** The company names are real Bulgarian
 * agri suppliers, but the offers are invented and the contact addresses are
 * `@example.com` on purpose: the lead-digest job emails `Company.contactEmail`,
 * and a demo row carrying a real address would send a real supplier mail about
 * a campaign they never bought. Production is curated by platform support.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

function inDays(days: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
}

/** Mirrors `companyNameKey` in the promotions usecase. */
function nameKey(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

interface CompanySeed {
    id: string;
    name: string;
    websiteUrl: string | null;
    contactName: string;
    contactEmail: string;
}

const COMPANIES: CompanySeed[] = [
    {
        id: 'demo-company-agropolychim',
        name: 'Agropolychim',
        websiteUrl: 'https://www.agropolychim.bg',
        contactName: 'Demo Contact',
        contactEmail: 'demo-agropolychim@example.com',
    },
    {
        id: 'demo-company-limagrain',
        name: 'Limagrain',
        websiteUrl: null,
        contactName: 'Demo Contact',
        contactEmail: 'demo-limagrain@example.com',
    },
    {
        id: 'demo-company-syngenta',
        name: 'Syngenta',
        websiteUrl: null,
        contactName: 'Demo Contact',
        contactEmail: 'demo-syngenta@example.com',
    },
    {
        id: 'demo-company-agrolab',
        name: 'AgroLab',
        websiteUrl: null,
        contactName: 'Demo Contact',
        contactEmail: 'demo-agrolab@example.com',
    },
];

interface PromotionSeed {
    id: string;
    companyId: string;
    title: string;
    body: string;
    category: string;
    ctaUrl: string | null;
    validFrom: Date | null;
    validTo: Date | null;
}

const PROMOTIONS: PromotionSeed[] = [
    {
        id: 'demo-promo-fertilizer-spring',
        companyId: 'demo-company-agropolychim',
        title: 'Spring NPK — 10% off bulk orders',
        body: 'Volume discount on NPK 15-15-15 for orders above 24 tonnes. Delivery included in Northern Bulgaria.',
        category: 'fertilizer',
        ctaUrl: 'https://www.agropolychim.bg',
        validFrom: inDays(-3),
        validTo: inDays(40),
    },
    {
        id: 'demo-promo-seeds-sunflower',
        companyId: 'demo-company-limagrain',
        title: 'Sunflower hybrids — early-booking offer',
        body: 'High-oleic hybrids with agronomy support. Book before the campaign for preferential pricing.',
        category: 'seeds',
        ctaUrl: null,
        validFrom: inDays(-10),
        validTo: inDays(25),
    },
    {
        id: 'demo-promo-products-fungicide',
        companyId: 'demo-company-syngenta',
        title: 'Cereal fungicide programme — bundle deal',
        body: 'T1 + T2 protection bundle for wheat and barley, with resistance-management guidance.',
        category: 'products',
        ctaUrl: null,
        validFrom: null,
        validTo: inDays(30),
    },
    {
        id: 'demo-promo-service-soil',
        companyId: 'demo-company-agrolab',
        title: 'Soil sampling & analysis — field-day rate',
        body: 'Grid soil sampling with full nutrient panel and variable-rate fertilisation maps.',
        category: 'service',
        ctaUrl: null,
        validFrom: null,
        validTo: null,
    },
];

/** Upsert suppliers then their promotions. Exported for the composed seeds + tests. */
export async function seedPromotions(
    prisma: Pick<PrismaClient, 'company' | 'promotion'>,
): Promise<{ companies: number; promotions: number }> {
    for (const c of COMPANIES) {
        const { id, name, ...rest } = c;
        const data = { name, nameKey: nameKey(name), ...rest };
        await prisma.company.upsert({ where: { id }, create: { id, ...data }, update: data });
    }

    for (const p of PROMOTIONS) {
        const { id, ...rest } = p;
        // Demo rows are published — the point is a populated feed. Support's
        // own flow creates drafts first.
        const data = { ...rest, publishedAt: new Date() };
        await prisma.promotion.upsert({ where: { id }, create: { id, ...data }, update: data });
    }

    return { companies: COMPANIES.length, promotions: PROMOTIONS.length };
}

async function main(): Promise<void> {
    const prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
    });
    try {
        const { companies, promotions } = await seedPromotions(prisma);
        console.log(`Seeded ${companies} companies and ${promotions} promotions.`);
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
