/**
 * «Почва» — the soil section and the assistant's `soil_guide` tool (owner,
 * 2026-11-26).
 *
 * Three readers share one module (`@/lib/knowledge/soil-guide`): the web page,
 * the phone's route and the assistant's tool. So the properties worth holding
 * are about the CONTENT — both languages say the same number of things, every
 * topic names a source that exists, no topic overflows what the tool may hand
 * the model, and nothing in it trips the dose/PHI/REI rule — plus that the tool
 * and the route really read it.
 */
import { makeRequestContext } from '../helpers/make-context';
import {
    SOIL_SECTION_IDS,
    SOIL_SOURCE_IDS,
    SOIL_SOURCES,
    soilGuide,
    soilLanguage,
    soilSection,
    type SoilLanguage,
} from '@/lib/knowledge/soil-guide';
import { scanForUnregisteredRegulatedContent } from '../../scripts/rag/dose-phi-guard';
import { runTool, SOIL_GUIDE_ROUTE, TOOL_RESULT_MAX_CHARS } from '@/app-layer/ai/assistant/tools';
import { getSoilGuide } from '@/app-layer/usecases/knowledge';

const LANGS: readonly SoilLanguage[] = ['bg', 'en'];
const reader = makeRequestContext('READER', { userId: 'u1', tenantId: 't1' });

describe('the soil guide content', () => {
    it('has every declared topic, once, in declared order, in both languages', () => {
        for (const lang of LANGS) {
            expect(soilGuide(lang).map((s) => s.id)).toEqual([...SOIL_SECTION_IDS]);
        }
    });

    it('says the same number of things in Bulgarian and English, and never nothing', () => {
        for (const id of SOIL_SECTION_IDS) {
            const bg = soilSection(id, 'bg');
            const en = soilSection(id, 'en');
            expect(bg.points.length).toBeGreaterThan(0);
            expect(en.points.length).toBe(bg.points.length);
            for (const text of [bg.title, bg.summary, en.title, en.summary, ...bg.points, ...en.points]) {
                expect(text.trim()).not.toBe('');
            }
            // A Bulgarian point written in English would pass the count above.
            expect(bg.points.every((p) => /[А-Яа-я]/.test(p))).toBe(true);
        }
    });

    it('names at least one real source per topic, and every source is used', () => {
        const used = new Set<string>();
        for (const id of SOIL_SECTION_IDS) {
            const section = soilSection(id, 'bg');
            expect(section.sources.length).toBeGreaterThan(0);
            for (const src of section.sources) {
                expect(SOIL_SOURCE_IDS).toContain(src.id);
                expect(src.url).toMatch(/^https:\/\//);
                used.add(src.id);
            }
        }
        expect([...used].sort()).toEqual([...SOIL_SOURCE_IDS].sort());
        expect(Object.keys(SOIL_SOURCES).sort()).toEqual([...SOIL_SOURCE_IDS].sort());
    });

    it('carries no dose, PHI or re-entry interval (the knowledge-base rule)', () => {
        // Positive control: the detector is live, so a clean result means clean.
        expect(scanForUnregisteredRegulatedContent('2 l/ha')).not.toEqual([]);
        for (const lang of LANGS) {
            for (const section of soilGuide(lang)) {
                const text = [section.title, section.summary, ...section.points].join('\n');
                expect({ id: section.id, lang, hits: scanForUnregisteredRegulatedContent(text) }).toEqual({
                    id: section.id,
                    lang,
                    hits: [],
                });
            }
        }
    });

    it('keeps the facts the sources state, where a slip would mislead a farmer', () => {
        const nitrogen = soilSection('nitrogen', 'bg').points.join(' ');
        expect(nitrogen).toContain('17 кг азот на декар');
        expect(nitrogen).toContain('1 ноември до 20 февруари');
        expect(nitrogen).toContain('до 25 февруари в Северна България');
        const water = soilSection('slopes-water', 'bg').points.join(' ');
        expect(water).toContain('5 м');
        expect(water).toContain('50 м при наклон над 10%');
        const cover = soilSection('erosion-cover', 'bg').points.join(' ');
        expect(cover).toContain('1 юни до 31 октомври');
        expect(cover).toContain('1 ноември до 15 февруари');
    });

    it('reads any locale as one of its two languages, Bulgarian by default', () => {
        expect(soilLanguage('en')).toBe('en');
        expect(soilLanguage('bg')).toBe('bg');
        expect(soilLanguage('de')).toBe('bg');
        expect(soilLanguage(null)).toBe('bg');
        expect(soilLanguage(undefined)).toBe('bg');
    });

    it('answers to the read policy like every other knowledge read', () => {
        expect(getSoilGuide(reader, 'bg')).toHaveLength(SOIL_SECTION_IDS.length);
        const noRead = makeRequestContext('READER', {
            userId: 'u1',
            tenantId: 't1',
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        expect(() => getSoilGuide(noRead, 'bg')).toThrow();
    });
});

describe('soil_guide, the assistant tool', () => {
    it('hands the model a whole topic, untruncated, with its sources', async () => {
        for (const topic of SOIL_SECTION_IDS) {
            const out = await runTool(reader, 'soil_guide', JSON.stringify({ topic }));
            expect(out.ok).toBe(true);
            expect(out.truncated).toBe(false);
            expect(out.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
            const body = JSON.parse(out.content) as {
                rows: Array<{ name: string; points: string[]; sources: Array<{ title: string }>; route?: string }>;
            };
            const section = soilSection(topic, 'bg');
            expect(body.rows[0].name).toBe(section.title);
            expect(body.rows[0].points).toEqual(section.points);
            expect(body.rows[0].sources.map((s) => s.title)).toEqual(section.sources.map((s) => s.title));
            // The page path is for the app's link, never for the prose.
            expect(body.rows[0].route).toBeUndefined();
            expect(out.content).not.toContain(SOIL_GUIDE_ROUTE);
            expect(out.links).toEqual([{ route: SOIL_GUIDE_ROUTE, label: section.title }]);
        }
    });

    it('refuses a topic it does not have rather than guessing one', async () => {
        const out = await runTool(reader, 'soil_guide', JSON.stringify({ topic: 'pesticides' }));
        expect(out.ok).toBe(false);
        const none = await runTool(reader, 'soil_guide', '{}');
        expect(none.ok).toBe(false);
    });
});

describe('GET /knowledge/soil-guide, the phone\'s read', () => {
    const getTenantCtx = jest.fn();
    beforeAll(() => {
        jest.doMock('@/app-layer/context', () => ({ getTenantCtx: (...a: unknown[]) => getTenantCtx(...a) }));
    });

    async function get(query: string): Promise<{ status: number; body: { sections: Array<{ id: string; title: string }> } }> {
        getTenantCtx.mockResolvedValue(reader);
        const { GET } = await import('@/app/api/t/[tenantSlug]/knowledge/soil-guide/route');
        const { NextRequest } = await import('next/server');
        const req = new NextRequest(`http://localhost/api/t/acme/knowledge/soil-guide${query}`);
        const res = await GET(req, { params: Promise.resolve({ tenantSlug: 'acme' }) });
        return { status: res.status, body: await res.json() };
    }

    it('serves every topic, Bulgarian by default and English on request', async () => {
        const bg = await get('');
        expect(bg.status).toBe(200);
        expect(bg.body.sections.map((s) => s.id)).toEqual([...SOIL_SECTION_IDS]);
        expect(bg.body.sections[0].title).toBe(soilSection('nitrogen', 'bg').title);
        const en = await get('?lang=en');
        expect(en.body.sections[0].title).toBe(soilSection('nitrogen', 'en').title);
        expect(getTenantCtx).toHaveBeenCalledWith({ tenantSlug: 'acme' }, expect.anything());
    });
});
