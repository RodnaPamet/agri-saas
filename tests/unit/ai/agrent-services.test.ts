/**
 * The assistant's product guide (`agrent-services.ts`) — owner, 2026-11-19.
 *
 * Hand-written by ruling, so these tests are what keep it from going stale:
 * every route must be a page the app serves, the whole guide must fit one tool
 * result, the insurance entry must name every product the engine prices, and
 * a service the farm cannot open must not be offered.
 */
const isModuleAvailable = jest.fn(async (_ctx: unknown, _key: string) => true);
jest.mock('@/app-layer/usecases/modules', () => ({
    isModuleAvailable: (ctx: unknown, key: string) => isModuleAvailable(ctx, key),
}));
const isFeatureEnabled = jest.fn(async (_key: string, _userId: string | null) => true);
jest.mock('@/lib/feature-flags', () => ({
    isFeatureEnabled: (key: string, userId: string | null) => isFeatureEnabled(key, userId),
}));
const hasVisiblePromotions = jest.fn(async () => true);
jest.mock('@/app-layer/usecases/promotions', () => ({
    hasVisiblePromotions: () => hasVisiblePromotions(),
}));

import {
    AGRENT_SERVICE_NAMES,
    AGRENT_SERVICES,
    answerAgrentServices,
    INSURANCE_PARTNER,
    listAgrentServices,
} from '@/app-layer/ai/assistant/agrent-services';
import { linkTemplateIsReal, linksFromPages } from '@/app-layer/ai/assistant/links';
import { runTool, TOOL_RESULT_MAX_CHARS } from '@/app-layer/ai/assistant/tools';
import { INSURANCE_PRODUCTS } from '@/lib/insurance/products';
import { readCatalogue } from '../../helpers/catalogue';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR');

beforeEach(() => {
    isModuleAvailable.mockReset().mockResolvedValue(true);
    isFeatureEnabled.mockReset().mockResolvedValue(true);
    hasVisiblePromotions.mockReset().mockResolvedValue(true);
});

describe('the guide matches the app', () => {
    it('reports its population', () => {
        const linked = AGRENT_SERVICES.filter((s) => s.route).length;
        console.log(`[agrent-services] ${AGRENT_SERVICES.length} service(s), ${linked} with a page`);
        expect(AGRENT_SERVICES.length).toBeGreaterThanOrEqual(15);
        expect(linked).toBeGreaterThanOrEqual(15);
    });

    it.each(AGRENT_SERVICES.filter((s) => s.route).map((s) => [s.name, s.route!]))(
        '%s points at a page the app serves (%s)',
        (_name, route) => {
            expect(route).toMatch(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/);
            expect(linkTemplateIsReal(route)).toBe(true);
        },
    );

    it('control: a route the app does not serve is caught', () => {
        expect(linkTemplateIsReal('/insurance-shop')).toBe(false);
    });

    it('names are unique, so a name the model passes back names one service', () => {
        const lower = AGRENT_SERVICE_NAMES.map((n) => n.toLocaleLowerCase('bg'));
        expect(new Set(lower).size).toBe(lower.length);
    });

    it('the whole guide fits one tool result, so asking for all of it is never truncated', async () => {
        const all = JSON.stringify(await answerAgrentServices(ctx));
        console.log(`[agrent-services] full guide ${all.length} of ${TOOL_RESULT_MAX_CHARS} chars`);
        expect(all.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    });

    it('insurance names every product the premium engine prices, and says Agrent is not an insurer', () => {
        const insurance = AGRENT_SERVICES.find((s) => s.name === 'Застраховка на посев');
        expect(insurance).toBeDefined();
        const bg = readCatalogue('bg') as unknown as {
            insurance: { products: Record<string, { name: string }> };
            ag: { risk: { ask: { open: string } } };
        };
        const names = INSURANCE_PRODUCTS.map((p) => String(bg.insurance.products[p.key].name));
        expect(names.length).toBeGreaterThanOrEqual(8);
        for (const name of names) {
            expect(insurance!.what.toLocaleLowerCase('bg')).toContain(name.toLocaleLowerCase('bg'));
        }
        expect(insurance!.what).toMatch(/не е\s+застраховател/);
        // The partner (owner, 2026-11-19), named AS Agrent's partner.
        expect(INSURANCE_PARTNER).toBe('agrozastrahovane.bg');
        expect(insurance!.what).toContain(`партньора на Agrent за застраховки, ${INSURANCE_PARTNER}`);
        // The control the button label is checked against: the screen's own words.
        expect(insurance!.where).toContain(bg.ag.risk.ask.open);
    });
});

describe('filtered for the farm', () => {
    it('leaves out a service whose module is off, and only that one', async () => {
        isModuleAvailable.mockImplementation(async (_c, key) => key !== 'GRAIN');
        const names = (await listAgrentServices(ctx)).map((r) => r.name);
        expect(names).not.toContain('Калкулатор');
        expect(names).not.toContain('Разходи');
        expect(names).toContain('Дневник');
        expect(names).toContain('Застраховка на посев');
    });

    it('leaves out a flag-gated service when its flag is off', async () => {
        isFeatureEnabled.mockImplementation(async (key) => key !== 'social.channels');
        const names = (await listAgrentServices(ctx)).map((r) => r.name);
        expect(names).not.toContain('Канали');
        expect(names).toContain('Лунен календар');
        expect(isFeatureEnabled).toHaveBeenCalledWith('social.channels', ctx.userId);
    });

    it('a gate that throws leaves out its service rather than failing the guide', async () => {
        hasVisiblePromotions.mockRejectedValue(new Error('db down'));
        const names = (await listAgrentServices(ctx)).map((r) => r.name);
        expect(names).not.toContain('Промоции');
        expect(names.length).toBe(AGRENT_SERVICES.length - 1);
    });
});

describe('asking about named services', () => {
    it('returns just those, case-blind, and marks the answer linked', async () => {
        const out = await answerAgrentServices(ctx, ['застраховка на посев']);
        expect(out.rows.map((r) => r.name)).toEqual(['Застраховка на посев']);
        expect(out.linked).toBe(true);
        expect(out.notOffered).toEqual([]);
    });

    it('says which are switched off here, and which Agrent does not offer at all', async () => {
        isModuleAvailable.mockImplementation(async (_c, key) => key !== 'EXCHANGE');
        const out = await answerAgrentServices(ctx, ['Борса', 'Кредити']);
        expect(out.rows).toEqual([]);
        expect(out.unavailableHere).toEqual(['Борса']);
        expect(out.notOffered).toEqual(['Кредити']);
    });

    it('with no names returns the whole open guide, unlinked', async () => {
        const out = await answerAgrentServices(ctx);
        expect(out.rows.length).toBe(AGRENT_SERVICES.length);
        expect(out.linked).toBe(false);
    });
});

describe('links to the screens', () => {
    it('builds a link per named service that has a page', async () => {
        const out = await answerAgrentServices(ctx, ['Застраховка на посев', 'Лунен календар']);
        expect(linksFromPages(out)).toEqual([{ route: '/farm-risk', label: 'Застраховка на посев' }]);
    });

    it('offers none for the whole guide, so an answer is not followed by every screen', async () => {
        expect(linksFromPages(await answerAgrentServices(ctx))).toEqual([]);
    });

    it('refuses a route that is not a page, or carries a parameter', () => {
        const rows = [
            { name: 'A', route: '/not-a-page' },
            { name: 'B', route: '/farm-tasks/[taskId]' },
            { name: 'C', route: 'https://example.com/x' },
            { name: 'D', route: '/journal' },
        ];
        expect(linksFromPages({ linked: true, rows })).toEqual([{ route: '/journal', label: 'D' }]);
    });

    it('through the dispatcher: the tool answers and the link reaches the outcome', async () => {
        const out = await runTool(ctx, 'agrent_services', JSON.stringify({ names: ['Застраховка на посев'] }));
        expect(out.ok).toBe(true);
        expect(out.content).toContain('не е застраховател');
        expect(out.links).toEqual([{ route: '/farm-risk', label: 'Застраховка на посев' }]);
        // And an unknown key is refused, as for every tool.
        expect((await runTool(ctx, 'agrent_services', '{"topic":"x"}')).ok).toBe(false);
    });
});
