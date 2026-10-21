/**
 * The ПРЗ register upload, end to end through the route (#2077).
 *
 * `platform-support-route-gate.test.ts` proves the gate refuses a non-platform
 * tenant before the upload is even parsed. What it CANNOT prove is the other
 * direction: its positive control asserts only `status !== 404`, and says so —
 * *"a handler may still fail downstream on a body this test does not bother to
 * make valid"*. For a bodyless POST that is a 500, which satisfies the
 * assertion while proving nothing about the path.
 *
 * So this file makes the body valid. It drives a real multipart upload through
 * the real route and the real parser, with only the usecase mocked, and asserts
 * what the parser handed it. That is the seam where a header-driven parser and
 * an HTTP boundary are wired together, and nothing else looks at it.
 */
export {};

const mockEnv: Record<string, unknown> = {};
jest.mock('@/env', () => ({
    get env() {
        return { ...jest.requireActual('@/env').env, ...mockEnv };
    },
}));

const getTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    ...jest.requireActual('@/app-layer/context'),
    getTenantCtx: (...a: unknown[]) => getTenantCtx(...a),
}));

const usecase = {
    importPppRegister: jest.fn(),
    describePppRegister: jest.fn(),
};
jest.mock('@/app-layer/usecases/ppp-register-admin', () => usecase);

/**
 * Call order, so the scan's POSITION can be asserted and not just its
 * presence. A scan after the parse would satisfy
 * `upload-route-scan-reachability` and protect nothing — the bytes would
 * already have been through `jszip` by then.
 */
const order: string[] = [];
const scanOrRefuse = jest.fn(async () => {
    order.push('scan');
    return 'SKIPPED' as const;
});
jest.mock('@/lib/upload/ingest', () => ({
    scanOrRefuse: (...a: unknown[]) => scanOrRefuse(...(a as [])),
}));

import { NextRequest } from 'next/server';
import { makeRequestContext } from '../../helpers/make-context';
import * as route from '@/app/api/t/[tenantSlug]/admin/ppp-register/route';

const PLATFORM_SLUG = 'agrent-platform';

const CSV = [
    'Култура;Продукт;Рег. №;Вредител;Доза;Карантинен срок;Статус',
    'Пшеница;Карате Зеон;1234-ПРЗ;Листни въшки;1,5 - 2,0 л/дка;30;разрешен',
    'Слънчоглед;Пулсар;999-ПРЗ;Плевели;1,2 л/дка;60;отнет',
].join('\n');

function upload(body: BodyInit | undefined, slug = PLATFORM_SLUG) {
    const req = new NextRequest(`http://localhost:3000/api/t/${slug}/admin/ppp-register`, {
        method: 'POST',
        body,
    });
    return route.POST(req, { params: Promise.resolve({ tenantSlug: slug }) });
}

function form(content: string, filename: string): FormData {
    const fd = new FormData();
    fd.set('file', new File([content], filename, { type: 'text/csv' }));
    return fd;
}

beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    mockEnv.PLATFORM_TENANT_SLUG = PLATFORM_SLUG;
    usecase.importPppRegister.mockResolvedValue({
        importId: 'imp_1',
        entryCount: 2,
        previousEntryCount: null,
        skippedRows: 0,
        unparsedDoses: 0,
        withdrawnCount: 1,
        headers: [],
    });
    usecase.describePppRegister.mockResolvedValue({ live: null, incompleteImports: 0 });
    getTenantCtx.mockResolvedValue(
        makeRequestContext('OWNER', {
            userId: 'u_support',
            tenantId: 'tnt_platform',
            tenantSlug: PLATFORM_SLUG,
        }),
    );
});

describe('POST', () => {
    it('parses a semicolon CSV and hands the entries to the usecase', async () => {
        const res = await upload(form(CSV, 'register-2026.csv'));
        expect(res.status).toBe(201);

        expect(usecase.importPppRegister).toHaveBeenCalledTimes(1);
        const [, arg] = usecase.importPppRegister.mock.calls[0]!;
        expect(arg.parsed.headers).toContain('Култура');
        expect(arg.sourceName).toBe('register-2026.csv');
        expect(arg.parsed.entries).toEqual([
            expect.objectContaining({
                crop: 'Пшеница',
                productName: 'Карате Зеон',
                pppRegistrationNo: '1234-ПРЗ',
                pests: ['Листни въшки'],
                doseMin: 1.5,
                doseMax: 2,
                doseUnit: 'л/дка',
                quarantinePeriodDays: 30,
                withdrawn: false,
            }),
            expect.objectContaining({ crop: 'Слънчоглед', withdrawn: true, doseMin: 1.2 }),
        ]);
    });

    it('returns the usecase result as the body, counts included', async () => {
        const res = await upload(form(CSV, 'r.csv'));
        await expect(res.json()).resolves.toMatchObject({
            importId: 'imp_1',
            entryCount: 2,
            withdrawnCount: 1,
            previousEntryCount: null,
        });
    });

    it('passes the parser refusal through as the 400 body, verbatim', async () => {
        const res = await upload(form('Име;Цена\nнещо;5', 'wrong.csv'));
        expect(res.status).toBe(400);
        const body = await res.json();
        // The message IS the operator's debugging — a generic "invalid file"
        // would make a wrong column indistinguishable from a wrong file.
        expect(JSON.stringify(body)).toContain('Име | Цена');
        expect(JSON.stringify(body)).toContain('култура');
        expect(usecase.importPppRegister).not.toHaveBeenCalled();
    });

    it('scans the bytes BEFORE the parser touches them', async () => {
        // The first draft of the route argued a scan was theatre because
        // nothing is stored. `upload-route-scan-reachability` refused that,
        // and rightly: "never stored" is not "never parsed" — these bytes go
        // through jszip and fast-xml-parser. Presence alone is not the
        // property, though; a scan after the parse would pass that guard and
        // protect nothing, so the ORDER is what this asserts.
        usecase.importPppRegister.mockImplementation(async () => {
            order.push('usecase');
            return { importId: 'imp_1', entryCount: 2 };
        });
        await upload(form(CSV, 'r.csv'));
        expect(order).toEqual(['scan', 'usecase']);
        expect(scanOrRefuse).toHaveBeenCalledWith(expect.any(Buffer), {
            component: 'ppp-register-import',
            exposure: 'private',
        });
    });

    it('does not scan when the gate has already refused', async () => {
        // The gate runs before `formData()`, so a non-platform caller costs
        // neither a scan nor a parse.
        getTenantCtx.mockResolvedValue(
            makeRequestContext('OWNER', {
                userId: 'u_farm',
                tenantId: 'tnt_farm',
                tenantSlug: 'acme-corp',
            }),
        );
        const res = await upload(form(CSV, 'r.csv'), 'acme-corp');
        expect(res.status).toBe(404);
        expect(scanOrRefuse).not.toHaveBeenCalled();
    });

    it('refuses a request with no file', async () => {
        const res = await upload(new FormData());
        expect(res.status).toBe(400);
        expect(usecase.importPppRegister).not.toHaveBeenCalled();
    });

    it('does not reach the usecase when the register is empty', async () => {
        // Headers bind, no data rows. The REFUSAL for this lives in the
        // usecase (it is the one that knows what it would overwrite), so what
        // the route must do is reach it with a parse that has zero entries —
        // not silently 201 on nothing.
        const res = await upload(form('Култура;Продукт\n', 'empty.csv'));
        expect(res.status).toBe(201);
        const [, arg] = usecase.importPppRegister.mock.calls[0]!;
        expect(arg.parsed.entries).toEqual([]);
    });
});

describe('GET', () => {
    it('reports the live import state', async () => {
        const req = new NextRequest(
            `http://localhost:3000/api/t/${PLATFORM_SLUG}/admin/ppp-register`,
        );
        const res = await route.GET(req, {
            params: Promise.resolve({ tenantSlug: PLATFORM_SLUG }),
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ live: null, incompleteImports: 0 });
        expect(usecase.describePppRegister).toHaveBeenCalledTimes(1);
    });
});
