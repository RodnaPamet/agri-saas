/**
 * Unit tests for the AI field-briefing usecase (`getFieldBriefing`).
 *
 * The usecase is a thin, fail-safe orchestrator: it assembles per-field
 * context (crop/area + today's satellite NDVI/NDMI when GEE is configured)
 * plus season/activity signals, hands it to `generateFieldBriefing`
 * (Claude Haiku), and caches a successful result. These tests mock every
 * seam and assert the three load-bearing branches:
 *   1. AI not configured  → aiConfigured:false, briefing:null, no LLM call.
 *   2. AI + GEE configured → per-field satellite means fetched,
 *      satelliteAvailable:true, briefing returned.
 *   3. AI on, GEE off      → no satellite calls, still briefs from records.
 */

jest.mock('@/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
}));
jest.mock('@/app-layer/usecases/location', () => ({
    listLocations: jest.fn(),
    listLocationParcels: jest.fn(),
}));
jest.mock('@/app-layer/usecases/farm-task', () => ({
    listMyFarmTasks: jest.fn(),
}));
jest.mock('@/app-layer/usecases/journal', () => ({
    listLogEntries: jest.fn(),
}));
jest.mock('@/app-layer/usecases/season-recap', () => ({
    getSeasonRecap: jest.fn(),
}));
jest.mock('@/app-layer/ai/field-briefing', () => ({
    generateFieldBriefing: jest.fn(),
    isFieldBriefingConfigured: jest.fn(),
}));
jest.mock('@/app-layer/ai/rag/retrieve', () => ({
    retrieve: jest.fn(),
}));
jest.mock('@/lib/agro/earth-engine', () => ({
    isGeeConfigured: jest.fn(),
    getIndexMeansForBounds: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({
    getRedis: jest.fn(() => null),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn() },
}));
// The usecase resolves the operator's locale via next-intl's getLocale to pin
// the briefing's output language. next-intl/server is ESM — mock it so the
// node test transforms cleanly and the locale source is deterministic.
jest.mock('next-intl/server', () => ({
    getLocale: jest.fn(async () => 'en'),
}));

import { getFieldBriefing } from '@/app-layer/usecases/satellite-briefing';
import { makeRequestContext } from '../helpers/make-context';
import { listLocations, listLocationParcels } from '@/app-layer/usecases/location';
import { listMyFarmTasks } from '@/app-layer/usecases/farm-task';
import { listLogEntries } from '@/app-layer/usecases/journal';
import { getSeasonRecap } from '@/app-layer/usecases/season-recap';
import { generateFieldBriefing, isFieldBriefingConfigured } from '@/app-layer/ai/field-briefing';
import { isGeeConfigured, getIndexMeansForBounds } from '@/lib/agro/earth-engine';
import { retrieve } from '@/app-layer/ai/rag/retrieve';

const mocks = {
    listLocations: jest.mocked(listLocations),
    listLocationParcels: jest.mocked(listLocationParcels),
    listMyFarmTasks: jest.mocked(listMyFarmTasks),
    listLogEntries: jest.mocked(listLogEntries),
    getSeasonRecap: jest.mocked(getSeasonRecap),
    generateFieldBriefing: jest.mocked(generateFieldBriefing),
    isFieldBriefingConfigured: jest.mocked(isFieldBriefingConfigured),
    isGeeConfigured: jest.mocked(isGeeConfigured),
    getIndexMeansForBounds: jest.mocked(getIndexMeansForBounds),
    retrieve: jest.mocked(retrieve),
};

const ctx = makeRequestContext('ADMIN');

function fieldLocation(over: Record<string, unknown> = {}) {
    return { id: 'loc1', name: 'North 40', kind: 'FIELD', status: 'ACTIVE', ...over } as never;
}

beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults; individual tests override.
    mocks.listLocations.mockResolvedValue([]);
    mocks.listLocationParcels.mockResolvedValue({ locationId: 'loc1', bounds: null, parcels: [] } as never);
    mocks.listMyFarmTasks.mockResolvedValue([] as never);
    mocks.listLogEntries.mockResolvedValue([] as never);
    mocks.getSeasonRecap.mockResolvedValue(null as never);
    // `FieldIndexMeans` carries the imagery's real acquisition date alongside
    // the means; "no clear pixels" means all three are absent.
    mocks.getIndexMeansForBounds.mockResolvedValue({ ndvi: null, ndmi: null, acquiredDate: null });
    mocks.generateFieldBriefing.mockResolvedValue({ headline: 'H', summary: 'S', actions: [] });
    mocks.retrieve.mockResolvedValue([]);
});

describe('getFieldBriefing', () => {
    it('returns aiConfigured:false and skips the LLM when no Claude key is set', async () => {
        mocks.isFieldBriefingConfigured.mockReturnValue(false);
        mocks.isGeeConfigured.mockReturnValue(false);

        const res = await getFieldBriefing(ctx);

        expect(res.aiConfigured).toBe(false);
        expect(res.briefing).toBeNull();
        expect(res.sources).toEqual([]);
        expect(mocks.generateFieldBriefing).not.toHaveBeenCalled();
        expect(mocks.listLocations).not.toHaveBeenCalled();
        expect(mocks.retrieve).not.toHaveBeenCalled();
    });

    it('fetches per-field satellite means and briefs when AI + GEE are configured', async () => {
        mocks.isFieldBriefingConfigured.mockReturnValue(true);
        mocks.isGeeConfigured.mockReturnValue(true);
        mocks.listLocations.mockResolvedValue([fieldLocation()]);
        mocks.listLocationParcels.mockResolvedValue({
            locationId: 'loc1',
            bounds: [1, 2, 3, 4],
            parcels: [{ cropType: 'wheat', areaHa: 40 }],
        } as never);
        mocks.getIndexMeansForBounds.mockResolvedValue({
            ndvi: 0.74,
            ndmi: 0.31,
            acquiredDate: '2026-06-12',
        });
        mocks.getSeasonRecap.mockResolvedValue({
            seasonName: 'Summer', year: 2026, totalAreaHa: 40, totalYieldTonnes: 0,
            avgYieldTPerHa: null, activityCount: 3, topFields: [], costPerHa: null,
        } as never);
        mocks.listMyFarmTasks.mockResolvedValue([{}, {}, {}] as never);
        mocks.listLogEntries.mockResolvedValue([{}, {}] as never);
        mocks.retrieve.mockResolvedValue([
            { id: 'c1', source: 'Agri-SaaS agronomy desk (original)', sourceType: 'EXTERNAL', text: 'Wheat scouting notes.', language: 'en', score: 0.5 },
        ]);
        mocks.generateFieldBriefing.mockResolvedValue({
            headline: 'Water stress in River Paddock', summary: 'x', actions: [],
        });

        const res = await getFieldBriefing(ctx);

        expect(mocks.getIndexMeansForBounds).toHaveBeenCalledTimes(1);
        expect(res.aiConfigured).toBe(true);
        expect(res.satelliteConfigured).toBe(true);
        expect(res.satelliteAvailable).toBe(true);
        expect(res.briefing).toEqual({ headline: 'Water stress in River Paddock', summary: 'x', actions: [] });

        // W1/#89 — retrieval is keyed off the field's own crop, bounded
        // to a small topK, and the result is both handed to the model AND
        // surfaced on the payload for the card's citation footer (W2/#90).
        expect(mocks.retrieve).toHaveBeenCalledTimes(1);
        expect(mocks.retrieve.mock.calls[0][1]).toMatchObject({ query: 'wheat', topK: 3, includeGlobal: true });
        expect(res.sources).toEqual([{ source: 'Agri-SaaS agronomy desk (original)', sourceType: 'EXTERNAL' }]);

        // The context handed to Haiku carries the field + signals.
        const arg = mocks.generateFieldBriefing.mock.calls[0][0];
        expect(arg.satelliteAvailable).toBe(true);
        expect(arg.openTaskCount).toBe(3);
        expect(arg.recentJournalCount).toBe(2);
        expect(arg.fields[0]).toMatchObject({
            name: 'North 40', crops: ['wheat'], areaHa: 40, ndvi: 0.74, ndmi: 0.31,
        });
        expect(arg.knowledgeContext).toEqual([
            { source: 'Agri-SaaS agronomy desk (original)', text: 'Wheat scouting notes.' },
        ]);
    });

    it('skips KB retrieval when no field carries a crop yet', async () => {
        mocks.isFieldBriefingConfigured.mockReturnValue(true);
        mocks.isGeeConfigured.mockReturnValue(false);
        mocks.listLocations.mockResolvedValue([fieldLocation()]);
        mocks.listLocationParcels.mockResolvedValue({
            locationId: 'loc1',
            bounds: null,
            parcels: [{ cropType: null, areaHa: 10 }],
        } as never);
        mocks.generateFieldBriefing.mockResolvedValue({ headline: 'H3', summary: 'S3', actions: [] });

        const res = await getFieldBriefing(ctx);

        expect(mocks.retrieve).not.toHaveBeenCalled();
        expect(res.sources).toEqual([]);
        expect(mocks.generateFieldBriefing.mock.calls[0][0].knowledgeContext).toEqual([]);
    });

    it('skips satellite calls but still briefs from farm records when GEE is unconfigured', async () => {
        mocks.isFieldBriefingConfigured.mockReturnValue(true);
        mocks.isGeeConfigured.mockReturnValue(false);
        mocks.listLocations.mockResolvedValue([fieldLocation()]);
        mocks.listLocationParcels.mockResolvedValue({
            locationId: 'loc1',
            bounds: [1, 2, 3, 4],
            parcels: [{ cropType: 'wheat', areaHa: 40 }],
        } as never);
        mocks.generateFieldBriefing.mockResolvedValue({ headline: 'H2', summary: 'S2', actions: [] });

        const res = await getFieldBriefing(ctx);

        expect(mocks.getIndexMeansForBounds).not.toHaveBeenCalled();
        expect(res.satelliteConfigured).toBe(false);
        expect(res.satelliteAvailable).toBe(false);
        expect(res.briefing).not.toBeNull();
        expect(mocks.generateFieldBriefing).toHaveBeenCalledTimes(1);
        expect(mocks.generateFieldBriefing.mock.calls[0][0].satelliteAvailable).toBe(false);
    });
});
