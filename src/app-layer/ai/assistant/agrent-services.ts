import type { ModuleKey } from '@prisma/client';

import type { RequestContext } from '@/app-layer/types';
import { hasVisiblePromotions } from '@/app-layer/usecases/promotions';
import { isModuleAvailable } from '@/app-layer/usecases/modules';
import { isFeatureEnabled } from '@/lib/feature-flags';

/**
 * What Agrent itself offers — the assistant's product guide.
 *
 * ## Why this exists
 *
 * Asked where a farmer can insure a crop, the assistant answered from general
 * knowledge and named outside routes, while Agrent itself prices a crop policy
 * per parcel and sends the request to an insurer («Риск» → «Поискай
 * застрахователна оферта»). Nothing had told it what the product does: every
 * other tool reads the farm's DATA, and no tool or prompt line described the
 * SERVICES. So a question about Agrent was answered as a question about the
 * world.
 *
 * ## Hand-written, and held to the app by tests
 *
 * Owner ruling 2026-11-19: written by hand, so each entry can say what a
 * service does and what it does NOT do (Agrent is not an insurer; it does not
 * file a subsidy application). A list generated from page titles could only
 * say that a page exists. The cost of writing it by hand is that it can go
 * stale, so `tests/unit/ai/agrent-services.test.ts` fails when an entry's
 * `route` is not a page this app serves, and when the whole guide no longer
 * fits in one tool result.
 *
 * Each `what` is taken from the page's own copy in `messages/bg/app.json`,
 * not paraphrased from memory: the guide's job is to stop the assistant
 * inventing, so it must not invent either.
 *
 * ## Filtered per farm
 *
 * `gate` hides a service the farm cannot open — a module switched off or not
 * on its plan, a feature flag off for this person — so the assistant never
 * sends somebody to a screen that will refuse them. Each flag gate names its
 * key as a LITERAL, for `social-routes-flag-gated`'s reason: an operator must
 * be able to find what a flag controls by reading the code.
 *
 * ## Links
 *
 * `route` is the web page, tenant-relative and without parameters. The tool
 * result carries it so `linksFromPages` can offer a tap to the screen — built
 * by the server from this list, never written by the model. The phone opens
 * one when it is a tab on the person's bar and hides it otherwise
 * (agrent-ios `AssistantSheet.followable`), which is the safe direction.
 */
export interface AgrentService {
    /** The service, in the words the farmer sees on screen. */
    readonly name: string;
    /** What it does, from the page's own copy. Bulgarian. */
    readonly what: string;
    /** Where to find it: the menu item, and the control on the screen when it matters. */
    readonly where: string;
    /** The web page, tenant-relative (`/farm-risk`); absent for a phone-only service. */
    readonly route?: string;
    /** When the farm cannot open it, it is left out. */
    readonly gate?: (ctx: RequestContext) => Promise<boolean>;
}

/**
 * Agrent's insurance partner (owner, 2026-11-19), who receives the in-app
 * quote requests («Поискай застрахователна оферта»). The assistant
 * recommends it and no other insurer, broker or comparison site — and always
 * as AGRENT'S PARTNER, because recommending one company is a commercial
 * communication, and a farmer is entitled to know it is one (the reasoning
 * the promotions rule gives for DSA Art 26). Named by its domain, which is
 * what a farmer types, rather than a Cyrillic brand spelling nobody has
 * confirmed.
 */
export const INSURANCE_PARTNER = 'agrozastrahovane.bg';

const moduleOn = (key: ModuleKey) => (ctx: RequestContext) => isModuleAvailable(ctx, key);

export const AGRENT_SERVICES: readonly AgrentService[] = [
    {
        name: 'Застраховка на посев',
        what: 'Ориентировъчна премия по парцел — за посев (пшеница, ечемик, царевица, слънчоглед, '
            + 'рапица) или срещу риск (засушаване, градушка, измръзване). Заявката отива при '
            + `партньора на Agrent за застраховки, ${INSURANCE_PARTNER}, който се свързва с Вас и `
            + 'потвърждава офертата. Agrent не е застраховател и не сключва полици.',
        where: '«Риск» → «Поискай застрахователна оферта» до парцела',
        route: '/farm-risk',
    },
    {
        name: 'Риск',
        what: 'Сателитен риск по парцел от Sentinel-2 — стрес на растителността и влага.',
        where: '«Риск»',
        route: '/farm-risk',
    },
    {
        name: 'Дневник',
        what: 'Записът на извършената и планираната работа — третирания с ПРЗ, торене, сеитба, прибиране.',
        where: '«Дневник»',
        route: '/journal',
        gate: moduleOn('JOURNAL'),
    },
    {
        name: 'Карта',
        what: 'Блоковете и парцелите на стопанството на карта, със сателитни индекси.',
        where: '«Карта»',
        route: '/locations',
    },
    {
        name: 'Задачи',
        what: 'Опашката със земеделска работа — задачи и операции, най-скоро дължимите първи.',
        where: '«Задачи»',
        route: '/farm-tasks',
    },
    {
        name: 'Климат',
        what: 'Времето за полетата — текущи условия, прогноза и подходящ момент за пръскане днес.',
        where: '«Климат»',
        route: '/climate',
    },
    {
        name: 'График',
        what: 'Важните дати — задачи, срокове на наеми, засаждане и прибиране, прозорци за пръскане.',
        where: '«График»',
        route: '/calendar',
    },
    {
        name: 'Планиране',
        what: 'Сезонни планове — графикът на сеитба, разсаждане и прибиране.',
        where: '«Планиране»',
        route: '/planning',
        gate: moduleOn('PLANNING'),
    },
    {
        name: 'Склад',
        what: 'Наличности от материали, партиди и движенията им.',
        where: '«Склад»',
        route: '/inventory',
        gate: moduleOn('INVENTORY'),
    },
    {
        name: 'Ренти',
        what: 'Договорите за наем по парцелите — ведомост за ренти и изтичащи договори.',
        where: '«Ренти»',
        route: '/rent',
    },
    {
        name: 'Документи',
        what: 'Качване и пазене на документите на стопанството — PDF, снимки, сканирани листове.',
        where: '«Документи»',
        route: '/evidence',
    },
    {
        name: 'Зърно',
        what: 'Договори за продажба и покупка, силози с наличната продукция и действителният добив по полета.',
        where: '«Договори», «Силози», «Добив»',
        route: '/grain/contracts',
        gate: moduleOn('GRAIN'),
    },
    {
        name: 'Разходи',
        what: 'Всички разходи — заплати, рента, материали, услуги — с фактурата и за какво са.',
        where: '«Разходи»',
        route: '/grain/costs',
        gate: moduleOn('GRAIN'),
    },
    {
        name: 'Калкулатор',
        what: 'Колко струват реколтата на корен и зърното в склада днес след разходите, рентата и заплатите.',
        where: '«Калкулатор»',
        route: '/grain/calculator',
        gate: moduleOn('GRAIN'),
    },
    {
        name: 'Борса',
        what: 'Обяви за продажба или покупка, видими за всички стопанства; запитванията стигат до продавача по имейл.',
        where: '«Борса»',
        route: '/exchange',
        gate: moduleOn('EXCHANGE'),
    },
    {
        name: 'Тенденции',
        what: 'Пазарни цени по култури във времето.',
        where: '«Тенденции»',
        route: '/trends',
    },
    {
        name: 'Новини',
        what: 'Земеделски новини.',
        where: '«Новини»',
        route: '/news',
    },
    {
        name: 'Схеми',
        what: 'Мерките за подпомагане (ДФЗ, МЗХ) със сроковете за кандидатстване. '
            + 'Кандидатства се в ДФЗ — Agrent не подава заявления.',
        where: '«Схеми»',
        route: '/schemes',
    },
    {
        name: 'Промоции',
        what: 'Промоции и оферти от доставчици за земеделието.',
        where: '«Промоции»',
        route: '/offers',
        gate: () => hasVisiblePromotions(),
    },
    {
        name: 'Канали',
        what: 'Канали по култури, области и материали, в които земеделци пишат помежду си.',
        where: '«Канали»',
        route: '/channels',
        gate: (ctx) => isFeatureEnabled('social.channels', ctx.userId),
    },
    {
        name: 'Лунен календар',
        what: 'Видът на деня по положението на Луната. Народна традиция, не агрономски съвет.',
        where: 'в приложението за телефон, «Календари»',
        gate: (ctx) => isFeatureEnabled('lunar.enabled', ctx.userId),
    },
    {
        name: 'Агрономически календар',
        what: 'Кога какво се прави по културите през годината, за Северна и Южна България, с източниците.',
        where: 'в приложението за телефон, «Календари»',
        gate: (ctx) => isFeatureEnabled('agro.calendar', ctx.userId),
    },
];

/** One row of the tool's answer. */
export interface AgrentServiceRow {
    readonly name: string;
    readonly what: string;
    readonly where: string;
    readonly route?: string;
}

/**
 * The services this farm can open, in the guide's order.
 *
 * A gate that FAILS leaves its service out rather than failing the whole
 * answer: offering one screen fewer costs a farmer a question, while a thrown
 * gate would cost them every service the guide describes.
 */
export async function listAgrentServices(ctx: RequestContext): Promise<AgrentServiceRow[]> {
    const open = await Promise.all(
        AGRENT_SERVICES.map(async (s) => {
            if (!s.gate) return true;
            try {
                return await s.gate(ctx);
            } catch {
                return false;
            }
        }),
    );
    return AGRENT_SERVICES.filter((_, i) => open[i]).map(({ name, what, where, route }) => ({
        name,
        what,
        where,
        ...(route ? { route } : {}),
    }));
}

/** The guide's names, for the system prompt: static, so the cached prefix stays one entry. */
export const AGRENT_SERVICE_NAMES: readonly string[] = AGRENT_SERVICES.map((s) => s.name);

/** What `agrent_services` answers. */
export interface AgrentServicesAnswer {
    /** The services asked for (or all of them) that this farm can open. */
    readonly rows: readonly AgrentServiceRow[];
    /** Asked for, in the guide, and switched off for this farm. */
    readonly unavailableHere: readonly string[];
    /** Asked for and not in the guide at all — Agrent does not offer it. */
    readonly notOffered: readonly string[];
    /** True when specific services were asked for; only then are links offered. */
    readonly linked: boolean;
}

/**
 * The guide for the tool, narrowed to `names` when given.
 *
 * Narrowed because a link is offered for every row returned: the whole guide
 * would put five unrelated screens under an answer about insurance. Matching
 * is case-blind on the exact name, the way the prompt lists them.
 */
export async function answerAgrentServices(
    ctx: RequestContext,
    names?: readonly string[],
): Promise<AgrentServicesAnswer> {
    const open = await listAgrentServices(ctx);
    if (!names || names.length === 0) {
        return { rows: open, unavailableHere: [], notOffered: [], linked: false };
    }
    const key = (s: string) => s.trim().toLocaleLowerCase('bg');
    const known = new Set(AGRENT_SERVICES.map((s) => key(s.name)));
    const wanted = new Set(names.map(key));
    return {
        rows: open.filter((r) => wanted.has(key(r.name))),
        unavailableHere: names.filter((n) => known.has(key(n)) && !open.some((r) => key(r.name) === key(n))),
        notOffered: names.filter((n) => !known.has(key(n))),
        linked: true,
    };
}
