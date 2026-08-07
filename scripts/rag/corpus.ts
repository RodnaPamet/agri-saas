/**
 * RAG corpus — licence gating + the GLOBAL corpus (feat/ai-rag, PR 4/5
 * Bulgarian agronomy content).
 *
 * ════════════════════════════════════════════════════════════════════
 *  LICENCE GATING (CRITICAL — read before adding any corpus)
 * ════════════════════════════════════════════════════════════════════
 *
 *  RAG ingests knowledge into the GLOBAL catalog. Only PERMISSIVELY-
 *  licensed corpora, OR content wholly original to this repository, may
 *  be ingested as TEXT. The `LICENSED_SOURCES` allowlist below is the
 *  single source of truth; `assertLicensedSource()` REFUSES anything not
 *  on it.
 *
 *  HARD PROHIBITIONS (Tier 4 — never ingested as text, regardless of the
 *  allowlist): GlobalG.A.P. standards/checklists (proprietary,
 *  cite-only), AHDB and Canola Council publications, agrochemical
 *  vendor product/label portals, and the editorial sites agri.bg /
 *  sinor.bg. Each is copyrighted and/or commercially motivated content
 *  this product does not have redistribution rights to.
 *  `assertLicensedSource()` hard-refuses anything matching those
 *  patterns. See THIRD_PARTY_NOTICES.md.
 *
 * ════════════════════════════════════════════════════════════════════
 *  THE DOSE / PHI / REI HARD RULE
 * ════════════════════════════════════════════════════════════════════
 *
 *  A dose rate, pre-harvest interval (PHI/карантинен срок), or re-entry
 *  interval may appear in this corpus ONLY alongside a real БАБХ
 *  (Bulgarian Food Safety Agency) registration number. This repository
 *  has no licensed БАБХ registration dataset, so NONE of the content
 *  below states a dose, PHI, or re-entry interval — it is agronomy only
 *  (BBCH stages, scouting thresholds, cultural practice, nutrition
 *  timing without rates, harvest readiness) and, where a real treatment
 *  decision would need a product, it says so and points the reader at
 *  the official БАБХ register instead of guessing.
 *  `assertNoUnregisteredRegulatedContent()` (scripts/rag/dose-phi-guard.ts)
 *  enforces this on every entry below AT INGEST TIME, so it would catch
 *  a violation added by a future change to this file, not just today's.
 *
 *  Each ingested chunk records its `source` (provenance + licence), so
 *  every retrieved answer can be traced back to a licensed/original
 *  origin.
 * ════════════════════════════════════════════════════════════════════
 */
import type { PrismaClient } from '@prisma/client';
import { getAiProvider } from '../../src/app-layer/ai/provider';
import { toVectorLiteral } from '../../src/lib/db/embeddings';
import { assertNoUnregisteredRegulatedContent } from './dose-phi-guard';

/**
 * The ONLY corpora permitted for TEXT ingestion. Each value is the exact
 * provenance+licence label stamped onto every chunk's `source`. Add a
 * corpus here ONLY after confirming its licence permits redistribution
 * of the text (or, for original in-repo content, that no third party's
 * rights are implicated) AND adding a matching entry to
 * THIRD_PARTY_NOTICES.md in the same diff.
 */
export const LICENSED_SOURCES = [
    'KCC (GODL)',
    'FAIR-Forward / Digital Green QA',
    'EU 2018/848',
    'USDA 7 CFR 205',
    // PR 4/5 — Bulgarian agronomy content. 100% original work authored in
    // this repository (mirrors the "AI eval golden datasets" precedent in
    // THIRD_PARTY_NOTICES.md): no third-party text is ingested under this
    // label, so no external licence needs verifying. See the notices file
    // for the full attribution entry.
    'Agri-SaaS agronomy desk (original)',
] as const;

export type LicensedSource = (typeof LICENSED_SOURCES)[number];

const LICENSED_SET: ReadonlySet<string> = new Set(LICENSED_SOURCES);

/**
 * Tier-4 — proprietary / copyrighted / commercially-motivated sources
 * that are NEVER ingested as text, regardless of the allowlist above.
 * Each carries its own reason so a refusal is legible about WHY. The
 * GlobalG.A.P. entry's message text is preserved verbatim (do not
 * rewrite it) — everything else was added alongside it to widen the
 * same hard-block shape to the rest of the Tier-4 list.
 */
const PROHIBITED_SOURCES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
    {
        pattern: /globalg\.?\s*a\.?\s*p/i,
        message:
            'matches GlobalG.A.P., which is PROPRIETARY / ' +
            'copyrighted and CITE-ONLY. Never ingest GlobalG.A.P. text into a ' +
            'RAG chunk — reference the official document instead. See ' +
            'THIRD_PARTY_NOTICES.md.',
    },
    {
        pattern: /\bAHDB\b|Agriculture\s+and\s+Horticulture\s+Development\s+Board/i,
        message:
            'matches AHDB (Agriculture and Horticulture Development Board), whose ' +
            'publications are copyrighted and CITE-ONLY. Reference the official AHDB ' +
            'document instead of ingesting its text. See THIRD_PARTY_NOTICES.md.',
    },
    {
        pattern: /Canola\s+Council/i,
        message:
            'matches the Canola Council (of Canada), whose publications are ' +
            'copyrighted and CITE-ONLY. Reference the official document instead of ' +
            'ingesting its text. See THIRD_PARTY_NOTICES.md.',
    },
    {
        pattern: /agri\.bg/i,
        message:
            'matches agri.bg, a copyrighted commercial editorial site. Its articles ' +
            'are CITE-ONLY — never ingest agri.bg text into a RAG chunk. See ' +
            'THIRD_PARTY_NOTICES.md.',
    },
    {
        pattern: /sinor\.bg/i,
        message:
            'matches sinor.bg, a copyrighted commercial editorial site. Its articles ' +
            'are CITE-ONLY — never ingest sinor.bg text into a RAG chunk. See ' +
            'THIRD_PARTY_NOTICES.md.',
    },
    {
        // Illustrative, non-exhaustive: the dominant global agrochemical vendors
        // whose product/label "portals" are the realistic sources someone might
        // try to ingest from. The allowlist model (LICENSED_SOURCES) is the
        // primary defence; this list is a named deterrent for the specific
        // mistake the brief calls out ("agrochemical vendor portals").
        pattern: /Bayer\s*CropScience|\bSyngenta\b|BASF\s*Agricultural|\bCorteva\b|\bUPL\b|\bNufarm\b/i,
        message:
            'matches a commercial agrochemical vendor product/label portal. Vendor ' +
            'portals are copyrighted and commercially motivated — never ingest their ' +
            'text into a RAG chunk. See THIRD_PARTY_NOTICES.md.',
    },
];

/**
 * Refuse any source that is not on the allowlist, and HARD-refuse any
 * Tier-4 source (GlobalG.A.P. + the rest of the widened block; proprietary
 * or commercially motivated, cite-only). Throws with a clear message
 * naming which pattern matched and why — the ingest path calls this
 * before writing any chunk.
 */
export function assertLicensedSource(source: string): void {
    for (const prohibited of PROHIBITED_SOURCES) {
        if (prohibited.pattern.test(source)) {
            throw new Error(`REFUSED: "${source}" ${prohibited.message}`);
        }
    }
    if (!LICENSED_SET.has(source)) {
        throw new Error(
            `REFUSED: "${source}" is not on the licensed-corpus allowlist ` +
                `(${LICENSED_SOURCES.join(', ')}). Only permissively-licensed ` +
                `corpora (or content wholly original to this repository) may be ` +
                `ingested. Add it to LICENSED_SOURCES in scripts/rag/corpus.ts AND ` +
                `THIRD_PARTY_NOTICES.md only after confirming the licence permits ` +
                `text redistribution — if you cannot verify a licence, do not add ` +
                `the source.`,
        );
    }
}

/** One passage from a licensed (or original) corpus. */
export interface CorpusEntry {
    source: LicensedSource;
    /** Stable external doc/QA id for provenance (the chunk's sourceRef). */
    sourceRef: string;
    text: string;
    /**
     * BCP-47-ish language tag mirrored onto the chunk (see
     * `ai/rag/retrieve.ts`'s language-aware ranking). Bulgarian is the
     * product default and, per this PR, the SOURCE language — English
     * entries are the translation, not the other way round.
     */
    language: 'bg' | 'en';
    /**
     * Crops this passage applies to (matches `CROP_OPTIONS` values in
     * `src/lib/agriculture/crop-options.ts`, e.g. "Wheat"). Mirrors onto
     * `KnowledgeChunk.cropTags`. Omit/empty = applies to every crop.
     */
    cropTags?: string[];
    /** Mirrors onto `KnowledgeChunk.regions`. Omit/empty = every region. */
    regions?: string[];
    /** BBCH growth-stage applicability range — both set, or neither. */
    bbchStageMin?: number;
    bbchStageMax?: number;
}

// ════════════════════════════════════════════════════════════════════
//  Bulgarian agronomy corpus — wheat / barley / maize / sunflower
//  (PR 4/5, tasks C5 + C7). Bulgarian-first: each topic is authored in
//  bg, then translated to en. Agronomy only — see the module header for
//  why no dose/PHI/REI appears anywhere below.
// ════════════════════════════════════════════════════════════════════

const AGRONOMY_SOURCE: LicensedSource = 'Agri-SaaS agronomy desk (original)';

// ─── Wheat / Пшеница ────────────────────────────────────────────────

const WHEAT_BBCH_BG =
    'BBCH скала за пшеница — основни фази на развитие (00–99). ' +
    '00–09 Покълване: от сухо зърно (00) до поникване, когато първото листо пробива повърхността на почвата (09). ' +
    '10–19 Развитие на листата: броят на разгънатите листа на главното стъбло (11 = първи лист, 13 = три листа и т.н.). ' +
    '20–29 Братене: образуват се странични братя от възела на братене; BBCH 21 = видимо е първото странично братя, BBCH 25 = пет и повече братя. Гъстотата на посева и потенциалният брой класове се определят до голяма степен в тази фаза. ' +
    '30–39 Стъблено удължаване: псевдостъблото се изправя (30), последователно се появяват възлите по стъблото (31 = първи възел, 32 = втори възел...), докато лигулата на флаговия лист стане видима (39). ' +
    '40–49 Бутонизация: влагалището на флаговия лист се удължава (41) и накрая набъбва видимо около формиращия се клас (45–49). ' +
    '50–59 Изкласяване: класът се подава от влагалището — начало на изкласяване (51) до пълно подаване на класа (59). ' +
    '60–69 Цъфтеж: начало на цъфтежа (61), пълен цъфтеж (65), край на цъфтежа (69) — кратка, но критична фаза за опрашване и начален брой зърна в класа. ' +
    '70–79 Млечна зрялост: зърното преминава от водниста (71) през ранна (73) и средна (75) до късна (77) млечна фаза. ' +
    '80–89 Восъчна зрялост: ранна (83), мека (85) и твърда (87) восъчна зрялост — зърното губи влага и придобива характерния цвят. ' +
    '90–99 Пълна зрялост: зърното е твърдо и трудно се разделя с нокът (91–92), растението е напълно узряло и мъртво (97), готово за прибиране (99).';

const WHEAT_BBCH_EN =
    'BBCH scale for wheat — principal growth stages (00–99). ' +
    '00–09 Germination: from dry seed (00) to emergence, when the first leaf breaks through the soil surface (09). ' +
    '10–19 Leaf development: counted by the number of unfolded leaves on the main shoot (11 = first leaf, 13 = three leaves, and so on). ' +
    '20–29 Tillering: side shoots form from the tillering node; BBCH 21 = first tiller visible, BBCH 25 = five or more tillers. Stand density and the eventual number of ears are largely set in this stage. ' +
    '30–39 Stem elongation: the pseudostem becomes erect (30), then successive stem nodes appear (31 = first node, 32 = second node...) until the flag leaf ligule is just visible (39). ' +
    '40–49 Booting: the flag leaf sheath extends (41) and finally swells visibly around the developing ear (45–49). ' +
    '50–59 Heading: the ear emerges from the sheath — beginning of heading (51) to fully emerged (59). ' +
    '60–69 Flowering (anthesis): beginning (61), full flowering (65), end of flowering (69) — a short but critical window for pollination and initial grain number. ' +
    '70–79 Milk development: grain passes from watery ripe (71) through early (73) and medium (75) to late milk (77). ' +
    '80–89 Dough development: early (83), soft (85) and hard (87) dough — the grain loses moisture and takes on its characteristic colour. ' +
    '90–99 Ripening: grain is hard and can barely be dented by a thumbnail (91–92), the plant is fully mature and dead (97), ready for harvest (99).';

const WHEAT_SCOUTING_BG =
    'Наблюдение на посева и прагове за намеса при пшеница. ' +
    'Листни въшки (напр. Sitobion avenae) по време на вретенене–изкласяване–цъфтеж: широко цитираният в интегрираната растителна защита праг е средно около 5 въшки на стъбло/клас при нарастваща популация — под тази плътност естествените врагове (калинки, златоочици, паразитоидни оси) обикновено удържат популацията сама. Проверявайте 20–30 стъбла на случаен принцип в няколко точки на полето, не само по края. ' +
    'Кафява ръжда и брашнеста мана: оглеждайте флаговия лист и листа флаг-1 за начални лезии още от вретенене; нарастващ процент засегната листна площ по флаговия лист е сигнал за по-чест оглед, тъй като именно този лист допринася най-много за пълненето на зърното. ' +
    'Житен бегач и листни минари: оглеждайте млади растения през есента и в началото на пролетта; неравномерно поникване или прекъснати редове са ранен индикатор. ' +
    'Каквото и решение за третиране да вземете при достигане на праг, продуктът трябва да е регистриран за тази цел в България — вижте официалния регистър на БАБХ, преди да предприемете каквото и да е третиране.';

const WHEAT_SCOUTING_EN =
    'Field scouting and intervention thresholds for wheat. ' +
    'Cereal aphids (e.g. Sitobion avenae) during stem elongation–heading–flowering: a widely cited IPM threshold is an average of around 5 aphids per stem/ear while the population is rising — below that density, natural enemies (ladybirds, lacewings, parasitoid wasps) usually hold the population in check on their own. Check 20–30 stems at random across several points in the field, not just the headland. ' +
    'Brown rust and powdery mildew: inspect the flag leaf and flag-1 leaf for early lesions from stem elongation onward; a rising percentage of affected flag-leaf area is a signal to scout more often, since that leaf contributes most to grain fill. ' +
    'Cereal leaf beetle and leaf miners: inspect young plants in autumn and early spring; uneven emergence or broken rows is an early indicator. ' +
    'Whatever treatment decision follows once a threshold is reached, the product used must be registered for that purpose in Bulgaria — check the official БАБХ register before any treatment.';

const WHEAT_CULTURAL_BG =
    'Културни практики и хранене без дози при пшеница. ' +
    'Сеитбооборот: избягвайте пшеница след пшеница повече от две поредни години — редуването с бобови, слънчоглед или окопни култури намалява натиска от кореново гниене и листни болести, пренасяни чрез растителни остатъци. ' +
    'Стърнищни остатъци: равномерното разпределение и заораване или повърхностно инкорпориране на сламата намалява инокулума на гъбни патогени, презимуващи по остатъците, и подобрява структурата на почвата в дългосрочен план. ' +
    'Сортов избор: предпочитайте сортове с доказана устойчивост на ръжди и брашнеста мана за конкретния район и предшественик — сортовият избор е първата линия на защита, преди всяко третиране. ' +
    'Гъстота и дълбочина на сеитба: подходящата сеитбена норма за сорта и срока на сеитба осигурява балансирано братене — прекалено гъст посев увеличава влажността в стъблостоя и риска от полягане и болести. ' +
    'Азотно хранене: разделянето на азотното торене по фази (базово торене преди/при сеитба, подхранване при братене, допълнително подхранване около флагов лист/изкласяване) е обичайна практика, тъй като различните фази отговарят на азота различно — братене влияе на броя класове, изкласяването на пълненето на зърното и протеиновото съдържание. Конкретните норми зависят от почвен анализ, предшественик и очакван добив и се определят с агроном — не се посочват тук. ' +
    'Дренаж: пшеницата е чувствителна на преовлажняване през зимата и ранна пролет; полета със стояща вода след дъжд се нуждаят от подобрен повърхностен отток преди засяване.';

const WHEAT_CULTURAL_EN =
    'Cultural practice and nutrition timing without rates for wheat. ' +
    'Crop rotation: avoid wheat after wheat for more than two years running — rotating with legumes, sunflower, or row crops reduces pressure from root rots and leaf diseases carried on residue. ' +
    'Stubble residue: even spreading and incorporation (or shallow tillage) of straw reduces the inoculum of fungal pathogens overwintering on residue and improves soil structure over time. ' +
    'Variety choice: favour varieties with proven resistance to rusts and powdery mildew for the local area and preceding crop — variety choice is the first line of defence, before any treatment. ' +
    'Seeding density and depth: a seeding rate matched to the variety and sowing date gives balanced tillering — an overly dense stand raises canopy humidity and the risk of lodging and disease. ' +
    'Nitrogen nutrition: splitting nitrogen across growth stages (a base dressing before/at sowing, a top-dressing at tillering, a further one around flag leaf/heading) is common practice, since different stages respond to nitrogen differently — tillering drives ear number, heading drives grain fill and protein content. Actual rates depend on soil testing, the preceding crop, and target yield, and are set with an agronomist — none are stated here. ' +
    'Drainage: wheat is sensitive to waterlogging in winter and early spring; fields that pond after rain need improved surface drainage before sowing.';

const WHEAT_HARVEST_BG =
    'Готовност за прибиране на пшеница. ' +
    'Влажност на зърното: прибирането обикновено става при влажност около 12–14%, когато зърното е твърдо и трудно се разделя с нокът (BBCH 91–92); по-висока влажност изисква последващо сушене за безопасно съхранение. ' +
    'Цвят на стъблото и класа: пожълтяване по цялата дължина на стъблото и класа, без зелени участъци, е визуален индикатор за физиологична зрялост. ' +
    'Обемно тегло: по-високото обемно тегло обикновено означава по-добре напълнено зърно и по-добро качество за мелничарска употреба — проверявайте на място с преносим уред, ако е наличен. ' +
    'Съхранение: складирайте само добре изсушено и охладено зърно; проветрявайте силозите периодично и следете за температурни точки, за да предотвратите развитие на плесени и вредители по време на съхранение.';

const WHEAT_HARVEST_EN =
    'Harvest readiness for wheat. ' +
    'Grain moisture: harvest typically happens around 12–14% grain moisture, once the grain is hard and can barely be dented by a thumbnail (BBCH 91–92); higher moisture needs subsequent drying for safe storage. ' +
    'Stem and ear colour: full yellowing of the stem and ear, with no green remaining, is a visual indicator of physiological maturity. ' +
    'Test weight: a higher test weight generally indicates better-filled grain and better milling quality — check on-site with a portable meter where available. ' +
    'Storage: only store grain that is well dried and cooled; ventilate silos periodically and monitor for hot spots to prevent mould and pest development in storage.';

// ─── Barley / Ечемик ────────────────────────────────────────────────

const BARLEY_BBCH_BG =
    'BBCH скала за ечемик — основни фази на развитие (00–99), по същата зърнено-житна скала като пшеницата, с някои характерни за ечемика особености. ' +
    '00–09 Покълване: от сухо зърно (00) до поникване (09). ' +
    '10–19 Развитие на листата: броене на разгънатите листа на главното стъбло. ' +
    '20–29 Братене: BBCH 21 = първо странично братя; ечемикът обикновено братва по-интензивно и по-рано от пшеницата. ' +
    '30–39 Стъблено удължаване: псевдостъблото се изправя (30) до поява на лигулата на флаговия лист (39); при много сортове ечемик остените стават видими още в края на тази фаза. ' +
    '40–49 Бутонизация: влагалището на флаговия лист набъбва около формиращия се клас. ' +
    '50–59 Изкласяване: класът (при ечемика често с добре изразени остени) се подава от влагалището. ' +
    '60–69 Цъфтеж: при ечемика цъфтежът често започва още преди пълното изкласяване (самоопрашващ се вид) — начало (61) до край (69). ' +
    '70–79 Млечна зрялост: водниста (71) до късна млечна фаза (77). ' +
    '80–89 Восъчна зрялост: ранна (83) до твърда восъчна зрялост (87). ' +
    '90–99 Пълна зрялост: зърното е твърдо (91–92), класът е напълно пожълтял, растението е узряло за прибиране (99). Ечемикът обикновено узрява 1–2 седмици по-рано от пшеницата при сходни условия.';

const BARLEY_BBCH_EN =
    'BBCH scale for barley — principal growth stages (00–99), the same cereal scale as wheat, with a few barley-specific notes. ' +
    '00–09 Germination: from dry grain (00) to emergence (09). ' +
    '10–19 Leaf development: counted by unfolded leaves on the main shoot. ' +
    '20–29 Tillering: BBCH 21 = first tiller visible; barley typically tillers earlier and more heavily than wheat. ' +
    '30–39 Stem elongation: the pseudostem becomes erect (30) until the flag leaf ligule is visible (39); in many barley varieties awns are already visible by the end of this stage. ' +
    '40–49 Booting: the flag leaf sheath swells visibly around the developing ear. ' +
    '50–59 Heading: the ear (often carrying prominent awns in barley) emerges from the sheath. ' +
    '60–69 Flowering: barley flowering often begins before heading is fully complete (it is largely self-pollinating) — beginning (61) to end (69). ' +
    '70–79 Milk development: watery ripe (71) to late milk (77). ' +
    '80–89 Dough development: early (83) to hard dough (87). ' +
    '90–99 Ripening: grain is hard (91–92), the ear is fully yellowed, the plant is ready for harvest (99). Barley typically matures 1–2 weeks earlier than wheat under comparable conditions.';

const BARLEY_SCOUTING_BG =
    'Наблюдение и прагове при ечемик. ' +
    'Мрежовидна петнистост (Pyrenophora teres): характерни мрежовидни некрози по листата, засилващи се от братене нататък при влажно и топло време; редовен оглед на долните листа през братене–стъблено удължаване позволява ранно откриване. ' +
    'Листни въшки: подобно на пшеницата, средно около 5 въшки на стъбло по време на удължаване–изкласяване е широко цитираният праг за намеса в интегрираната растителна защита, като винаги се отчита и присъствието на естествени врагове. ' +
    'Полягане: ечемикът е по-чувствителен на полягане от пшеницата при прекомерно гъст посев или излишък на азот в ранна фаза — наблюдавайте посева след силен дъжд или вятър около изкласяване. ' +
    'Всяко решение за третиране изисква продукт, регистриран в България за тази култура и цел — проверявайте официалния регистър на БАБХ.';

const BARLEY_SCOUTING_EN =
    'Field scouting and thresholds for barley. ' +
    'Net blotch (Pyrenophora teres): characteristic net-like necrotic lesions on leaves, intensifying from tillering onward in warm, humid conditions; regular inspection of lower leaves through tillering–stem elongation allows early detection. ' +
    'Cereal aphids: as with wheat, an average of around 5 aphids per stem during elongation–heading is the widely cited IPM intervention threshold, always weighed against the presence of natural enemies. ' +
    'Lodging: barley is more prone to lodging than wheat under an overly dense stand or excess early nitrogen — check the crop after heavy rain or wind around heading. ' +
    'Any treatment decision needs a product registered in Bulgaria for this crop and purpose — check the official БАБХ register.';

const BARLEY_CULTURAL_BG =
    'Културни практики и хранене без дози при ечемик. ' +
    'Сеитбооборот и предшественик: ечемикът реагира добре след бобови или окопни култури; избягвайте пряко повтаряне на житни култури, за да ограничите натрупването на почвени патогени. ' +
    'Сортов избор: пивоварният и фуражният ечемик имат различни изисквания към сорта и торенето — изборът на сорт според предназначението на реколтата определя и агротехниката. ' +
    'Гъстота на сеитба: ечемикът братва по-интензивно от пшеницата, затова по-ниска сеитбена норма често е достатъчна за постигане на желаната гъстота на стъблостоя — прекалено гъстият посев увеличава риска от полягане и болести. ' +
    'Азотно хранене: за пивоварен ечемик балансираното, а не прекомерното азотно торене в късните фази е от значение за качеството на зърното (протеиново съдържание); норми и срокове се определят с агроном и на база почвен анализ — не се посочват тук. ' +
    'Дренаж: подобно на пшеницата, ечемикът не понася застояла вода през зимата; лошо отводнени участъци трябва да се коригират преди сеитба.';

const BARLEY_CULTURAL_EN =
    'Cultural practice and nutrition timing without rates for barley. ' +
    'Crop rotation and preceding crop: barley responds well after legumes or row crops; avoid direct cereal-on-cereal repetition to limit the build-up of soil-borne pathogens. ' +
    'Variety choice: malting and feed barley have different variety and fertilisation requirements — the choice of variety for the intended end use shapes the whole agronomy programme. ' +
    'Seeding density: barley tillers more heavily than wheat, so a lower seeding rate is often enough to reach the target stand density — an overly dense stand raises the risk of lodging and disease. ' +
    'Nitrogen nutrition: for malting barley, balanced rather than excessive late-stage nitrogen matters for grain quality (protein content); rates and timing are set with an agronomist based on soil testing — none are stated here. ' +
    'Drainage: like wheat, barley does not tolerate standing water over winter; poorly drained areas should be corrected before sowing.';

const BARLEY_HARVEST_BG =
    'Готовност за прибиране на ечемик. ' +
    'Влажност на зърното: прибирането обикновено се извършва при влажност около 13–14%; ечемикът узрява и изсъхва по-бързо от пшеницата, затова полето трябва да се проверява по-често в края на восъчната зрялост. ' +
    'Чупливост на класа: узрелият клас на ечемика лесно се чупи и зърното лесно се рони — забавеното прибиране увеличава загубите при жътва повече, отколкото при пшеницата. ' +
    'Цвят: пълно пожълтяване на класа и стъблото, без зелени участъци, е индикатор за физиологична зрялост. ' +
    'Съхранение: пивоварният ечемик изисква по-стриктен контрол на влажността и температурата при съхранение, за да се запази кълняемостта за малцуване; проветрявайте и следете температурата на силоза редовно.';

const BARLEY_HARVEST_EN =
    'Harvest readiness for barley. ' +
    'Grain moisture: harvest typically happens around 13–14% moisture; barley matures and dries faster than wheat, so the field should be checked more often in late dough/ripening. ' +
    'Ear brittleness: a fully ripe barley ear shatters easily and grain sheds readily — delayed harvest increases shatter losses more than it does in wheat. ' +
    'Colour: full yellowing of the ear and stem, with no green remaining, indicates physiological maturity. ' +
    'Storage: malting barley needs tighter moisture and temperature control in storage to preserve germination capacity for malting; ventilate and monitor silo temperature regularly.';

// ─── Maize / Царевица ───────────────────────────────────────────────

const MAIZE_BBCH_BG =
    'BBCH скала за царевица — основни фази на развитие (00–99). ' +
    '00–09 Покълване: от сухо зърно (00), през наклюване на коренчето (05) и колеоптила (06), до поникване над почвената повърхност (09). ' +
    '10–19 Развитие на листата: броене на разгънатите листа (11 = първи лист... до 19 = девет и повече листа); при царевицата тази фаза продължава дълго и се застъпва с началото на стъбленото удължаване. ' +
    '30–39 Стъблено удължаване: интензивен растеж на стъблото и формиране на междувъзлията; в тази фаза до голяма степен се определя потенциалният брой редове зърна на кочана. ' +
    '51–59 Изявяване на съцветието (изметляване): метлицата постепенно се подава от обвивката на последния лист — начало (51) до пълно изметляване (59). ' +
    '61–69 Цъфтеж (прашене и поява на копринки): началото на прашене от метлицата (61) обикновено предхожда масовата поява на копринки от кочана; пълен цъфтеж (65) до край (69) — синхронът между прашене и копринки е критичен за озърняването. ' +
    '71–79 Развитие на зърното: от млечна фаза (71–75) до тестена зрялост (79). ' +
    '83–89 Зряло зърно: восъчна зрялост (83–85) до физиологична зрялост, маркирана от появата на „черния слой“ при основата на зърното (87), след което наливането на сухо вещество спира. ' +
    '90–99 Пълна зрялост: растението изсъхва (91–97), зърното е готово за прибиране на зърно или силаж според целта на отглеждане (99).';

const MAIZE_BBCH_EN =
    'BBCH scale for maize — principal growth stages (00–99). ' +
    '00–09 Germination: from dry kernel (00), through radicle emergence (05) and coleoptile emergence (06), to emergence above the soil surface (09). ' +
    '10–19 Leaf development: counted by unfolded leaves (11 = first leaf... up to 19 = nine or more leaves); in maize this stage runs long and overlaps with the start of stem elongation. ' +
    '30–39 Stem elongation: rapid stem growth and internode formation; the potential number of kernel rows on the ear is largely set during this stage. ' +
    '51–59 Inflorescence emergence (tasseling): the tassel gradually emerges from the sheath of the uppermost leaf — beginning (51) to fully emerged (59). ' +
    '61–69 Flowering (anthesis and silking): pollen shed from the tassel (61) typically precedes mass silk emergence from the ear; full flowering (65) to end of flowering (69) — the synchrony between pollen shed and silking is critical for kernel set. ' +
    '71–79 Fruit development: from milk stage (71–75) to dough stage (79). ' +
    '83–89 Ripening: dent stage (83–85) to physiological maturity, marked by the appearance of a "black layer" at the kernel base (87), after which dry-matter accumulation stops. ' +
    '90–99 Senescence: the plant dries down (91–97), the crop is ready for grain or silage harvest depending on the growing purpose (99).';

const MAIZE_SCOUTING_BG =
    'Наблюдение и прагове при царевица. ' +
    'Есенен армейски червей (Spodoptera frugiperda) и царевичен стъблопробивач (Ostrinia nubilalis): оглеждайте фунията на младите растения за характерни прозорчести проядени места по листата и за екскременти; за есенния армейски червей праг за реакция, посочван в редица интегрирани системи, е около 5–10% от растенията с прясна фунийна повреда в ранните фази на развитие — проверявайте посева поне два пъти седмично в тази чувствителна фаза. ' +
    'Житен бегач и телени червеи: рискови са особено след тревни предшественици; неравномерно, петнисто поникване е ранен сигнал за оглед на почвата около корените. ' +
    'Хелминтоспориум (ленено кафяво прегаряне): наблюдавайте долните листа от стъблено удължаване нататък за удължени некротични петна. ' +
    'Всяко решение за третиране трябва да използва продукт, регистриран в България за царевица и конкретния вредител — проверявайте официалния регистър на БАБХ, преди да предприемете действие.';

const MAIZE_SCOUTING_EN =
    'Field scouting and thresholds for maize. ' +
    'Fall armyworm (Spodoptera frugiperda) and European corn borer (Ostrinia nubilalis): inspect the whorl of young plants for characteristic window-pane leaf damage and frass; for fall armyworm, a threshold cited in a number of integrated pest management systems is around 5–10% of plants with fresh whorl damage during early growth stages — check the crop at least twice a week during this sensitive window. ' +
    'Wireworms: a particular risk after grass/pasture preceding crops; patchy, uneven emergence is an early signal to inspect the soil around roots. ' +
    'Helminthosporium (northern corn leaf blight): watch the lower leaves from stem elongation onward for elongated necrotic lesions. ' +
    'Any treatment decision needs a product registered in Bulgaria for maize and the specific pest — check the official БАБХ register before acting.';

const MAIZE_CULTURAL_BG =
    'Културни практики и хранене без дози при царевица. ' +
    'Сеитбооборот: избягвайте царевица след царевица повече от 1–2 години последователно в райони с натиск от стъблопробивач и хелминтоспориум — редуването с бобови или житни култури намалява презимуващия инокулум и вредители в растителните остатъци. ' +
    'Гъстота на сеитба: гъстотата трябва да е съобразена със сорта/хибрида, влагообезпечеността на района и целта (зърно или силаж) — прекалено гъст посев при недостиг на влага намалява озърняването на кочана. ' +
    'Дълбочина на сеитба и температура на почвата: царевицата покълва надеждно едва когато почвата се затопли трайно за сезона; прекалено ранна сеитба в студена почва удължава покълването и увеличава риска от загниване на семето. ' +
    'Азотно хранене: царевицата има високо и концентрирано във времето изискване към азота около изметляване–цъфтеж; разделеното торене (база при сеитба + подхранване преди бързия растеж на стъблото) е обичайна практика — конкретните норми зависят от почвен анализ, предшественик и очакван добив и се определят с агроном. ' +
    'Напояване/дренаж: периодът около цъфтежа е най-чувствителен на воден стрес за царевицата — недостигът на влага точно тогава силно намалява озърняването.';

const MAIZE_CULTURAL_EN =
    'Cultural practice and nutrition timing without rates for maize. ' +
    'Crop rotation: avoid maize after maize for more than 1–2 years running in areas with corn borer or helminthosporium pressure — rotating with legumes or cereals reduces overwintering inoculum and pests carried on residue. ' +
    'Seeding density: density should match the hybrid, the area’s moisture availability, and the goal (grain vs silage) — an overly dense stand under moisture stress reduces kernel set on the ear. ' +
    'Seeding depth and soil temperature: maize germinates reliably only once the soil has warmed durably for the season; sowing too early into cold soil prolongs germination and raises the risk of seed rot. ' +
    'Nitrogen nutrition: maize has a high, time-concentrated nitrogen demand around tasseling–flowering; split applications (a base dressing at sowing plus a top-dressing before rapid stem growth) are common practice — actual rates depend on soil testing, the preceding crop, and target yield, set with an agronomist. ' +
    'Irrigation/drainage: the window around flowering is maize’s most water-stress-sensitive period — a moisture deficit exactly then sharply reduces kernel set.';

const MAIZE_HARVEST_BG =
    'Готовност за прибиране на царевица. ' +
    'Черен слой: появата на тъмна ивица („черен слой“) при основата на зърното маркира физиологична зрялост (BBCH 87) — след този момент наливането на сухо вещество спира, но зърното все още трябва да изсъхне на корен или чрез сушене. ' +
    'Влажност на зърното: прибирането на зърно обикновено става с последващо сушене при по-висока влажност, или директно, без сушене, при по-ниска влажност — изборът зависи от съоръженията на стопанството. ' +
    'Прибиране на силажна царевица: определя се по съдържание на сухо вещество на цялото растение (обичайно около восъчна зрялост на зърното), а не по влажност само на зърното. ' +
    'Съхранение: зърното трябва да се охлади и подсуши до безопасно за съхранение ниво възможно най-скоро след прибиране, за да се предотврати развитие на плесени (включително микотоксин-продуциращи гъби) в силоза.';

const MAIZE_HARVEST_EN =
    'Harvest readiness for maize. ' +
    'Black layer: the appearance of a dark line ("black layer") at the kernel base marks physiological maturity (BBCH 87) — after this point dry-matter accumulation stops, though the kernel still needs to dry down in the field or by mechanical drying. ' +
    'Grain moisture: grain harvest is typically followed by drying at higher moisture, or done directly without drying at lower moisture — the choice depends on the farm’s facilities. ' +
    'Silage maize harvest: timed by whole-plant dry-matter content (usually around kernel dough/dent stage), not by kernel moisture alone. ' +
    'Storage: grain should be cooled and dried down to a safe storage moisture as soon as possible after harvest to prevent mould (including mycotoxin-producing fungi) developing in the silo.';

// ─── Sunflower / Слънчоглед ─────────────────────────────────────────

const SUNFLOWER_BBCH_BG =
    'BBCH скала за слънчоглед — основни фази на развитие (00–99). ' +
    '00–09 Покълване: от сухо семе (00) до поникване на семедялните листа над почвата (09). ' +
    '10–19 Развитие на листата: слънчогледът има срещуположно разположени листа в основата, затова фазите често се броят по двойки листа (12 = два чифта листа...) до 19 = девет и повече чифта/листа, разгънати. ' +
    '30–39 Стъблено удължаване: видими междувъзлия, стъблото бързо нараства на височина. ' +
    '51–59 Поява на съцветието: пъпката на кошницата става видима отгоре, все още обградена от млади листа (звездовиден бутон) — от начало (51) до момента, в който пъпката започва да се отделя от най-горните листа (59). ' +
    '60–69 Цъфтеж: начало на цъфтежа при езичестите (лигулатни) цветове по периферията на кошницата (61), пълен цъфтеж когато централните тръбести цветове цъфтят (65), край на цъфтежа с окапване на повечето езичести цветове (69) — кратка фаза, критична за опрашването, тъй като слънчогледът разчита силно на пчели и други опрашители. ' +
    '70–79 Развитие на семето: гърбът на кошницата е все още зелен, семената се наливат. ' +
    '80–89 Зреене: гърбът на кошницата пожълтява и постепенно кафенее, семената потъмняват — физиологична зрялост настъпва, когато гърбът на кошницата стане кафяв. ' +
    '90–99 Пълна зрялост: кошницата и стъблото изсъхват напълно, семената са готови за прибиране (99).';

const SUNFLOWER_BBCH_EN =
    'BBCH scale for sunflower — principal growth stages (00–99). ' +
    '00–09 Germination: from dry seed (00) to emergence of the cotyledons above the soil (09). ' +
    '10–19 Leaf development: sunflower carries opposite leaves at the base, so stages are often counted in leaf pairs (12 = two leaf pairs...) up to 19 = nine or more pairs/leaves unfolded. ' +
    '30–39 Stem elongation: internodes become visible, the stem grows rapidly in height. ' +
    '51–59 Inflorescence emergence: the head bud becomes visible from above, still surrounded by young leaves (the "star-bud" stage) — from the beginning (51) to the point the bud starts separating from the topmost leaves (59). ' +
    '60–69 Flowering: beginning of flowering as the ray (ligulate) florets around the head’s rim open (61), full flowering when the central disc florets are flowering (65), end of flowering as most ray florets drop (69) — a short window critical for pollination, since sunflower relies heavily on bees and other pollinators. ' +
    '70–79 Seed development: the back of the head is still green, seeds are filling. ' +
    '80–89 Ripening: the back of the head turns yellow then progressively brown, seeds darken — physiological maturity is reached once the back of the head has turned brown. ' +
    '90–99 Senescence: the head and stem dry down completely, seeds are ready for harvest (99).';

const SUNFLOWER_SCOUTING_BG =
    'Наблюдение и прагове при слънчоглед. ' +
    'Синя китка (Orobanche cumana, слънчогледова синя китка): паразитен плевел без хлорофил, прикрепящ се към корените, който не се овладява само чрез наблюдение — ключовата мярка е сортов/хибриден избор с устойчивост към разпространените в стопанството раси и удължен сеитбооборот (виж по-долу); появата на стъбла на синя китка над почвата е знак за картографиране на засегнатите петна за бъдещо планиране. ' +
    'Мана по слънчогледа (Plasmopara halstedii): наблюдавайте за характерно закърнели, хлоротични и удебелени млади растения скоро след поникване — засегнатите растения рядко се възстановяват и обикновено се бракуват, а не третират. ' +
    'Семеяди и стъблени неприятели: оглеждайте гърба на кошницата към края на цъфтежа и в началото на зреене за пробождания и ходове. ' +
    'Продуктовото решение при достигнат праг изисква продукт, регистриран в България за слънчоглед — проверявайте официалния регистър на БАБХ.';

const SUNFLOWER_SCOUTING_EN =
    'Field scouting and thresholds for sunflower. ' +
    'Broomrape (Orobanche cumana): a chlorophyll-free parasitic weed that attaches to roots and cannot be managed by scouting alone — the key measure is choosing a variety/hybrid resistant to the races present on the farm, plus an extended rotation (see below); broomrape stalks emerging above ground are a signal to map the affected patches for future rotation planning. ' +
    'Downy mildew (Plasmopara halstedii): watch for characteristically stunted, chlorotic, thickened young plants shortly after emergence — affected plants rarely recover and are usually rogued out rather than treated. ' +
    'Seed feeders and head pests: inspect the back of the head toward the end of flowering and early ripening for punctures and feeding tunnels. ' +
    'Any treatment decision once a threshold is reached needs a product registered in Bulgaria for sunflower — check the official БАБХ register.';

const SUNFLOWER_CULTURAL_BG =
    'Културни практики и хранене без дози при слънчоглед. ' +
    'Сеитбооборот: слънчогледът изисква едно от най-дългите междинни редувания сред земеделските култури — обичайна препоръка в практиката е връщане на едно и също поле не по-рано от 4–5 години, именно заради натрупването на синя китка и мана в почвата при по-чести повторения. ' +
    'Сортов/хибриден избор: устойчивостта към местните раси синя китка и към мана е основен критерий при избора на хибрид за поле с известна история на тези проблеми — това е предпазна мярка, приложена преди сеитба, а не третиране след появата на проблема. ' +
    'Гъстота на сеитба: балансирана гъстота на посева влияе пряко върху диаметъра на кошницата и озърняването; прекалено гъст посев намалява средния диаметър на кошницата и добива на растение. ' +
    'Хранене: слънчогледът е сравнително добър извличател на калий и бор от почвата; балансирано, основано на почвен анализ торене преди сеитба, съобразено с предшественика, подкрепя нормалното развитие на кошницата — конкретни норми не се посочват тук и се определят с агроном. ' +
    'Опрашване: тъй като слънчогледът разчита силно на насекоми опрашители по време на цъфтеж, запазването на цъфтящи покрайнини и намаляването на безпокойството на опрашителите точно в тази фаза подпомага озърняването.';

const SUNFLOWER_CULTURAL_EN =
    'Cultural practice and nutrition timing without rates for sunflower. ' +
    'Crop rotation: sunflower needs one of the longest rotation intervals among field crops — a common field recommendation is not returning to the same field sooner than 4–5 years, precisely because more frequent repetition lets broomrape and downy mildew build up in the soil. ' +
    'Variety/hybrid choice: resistance to the local broomrape races and to downy mildew is a key criterion when choosing a hybrid for a field with a known history of these problems — a preventive measure applied before sowing, not a treatment after the problem appears. ' +
    'Seeding density: a balanced stand density directly affects head diameter and kernel set; an overly dense stand reduces average head diameter and yield per plant. ' +
    'Nutrition: sunflower is a comparatively strong extractor of potassium and boron from the soil; balanced, soil-test-based fertilisation before sowing, matched to the preceding crop, supports normal head development — actual rates are not stated here and are set with an agronomist. ' +
    'Pollination: since sunflower relies heavily on insect pollinators during flowering, preserving flowering field margins and minimising disturbance to pollinators exactly during that stage supports kernel set.';

const SUNFLOWER_HARVEST_BG =
    'Готовност за прибиране на слънчоглед. ' +
    'Цвят на гърба на кошницата: преминаването от зелено през жълто към кафяво по гърба на кошницата е основният визуален индикатор за настъпваща физиологична зрялост. ' +
    'Влажност на семето: прибирането обикновено става при влажност на семето, при която то вече е достатъчно сухо за безопасно съхранение след кратко досушаване; по-високата влажност при прибиране изисква активно сушене преди складиране. ' +
    'Загуби при прибиране: закъснялото прибиране на напълно узрели кошници увеличава загубите от опадали семена и повреди от птици — планирайте прибирането веднага щом кошниците достигнат кафяв цвят по цялата площ на полето. ' +
    'Съхранение: маслодайните семена на слънчогледа са чувствителни на прегряване и окисляване при съхранение с висока влажност — охлаждането и проветряването на силоза скоро след прибиране пази маслеността и качеството.';

const SUNFLOWER_HARVEST_EN =
    'Harvest readiness for sunflower. ' +
    'Head-back colour: the transition from green through yellow to brown on the back of the head is the main visual indicator of approaching physiological maturity. ' +
    'Seed moisture: harvest typically happens once seed moisture is low enough for safe storage after brief additional drying; higher moisture at harvest needs active drying before storage. ' +
    'Harvest losses: delaying harvest of fully ripe heads increases losses from seed shatter and bird damage — plan harvest as soon as heads have turned brown across the whole field. ' +
    'Storage: sunflower’s oil-rich seed is sensitive to overheating and oxidation when stored at high moisture — cooling and ventilating the silo soon after harvest preserves oil content and quality.';

// ─── Shared — how to check the official БАБХ register ──────────────

// NOTE on phrasing: this entry deliberately does NOT use the literal
// "карантинен срок" / "PHI" / "pre-harvest interval" / "re-entry
// interval" / "влизане в третираната площ" trigger phrases, even though
// its whole subject is those concepts — it explains the POLICY, states
// no specific value, and would otherwise trip its own dose/PHI/REI gate
// on a bare mention of the term. Paraphrased instead ("waiting period
// before harvest" / "before returning to the treated area").
const REGISTER_CHECK_BG =
    'Как да проверите официалния регистър на БАБХ преди третиране. ' +
    'Преди да приложите какъвто и да е продукт за растителна защита, е задължително да проверите официалния регистър на разрешените за употреба в България продукти, поддържан от Българската агенция по безопасност на храните (БАБХ). Регистърът посочва за всеки продукт културите и вредителите/болестите, за които е разрешен, разрешената норма на употреба, изчаквателния период, който трябва да мине преди прибиране, и периода, който трябва да мине преди връщане в третираната площ — тази информация е специфична за всеки отделен регистриран продукт и не може да бъде обобщена. Тази база от знания съзнателно не съдържа конкретни норми на употреба или срокове именно защото те са валидни само заедно с конкретния регистрационен номер на продукта в регистъра на БАБХ — винаги проверявайте актуалния регистър, или се консултирайте с регистриран агроном, преди всяко третиране.';

const REGISTER_CHECK_EN =
    'How to check the official БАБХ register before any treatment. ' +
    'Before applying any plant-protection product, it is a legal requirement to check the official register of products authorised for use in Bulgaria, maintained by the Bulgarian Food Safety Agency (БАБХ). For each product, the register states the crops and pests/diseases it is authorised for, the authorised rate of use, the waiting period that must pass before harvest, and the waiting period that must pass before returning to the treated area — this information is specific to each individual registered product and cannot be generalised. This knowledge base deliberately carries no specific rates or waiting periods, precisely because they are only valid together with a product’s specific БАБХ registration number — always check the current register, or consult a registered agronomist, before any treatment.';

/**
 * The GLOBAL corpus (renamed from `SAMPLE_GLOBAL_CORPUS` — PR 4/5 replaces
 * the earlier handful of Indian-KCC/EU/USDA samples with a real Bulgarian
 * agronomy corpus for the country's four major arable crops: wheat,
 * barley, maize, sunflower). Bulgarian-first: every topic below is
 * authored in `bg`, then translated to `en` — the `en` entry is the
 * translation, never the source. No dose/PHI/REI appears anywhere (see
 * the module header) — `ingestGlobalCorpus` enforces this at write time.
 */
export const GLOBAL_CORPUS: CorpusEntry[] = [
    // ─── Wheat ───
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-wheat-bbch', text: WHEAT_BBCH_BG, language: 'bg', cropTags: ['Wheat'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-wheat-bbch', text: WHEAT_BBCH_EN, language: 'en', cropTags: ['Wheat'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-wheat-scouting', text: WHEAT_SCOUTING_BG, language: 'bg', cropTags: ['Wheat'], bbchStageMin: 10, bbchStageMax: 69 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-wheat-scouting', text: WHEAT_SCOUTING_EN, language: 'en', cropTags: ['Wheat'], bbchStageMin: 10, bbchStageMax: 69 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-wheat-cultural', text: WHEAT_CULTURAL_BG, language: 'bg', cropTags: ['Wheat'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-wheat-cultural', text: WHEAT_CULTURAL_EN, language: 'en', cropTags: ['Wheat'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-wheat-harvest', text: WHEAT_HARVEST_BG, language: 'bg', cropTags: ['Wheat'], bbchStageMin: 80, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-wheat-harvest', text: WHEAT_HARVEST_EN, language: 'en', cropTags: ['Wheat'], bbchStageMin: 80, bbchStageMax: 99 },

    // ─── Barley ───
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-barley-bbch', text: BARLEY_BBCH_BG, language: 'bg', cropTags: ['Barley'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-barley-bbch', text: BARLEY_BBCH_EN, language: 'en', cropTags: ['Barley'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-barley-scouting', text: BARLEY_SCOUTING_BG, language: 'bg', cropTags: ['Barley'], bbchStageMin: 21, bbchStageMax: 69 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-barley-scouting', text: BARLEY_SCOUTING_EN, language: 'en', cropTags: ['Barley'], bbchStageMin: 21, bbchStageMax: 69 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-barley-cultural', text: BARLEY_CULTURAL_BG, language: 'bg', cropTags: ['Barley'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-barley-cultural', text: BARLEY_CULTURAL_EN, language: 'en', cropTags: ['Barley'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-barley-harvest', text: BARLEY_HARVEST_BG, language: 'bg', cropTags: ['Barley'], bbchStageMin: 80, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-barley-harvest', text: BARLEY_HARVEST_EN, language: 'en', cropTags: ['Barley'], bbchStageMin: 80, bbchStageMax: 99 },

    // ─── Maize ───
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-maize-bbch', text: MAIZE_BBCH_BG, language: 'bg', cropTags: ['Maize'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-maize-bbch', text: MAIZE_BBCH_EN, language: 'en', cropTags: ['Maize'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-maize-scouting', text: MAIZE_SCOUTING_BG, language: 'bg', cropTags: ['Maize'], bbchStageMin: 0, bbchStageMax: 39 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-maize-scouting', text: MAIZE_SCOUTING_EN, language: 'en', cropTags: ['Maize'], bbchStageMin: 0, bbchStageMax: 39 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-maize-cultural', text: MAIZE_CULTURAL_BG, language: 'bg', cropTags: ['Maize'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-maize-cultural', text: MAIZE_CULTURAL_EN, language: 'en', cropTags: ['Maize'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-maize-harvest', text: MAIZE_HARVEST_BG, language: 'bg', cropTags: ['Maize'], bbchStageMin: 83, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-maize-harvest', text: MAIZE_HARVEST_EN, language: 'en', cropTags: ['Maize'], bbchStageMin: 83, bbchStageMax: 99 },

    // ─── Sunflower ───
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-sunflower-bbch', text: SUNFLOWER_BBCH_BG, language: 'bg', cropTags: ['Sunflower'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-sunflower-bbch', text: SUNFLOWER_BBCH_EN, language: 'en', cropTags: ['Sunflower'], bbchStageMin: 0, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-sunflower-scouting', text: SUNFLOWER_SCOUTING_BG, language: 'bg', cropTags: ['Sunflower'], bbchStageMin: 0, bbchStageMax: 89 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-sunflower-scouting', text: SUNFLOWER_SCOUTING_EN, language: 'en', cropTags: ['Sunflower'], bbchStageMin: 0, bbchStageMax: 89 },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-sunflower-cultural', text: SUNFLOWER_CULTURAL_BG, language: 'bg', cropTags: ['Sunflower'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-sunflower-cultural', text: SUNFLOWER_CULTURAL_EN, language: 'en', cropTags: ['Sunflower'] },
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-sunflower-harvest', text: SUNFLOWER_HARVEST_BG, language: 'bg', cropTags: ['Sunflower'], bbchStageMin: 80, bbchStageMax: 99 },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-sunflower-harvest', text: SUNFLOWER_HARVEST_EN, language: 'en', cropTags: ['Sunflower'], bbchStageMin: 80, bbchStageMax: 99 },

    // ─── Shared — official register pointer (every crop) ───
    { source: AGRONOMY_SOURCE, sourceRef: 'bg-babh-register-check', text: REGISTER_CHECK_BG, language: 'bg' },
    { source: AGRONOMY_SOURCE, sourceRef: 'en-babh-register-check', text: REGISTER_CHECK_EN, language: 'en' },
];

/**
 * Write one batch of GLOBAL (tenantId NULL) chunks WITH embeddings.
 *
 * Runs via the supplied raw PrismaClient (the ingestion scripts use the
 * superuser-bypassed global client, since NULL-tenant rows can only be
 * written off the app_user path). Each entry is licence-checked AND
 * dose/PHI/REI-checked, inserted via Prisma (the non-vector columns,
 * including the mirrored crop/region/BBCH/language fields — see the
 * KnowledgeChunk model doc for why those are denormalized onto the
 * chunk rather than requiring a join back to an article), then its
 * embedding is written via raw `$executeRaw` (the Unsupported vector
 * column). Embeds in one batch.
 *
 * Idempotent on (source, sourceRef): existing GLOBAL chunks are skipped.
 */
export async function ingestGlobalCorpus(
    prisma: PrismaClient,
    entries: CorpusEntry[],
): Promise<{ created: number; skipped: number }> {
    for (const e of entries) {
        assertLicensedSource(e.source);
        assertNoUnregisteredRegulatedContent(e.text, e.sourceRef);
    }

    // Skip already-present GLOBAL chunks (idempotent re-run).
    const refs = entries.map((e) => e.sourceRef);
    const existing = await prisma.knowledgeChunk.findMany({
        where: { tenantId: null, sourceRef: { in: refs } },
        select: { source: true, sourceRef: true },
    });
    const seen = new Set(existing.map((x) => `${x.source}::${x.sourceRef}`));
    const todo = entries.filter((e) => !seen.has(`${e.source}::${e.sourceRef}`));
    if (todo.length === 0) return { created: 0, skipped: entries.length };

    const embeddings = await getAiProvider().embed({ texts: todo.map((e) => e.text) });

    let created = 0;
    for (let i = 0; i < todo.length; i++) {
        const e = todo[i];
        const row = await prisma.knowledgeChunk.create({
            data: {
                tenantId: null,
                source: e.source,
                sourceType: 'EXTERNAL',
                sourceRef: e.sourceRef,
                text: e.text,
                chunkIndex: 0,
                language: e.language,
                cropTags: e.cropTags ?? [],
                regions: e.regions ?? [],
                bbchStageMin: e.bbchStageMin ?? null,
                bbchStageMax: e.bbchStageMax ?? null,
            },
            select: { id: true },
        });
        const literal = toVectorLiteral(embeddings[i].vector);
        await prisma.$executeRaw`
            UPDATE "KnowledgeChunk"
            SET "embedding" = ${literal}::vector
            WHERE "id" = ${row.id}
        `;
        created++;
    }
    return { created, skipped: entries.length - todo.length };
}
