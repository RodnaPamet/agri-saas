/**
 * `enqueueEmail` renders the outbox row in the RECIPIENT's language (#694).
 *
 * WHY THIS FILE EXISTS, separately from `notification-email-locale.test.ts`:
 * that one drives the template builders directly and proves they honour a
 * `locale` argument. It cannot see whether the SEAM passes one. I found the
 * gap by mutation — replacing `buildEmailContent(type, payload, locale)` with
 * a hardcoded `'en'` left all 34 tests green.
 *
 * Same shape as the token-exchange budget in #715: the mechanism was covered
 * and the call site was not. A test per layer is not redundancy; the layers
 * fail independently.
 *
 * The row is the artifact that matters here — `NotificationOutbox` stores
 * RENDERED `subject` / `bodyText` (`prisma/schema/automation.prisma:80-100`,
 * no locale column), so whatever `enqueueEmail` writes is what the recipient
 * eventually receives. `processOutbox` replays it verbatim.
 */
const isNotificationsEnabled = jest.fn();
jest.mock('@/app-layer/notifications/settings', () => ({
    isNotificationsEnabled: (...a: unknown[]) => isNotificationsEnabled(...a),
}));

import { enqueueEmail } from '@/app-layer/notifications/enqueue';

type Row = { subject: string; bodyText: string; toEmail: string; dedupeKey: string };

function makeDb() {
    const created: Row[] = [];
    return {
        created,
        db: {
            notificationOutbox: {
                create: jest.fn(async ({ data }: { data: Row }) => {
                    created.push(data);
                    return { id: 'row-1', dedupeKey: data.dedupeKey };
                }),
            },
        },
    };
}

const base = {
    tenantId: 't1',
    type: 'TASK_ASSIGNED' as const,
    entityId: 'task-1',
    payload: {
        taskTitle: 'Repair the east irrigation line',
        taskKey: 'TSK-42',
        taskType: 'TASK',
        assigneeName: 'Ivan Petrov',
        assignerName: 'Bob Manager',
        tenantSlug: 'acme-farm',
    },
};

beforeEach(() => {
    isNotificationsEnabled.mockReset().mockResolvedValue(true);
});

describe('enqueueEmail carries the locale to the rendered row', () => {
    it('writes a Bulgarian row for a bg recipient', async () => {
        const { db, created } = makeDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await enqueueEmail(db as any, { ...base, toEmail: 'ivan@example.bg', locale: 'bg' });
        expect(created).toHaveLength(1);
        expect(created[0].subject).toContain('Възложена ви е задача');
        expect(created[0].subject).not.toContain('Task assigned');
    });

    it('writes an English row for an en recipient', async () => {
        const { db, created } = makeDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await enqueueEmail(db as any, { ...base, toEmail: 'bob@example.com', locale: 'en' });
        expect(created[0].subject).toContain('Task assigned to you');
        expect(created[0].subject).not.toContain('Възложена');
    });

    it('two recipients of the SAME event get their own language and their own row', async () => {
        // The dedupe key is `{tenantId}:{type}:{email}:{entityId}:{day}` — it
        // includes the email, so per-recipient rows are already the contract.
        // If it had collapsed them, one of these two people would silently get
        // the other's language, and this asserts it does not.
        const { db, created } = makeDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await enqueueEmail(db as any, { ...base, toEmail: 'ivan@example.bg', locale: 'bg' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await enqueueEmail(db as any, { ...base, toEmail: 'bob@example.com', locale: 'en' });

        expect(created).toHaveLength(2);
        expect(created[0].dedupeKey).not.toBe(created[1].dedupeKey);
        expect(created[0].subject).toContain('Възложена');
        expect(created[1].subject).toContain('Task assigned');
    });

    it('does not put the locale in the dedupe key', async () => {
        // Deliberate: a user who switches language mid-UTC-day would otherwise
        // receive a SECOND copy of the same notification, which is worse than
        // the first arriving in the prior language.
        const { db, created } = makeDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await enqueueEmail(db as any, { ...base, toEmail: 'ivan@example.bg', locale: 'bg' });
        const { db: db2, created: created2 } = makeDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await enqueueEmail(db2 as any, { ...base, toEmail: 'ivan@example.bg', locale: 'en' });
        expect(created[0].dedupeKey).toBe(created2[0].dedupeKey);
    });

    it('still respects the tenant notification kill-switch', async () => {
        // Resolving power in the other direction: the locale work must not
        // have moved the disabled check below the render.
        isNotificationsEnabled.mockResolvedValue(false);
        const { db, created } = makeDb();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await enqueueEmail(db as any, {
            ...base,
            toEmail: 'ivan@example.bg',
            locale: 'bg',
        });
        expect(res).toBeNull();
        expect(created).toHaveLength(0);
    });
});
