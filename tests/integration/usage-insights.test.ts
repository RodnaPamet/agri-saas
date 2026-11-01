/**
 * The superuser usage view counts ACROSS farms — and counts only.
 *
 * The assertions here are the inverse of every other tenant test in this repo:
 * §1 requires that two farms' events BOTH appear, because cross-tenant breadth
 * is the feature rather than a leak. That inversion is worth stating, since a
 * reviewer skimming for "the other tenant must be absent" would read this file
 * as wrong.
 *
 * What replaces tenant isolation as the control is the SHAPE: §4 asserts the
 * result exposes no per-user identity, only counts. The same table could answer
 * "what did this named person do on Tuesday"; the absence of a query that
 * returns rows is what stops it.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { getUsageInsights } from '@/app-layer/usecases/usage-insights';
import { USAGE_EVENT_RETENTION_DAYS } from '@/app-layer/telemetry/usage-events';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `ui-${randomUUID().slice(0, 8)}`;
const FARM_A = `t-${TAG}-a`;
const FARM_B = `t-${TAG}-b`;
let userOne = '';
let userTwo = '';

const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function event(tenantId: string, userId: string, name: string, surface: string | null, receivedAt: Date) {
    await prisma.usageEvent.create({
        data: { tenantId, userId, name, surface, at: receivedAt, receivedAt },
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    for (const [id, slug] of [[FARM_A, `${TAG}-a`], [FARM_B, `${TAG}-b`]]) {
        await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug } });
    }
    const mk = async (suffix: string) => {
        const email = `${TAG}-${suffix}@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        return u.id;
    };
    userOne = await mk('one');
    userTwo = await mk('two');

    // Farm A: two people, three screen opens and one action, all recent.
    await event(FARM_A, userOne, 'screen_opened', '/journal', ago(1));
    await event(FARM_A, userOne, 'screen_opened', '/journal', ago(2));
    await event(FARM_A, userTwo, 'screen_opened', '/trends', ago(3));
    await event(FARM_A, userOne, 'treatment_saved', null, ago(1));

    // Farm B: one person, one screen open.
    await event(FARM_B, userTwo, 'screen_opened', '/journal', ago(4));

    // Beyond the window — must be excluded by §5.
    await event(FARM_A, userOne, 'cost_saved', null, ago(60));
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.usageEvent.deleteMany({ where: { tenantId: { in: [FARM_A, FARM_B] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userOne, userTwo] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [FARM_A, FARM_B] } } });
    await prisma.$disconnect();
});

describeFn('usage insights (superuser, cross-tenant)', () => {
    it('§1 reports BOTH farms — breadth is the feature, not a leak', async () => {
        const out = await getUsageInsights({ days: 30 });
        const a = out.byFarm.find((r) => r.tenantId === FARM_A);
        const b = out.byFarm.find((r) => r.tenantId === FARM_B);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a!.events).toBe(4);
        expect(b!.events).toBe(1);
    });

    it('§2 distinctUsers is a COUNT of people, not of events', async () => {
        const out = await getUsageInsights({ days: 30 });
        const a = out.byFarm.find((r) => r.tenantId === FARM_A);
        // Four events from two people. Counting events would say 4.
        expect(a!.distinctUsers).toBe(2);
        expect(out.byFarm.find((r) => r.tenantId === FARM_B)!.distinctUsers).toBe(1);
    });

    it('§3 splits screens from actions, and screens keep their surface', async () => {
        const out = await getUsageInsights({ days: 30 });
        const journal = out.byScreen.find((r) => r.surface === '/journal');
        // Three /journal opens: two in farm A, one in farm B.
        expect(journal?.events).toBe(3);
        expect(out.byScreen.every((r) => r.name === 'screen_opened')).toBe(true);
        expect(out.byAction.every((r) => r.name !== 'screen_opened')).toBe(true);
        expect(out.byAction.find((r) => r.name === 'treatment_saved')?.events).toBe(1);
    });

    it('§4 exposes NO per-user identity — the shape is the control', async () => {
        const out = await getUsageInsights({ days: 30 });
        // The restraint that makes a cross-tenant read defensible: counts, never
        // rows. If a future change adds a userId anywhere in this payload, this
        // is the test that should stop it.
        const serialised = JSON.stringify(out);
        expect(serialised).not.toContain(userOne);
        expect(serialised).not.toContain(userTwo);
        expect(Object.keys(out)).toEqual(
            expect.arrayContaining(['days', 'totalEvents', 'byFarm', 'byScreen', 'byAction']),
        );
    });

    it('§5 the window excludes what falls outside it', async () => {
        const out = await getUsageInsights({ days: 30 });
        // `cost_saved` was recorded 60 days ago.
        expect(out.byAction.find((r) => r.name === 'cost_saved')).toBeUndefined();
        const wide = await getUsageInsights({ days: 90 });
        expect(wide.byAction.find((r) => r.name === 'cost_saved')?.events).toBe(1);
    });

    it('§6 a window longer than retention is CLAMPED and says so', async () => {
        const out = await getUsageInsights({ days: 365 });
        // Reporting 90 days of data under a 365-day heading is the quiet
        // wrongness that makes somebody conclude usage collapsed last spring.
        expect(out.days).toBe(USAGE_EVENT_RETENTION_DAYS);
        const silly = await getUsageInsights({ days: -5 });
        expect(silly.days).toBe(30);
    });
});
