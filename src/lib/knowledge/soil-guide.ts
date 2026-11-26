/**
 * «Почва» — the soil section of the knowledge base (owner, 2026-11-26).
 *
 * Seven topics, each a short Agrent-written summary of what Bulgarian
 * official documents and two freely published guides say, with the source
 * named on every topic. It is ORIGINAL WORDING throughout: the owner asked
 * for the knowledge "organised into sections" from these books, and this
 * repository is public, so nothing here is copied from a source — the facts
 * (dates, distances, limits, figures) are stated in our own sentences and
 * each topic points at the document a farmer should check.
 *
 * ## One source of truth, three readers
 *
 * The web page (`/knowledge/soil`), the phone (`GET …/knowledge/soil-guide`)
 * and the assistant's `soil_guide` tool all read THIS module. It is code
 * rather than seeded `KnowledgeArticle` rows on purpose: a seed is an
 * operator step on the VM, and the satellite guide shows what that costs — a
 * page that must carry a fallback for the day the seed has not run. Here
 * there is nothing to run; a deploy is the publication.
 *
 * ## What is deliberately NOT here
 *
 * - **Crop-by-crop nitrogen norms.** The statutory-requirements guide carries
 *   a table of them by soil texture and expected yield. A partial copy would
 *   be worse than a pointer, so the `nitrogen` topic names the table instead.
 * - **Pesticide anything.** Same rule as every knowledge surface here
 *   (`scripts/rag/dose-phi-guard.ts`): no dose, pre-harvest interval or
 *   re-entry interval without a БАБХ registration number, and this product
 *   has no registration dataset. `tests/unit/soil-guide.test.ts` runs the
 *   real detector over every string below.
 * - **Rules newer than the sources.** The ДЗЕС text follows the ministry's
 *   2023 handbook; the EU simplified parts of conditionality in 2024, so the
 *   topics that cite ДЗЕС say to check the current year with ДФЗ / МЗХ rather
 *   than restating a change we have not read in a Bulgarian source.
 *
 * Every topic must fit one assistant tool result (`TOOL_RESULT_MAX_CHARS`),
 * which the test asserts per language.
 */

export const SOIL_SECTION_IDS = [
    'nitrogen',
    'slopes-water',
    'manure',
    'analysis',
    'erosion-cover',
    'organic-matter',
    'soil-life',
] as const;
export type SoilSectionId = (typeof SOIL_SECTION_IDS)[number];

export const SOIL_SOURCE_IDS = [
    'nitrates-rules',
    'ziu-guide',
    'dzes-handbook',
    'ordinance-9',
    'earthworms',
    'organic-handbook',
] as const;
export type SoilSourceId = (typeof SOIL_SOURCE_IDS)[number];

export type SoilLanguage = 'bg' | 'en';

interface Localised {
    readonly bg: string;
    readonly en: string;
}

export interface SoilSource {
    readonly id: SoilSourceId;
    /** The document's own title — Bulgarian, because that is what it is called. */
    readonly title: string;
    readonly publisher: Localised;
    readonly year: number;
    readonly url: string;
    /**
     * `official`: a Bulgarian normative act or ministry document, free to read
     * and to restate. `free-guide`: freely downloadable, still somebody's
     * copyright — summarised in our words, never quoted.
     */
    readonly kind: 'official' | 'free-guide';
}

interface SoilSectionData {
    readonly id: SoilSectionId;
    readonly title: Localised;
    readonly summary: Localised;
    readonly points: { readonly bg: readonly string[]; readonly en: readonly string[] };
    readonly sources: readonly SoilSourceId[];
}

/** A topic as one reader sees it, in one language. */
export interface SoilSectionView {
    readonly id: SoilSectionId;
    readonly title: string;
    readonly summary: string;
    readonly points: readonly string[];
    readonly sources: readonly SoilSourceView[];
}

export interface SoilSourceView {
    readonly id: SoilSourceId;
    readonly title: string;
    readonly publisher: string;
    readonly year: number;
    readonly url: string;
    readonly kind: SoilSource['kind'];
}

export const SOIL_SOURCES: Readonly<Record<SoilSourceId, SoilSource>> = {
    'nitrates-rules': {
        id: 'nitrates-rules',
        title:
            'Правила за добра земеделска практика за опазване на водите от замърсяване с нитрати '
            + 'от земеделски източници (Заповед № РД 09-1042/01.10.2024 г.)',
        publisher: { bg: 'Министерство на земеделието и храните', en: 'Ministry of Agriculture and Food' },
        year: 2024,
        url: 'https://leap.unep.org/en/countries/bg/national-legislation/order-no-rd09-104201102024-approving-rules-good-agricultural',
        kind: 'official',
    },
    'ziu-guide': {
        id: 'ziu-guide',
        title: 'Ръководство за законоустановените изисквания за управление (ЗИУ)',
        publisher: { bg: 'Министерство на земеделието и храните', en: 'Ministry of Agriculture and Food' },
        year: 2024,
        url: 'https://www.mzh.government.bg/media/filer_public/2024/10/14/rkovodstvo_ziu_dv_br_86-2024.pdf',
        kind: 'official',
    },
    'dzes-handbook': {
        id: 'dzes-handbook',
        title:
            'Наръчник за практическо приложение на условията за поддържане на земята в добро '
            + 'земеделско и екологично състояние (ДЗЕС)',
        publisher: { bg: 'Министерство на земеделието и храните', en: 'Ministry of Agriculture and Food' },
        year: 2023,
        url: 'https://www.mzh.government.bg/media/filer_public/2024/03/15/narchnik_dzes.pdf',
        kind: 'official',
    },
    'ordinance-9': {
        id: 'ordinance-9',
        title: 'Наредба № 9 от 26.02.2021 г. за интегрирано производство на растения и растителни продукти',
        publisher: { bg: 'Министерство на земеделието, храните и горите', en: 'Ministry of Agriculture, Food and Forestry' },
        year: 2021,
        url: 'https://www.mzh.government.bg/media/filer_public/2021/03/12/naredba__9_ot_26_fevruari_2021_g_za_integrirano_pr_0.pdf',
        kind: 'official',
    },
    earthworms: {
        id: 'earthworms',
        title: 'Земните червеи – архитекти на плодородната почва',
        publisher: { bg: 'FiBL и Биоселена', en: 'FiBL and Bioselena' },
        year: 2017,
        url: 'https://www.fibl.org/fileadmin/documents/shop/1042-duzhdovni-chervei.pdf',
        kind: 'free-guide',
    },
    'organic-handbook': {
        id: 'organic-handbook',
        title: 'Наръчник за органичния фермер',
        publisher: {
            bg: 'Програма за трансгранично сътрудничество България – Сърбия',
            en: 'Bulgaria–Serbia IPA Cross-border Programme',
        },
        year: 2012,
        url: 'https://arci-ngo.org/wp-content/uploads/2016/02/19_Manual_organic_farming_vanya.pdf',
        kind: 'free-guide',
    },
};

const SECTIONS: readonly SoilSectionData[] = [
    {
        id: 'nitrogen',
        title: { bg: 'Азотни торове: кога и колко', en: 'Nitrogen fertilisers: when and how much' },
        summary: {
            bg: 'Забранените периоди, годишният таван и разделянето на нормата. Задължително в нитратно '
                + 'уязвимите зони, добра практика навсякъде другаде.',
            en: 'Closed periods, the annual ceiling and splitting the rate. Mandatory in nitrate '
                + 'vulnerable zones, good practice everywhere else.',
        },
        points: {
            bg: [
                'В нитратно уязвимите зони тези правила са задължителни (ЗИУ 2). Извън тях са доброволни, '
                    + 'но важат задължително за кандидатите по някои мерки за подпомагане (агроекология, '
                    + 'биологично земеделие).',
                'Забранени периоди за всички азотни торове, органични и минерални: от 1 ноември до '
                    + '20 февруари в Южна България и до 25 февруари в Северна България (областите са '
                    + 'изброени в правилата); от 1 ноември до 5 февруари при есенници; от 1 ноември до '
                    + '25 февруари на голи площи, подготвени за сеитба; от 15 ноември до 25 февруари при '
                    + 'нови овощни насаждения, където оборски тор е допустим до 15 ноември.',
                'Не се тори замръзнала почва или почва със сняг, по време на дъжд и докато почвата е '
                    + 'преовлажнена, нито наводнена почва (освен оризища).',
                'Таванът е 17 кг азот на декар годишно от органични и минерални торове заедно — при '
                    + 'всички култури, ливади и пасища.',
                'При повече от 12 кг активно вещество азот на декар минералната норма се разделя: до една '
                    + 'трета преди сеитбата, останалото за подхранване. На леки, песъчливи почви азотът се '
                    + 'внася на 2–3 пъти, за да не се измие към подпочвените води.',
                'Нормата се определя по агрохимичен анализ на почвата и на органичния тор и по баланс на '
                    + 'азота: колко има в почвата преди сеитба, колко идва от минерализация на органичното '
                    + 'вещество и колко се внася с торовете. Без софтуер се ползва таблицата с норми по '
                    + 'култури и механичен състав в Ръководството за ЗИУ.',
                'Пресен оборски тор не се внася. Твърдият отлежава поне 6 месеца; в уязвимите зони течният '
                    + '— поне 4 месеца (правилата извън зоните искат 6). Остатъкът от биогазова инсталация '
                    + 'не изисква отлежаване, но пак не се внася в забранените периоди.',
                'В уязвимите зони органичният тор се заорава в деня на разпръскването, а всички азотни '
                    + 'торове се разпределят равномерно със специализирана техника.',
                'Минералните торове се съхраняват на закрито, с непропускливи под и покрив; насипни торове '
                    + 'не стоят на открито, а амониевата селитра се държи само опакована, до 10 реда '
                    + 'височина и на поне 25 см от стената.',
            ],
            en: [
                'In nitrate vulnerable zones these rules are mandatory (SMR 2). Outside them they are '
                    + 'voluntary, but they bind applicants under some support measures (agri-environment, '
                    + 'organic farming).',
                'Closed periods for every nitrogen fertiliser, organic or mineral: 1 November to '
                    + '20 February in southern Bulgaria and to 25 February in northern Bulgaria (the rules '
                    + 'list the provinces); 1 November to 5 February for autumn-sown crops; 1 November to '
                    + '25 February on bare land prepared for sowing; 15 November to 25 February when '
                    + 'planting new orchards, where manure is allowed until 15 November.',
                'No fertilising on frozen or snow-covered soil, during rain and while the soil is '
                    + 'waterlogged, or on flooded soil (rice fields excepted).',
                'The ceiling is 17 kg of nitrogen per decare a year from organic and mineral '
                    + 'fertilisers together, for every crop, meadow and pasture.',
                'Above 12 kg of nitrogen active substance per decare the mineral rate is split: up to a '
                    + 'third before sowing, the rest as top dressing. On light, sandy soils nitrogen goes '
                    + 'on in 2–3 passes so it is not washed down to groundwater.',
                'The rate comes from a soil and manure analysis and a nitrogen balance: what is in the '
                    + 'soil before sowing, what mineralising organic matter releases, and what fertilisers '
                    + 'add. Without software, use the table of rates by crop and soil texture in the '
                    + 'statutory requirements guide.',
                'Fresh manure is not spread. Solid manure is stored at least 6 months; in vulnerable '
                    + 'zones liquid manure at least 4 months (the rules outside the zones ask for 6). '
                    + 'Biogas digestate needs no storage time but still respects the closed periods.',
                'In vulnerable zones organic fertiliser is ploughed in on the day it is spread, and all '
                    + 'nitrogen fertilisers are spread evenly with proper equipment.',
                'Mineral fertilisers are stored indoors with an impermeable floor and roof; bulk '
                    + 'fertiliser never sits in the open, and ammonium nitrate is kept bagged only, stacked '
                    + 'at most 10 high and at least 25 cm from the wall.',
            ],
        },
        sources: ['nitrates-rules', 'ziu-guide'],
    },
    {
        id: 'slopes-water',
        title: { bg: 'Склонове и води', en: 'Slopes and water' },
        summary: {
            bg: 'Колко далеч от реки и канали и при какъв наклон може да се тори, и буферните ивици по ДЗЕС 4.',
            en: 'How far from rivers and canals and on what slope you may fertilise, and the GAEC 4 buffer strips.',
        },
        points: {
            bg: [
                'На равен терен азотни торове не се внасят на по-малко от 5 м от повърхностни води — реки, '
                    + 'потоци, канали, езера, язовири, морето. При течна фракция на оборски тор отстоянието '
                    + 'е 10 м, а при торене от въздух — 10 м и само при тихо време.',
                'ДЗЕС 4 — буферни ивици без торове и без продукти за растителна защита: поне 5 м при наклон '
                    + 'до 5% (3°); 10 м при течна фракция на оборски тор или при наклон до 10% (6°); 50 м при '
                    + 'наклон над 10%; 2 м край напоителни и отводнителни канали на оризища.',
                'Първите 5 м до водата са с трева, храсти или дървета целогодишно; останалата част от '
                    + 'по-широката ивица може да се обработва и засява, но не се тори и не се пръска. Ивицата '
                    + 'се мери от брега при пълноводие.',
                'Наклон от 3° до 6°: противоерозионни мерки — сеитбообращения, обработка напречно на '
                    + 'склона, ивично (контурно) земеделие, тревни буферни ивици, мулчиране, отвеждане на '
                    + 'повърхностната вода.',
                'Наклон над 6° и по-малко от 50 м до вода: не се тори. Изключение е само рекултивацията и '
                    + 'подобряването на слабопродуктивни земи по Наредба № 26.',
                'Наклон от 6° до 12°: освен горните мерки азотните торове се внасят вътрепочвено, а край '
                    + 'реки се оставя 5 м затревена или храстова ивица, която не се обработва и не се тори.',
                'Наклон над 12°: азот само по схема на торене за конкретния участък, изготвена от '
                    + 'специалист по торене и специалист по ерозия.',
                'Средният наклон на всеки заявен парцел е изчислен от цифров модел на релефа и се вижда в '
                    + 'профила в Системата за електронни услуги на ДФЗ, раздел „Справки“.',
            ],
            en: [
                'On flat land nitrogen fertiliser is not spread within 5 m of surface water — rivers, '
                    + 'streams, canals, lakes, reservoirs, the sea. For the liquid fraction of manure the '
                    + 'distance is 10 m, and aerial spreading keeps 10 m and needs calm weather.',
                'GAEC 4 buffer strips, with no fertiliser and no plant protection products: at least 5 m '
                    + 'on slopes up to 5% (3°); 10 m for liquid manure or slopes up to 10% (6°); 50 m on '
                    + 'slopes over 10%; 2 m along irrigation and drainage canals of rice fields.',
                'The first 5 m from the water carry grass, shrubs or trees all year; the rest of a wider '
                    + 'strip may be tilled and sown but not fertilised or sprayed. The strip is measured '
                    + 'from the bank at high water.',
                'Slopes of 3° to 6°: anti-erosion measures — rotations, tillage across the slope, contour '
                    + 'strip farming, grass buffer strips, mulching, draining surface water away.',
                'Slopes over 6° within 50 m of water: no fertilising. The only exception is reclaiming '
                    + 'and improving poor land under Ordinance No 26.',
                'Slopes of 6° to 12°: on top of the measures above, nitrogen is placed into the soil, and '
                    + 'along rivers a 5 m grass or shrub strip is left untilled and unfertilised.',
                'Slopes over 12°: nitrogen only under a fertilising scheme for that plot drawn up by a '
                    + 'fertiliser specialist and an erosion specialist.',
                'The average slope of every declared parcel is computed from a terrain model and shown in '
                    + 'the State Fund Agriculture e-services profile, under «Справки».',
            ],
        },
        sources: ['nitrates-rules', 'dzes-handbook'],
    },
    {
        id: 'manure',
        title: { bg: 'Оборски тор: съхранение и количество', en: 'Manure: storage and amount' },
        summary: {
            bg: 'Торища, отстояния и капацитет, колко азот носи тонът тор и как се смята годишното количество.',
            en: 'Manure stores, distances and capacity, how much nitrogen a tonne carries and how the annual amount is worked out.',
        },
        points: {
            bg: [
                'Торището не пуска течове в почвата и подземните води: до 5 животински единици — площадка с '
                    + 'непропусклива основа; над 5 — съоръжение с непропускливи дъно и стени, отделно за '
                    + 'твърдата и течната фракция, ако торът се разделя.',
                'Торище се прави на поне 20 м от повърхностни води; течен тор не се съхранява на наклон над 6°.',
                'Капацитет: при оборно-пасищно отглеждане — тор за поне 4 месеца; при оборно — поне 6 '
                    + 'месеца; течният тор — поне 6 месеца, включително забранения за торене период. Който '
                    + 'няма достатъчно земя, предава тора по договор.',
                'Общ азот в тон пресен тор, в кг: говеда и биволи 5,7; млади говеда 6; телета 7,3; свине за '
                    + 'разплод 6,4; свине за угояване 7; кокошки носачки 10,8; бройлери 9; патици и гъски '
                    + '10,9; овце 8,3; кози 7; коне и магарета 5,8; зайци 14.',
                'Най-много тор за година на декар = 17 × 1000 ÷ азота в тон. Говежди тор (5,7 кг в тон) — до '
                    + 'около 2,98 т на декар; тор от кокошки носачки — до около 1,57 т. Разреденият с вода тор '
                    + 'носи по-малко азот в тон.',
                'През годината растенията усвояват само част от азота в оборския тор — около 20–35% при '
                    + 'твърд говежди тор срещу 100% при минерален тор. Това се отчита, когато се смята колко '
                    + 'минерален азот да се добави.',
                'На ливади и пасища количеството се намалява с тора, оставен от животните по време на паша.',
                'В биологичното производство общото количество оборски тор е до 170 кг азот на хектар '
                    + 'годишно — същите 17 кг на декар.',
                'Отцеждащите се води от силаж се събират в непропусклив резервоар, балираният силаж стои на '
                    + 'поне 20 м от води, а развален силаж се изгребва заедно с 5 см почва и се компостира.',
            ],
            en: [
                'A manure store must not leak into soil or groundwater: up to 5 livestock units, a pad '
                    + 'with an impermeable base; above 5, a store with impermeable floor and walls, '
                    + 'separate for solid and liquid fractions if the manure is separated.',
                'Stores sit at least 20 m from surface water; liquid manure is not stored on slopes over 6°.',
                'Capacity: housed-and-grazed animals, at least 4 months of manure; fully housed, at least '
                    + '6 months; liquid manure, at least 6 months including the closed period. A farm '
                    + 'without enough land hands manure on under contract.',
                'Total nitrogen per tonne of fresh manure, in kg: cattle and buffalo 5.7; young cattle 6; '
                    + 'calves 7.3; breeding pigs 6.4; fattening pigs 7; laying hens 10.8; broilers 9; '
                    + 'ducks and geese 10.9; sheep 8.3; goats 7; horses and donkeys 5.8; rabbits 14.',
                'Most manure per decare a year = 17 × 1000 ÷ nitrogen per tonne. Cattle manure (5.7 kg a '
                    + 'tonne) — up to about 2.98 t per decare; laying-hen manure — up to about 1.57 t. '
                    + 'Manure diluted with water carries less nitrogen per tonne.',
                'Within a year crops take up only part of the nitrogen in manure — about 20–35% for solid '
                    + 'cattle manure against 100% for mineral fertiliser. This is counted when working out '
                    + 'how much mineral nitrogen to add.',
                'On meadows and pastures the amount is reduced by the manure the animals leave while grazing.',
                'In organic production total manure is capped at 170 kg of nitrogen per hectare a year — '
                    + 'the same 17 kg per decare.',
                'Silage effluent is collected in an impermeable tank, baled silage is kept at least 20 m '
                    + 'from water, and spoiled silage is scraped up with 5 cm of soil and composted.',
            ],
        },
        sources: ['nitrates-rules', 'ziu-guide', 'organic-handbook'],
    },
    {
        id: 'analysis',
        title: { bg: 'Почвен анализ и балансирано торене', en: 'Soil analysis and balanced fertilising' },
        summary: {
            bg: 'Защо нормата идва от анализа, какво да се записва, фосфор и pH, планът при интегрирано производство и утайките.',
            en: 'Why the rate comes from analysis, what to record, phosphorus and pH, the integrated-production plan and sewage sludge.',
        },
        points: {
            bg: [
                'Нормата на торене се определя по агрохимичен анализ на почвата и препоръка на специалист '
                    + 'по торене, а планът за подобряване на почвата — според предназначението ѝ.',
                'Води се дневник на торенето: име и вид на тора, количество и норма, резултатите от анализа '
                    + 'и препоръката на специалиста.',
                'Балансът на азота и фосфора се смята със софтуер — инструмента за балансирано торене на '
                    + 'НССЗ, платформата FaST (fastplatform.eu) или друго приложение за прецизно торене.',
                'Фосфорът и калият се държат в оптималния диапазон, като торенето покрива изнесеното с '
                    + 'реколтата. На бедни на фосфор почви се внася повече от износа, за да се вдигне запасът '
                    + 'за няколко години; на богати е допустим отрицателен баланс.',
                'Почвената реакция се поддържа оптимална за културата — при нужда с варуване или гипсуване, '
                    + 'според анализа. Под pH (H₂O) 5,5 почвата е неблагоприятна и за земните червеи.',
                'Интегрирано производство (Наредба № 9/2021): план за 5 години със скица на площите, '
                    + 'сеитбообращение по полета и схема за наторяване по анализ от акредитирана '
                    + 'лаборатория; дневник на торенето и растителната защита.',
                'Схемата за наторяване съдържа: поле и площ; култура, сорт и планиран добив; предшественик; '
                    + 'норми на азот, фосфор (P₂O₅) и калий (K₂O) в кг на хектар; органичен тор (вид и '
                    + 'тонове на хектар); минерален тор (вид и основни компоненти).',
                'Утайки от пречиствателни станции се ползват само с разрешение от БАБХ по Закона за '
                    + 'опазване на земеделските земи и документ по Закона за управление на отпадъците. Не '
                    + 'се внасят върху пасища и фуражни площи, ако пашата или прибирането е до 45 дни след '
                    + 'това, върху зеленчуци и плодове (освен овощни дървета и лозя), в защитени територии '
                    + 'и в санитарни зони на водоизточници. Декларация до РИОСВ се подава до 31 март.',
            ],
            en: [
                'The fertilising rate comes from an agrochemical soil analysis and a fertiliser '
                    + 'specialist\'s recommendation, and a soil improvement plan follows the land\'s use.',
                'Keep a fertilising diary: name and type of fertiliser, amount and rate, the analysis '
                    + 'results and the specialist\'s recommendation.',
                'Nitrogen and phosphorus balances are worked out in software — the national advisory '
                    + 'service\'s balanced-fertilising tool, the FaST platform (fastplatform.eu) or another '
                    + 'precision-fertilising application.',
                'Keep phosphorus and potassium in the optimal range by replacing what the harvest removes. '
                    + 'On phosphorus-poor soils apply more than is removed to raise the reserve over a few '
                    + 'years; on rich soils a negative balance is acceptable.',
                'Keep soil reaction right for the crop — liming or gypsum where needed, according to the '
                    + 'analysis. Below pH (H₂O) 5.5 the soil is also hostile to earthworms.',
                'Integrated production (Ordinance No 9/2021): a 5-year plan with a map of the fields, the '
                    + 'rotation by field and a fertilising scheme based on an accredited laboratory\'s '
                    + 'analysis; a diary of fertilising and plant protection.',
                'The fertilising scheme lists: field and area; crop, variety and planned yield; previous '
                    + 'crop; nitrogen, phosphorus (P₂O₅) and potassium (K₂O) in kg per hectare; organic '
                    + 'fertiliser (type and tonnes per hectare); mineral fertiliser (type and main nutrients).',
                'Sewage sludge may be used only with a БАБХ permit under the Agricultural Land Protection '
                    + 'Act and a document under the Waste Management Act. Not on pasture or forage land '
                    + 'grazed or cut within 45 days, not on vegetables and fruit (orchard trees and vines '
                    + 'excepted), not in protected areas or water-source protection zones. A declaration '
                    + 'goes to the regional environment inspectorate by 31 March.',
            ],
        },
        sources: ['nitrates-rules', 'ziu-guide', 'ordinance-9', 'earthworms'],
    },
    {
        id: 'erosion-cover',
        title: { bg: 'Ерозия и почвена покривка', en: 'Erosion and soil cover' },
        summary: {
            bg: 'Обработка на склонове по ДЗЕС 5, задължителната покривка по ДЗЕС 6, зелено торене и мулч.',
            en: 'Tillage on slopes under GAEC 5, the required cover under GAEC 6, green manure and mulch.',
        },
        points: {
            bg: [
                'ДЗЕС 5: на парцели с наклон 10% и повече обработваемата земя се обработва напречно на '
                    + 'склона, по хоризонталите или с обработки без обръщане на пласта (минимални, ивични, '
                    + 'нулеви); трайните насаждения — напречно на склона, с тераси или противоерозионни ивици.',
                'В цялото стопанство не се работи с машини върху наводнена или преовлажнена почва.',
                'ДЗЕС 6: на поне 80% от обработваемата земя почвата е покрита в чувствителния период — от '
                    + '1 юни до 31 октомври за парцели с наклон до 10% и от 1 ноември до 15 февруари за '
                    + 'парцели над 10%. Не се изисква, ако следващата култура се засее до 2 седмици.',
                'Покривка са есенниците и фуражните култури, стърнището (необработено или с вертикална '
                    + 'обработка без обръщане), самосевките, покривните и междинните култури и мулчът. '
                    + 'Черната угар не е покривка.',
                'В трайните насаждения поне половината площ има затревени или засети с покривни култури '
                    + 'междуредия от 1 ноември до 15 февруари.',
                'Препоръчани мерки: противоерозионни сеитбообращения — повече житни със слята повърхност и '
                    + 'многогодишни треви, по-тесни парцели, без окопни култури на най-рисковите места; '
                    + 'обработки, които оставят 30–100% от растителните остатъци; полезащитни пояси, тераси, синори.',
                'Зелено торене: най-добри сидерати са бобовите. Заорават се на 20–25 см — 4–5 седмици преди '
                    + 'следващата сеитба на тежки почви и 2–3 седмици на леки.',
                'Мулч: почвата се разрохква първо; сухият мулч, например слама, се слага на 2–10 см и се '
                    + 'овлажнява; материалът е без семена от плевели.',
                'Около 76,5% от обработваемите земи в България са от II до IV клас по пригодност и имат '
                    + 'нужда от противоерозионни мерки. ЕС опрости част от ДЗЕС през 2024 г. — проверете '
                    + 'изискванията за текущата година в ДФЗ или МЗХ.',
            ],
            en: [
                'GAEC 5: on parcels with a slope of 10% or more, arable land is tilled across the slope, '
                    + 'along the contours or without turning the soil (minimum, strip or zero tillage); '
                    + 'permanent crops across the slope, on terraces or with anti-erosion strips.',
                'Nowhere on the farm is machinery worked on flooded or waterlogged soil.',
                'GAEC 6: at least 80% of arable land stays covered in the sensitive period — 1 June to '
                    + '31 October for parcels up to 10% slope, 1 November to 15 February for steeper ones. '
                    + 'Not required if the next crop is sown within 2 weeks.',
                'Cover means autumn-sown and forage crops, stubble (untilled or with non-inversion '
                    + 'tillage), volunteer plants, cover and catch crops, and mulch. Bare fallow is not cover.',
                'In permanent crops at least half the area has grassed or cover-cropped inter-rows from '
                    + '1 November to 15 February.',
                'Recommended: anti-erosion rotations — more close-sown cereals and perennial grasses, '
                    + 'narrower plots, no row crops on the riskiest ground; tillage that keeps 30–100% of '
                    + 'residues on the surface; shelter belts, terraces, field margins.',
                'Green manure: legumes are the best. Plough them in at 20–25 cm — 4–5 weeks before the '
                    + 'next sowing on heavy soils, 2–3 weeks on light ones.',
                'Mulch: loosen the soil first; dry mulch such as straw goes on 2–10 cm deep and is '
                    + 'moistened; the material must be free of weed seed.',
                'About 76.5% of Bulgaria\'s arable land is in suitability classes II to IV and needs '
                    + 'anti-erosion measures. The EU simplified parts of GAEC in 2024 — check the current '
                    + 'year\'s requirements with State Fund Agriculture or the ministry.',
            ],
        },
        sources: ['dzes-handbook'],
    },
    {
        id: 'organic-matter',
        title: { bg: 'Органично вещество и сеитбооборот', en: 'Organic matter and crop rotation' },
        summary: {
            bg: 'Забраната за палене на стърнища, сеитбооборотът по ДЗЕС 7, влажните зони и как се поддържа плодородието.',
            en: 'The stubble-burning ban, rotation under GAEC 7, wetlands and peat, and how fertility is kept up.',
        },
        points: {
            bg: [
                'ДЗЕС 3: стърнищата от житни култури не се палят, освен по фитосанитарни причини с документ '
                    + 'от компетентния орган. Огънят унищожава органичното вещество, хумусния слой и '
                    + 'почвените микроорганизми; ръководството съветва да не се горят и остатъците от '
                    + 'слънчоглед, царевица и други пролетни култури.',
                'Остатъците се надробяват с мулчер или сечка и се заорават или остават като мулч; могат да '
                    + 'станат фураж, постеля, компост, пелети или суровина за биогаз.',
                'ДЗЕС 7: стопанство с над 10 ха обработваема земя сменя културата всяка година на поне 35% '
                    + 'от нея. Втора култура, засята веднага след прибирането и останала до подготовката за '
                    + 'следващата, се брои за смяна. След третата година всички парцели трябва да са '
                    + 'сменили културата спрямо 2023 г.',
                'Освободени са стопанствата до 10 ха и тези, в които над 75% от обработваемата земя е под '
                    + 'треви, фуражи, бобови или угар; сертифицираните биологични стопанства се смятат за '
                    + 'изпълнили изискването. Угарта не се брои за смяна.',
                'Сеитбооборотът обикновено се планира за 3–4 години — толкова е нужно повечето почвени '
                    + 'болести и неприятели да спаднат. Различните култури черпят различни хранителни '
                    + 'вещества и подобряват структурата на почвата.',
                'Плодородието се поддържа с бобови, зелено торене и дълбококоренови растения в '
                    + 'сеитбооборота и с оборски тор и компост — така е и в биологичното производство.',
                'ДЗЕС 2 (от 2025 г.): във влажни зони и торфища са забранени оранта и дълбокото '
                    + 'разрохкване, пресушаването и дренирането, разораването на постоянно затревени площи, '
                    + 'паленето на растителност, азотните торове и продуктите за растителна защита.',
                'ЕС опрости част от ДЗЕС през 2024 г. — проверете изискванията за текущата година в ДФЗ или МЗХ.',
            ],
            en: [
                'GAEC 3: cereal stubble is not burned, except for plant-health reasons with a document '
                    + 'from the competent authority. Fire destroys organic matter, the humus layer and soil '
                    + 'microbes; the handbook advises against burning sunflower, maize and other spring '
                    + 'crop residues too.',
                'Chop residues with a mulcher or flail and plough them in or leave them as mulch; they can '
                    + 'also become feed, bedding, compost, pellets or biogas feedstock.',
                'GAEC 7: a farm with more than 10 ha of arable land changes the crop every year on at '
                    + 'least 35% of it. A second crop sown straight after harvest and kept until the next '
                    + 'seedbed counts as a change. After the third year every parcel must have changed '
                    + 'crop compared with 2023.',
                'Exempt: farms up to 10 ha and farms where more than 75% of arable land is grass, forage, '
                    + 'legumes or fallow; certified organic farms count as compliant. Fallow does not count '
                    + 'as a change.',
                'A rotation is usually planned over 3–4 years — the time most soil-borne diseases and '
                    + 'pests need to decline. Different crops draw different nutrients and improve soil '
                    + 'structure.',
                'Fertility is kept up with legumes, green manure and deep-rooted plants in the rotation '
                    + 'and with manure and compost — as in organic production.',
                'GAEC 2 (from 2025): in wetlands and peatland, ploughing and deep loosening, drying and '
                    + 'draining, ploughing up permanent grassland, burning vegetation, nitrogen fertilisers '
                    + 'and plant protection products are banned.',
                'The EU simplified parts of GAEC in 2024 — check the current year\'s requirements with '
                    + 'State Fund Agriculture or the ministry.',
            ],
        },
        sources: ['dzes-handbook', 'organic-handbook'],
    },
    {
        id: 'soil-life',
        title: { bg: 'Почвен живот: земните червеи', en: 'Soil life: earthworms' },
        summary: {
            bg: 'Какво правят червеите за почвата, кое им вреди и как да ги преброите сами.',
            en: 'What earthworms do for the soil, what harms them and how to count them yourself.',
        },
        points: {
            bg: [
                'Здравата почва има от 1 до 3 милиона земни червея на хектар; 120–140 на кв. м в '
                    + 'обработваема земя се смятат за добра плътност.',
                'Червеите вкарват в почвата до 6 т растителни остатъци на хектар годишно и правят 40–100 т '
                    + 'екскременти — стабилни трохи с около 5 пъти повече азот, 7 пъти повече фосфор и 11 пъти '
                    + 'повече калий от околната почва.',
                'Вертикалните им ходове (до 3 м в льос, до 6 м в чернозем) подобряват попиването на водата и '
                    + 'намаляват отока и ерозията; корените заемат над 90% от тях.',
                'Плугът убива около 25% от червеите, бързо въртящите се машини — до 70%. Избягвайте '
                    + 'интензивна обработка през март–април и септември–октомври, когато са най-активни; '
                    + 'суха или студена почва се обработва с по-малко щети.',
                'Уплътняването им вреди: по-лека техника, по-ниско налягане в гумите и работа само върху '
                    + 'просъхнала почва.',
                'Хранят ги разнообразният сеитбооборот, многогодишната детелина и люцерната, сидератите и '
                    + 'растителните остатъци. Органичният тор се внася плитко — дълбоко заровеният създава '
                    + 'анаеробни условия.',
                'Течният тор се разбърква, разрежда и внася умерено — около 25 м³ на хектар — върху '
                    + 'попиваща почва. Амониевият сулфат вкислява почвата и им вреди; при pH (H₂O) под 5,5 се '
                    + 'варува според анализа.',
                'Бърза проверка: лопата 10 × 10 см и 25 см дълбока в средно тежка почва съдържа средно 2–3 '
                    + 'червея, т.е. 100–200 на кв. м. На площ 50 × 50 см през пролетта или есента до 5 '
                    + 'купчинки екскременти означават слаба активност, около 10 — умерена, 20 и повече — висока.',
            ],
            en: [
                'Healthy soil holds 1 to 3 million earthworms per hectare; 120–140 per m² on arable land '
                    + 'counts as a good density.',
                'Earthworms take up to 6 t of plant residue per hectare a year into the soil and produce '
                    + '40–100 t of casts — stable crumbs with about 5 times the nitrogen, 7 times the '
                    + 'phosphorus and 11 times the potassium of the soil around them.',
                'Their vertical burrows (up to 3 m deep in loess, up to 6 m in chernozem) help water soak '
                    + 'in and cut runoff and erosion; roots occupy more than 90% of them.',
                'A plough kills about 25% of earthworms, fast rotary implements up to 70%. Avoid intensive '
                    + 'tillage in March–April and September–October, when they are most active; dry or cold '
                    + 'soil is tilled with less harm.',
                'Compaction harms them: lighter machinery, lower tyre pressure and working only on soil '
                    + 'that has dried out.',
                'They are fed by a varied rotation, perennial clover and lucerne, green manures and crop '
                    + 'residues. Organic fertiliser goes in shallow — buried deep, it turns anaerobic.',
                'Liquid manure is stirred, diluted and applied moderately — about 25 m³ per hectare — on '
                    + 'absorbent soil. Ammonium sulphate acidifies the soil and harms them; below pH (H₂O) '
                    + '5.5, lime according to the analysis.',
                'Quick check: a spadeful 10 × 10 cm and 25 cm deep in medium soil holds 2–3 worms on '
                    + 'average, i.e. 100–200 per m². On a 50 × 50 cm patch in spring or autumn, up to 5 '
                    + 'casts means low activity, about 10 moderate, 20 or more high.',
            ],
        },
        sources: ['earthworms'],
    },
];

function sourceView(id: SoilSourceId, language: SoilLanguage): SoilSourceView {
    const s = SOIL_SOURCES[id];
    return { id: s.id, title: s.title, publisher: s.publisher[language], year: s.year, url: s.url, kind: s.kind };
}

function sectionView(section: SoilSectionData, language: SoilLanguage): SoilSectionView {
    return {
        id: section.id,
        title: section.title[language],
        summary: section.summary[language],
        points: section.points[language],
        sources: section.sources.map((id) => sourceView(id, language)),
    };
}

/** Narrows any locale string to the guide's two languages; Bulgarian otherwise. */
export function soilLanguage(locale: string | null | undefined): SoilLanguage {
    return locale === 'en' ? 'en' : 'bg';
}

/** The whole guide, in order, in one language. */
export function soilGuide(language: SoilLanguage): readonly SoilSectionView[] {
    return SECTIONS.map((s) => sectionView(s, language));
}

/** One topic in one language. */
export function soilSection(id: SoilSectionId, language: SoilLanguage): SoilSectionView {
    const section = SECTIONS.find((s) => s.id === id);
    // SOIL_SECTION_IDS and SECTIONS are asserted to be the same set, in the
    // same order, by tests/unit/soil-guide.test.ts — so this cannot miss.
    if (!section) throw new Error(`soil-guide: no section ${id}`);
    return sectionView(section, language);
}
