/**
 * #3179 — two outbox drains overlapping on one row send it ONCE.
 *
 * The claim bumped `attempts` and left the row PENDING with `sendAfter` in
 * the past for the whole send, so a second drain whose read landed mid-send
 * saw the bumped value, won its own compare-and-set on it, and sent the same
 * mail again. The claim is now a lease on `sendAfter`.
 *
 * Driven against a real database with the second drain started WHILE the
 * first send is in flight — the shape of the 06:00 overlap.
 */
const sends: string[] = [];
let releaseFirstSend: () => void = () => {};
let secondDrainStarted: Promise<unknown> | null = null;

jest.mock('@/lib/mailer', () => ({
    sendEmailOrFail: async (msg: { subjectIds?: string[] }) => {
        sends.push(String(msg.subjectIds?.[0]));
        if (sends.length === 1) {
            // Mid-send: start the overlapping drain now, then hold this send
            // open until it has finished reading and claiming.
            const { processOutbox } = jest.requireActual<
                typeof import('@/app-layer/notifications/processOutbox')
            >('@/app-layer/notifications/processOutbox');
            secondDrainStarted = processOutbox();
            await secondDrainStarted;
            releaseFirstSend();
        }
    },
}));
jest.mock('@/app-layer/notifications/settings', () => ({
    getTenantNotificationSettings: async () => ({
        enabled: true, defaultFromName: 'Agrent', defaultFromEmail: 'noreply@example.test', complianceMailbox: null,
    }),
}));

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { processOutbox } from '@/app-layer/notifications/processOutbox';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
let tenantId = '';
let rowId = '';

describeFn('processOutbox — overlapping drains (#3179)', () => {
    beforeAll(async () => {
        const slug = `outbox-lease-${randomUUID().slice(0, 8)}`;
        tenantId = (await db.tenant.create({ data: { name: slug, slug }, select: { id: true } })).id;
        // Every other PENDING row out of the way, so the drain sees only ours.
        await db.notificationOutbox.updateMany({
            where: { status: 'PENDING' }, data: { sendAfter: new Date(Date.now() + 86_400_000) },
        });
        rowId = (await db.notificationOutbox.create({
            data: {
                tenantId, type: 'EXCHANGE_MESSAGE', toEmail: 'a@example.test',
                subject: 's', bodyText: 'b', dedupeKey: `lease-${randomUUID()}`,
            },
            select: { id: true },
        })).id;
    });

    afterAll(async () => {
        await db.notificationOutbox.deleteMany({ where: { tenantId } });
        await db.tenant.deleteMany({ where: { id: tenantId } });
        await db.$disconnect();
    });

    it('sends the row once, and the overlapping drain sends nothing', async () => {
        const released = new Promise<void>((r) => { releaseFirstSend = r; });
        const result = await processOutbox();
        await released;

        expect(sends.filter((id) => id === rowId)).toHaveLength(1);
        expect(result.sent).toBe(1);
        const row = await db.notificationOutbox.findUniqueOrThrow({ where: { id: rowId }, select: { status: true, attempts: true } });
        expect(row).toEqual({ status: 'SENT', attempts: 1 });
    });
});
