/**
 * Insurance-lead retention sweep (owner, 2026-11-20: 24 months, like offer
 * requests).
 *
 * The privacy notice states the period from `INSURANCE_LEAD_RETENTION_DAYS`,
 * so this is the test that keeps that sentence true: the sweep deletes exactly
 * the rows past the window, measured from creation, and nothing newer.
 *
 * The DB is injected, so these assert the sweep's decisions without Postgres.
 */
import {
    runInsuranceLeadRetentionSweep,
    INSURANCE_LEAD_RETENTION_DAYS,
} from '@/app-layer/jobs/insurance-lead-retention';
import { PROMOTION_LEAD_RETENTION_DAYS } from '@/app-layer/jobs/promotion-lead-retention';

type Call = { op: string; args: unknown };

function fakeDb(deleted = 4) {
    const calls: Call[] = [];
    return {
        calls,
        db: {
            insuranceLead: {
                deleteMany: (args: unknown) => {
                    calls.push({ op: 'deleteMany', args });
                    return Promise.resolve({ count: deleted });
                },
                count: (args: unknown) => {
                    calls.push({ op: 'count', args });
                    return Promise.resolve(9);
                },
            },
        } as never,
    };
}

describe('insurance-lead retention sweep', () => {
    const now = new Date('2026-11-20T03:40:00Z');

    it('keeps the window the owner chose: the same 24 months as offer requests', () => {
        expect(INSURANCE_LEAD_RETENTION_DAYS).toBe(730);
        expect(INSURANCE_LEAD_RETENTION_DAYS).toBe(PROMOTION_LEAD_RETENTION_DAYS);
    });

    it('deletes leads created before the window, measured from creation', async () => {
        const { db, calls } = fakeDb();
        const result = await runInsuranceLeadRetentionSweep({ now, db });

        expect(result).toEqual({ deleted: 4, dryRun: false });
        const del = calls.find((c) => c.op === 'deleteMany')!.args as {
            where: { createdAt: { lt: Date } };
        };
        expect(del.where.createdAt.lt).toEqual(
            new Date(now.getTime() - INSURANCE_LEAD_RETENTION_DAYS * 86_400_000),
        );
        // `lt`, not `lte`: a lead exactly at the boundary is still inside the
        // window the notice promises, and the where clause names nothing else.
        expect(Object.keys(del.where)).toEqual(['createdAt']);
        expect(Object.keys(del.where.createdAt)).toEqual(['lt']);
    });

    it('dry run counts without writing', async () => {
        const { db, calls } = fakeDb();
        const result = await runInsuranceLeadRetentionSweep({ now, db, dryRun: true });
        expect(result).toEqual({ deleted: 9, dryRun: true });
        expect(calls.map((c) => c.op)).toEqual(['count']);
    });

    it('is scheduled, has an executor, and the notice renders the period from the constant', () => {
        // A sweep nobody runs, or a notice that types the number, is the
        // state that let the notice say nothing at all about insurance.
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const root = path.resolve(__dirname, '../..');
        const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/name: 'insurance-lead-retention'/);
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(
            /executorRegistry\.register\('insurance-lead-retention'/,
        );
        const page = read('src/app/privacy/page.tsx');
        expect(page).toMatch(/t\('keepInsurance', \{ months: Math\.round\(INSURANCE_LEAD_RETENTION_DAYS \/ 30\) \}\)/);
        for (const loc of ['bg', 'en']) {
            const notice = JSON.parse(read(`messages/${loc}/app.json`)).privacy.keepInsurance as string;
            expect(notice).toContain('{months}');
            expect(notice).not.toMatch(/\b24\b/);
        }
    });
});
