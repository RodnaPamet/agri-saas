/**
 * Every assistant list tool returns a NON-EMPTY result on a farm that has data.
 *
 * ## Why this exists, and why the obvious tests did not catch it
 *
 * On 2026-11-01 `list_journal_entries` told every farm «Дневникът ти засега е
 * празен». The owner's farm had 8 entries. The tool read `.rows` from a usecase
 * that returns `{ items, pageInfo }`, a cast told the compiler to stop
 * checking, and `?? []` converted the miss into a confident empty (#2680).
 *
 * Two kinds of test already existed and neither could see it:
 *
 *   · unit tests with DOUBLES — two of them asserted journal rows flowing
 *     through, and passed, because the double was hand-typed `{ rows }`: mock
 *     and code wrong together.
 *   · integration tests of the USECASE — four read `.items` correctly against a
 *     real database, and were right the whole time.
 *
 * The repo held the right answer and the tool held the wrong one, and nothing
 * compared them. #2680 fixes that by DERIVING the doubles' types from the real
 * usecases, which is the better unit-level instrument.
 *
 * This is the other half, and it catches something a derived type cannot: a
 * usecase that returns a correctly-shaped page which is EMPTY — wrong filter,
 * wrong tenant, wrong default window. The types would be perfect and the farmer
 * would still be told they have nothing. The only way to see that is to put
 * real rows in a real database and insist the tool finds them.
 *
 * ## The assertion is NON-EMPTY, deliberately
 *
 * Not "returns the right shape" and not a count. Every failure this guards
 * against — a wrong field, a wrong tenant filter, a default window that
 * excludes everything — arrives as zero rows, which is also what a quiet farm
 * looks like. Seeding first is what makes zero mean something.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { ASSISTANT_TOOLS } from '@/app-layer/ai/assistant/tools';
import { listLogEntriesPaginated } from '@/app-layer/usecases/journal';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `atools-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;
let userId = '';

/** Pull the rows out of a tool result, whatever the tool calls them. */
function rowsOf(result: unknown): unknown[] {
    const r = result as { rows?: unknown[]; items?: unknown[] } | unknown[];
    if (Array.isArray(r)) return r;
    // Deliberately tolerant HERE, in the test, because the tool contract is
    // `{ rows, hasMore }` (#2647) and asserting that shape is a different
    // test's job. This one asks only: did it find the farm's data?
    return r?.rows ?? r?.items ?? [];
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: TENANT, slug: TAG },
    });
    const email = `${TAG}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userId = u.id;

    // One row per tool. One is enough: the failure mode is ZERO, not "too few".
    await prisma.task.create({
        data: { tenantId: TENANT, title: `${TAG} task`, createdByUserId: userId },
    });
    await prisma.logEntry.create({
        data: {
            tenantId: TENANT,
            type: 'OBSERVATION' as never,
            title: `${TAG} journal`,
            occurredAt: new Date(),
        },
    });
    await prisma.costEntry.create({
        data: {
            tenantId: TENANT,
            category: 'FUEL' as never,
            amount: '123.45' as never,
            currency: 'EUR',
            incurredOn: new Date(),
        },
    });
    await prisma.location.create({ data: { tenantId: TENANT, name: `${TAG} block` } });
    await prisma.exchangeListing.create({
        data: {
            sellerTenantId: TENANT,
            sellerUserId: userId,
            side: 'SELL' as never,
            commodity: 'wheat',
            quantityTonnes: '10' as never,
            regionCode: 'BG-23',
            regionName: 'София',
            lat: 42.7,
            lon: 23.3,
        },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.exchangeListing.deleteMany({ where: { sellerTenantId: TENANT } });
    await prisma.costEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.logEntry.deleteMany({ where: { tenantId: TENANT } });
    await prisma.location.deleteMany({ where: { tenantId: TENANT } });
    await prisma.task.deleteMany({ where: { tenantId: TENANT } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.$disconnect();
});

describeFn('assistant list tools see a seeded farm', () => {
    const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT, userId });

    // Derived from the registry rather than listed, so a SIXTH list tool is
    // covered the day it is added instead of when somebody remembers this file.
    const listTools = Object.keys(ASSISTANT_TOOLS).filter((n) => n.startsWith('list_'));

    it('the population is the real registry, and it is not empty', () => {
        console.log(`[assistant-tools-seeded] list tools: ${listTools.join(', ')}`);
        // Floor: an empty list would make every assertion below pass over nothing.
        expect(listTools.length).toBeGreaterThanOrEqual(5);
    });

    it.each(['list_farm_tasks', 'list_journal_entries', 'list_cost_entries', 'list_blocks', 'list_exchange_listings'])(
        '%s returns at least one row',
        async (name) => {
            const tool = ASSISTANT_TOOLS[name];
            expect(tool).toBeDefined();
            const result = await tool.run(ctx(), {});
            const rows = rowsOf(result);
            // The whole point. #2680's bug produced exactly zero here while
            // every type was satisfied and no error was logged.
            expect(rows.length).toBeGreaterThan(0);
        },
    );

    it('the tool AGREES with the usecase it wraps — the comparison nobody was making', async () => {
        // This is the shape of the whole #2680 defect, stated as an assertion.
        //
        // The usecase was right the entire time: four integration tests read
        // `.items` from it correctly against a real database. The tool was
        // wrong. Both were tested, neither test could see the other, and the
        // disagreement lived in the gap.
        //
        // So: ask the usecase, ask the tool, require the same answer about
        // whether this farm has journal entries.
        const direct = await listLogEntriesPaginated(ctx(), { limit: 20 });
        const viaTool = rowsOf(await ASSISTANT_TOOLS.list_journal_entries.run(ctx(), {}));

        const directCount = (direct as { items?: unknown[] }).items?.length ?? 0;
        // Positive control FIRST: if the usecase itself returns nothing the
        // comparison below is vacuous and the seed is what is broken.
        expect(directCount).toBeGreaterThan(0);
        expect(viaTool.length).toBe(directCount);
    });

    it('every list tool in the registry is covered by the cases above', () => {
        // Stops the named list silently falling behind the registry — the
        // failure that lets a new tool ship untested while this file looks
        // thorough.
        const covered = ['list_farm_tasks', 'list_journal_entries', 'list_cost_entries', 'list_blocks', 'list_exchange_listings'];
        expect(listTools.sort()).toEqual(covered.sort());
    });
});
