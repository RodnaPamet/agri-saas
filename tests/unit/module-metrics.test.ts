/**
 * Unit test: module-usage telemetry fires with the right module + device tags
 * (Roadmap-5 PR5). Device class is derived from sec-ch-ua-mobile with a UA
 * fallback, and is EXACTLY two values.
 */
const addMock = jest.fn();
jest.mock('@opentelemetry/api', () => ({
    metrics: { getMeter: () => ({ createCounter: () => ({ add: addMock }) }) },
}));

const headersMock = jest.fn();
jest.mock('next/headers', () => ({ headers: () => headersMock() }));

import {
    recordModuleAccess,
    resolveDeviceClass,
    __resetModuleMetricsForTests,
} from '@/lib/observability/module-metrics';

function withHeaders(map: Record<string, string>): void {
    headersMock.mockResolvedValue({ get: (k: string) => map[k] ?? null });
}

beforeEach(() => {
    addMock.mockClear();
    headersMock.mockReset();
    __resetModuleMetricsForTests();
});

describe('resolveDeviceClass', () => {
    it('sec-ch-ua-mobile "?1" → mobile', async () => {
        withHeaders({ 'sec-ch-ua-mobile': '?1' });
        expect(await resolveDeviceClass()).toBe('mobile');
    });

    it('sec-ch-ua-mobile "?0" → desktop even with a mobile-ish UA', async () => {
        withHeaders({ 'sec-ch-ua-mobile': '?0', 'user-agent': 'iPhone' });
        expect(await resolveDeviceClass()).toBe('desktop');
    });

    it('UA fallback → mobile when no client hint', async () => {
        withHeaders({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
        expect(await resolveDeviceClass()).toBe('mobile');
    });

    it('UA fallback → desktop for a desktop UA', async () => {
        withHeaders({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' });
        expect(await resolveDeviceClass()).toBe('desktop');
    });

    it('no request scope → desktop (never throws)', async () => {
        headersMock.mockRejectedValue(new Error('called outside a request scope'));
        expect(await resolveDeviceClass()).toBe('desktop');
    });
});

describe('recordModuleAccess', () => {
    it('increments the counter tagged by module + mobile device', async () => {
        withHeaders({ 'sec-ch-ua-mobile': '?1' });
        await recordModuleAccess('JOURNAL');
        expect(addMock).toHaveBeenCalledWith(1, { module: 'JOURNAL', device: 'mobile' });
    });

    it('increments the counter tagged by module + desktop device', async () => {
        withHeaders({ 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' });
        await recordModuleAccess('CERTIFICATION');
        expect(addMock).toHaveBeenCalledWith(1, { module: 'CERTIFICATION', device: 'desktop' });
    });

    it('the device tag is only ever mobile|desktop (no cardinality risk)', async () => {
        withHeaders({ 'sec-ch-ua-mobile': 'garbage', 'user-agent': '' });
        await recordModuleAccess('EXCHANGE');
        const [, attrs] = addMock.mock.calls[0];
        expect(['mobile', 'desktop']).toContain(attrs.device);
    });
});
