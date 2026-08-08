#!/usr/bin/env tsx
/**
 * Seed the Knowledge Base with per-tenant demo growing-guide overviews
 * for Bulgaria's four major arable crops (PR 4/5 — replaces the earlier
 * OpenFarm-modelled home-garden vegetable guides, which had nothing to
 * do with Bulgarian arable farming).
 *
 * Content provenance: 100% original agronomy authored in this repository
 * — "Agri-SaaS agronomy desk (original)" — same source label and same
 * dose/PHI/REI gate as the GLOBAL corpus in scripts/rag/corpus.ts (see
 * that module's header for the hard rule this content must not violate).
 * These are short, tenant-scoped overview articles; the deep BBCH/
 * scouting/cultural-practice/harvest content lives ONCE in the GLOBAL
 * NULL-tenant catalog (scripts/rag/corpus.ts) rather than being
 * duplicated into every tenant — see this PR's implementation note
 * (docs/implementation-notes/2026-08-07-kb-bulgarian-agronomy-content.md)
 * for why. Each overview points the reader at that GLOBAL content.
 *
 * Bulgarian-first: each crop gets a `bg` article (the source) and an
 * `en` article (the translation) — two rows, two slugs, same crop.
 *
 * `SATELLITE_GUIDES` (W5/#93 — KB wire-up PR) folds the standalone
 * `/knowledge/satellite` guide page's content in the same way: one bg +
 * one en article per vegetation index (NDVI/NDMI/NDRE/GNDVI/EVI),
 * category "Satellite Imagery". `ALL_SEED_ARTICLES` is the combined
 * list this script actually seeds.
 *
 * Each guide becomes a PUBLISHED KnowledgeArticle (+ v1 version) in the
 * target tenant, authored by its first active OWNER/ADMIN. Idempotent:
 * re-running upserts by (tenantId, slug) and skips guides already present.
 *
 * Usage:
 *   tsx scripts/import-knowledge.ts                 # first tenant
 *   tsx scripts/import-knowledge.ts --tenant <slug> # a specific tenant
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { sanitizeRichTextHtml } from '../src/lib/security/sanitize';
import { assertNoUnregisteredRegulatedContent } from './rag/dose-phi-guard';

/** Provenance label — see the module header. Matches `LICENSED_SOURCES`
 *  in scripts/rag/corpus.ts (kept as a literal here so this script has
 *  no import-time dependency on the RAG corpus module beyond the guard). */
const AGRONOMY_SOURCE = 'Agri-SaaS agronomy desk (original)';

interface Guide {
    slug: string;
    title: string;
    summary: string;
    category: string;
    /** TipTap-compatible HTML. */
    content: string;
    language: 'bg' | 'en';
    cropTags: string[];
}

/** Bulgarian-first arable-crop overviews (bg source + en translation, one
 *  pair per crop). Agronomy only — no dose/PHI/REI (see module header). */
export const GROWING_GUIDES: Guide[] = [
    // ─── Wheat / Пшеница ───
    {
        slug: 'growing-guide-wheat-bg',
        title: 'Отглеждане на пшеница',
        summary: 'Есенна житна култура — основна земеделска култура за България.',
        category: 'Growing Guide',
        language: 'bg',
        cropTags: ['Wheat'],
        content:
            '<h2>Пшеница</h2><p>Есенна житна култура, една от четирите основни земеделски култури в България.</p>' +
            '<ul><li><strong>Сеитбооборот:</strong> избягвайте пшеница след пшеница повече от две поредни години.</li>' +
            '<li><strong>Гъстота на сеитба:</strong> съобразена със сорта и срока на сеитба, за балансирано братене.</li>' +
            '<li><strong>Наблюдение:</strong> редовен оглед за листни въшки, ръжда и брашнеста мана от вретенене нататък.</li>' +
            '<li><strong>Прибиране:</strong> при влажност на зърното около 12–14%, когато зърното е твърдо.</li></ul>' +
            '<p>Пълната BBCH скала, прагове за наблюдение и хранене без дози са налични в глобалната база от знания. Тази статия съзнателно не посочва конкретна норма на употреба, нито срокове, свързани с прибиране или връщане на площта — те са валидни само заедно с регистрационен номер на конкретен продукт от официалния регистър на БАБХ.</p>',
    },
    {
        slug: 'growing-guide-wheat-en',
        title: 'Growing wheat',
        summary: 'Autumn-sown cereal — one of Bulgaria’s four major arable crops.',
        category: 'Growing Guide',
        language: 'en',
        cropTags: ['Wheat'],
        content:
            '<h2>Wheat</h2><p>An autumn-sown cereal, one of Bulgaria’s four major arable crops.</p>' +
            '<ul><li><strong>Rotation:</strong> avoid wheat after wheat for more than two years running.</li>' +
            '<li><strong>Seeding density:</strong> matched to the variety and sowing date for balanced tillering.</li>' +
            '<li><strong>Scouting:</strong> regularly check for cereal aphids, rust, and powdery mildew from stem elongation onward.</li>' +
            '<li><strong>Harvest:</strong> around 12–14% grain moisture, once the grain is hard.</li></ul>' +
            '<p>The full BBCH scale, scouting thresholds, and nutrition timing without rates live in the global knowledge base. This article deliberately states no specific rate of use, and no waiting period tied to harvest or to returning to the field — those are only valid together with a specific product’s registration number from the official БАБХ register.</p>',
    },
    // ─── Barley / Ечемик ───
    {
        slug: 'growing-guide-barley-bg',
        title: 'Отглеждане на ечемик',
        summary: 'Есенна житна култура, узряваща по-рано от пшеницата.',
        category: 'Growing Guide',
        language: 'bg',
        cropTags: ['Barley'],
        content:
            '<h2>Ечемик</h2><p>Есенна житна култура, узряваща обикновено 1–2 седмици по-рано от пшеницата.</p>' +
            '<ul><li><strong>Предшественик:</strong> реагира добре след бобови или окопни култури.</li>' +
            '<li><strong>Гъстота на сеитба:</strong> братва по-интензивно от пшеницата, затова по-ниска норма често е достатъчна.</li>' +
            '<li><strong>Наблюдение:</strong> редовен оглед за мрежовидна петнистост и листни въшки от братене нататък.</li>' +
            '<li><strong>Прибиране:</strong> при влажност около 13–14%; класът лесно се рони при закъсняло прибиране.</li></ul>' +
            '<p>Пълната BBCH скала, прагове за наблюдение и хранене без дози са налични в глобалната база от знания. Тази статия съзнателно не посочва конкретна норма на употреба, нито срокове, свързани с прибиране или връщане на площта — те са валидни само заедно с регистрационен номер на конкретен продукт от официалния регистър на БАБХ.</p>',
    },
    {
        slug: 'growing-guide-barley-en',
        title: 'Growing barley',
        summary: 'Autumn-sown cereal that matures earlier than wheat.',
        category: 'Growing Guide',
        language: 'en',
        cropTags: ['Barley'],
        content:
            '<h2>Barley</h2><p>An autumn-sown cereal that typically matures 1–2 weeks earlier than wheat.</p>' +
            '<ul><li><strong>Preceding crop:</strong> responds well after legumes or row crops.</li>' +
            '<li><strong>Seeding density:</strong> barley tillers more heavily than wheat, so a lower rate is often enough.</li>' +
            '<li><strong>Scouting:</strong> regularly check for net blotch and cereal aphids from tillering onward.</li>' +
            '<li><strong>Harvest:</strong> around 13–14% moisture; the ear shatters easily if harvest is delayed.</li></ul>' +
            '<p>The full BBCH scale, scouting thresholds, and nutrition timing without rates live in the global knowledge base. This article deliberately states no specific rate of use, and no waiting period tied to harvest or to returning to the field — those are only valid together with a specific product’s registration number from the official БАБХ register.</p>',
    },
    // ─── Maize / Царевица ───
    {
        slug: 'growing-guide-maize-bg',
        title: 'Отглеждане на царевица',
        summary: 'Пролетна окопна култура за зърно или силаж.',
        category: 'Growing Guide',
        language: 'bg',
        cropTags: ['Maize'],
        content:
            '<h2>Царевица</h2><p>Пролетна култура, отглеждана за зърно или силаж.</p>' +
            '<ul><li><strong>Сеитба:</strong> едва когато почвата се затопли трайно за сезона — ранната сеитба в студена почва удължава покълването.</li>' +
            '<li><strong>Сеитбооборот:</strong> избягвайте повторение повече от 1–2 години в райони с натиск от стъблопробивач.</li>' +
            '<li><strong>Наблюдение:</strong> оглед на фунията за есенен армейски червей и стъблопробивач от поникване до стъблено удължаване.</li>' +
            '<li><strong>Прибиране:</strong> след появата на „черния слой“ при основата на зърното (физиологична зрялост).</li></ul>' +
            '<p>Пълната BBCH скала, прагове за наблюдение и хранене без дози са налични в глобалната база от знания. Тази статия съзнателно не посочва конкретна норма на употреба, нито срокове, свързани с прибиране или връщане на площта — те са валидни само заедно с регистрационен номер на конкретен продукт от официалния регистър на БАБХ.</p>',
    },
    {
        slug: 'growing-guide-maize-en',
        title: 'Growing maize',
        summary: 'Spring-sown row crop grown for grain or silage.',
        category: 'Growing Guide',
        language: 'en',
        cropTags: ['Maize'],
        content:
            '<h2>Maize</h2><p>A spring-sown crop grown for grain or silage.</p>' +
            '<ul><li><strong>Sowing:</strong> only once the soil has warmed durably for the season — sowing too early into cold soil prolongs germination.</li>' +
            '<li><strong>Rotation:</strong> avoid maize after maize for more than 1–2 years in areas with corn borer pressure.</li>' +
            '<li><strong>Scouting:</strong> inspect the whorl for fall armyworm and corn borer from emergence through stem elongation.</li>' +
            '<li><strong>Harvest:</strong> once the "black layer" appears at the kernel base (physiological maturity).</li></ul>' +
            '<p>The full BBCH scale, scouting thresholds, and nutrition timing without rates live in the global knowledge base. This article deliberately states no specific rate of use, and no waiting period tied to harvest or to returning to the field — those are only valid together with a specific product’s registration number from the official БАБХ register.</p>',
    },
    // ─── Sunflower / Слънчоглед ───
    {
        slug: 'growing-guide-sunflower-bg',
        title: 'Отглеждане на слънчоглед',
        summary: 'Пролетна маслодайна култура с най-дългия изискван сеитбооборот.',
        category: 'Growing Guide',
        language: 'bg',
        cropTags: ['Sunflower'],
        content:
            '<h2>Слънчоглед</h2><p>Пролетна маслодайна култура, изискваща едно от най-дългите редувания сред земеделските култури.</p>' +
            '<ul><li><strong>Сеитбооборот:</strong> обичайна препоръка е връщане на едно и също поле не по-рано от 4–5 години заради синя китка и мана.</li>' +
            '<li><strong>Сортов избор:</strong> устойчивост към местните раси синя китка е ключов критерий за поле с история на проблема.</li>' +
            '<li><strong>Наблюдение:</strong> оглед за закърнели, хлоротични растения (мана) скоро след поникване.</li>' +
            '<li><strong>Прибиране:</strong> когато гърбът на кошницата стане кафяв по цялата площ на полето.</li></ul>' +
            '<p>Пълната BBCH скала, прагове за наблюдение и хранене без дози са налични в глобалната база от знания. Тази статия съзнателно не посочва конкретна норма на употреба, нито срокове, свързани с прибиране или връщане на площта — те са валидни само заедно с регистрационен номер на конкретен продукт от официалния регистър на БАБХ.</p>',
    },
    {
        slug: 'growing-guide-sunflower-en',
        title: 'Growing sunflower',
        summary: 'Spring-sown oilseed crop with the longest required rotation.',
        category: 'Growing Guide',
        language: 'en',
        cropTags: ['Sunflower'],
        content:
            '<h2>Sunflower</h2><p>A spring-sown oilseed crop requiring one of the longest rotation intervals among field crops.</p>' +
            '<ul><li><strong>Rotation:</strong> a common recommendation is not returning to the same field sooner than 4–5 years, because of broomrape and downy mildew.</li>' +
            '<li><strong>Variety choice:</strong> resistance to the local broomrape races is a key criterion for a field with a history of the problem.</li>' +
            '<li><strong>Scouting:</strong> watch for stunted, chlorotic plants (downy mildew) shortly after emergence.</li>' +
            '<li><strong>Harvest:</strong> once the back of the head has turned brown across the whole field.</li></ul>' +
            '<p>The full BBCH scale, scouting thresholds, and nutrition timing without rates live in the global knowledge base. This article deliberately states no specific rate of use, and no waiting period tied to harvest or to returning to the field — those are only valid together with a specific product’s registration number from the official БАБХ register.</p>',
    },
];

// ═══════════════════════════════════════════════════════════════════
//  Satellite imagery guide (W5/#93 — KB wire-up PR)
// ═══════════════════════════════════════════════════════════════════
//
//  Folds the standalone `/knowledge/satellite` page's content into the
//  Article model: one bg + one en article per vegetation index, so the
//  same text is versioned, shows up in the searchable /knowledge list,
//  and (once published through the UI, which runs `enqueueReindex`
//  unlike this raw-seed path — see the module docstring above) is
//  retrievable. The GLOBAL, un-seeded half of this fold lives in
//  `scripts/rag/corpus.ts`'s `GLOBAL_CORPUS` (every tenant, no seeding
//  required); see that file's "Satellite vegetation indices" section
//  and the doc comment on `satellite/page.tsx` for the full picture of
//  what folded and what deliberately did not.
const SATELLITE_GUIDES: Guide[] = [
    {
        slug: 'satellite-ndvi-bg',
        title: 'NDVI — жизненост на посева',
        summary: 'Как да четете сателитния индекс NDVI за жизненост на посева.',
        category: 'Satellite Imagery',
        language: 'bg',
        cropTags: [],
        content:
            '<h2>NDVI — жизненост на посева</h2><p>NDVI сравнява червената и близката инфрачервена светлина, за да измери количеството здрава, фотосинтезираща листна маса. Най-полезен е от пълно покритие на почвата до средата на сезона; при много гъст листен покрив се насища, затова тогава е по-подходящо да се погледне EVI или NDRE.</p>' +
            '<p><strong>Как да четете цветовете:</strong> червено-кафяво отбелязва гола почва, пропуски в посева или стресирани и подсъхващи растения; жълто е рядко или възстановяващо се покритие; тъмнозелено е гъст, жизнен посев. Търсете червени петна в поле, което иначе би трябвало да е равномерно зелено.</p>',
    },
    {
        slug: 'satellite-ndvi-en',
        title: 'NDVI — canopy vigour',
        summary: 'How to read the NDVI satellite index for canopy vigour.',
        category: 'Satellite Imagery',
        language: 'en',
        cropTags: [],
        content:
            '<h2>NDVI — canopy vigour</h2><p>NDVI compares red and near-infrared light to measure how much healthy, photosynthesising leaf area is present. It is most useful from full ground cover to mid-season; in a very dense canopy it saturates, so EVI or NDRE become the better read then.</p>' +
            '<p><strong>How to read the colours:</strong> red-brown marks bare soil, gaps, or stressed and senescing plants; yellow is thin or recovering cover; deep green is a dense, vigorous canopy. Scan for red patches inside a field that should otherwise be uniformly green.</p>',
    },
    {
        slug: 'satellite-ndmi-bg',
        title: 'NDMI — влажност на посева',
        summary: 'Как да четете сателитния индекс NDMI за влажност на посева.',
        category: 'Satellite Imagery',
        language: 'bg',
        cropTags: [],
        content:
            '<h2>NDMI — влажност на посева</h2><p>NDMI проследява водното съдържание в листния покрив, използвайки близка и късовълнова инфрачервена светлина, затова сигнализира воден стрес преди той да стане видим за окото. Полезен е за преценка на неравномерно изсъхване на посева и за сравнение на напоявани спрямо неполивни площи.</p>' +
            '<p><strong>Как да четете цветовете:</strong> червено е сух, воднострадащ посев; през бледожълто до синьо е постепенно по-добре хидратиран посев. Разглеждайте този индекс особено в горещи, сухи периоди.</p>',
    },
    {
        slug: 'satellite-ndmi-en',
        title: 'NDMI — canopy moisture',
        summary: 'How to read the NDMI satellite index for canopy moisture.',
        category: 'Satellite Imagery',
        language: 'en',
        cropTags: [],
        content:
            '<h2>NDMI — canopy moisture</h2><p>NDMI tracks water content in the canopy using near-infrared and shortwave-infrared light, so it flags moisture stress before it is visible to the eye. Useful for judging uneven crop dry-down and for comparing irrigated against rain-fed blocks.</p>' +
            '<p><strong>How to read the colours:</strong> red is dry, moisture-stressed canopy; through pale yellow to blue is progressively better-hydrated crop. Reach for it in hot, dry spells.</p>',
    },
    {
        slug: 'satellite-ndre-bg',
        title: 'NDRE — хлорофил и азотен статус',
        summary: 'Как да четете сателитния индекс NDRE за хлорофил и азот.',
        category: 'Satellite Imagery',
        language: 'bg',
        cropTags: [],
        content:
            '<h2>NDRE — хлорофил и азотен статус</h2><p>NDRE използва лентата „red-edge“, която остава чувствителна в гъст, средно- и късносезонен посев, където NDVI вече се е наситил. Проследява съдържанието на хлорофил — добър индикатор за азотния статус — затова е индексът за преценка на неравномерно азотно хранене по полето.</p>' +
            '<p><strong>Как да четете цветовете:</strong> лилаво отбелязва нисък хлорофил (възможен азотен недостиг); през бяло до тъмнозелено е нарастващ хлорофил и жизненост. Използвайте го в късния сезон или при буен посев.</p>',
    },
    {
        slug: 'satellite-ndre-en',
        title: 'NDRE — chlorophyll & nitrogen',
        summary: 'How to read the NDRE satellite index for chlorophyll and nitrogen.',
        category: 'Satellite Imagery',
        language: 'en',
        cropTags: [],
        content:
            '<h2>NDRE — chlorophyll & nitrogen</h2><p>NDRE uses the red-edge band, which stays sensitive in a thick, mid-to-late-season canopy where NDVI has already saturated. It tracks chlorophyll — a good proxy for nitrogen status — so it is the layer for judging uneven nitrogen nutrition across a field.</p>' +
            '<p><strong>How to read the colours:</strong> purple marks low chlorophyll (a possible nitrogen shortfall); through white to deep green is increasing chlorophyll and vigour. Use it late-season or in a lush crop.</p>',
    },
    {
        slug: 'satellite-gndvi-bg',
        title: 'GNDVI — зелена жизненост',
        summary: 'Как да четете сателитния индекс GNDVI за зелена жизненост.',
        category: 'Satellite Imagery',
        language: 'bg',
        cropTags: [],
        content:
            '<h2>GNDVI — зелена жизненост</h2><p>GNDVI е близък на NDVI, но заменя червената лента със зелена, което го прави по-чувствителен към хлорофил и азот и по-бавно насищащ се при гъст посев. Служи като допълнителна проверка на хранителния статус и фотосинтетичната активност.</p>' +
            '<p><strong>Как да четете цветовете:</strong> бледокремаво е слаб или разреден растеж; задълбочаващо се зелено е по-висок хлорофил и по-силен посев. Сравнявайте го с NDVI.</p>',
    },
    {
        slug: 'satellite-gndvi-en',
        title: 'GNDVI — green vigour',
        summary: 'How to read the GNDVI satellite index for green vigour.',
        category: 'Satellite Imagery',
        language: 'en',
        cropTags: [],
        content:
            '<h2>GNDVI — green vigour</h2><p>GNDVI is a close relative of NDVI that swaps the red band for the green one, making it more sensitive to chlorophyll and nitrogen and slower to saturate in a dense canopy. A useful second check on nutrient status and photosynthetic activity.</p>' +
            '<p><strong>How to read the colours:</strong> pale cream is weak or sparse growth; deepening green is higher chlorophyll and a stronger canopy. Compare it against NDVI.</p>',
    },
    {
        slug: 'satellite-evi-bg',
        title: 'EVI — подобрена вегетационна оценка',
        summary: 'Как да четете сателитния индекс EVI за подобрена вегетационна оценка.',
        category: 'Satellite Imagery',
        language: 'bg',
        cropTags: [],
        content:
            '<h2>EVI — подобрена вегетационна оценка</h2><p>EVI е подобрена версия на NDVI, която коригира за атмосферна мъгла и яркост на фона на почвата и се насища по-трудно при висока биомаса. Затова е най-надеждният индекс за жизненост в пика на сезона и при горещи, мъгливи условия.</p>' +
            '<p><strong>Как да четете цветовете:</strong> тъмно лилаво-синьо е рядка или стресирана растителност; през тюркоазено и зелено до жълто е все по-гъст, жизнен посев. Предпочитайте го пред NDVI при пълно листно покритие.</p>',
    },
    {
        slug: 'satellite-evi-en',
        title: 'EVI — enhanced vegetation',
        summary: 'How to read the EVI satellite index for enhanced vegetation.',
        category: 'Satellite Imagery',
        language: 'en',
        cropTags: [],
        content:
            '<h2>EVI — enhanced vegetation</h2><p>EVI is an improved NDVI that corrects for atmospheric haze and background soil brightness and resists saturating in high-biomass crops. The most reliable vigour layer at peak season and in hot, hazy conditions.</p>' +
            '<p><strong>How to read the colours:</strong> dark purple-blue is sparse or stressed vegetation; through teal and green to yellow is an increasingly dense, vigorous canopy. Prefer it over NDVI once the crop is at full canopy.</p>',
    },
];

export interface ImportKnowledgeResult {
    tenantId: string;
    created: number;
    skipped: number;
}

/** Every article this script seeds — growing guides + the satellite guide. */
export const ALL_SEED_ARTICLES: Guide[] = [...GROWING_GUIDES, ...SATELLITE_GUIDES];

/** Seed the growing guides + satellite guide into a tenant. Idempotent on (tenantId, slug). */
export async function importKnowledge(
    prisma: PrismaClient,
    opts: { tenantSlug?: string } = {},
): Promise<ImportKnowledgeResult> {
    const tenant = opts.tenantSlug
        ? await prisma.tenant.findUnique({ where: { slug: opts.tenantSlug }, select: { id: true } })
        : await prisma.tenant.findFirst({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!tenant) throw new Error(`No tenant found${opts.tenantSlug ? ` for slug "${opts.tenantSlug}"` : ''}`);

    const author = await prisma.tenantMembership.findFirst({
        where: { tenantId: tenant.id, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
        select: { userId: true },
    });
    if (!author) throw new Error(`Tenant ${tenant.id} has no active OWNER/ADMIN to author the guides`);

    let created = 0;
    let skipped = 0;

    for (const guide of ALL_SEED_ARTICLES) {
        const existing = await prisma.knowledgeArticle.findUnique({
            where: { tenantId_slug: { tenantId: tenant.id, slug: guide.slug } },
            select: { id: true },
        });
        if (existing) {
            skipped++;
            continue;
        }

        // Dose/PHI/REI hard-rule gate (see scripts/rag/dose-phi-guard.ts) —
        // scans title + summary + content so a violation anywhere in the
        // authored guide is caught before anything is written.
        assertNoUnregisteredRegulatedContent(
            `${guide.title} ${guide.summary} ${guide.content}`,
            guide.slug,
        );

        const article = await prisma.knowledgeArticle.create({
            data: {
                tenantId: tenant.id,
                slug: guide.slug,
                title: guide.title,
                summary: guide.summary,
                category: guide.category,
                source: AGRONOMY_SOURCE,
                language: guide.language,
                cropTags: guide.cropTags,
                ownerUserId: author.userId,
                status: 'PUBLISHED',
            },
            select: { id: true },
        });
        const version = await prisma.knowledgeArticleVersion.create({
            data: {
                tenantId: tenant.id,
                articleId: article.id,
                versionNumber: 1,
                contentType: 'HTML',
                contentText: sanitizeRichTextHtml(guide.content),
                changeSummary: 'Seeded — Agri-SaaS agronomy desk (original) demo overview',
                createdById: author.userId,
            },
            select: { id: true },
        });
        await prisma.knowledgeArticle.update({
            where: { id: article.id },
            data: { currentVersionId: version.id },
        });
        created++;
    }

    return { tenantId: tenant.id, created, skipped };
}

async function main(): Promise<number> {
    const tenantIdx = process.argv.indexOf('--tenant');
    const tenantSlug = tenantIdx >= 0 ? process.argv[tenantIdx + 1] : undefined;
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    try {
        const res = await importKnowledge(prisma, { tenantSlug });
        console.log(`Knowledge import: tenant ${res.tenantId} — ${res.created} created, ${res.skipped} already present.`);
        return 0;
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        console.error('Knowledge import failed:', err);
        process.exit(1);
    });
}
