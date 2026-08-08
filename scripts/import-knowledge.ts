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

export interface ImportKnowledgeResult {
    tenantId: string;
    created: number;
    skipped: number;
}

/** Seed the growing guides into a tenant. Idempotent on (tenantId, slug). */
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

    for (const guide of GROWING_GUIDES) {
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
