#!/usr/bin/env tsx
/**
 * Seed the GLOBAL satellite-imagery guide (W5, final task — folds
 * `/knowledge/satellite/page.tsx` into the KnowledgeArticle model).
 *
 * One bg + one en `KnowledgeArticle` (+ v1 `KnowledgeArticleVersion`) per
 * vegetation index (NDVI/NDMI/NDRE/GNDVI/EVI), written as GLOBAL rows
 * (`tenantId: null`) via the default (superuser-bypassed) Prisma client —
 * mirrors `scripts/rag/ingest-corpus.ts`'s GLOBAL `KnowledgeChunk` write.
 * GLOBAL rows are readable by every tenant through the asymmetric RLS
 * policy on `KnowledgeArticle` / `KnowledgeArticleVersion` (migration
 * 20260809130000_knowledge_global_articles); they can only be WRITTEN off
 * the app_user path, so a tenant-scoped `runInTenantContext` write would
 * be rejected by `WITH CHECK (own)` even if someone tried.
 *
 * This content used to be tenant-scoped (`SATELLITE_GUIDES` in
 * `scripts/import-knowledge.ts`, requiring `npm run import:knowledge` per
 * tenant before it showed up). Promoted to GLOBAL here so every tenant —
 * including ones that never run a seed script — gets it for free, the
 * same reasoning that already applies to `GROWING_GUIDES`' deep agronomy
 * content living once in `scripts/rag/corpus.ts`'s `GLOBAL_CORPUS`
 * instead of being duplicated per tenant.
 *
 * Idempotent on (tenantId: null, slug) — Prisma's generated
 * `tenantId_slug` compound-unique key cannot express a NULL lookup
 * (`WHERE "tenantId" IS NULL AND slug = $1` is not what a Prisma
 * `findUnique({ where: { tenantId_slug: { tenantId: null, slug } } })`
 * reliably produces), so this script checks via `findFirst` instead —
 * see the partial unique index in the migration for the DB-level
 * uniqueness guarantee this mirrors.
 *
 * `createdById` — GLOBAL content still needs a real, displayable author
 * (`KnowledgeArticleVersion.createdById` stays a required FK to `User`
 * even for GLOBAL rows; see the schema header). `getOrCreatePlatformAuthor`
 * upserts one designated "platform author" User row (no password, cannot
 * sign in) the same way `createTenantWithOwner` upserts a placeholder
 * owner — by `emailHash`, idempotent.
 *
 * Usage:
 *   tsx scripts/rag/ingest-satellite-guide.ts
 *   npm run rag:ingest:satellite
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { sanitizeRichTextHtml } from '../../src/lib/security/sanitize';
import { hashForLookup } from '../../src/lib/security/encryption';
import { assertNoUnregisteredRegulatedContent } from './dose-phi-guard';

/** Provenance label — same original-content label used for the growing
 *  guides (`AGRONOMY_SOURCE` in scripts/import-knowledge.ts) and the
 *  GLOBAL_CORPUS entries in scripts/rag/corpus.ts. Kept as a literal here
 *  (no import-time coupling to either module). */
const SOURCE = 'Agri-SaaS agronomy desk (original)';

/** MUST match `SATELLITE_ARTICLE_CATEGORY` in
 *  `src/app-layer/usecases/knowledge.ts` and
 *  `src/app/t/[tenantSlug]/(app)/knowledge/satellite/page.tsx`. */
const CATEGORY = 'Satellite Imagery';

/** The designated platform-authored-content User — no password, cannot
 *  sign in. Idempotent upsert by `emailHash`, mirroring
 *  `createTenantWithOwner` in `src/app-layer/usecases/tenant-lifecycle.ts`. */
const PLATFORM_AUTHOR_EMAIL = 'knowledge-platform@agri-saas.internal';
const PLATFORM_AUTHOR_NAME = 'Agri-SaaS Knowledge Team';

interface GlobalArticleSeed {
    slug: string;
    title: string;
    summary: string;
    /** TipTap-compatible HTML. */
    content: string;
    language: 'bg' | 'en';
}

/**
 * Satellite vegetation-index guides — one bg + one en article per index,
 * moved verbatim from the former tenant-scoped `SATELLITE_GUIDES` in
 * `scripts/import-knowledge.ts`. Agronomy/remote-sensing explainer only —
 * no dose/PHI/REI content is possible here (nothing about spraying), but
 * every entry still runs through the same hard-rule gate as everything
 * else this product authors, for defence in depth.
 */
export const SATELLITE_GUIDES: GlobalArticleSeed[] = [
    {
        slug: 'satellite-ndvi-bg',
        title: 'NDVI — жизненост на посева',
        summary: 'Как да четете сателитния индекс NDVI за жизненост на посева.',
        language: 'bg',
        content:
            '<h2>NDVI — жизненост на посева</h2><p>NDVI сравнява червената и близката инфрачервена светлина, за да измери количеството здрава, фотосинтезираща листна маса. Най-полезен е от пълно покритие на почвата до средата на сезона; при много гъст листен покрив се насища, затова тогава е по-подходящо да се погледне EVI или NDRE.</p>' +
            '<p><strong>Как да четете цветовете:</strong> червено-кафяво отбелязва гола почва, пропуски в посева или стресирани и подсъхващи растения; жълто е рядко или възстановяващо се покритие; тъмнозелено е гъст, жизнен посев. Търсете червени петна в поле, което иначе би трябвало да е равномерно зелено.</p>',
    },
    {
        slug: 'satellite-ndvi-en',
        title: 'NDVI — canopy vigour',
        summary: 'How to read the NDVI satellite index for canopy vigour.',
        language: 'en',
        content:
            '<h2>NDVI — canopy vigour</h2><p>NDVI compares red and near-infrared light to measure how much healthy, photosynthesising leaf area is present. It is most useful from full ground cover to mid-season; in a very dense canopy it saturates, so EVI or NDRE become the better read then.</p>' +
            '<p><strong>How to read the colours:</strong> red-brown marks bare soil, gaps, or stressed and senescing plants; yellow is thin or recovering cover; deep green is a dense, vigorous canopy. Scan for red patches inside a field that should otherwise be uniformly green.</p>',
    },
    {
        slug: 'satellite-ndmi-bg',
        title: 'NDMI — влажност на посева',
        summary: 'Как да четете сателитния индекс NDMI за влажност на посева.',
        language: 'bg',
        content:
            '<h2>NDMI — влажност на посева</h2><p>NDMI проследява водното съдържание в листния покрив, използвайки близка и късовълнова инфрачервена светлина, затова сигнализира воден стрес преди той да стане видим за окото. Полезен е за преценка на неравномерно изсъхване на посева и за сравнение на напоявани спрямо неполивни площи.</p>' +
            '<p><strong>Как да четете цветовете:</strong> червено е сух, воднострадащ посев; през бледожълто до синьо е постепенно по-добре хидратиран посев. Разглеждайте този индекс особено в горещи, сухи периоди.</p>',
    },
    {
        slug: 'satellite-ndmi-en',
        title: 'NDMI — canopy moisture',
        summary: 'How to read the NDMI satellite index for canopy moisture.',
        language: 'en',
        content:
            '<h2>NDMI — canopy moisture</h2><p>NDMI tracks water content in the canopy using near-infrared and shortwave-infrared light, so it flags moisture stress before it is visible to the eye. Useful for judging uneven crop dry-down and for comparing irrigated against rain-fed blocks.</p>' +
            '<p><strong>How to read the colours:</strong> red is dry, moisture-stressed canopy; through pale yellow to blue is progressively better-hydrated crop. Reach for it in hot, dry spells.</p>',
    },
    {
        slug: 'satellite-ndre-bg',
        title: 'NDRE — хлорофил и азотен статус',
        summary: 'Как да четете сателитния индекс NDRE за хлорофил и азот.',
        language: 'bg',
        content:
            '<h2>NDRE — хлорофил и азотен статус</h2><p>NDRE използва лентата „red-edge“, която остава чувствителна в гъст, средно- и късносезонен посев, където NDVI вече се е наситил. Проследява съдържанието на хлорофил — добър индикатор за азотния статус — затова е индексът за преценка на неравномерно азотно хранене по полето.</p>' +
            '<p><strong>Как да четете цветовете:</strong> лилаво отбелязва нисък хлорофил (възможен азотен недостиг); през бяло до тъмнозелено е нарастващ хлорофил и жизненост. Използвайте го в късния сезон или при буен посев.</p>',
    },
    {
        slug: 'satellite-ndre-en',
        title: 'NDRE — chlorophyll & nitrogen',
        summary: 'How to read the NDRE satellite index for chlorophyll and nitrogen.',
        language: 'en',
        content:
            '<h2>NDRE — chlorophyll & nitrogen</h2><p>NDRE uses the red-edge band, which stays sensitive in a thick, mid-to-late-season canopy where NDVI has already saturated. It tracks chlorophyll — a good proxy for nitrogen status — so it is the layer for judging uneven nitrogen nutrition across a field.</p>' +
            '<p><strong>How to read the colours:</strong> purple marks low chlorophyll (a possible nitrogen shortfall); through white to deep green is increasing chlorophyll and vigour. Use it late-season or in a lush crop.</p>',
    },
    {
        slug: 'satellite-gndvi-bg',
        title: 'GNDVI — зелена жизненост',
        summary: 'Как да четете сателитния индекс GNDVI за зелена жизненост.',
        language: 'bg',
        content:
            '<h2>GNDVI — зелена жизненост</h2><p>GNDVI е близък на NDVI, но заменя червената лента със зелена, което го прави по-чувствителен към хлорофил и азот и по-бавно насищащ се при гъст посев. Служи като допълнителна проверка на хранителния статус и фотосинтетичната активност.</p>' +
            '<p><strong>Как да четете цветовете:</strong> бледокремаво е слаб или разреден растеж; задълбочаващо се зелено е по-висок хлорофил и по-силен посев. Сравнявайте го с NDVI.</p>',
    },
    {
        slug: 'satellite-gndvi-en',
        title: 'GNDVI — green vigour',
        summary: 'How to read the GNDVI satellite index for green vigour.',
        language: 'en',
        content:
            '<h2>GNDVI — green vigour</h2><p>GNDVI is a close relative of NDVI that swaps the red band for the green one, making it more sensitive to chlorophyll and nitrogen and slower to saturate in a dense canopy. A useful second check on nutrient status and photosynthetic activity.</p>' +
            '<p><strong>How to read the colours:</strong> pale cream is weak or sparse growth; deepening green is higher chlorophyll and a stronger canopy. Compare it against NDVI.</p>',
    },
    {
        slug: 'satellite-evi-bg',
        title: 'EVI — подобрена вегетационна оценка',
        summary: 'Как да четете сателитния индекс EVI за подобрена вегетационна оценка.',
        language: 'bg',
        content:
            '<h2>EVI — подобрена вегетационна оценка</h2><p>EVI е подобрена версия на NDVI, която коригира за атмосферна мъгла и яркост на фона на почвата и се насища по-трудно при висока биомаса. Затова е най-надеждният индекс за жизненост в пика на сезона и при горещи, мъгливи условия.</p>' +
            '<p><strong>Как да четете цветовете:</strong> тъмно лилаво-синьо е рядка или стресирана растителност; през тюркоазено и зелено до жълто е все по-гъст, жизнен посев. Предпочитайте го пред NDVI при пълно листно покритие.</p>',
    },
    {
        slug: 'satellite-evi-en',
        title: 'EVI — enhanced vegetation',
        summary: 'How to read the EVI satellite index for enhanced vegetation.',
        language: 'en',
        content:
            '<h2>EVI — enhanced vegetation</h2><p>EVI is an improved NDVI that corrects for atmospheric haze and background soil brightness and resists saturating in high-biomass crops. The most reliable vigour layer at peak season and in hot, hazy conditions.</p>' +
            '<p><strong>How to read the colours:</strong> dark purple-blue is sparse or stressed vegetation; through teal and green to yellow is an increasingly dense, vigorous canopy. Prefer it over NDVI once the crop is at full canopy.</p>',
    },
];

export interface IngestSatelliteGuideResult {
    created: number;
    skipped: number;
}

/** Idempotent upsert of the designated platform-author User row. */
async function getOrCreatePlatformAuthor(prisma: PrismaClient): Promise<string> {
    const emailHash = hashForLookup(PLATFORM_AUTHOR_EMAIL);
    const user = await prisma.user.upsert({
        where: { emailHash },
        update: {},
        create: { email: PLATFORM_AUTHOR_EMAIL, emailHash, name: PLATFORM_AUTHOR_NAME },
        select: { id: true },
    });
    return user.id;
}

/** Seed the GLOBAL satellite-imagery guide. Idempotent on (tenantId: null, slug). */
export async function ingestSatelliteGuide(prisma: PrismaClient): Promise<IngestSatelliteGuideResult> {
    const authorId = await getOrCreatePlatformAuthor(prisma);

    let created = 0;
    let skipped = 0;

    for (const guide of SATELLITE_GUIDES) {
        // Dose/PHI/REI hard-rule gate (see scripts/rag/dose-phi-guard.ts) —
        // scans title + summary + content so a violation anywhere in the
        // authored guide is caught before anything is written.
        assertNoUnregisteredRegulatedContent(`${guide.title} ${guide.summary} ${guide.content}`, guide.slug);

        // Prisma's compound-unique `tenantId_slug` key cannot express a
        // NULL-tenant lookup reliably — findFirst is unambiguous.
        const existing = await prisma.knowledgeArticle.findFirst({
            where: { tenantId: null, slug: guide.slug },
            select: { id: true },
        });
        if (existing) {
            skipped++;
            continue;
        }

        const article = await prisma.knowledgeArticle.create({
            data: {
                tenantId: null,
                slug: guide.slug,
                title: guide.title,
                summary: guide.summary,
                category: CATEGORY,
                source: SOURCE,
                language: guide.language,
                cropTags: [],
                ownerUserId: authorId,
                status: 'PUBLISHED',
            },
            select: { id: true },
        });
        const version = await prisma.knowledgeArticleVersion.create({
            data: {
                tenantId: null,
                articleId: article.id,
                versionNumber: 1,
                contentType: 'HTML',
                contentText: sanitizeRichTextHtml(guide.content),
                changeSummary: 'Seeded — GLOBAL satellite-imagery guide',
                createdById: authorId,
            },
            select: { id: true },
        });
        await prisma.knowledgeArticle.update({
            where: { id: article.id },
            data: { currentVersionId: version.id },
        });
        created++;
    }

    return { created, skipped };
}

async function main(): Promise<number> {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    try {
        const res = await ingestSatelliteGuide(prisma);
        console.log(`Satellite guide (GLOBAL): ${res.created} created, ${res.skipped} already present.`);
        return 0;
    } finally {
        await prisma.$disconnect();
    }
}

// `typeof module !== 'undefined'` guards this CJS entry-point check for
// callers that import this file's named exports from a real ESM
// context (scripts/seed.ts, bundled by esbuild into dist/seed.mjs —
// `module` is not a defined identifier there, and a bare
// `require.main === module` throws `ReferenceError: module is not
// defined in ES module scope`). Under tsx and ts-jest (both of which
// shim `require`/`module` as CJS-interop globals) this behaves exactly
// as before.
if (typeof module !== 'undefined' && require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error('Satellite guide ingestion failed:', err);
        process.exit(1);
    });
}
