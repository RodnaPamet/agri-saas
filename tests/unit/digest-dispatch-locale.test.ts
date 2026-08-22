/**
 * `dispatchDigest` renders each recipient's row in THEIR language (#694).
 *
 * WHY THIS IS SEPARATE from `digest-email-locale.test.ts`: that one drives the
 * two builders directly and proves they honour a `locale` argument. It cannot
 * see whether the DISPATCHER passes one. I found the gap by mutation —
 * replacing `recipient.locale` with a hardcoded `'en'` at the
 * `buildDigestEmail` call left all 34 tests green.
 *
 * That is the third time this session the same shape has appeared: the
 * mechanism covered, the call site not (#715's token-exchange budget, #723's
 * `enqueueEmail` seam, this). A test per layer is not redundancy — the layers
 * fail independently, and only a mutation at the seam shows which one is bare.
 *
 * The assertion target is the OUTBOX ROW, because that is the artifact that
 * survives: `NotificationOutbox` stores rendered text and `processOutbox`
 * replays it verbatim.
 */
const mockOutboxCreate = jest.fn();
const mockUserFindMany = jest.fn().mockResolvedValue([]);
const mockMembershipFindMany = jest.fn().mockResolvedValue([]);
const mockTenantFindUnique = jest.fn().mockResolvedValue({ slug: 'acme-farm' });

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: { findMany: (...a: unknown[]) => mockUserFindMany(...a) },
        tenantMembership: { findMany: (...a: unknown[]) => mockMembershipFindMany(...a) },
        tenant: { findUnique: (...a: unknown[]) => mockTenantFindUnique(...a) },
        notificationOutbox: { create: (...a: unknown[]) => mockOutboxCreate(...a) },
        tenantNotificationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    },
}));

import { dispatchDigest } from '@/app-layer/notifications/digest-dispatcher';
import type { DueItem } from '@/app-layer/jobs/types';
import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

type Cat = Record<string, Record<string, string>>;
const BG = (bg.notificationEmail as unknown as { digest: Cat }).digest;
const EN = (en.notificationEmail as unknown as { digest: Cat }).digest;

const item = (ownerUserId: string, entityId = 'task-1'): DueItem =>
    ({
        entityType: 'TASK',
        entityId,
        tenantId: 't1',
        name: 'Repair the east irrigation line',
        reason: { key: 'taskOverdue', params: { days: 3 } },
        urgency: 'OVERDUE',
        dueDate: '2026-08-01T00:00:00.000Z',
        daysRemaining: -3,
        ownerUserId,
    }) as DueItem;

/** The rows `notificationOutbox.create` was asked to write, by recipient. */
function rowsByEmail(): Record<string, { subject: string; bodyText: string }> {
    const out: Record<string, { subject: string; bodyText: string }> = {};
    for (const call of mockOutboxCreate.mock.calls) {
        const d = (call[0] as { data: { toEmail: string; subject: string; bodyText: string } }).data;
        out[d.toEmail] = { subject: d.subject, bodyText: d.bodyText };
    }
    return out;
}

beforeEach(() => {
    mockOutboxCreate.mockReset().mockImplementation(async ({ data }: { data: { dedupeKey: string } }) => ({
        id: `row-${data.dedupeKey}`,
        dedupeKey: data.dedupeKey,
    }));
    mockUserFindMany.mockReset().mockResolvedValue([]);
    mockMembershipFindMany.mockReset().mockResolvedValue([]);
    mockTenantFindUnique.mockReset().mockResolvedValue({ slug: 'acme-farm' });
});

describe('dispatchDigest carries each recipient their own language', () => {
    it('writes a Bulgarian row for a bg owner', async () => {
        mockUserFindMany.mockResolvedValue([
            { id: 'u-bg', email: 'ivan@example.bg', name: 'Ivan', uiLanguage: 'bg' },
        ]);
        await dispatchDigest({ category: 'DEADLINE_DIGEST', items: [item('u-bg')] });
        const row = rowsByEmail()['ivan@example.bg'];
        expect(row).toBeDefined();
        expect(row.subject).toContain('Обобщение на сроковете');
        expect(row.bodyText).toContain(BG.reason.taskOverdue.replace('{days}', '3'));
    });

    it('TWO owners, TWO languages, from one dispatch', async () => {
        // The case the whole `DueItem.reason` redesign exists for. A
        // pre-rendered reason string could not do this, and a dispatcher that
        // ignored `recipient.locale` would give both people the same language
        // while every builder-level test stayed green.
        mockUserFindMany.mockResolvedValue([
            { id: 'u-bg', email: 'ivan@example.bg', name: 'Ivan', uiLanguage: 'bg' },
            { id: 'u-en', email: 'bob@example.com', name: 'Bob', uiLanguage: 'en' },
        ]);
        await dispatchDigest({
            category: 'DEADLINE_DIGEST',
            items: [item('u-bg', 'task-1'), item('u-en', 'task-2')],
        });

        const rows = rowsByEmail();
        expect(Object.keys(rows).sort()).toEqual(['bob@example.com', 'ivan@example.bg']);
        expect(rows['ivan@example.bg'].bodyText).toContain(
            BG.reason.taskOverdue.replace('{days}', '3'),
        );
        expect(rows['bob@example.com'].bodyText).toContain(
            EN.reason.taskOverdue.replace('{days}', '3'),
        );
        // …and neither leaked into the other.
        expect(rows['bob@example.com'].bodyText).not.toContain('просрочена');
        expect(rows['ivan@example.bg'].bodyText).not.toContain('Task overdue by');
    });

    it('falls back to the recipient default when uiLanguage is absent', async () => {
        // `User.uiLanguage` is `@default("bg")`, and a row can still hold null
        // from before the column existed. `resolveRecipientLocale` decides,
        // and the fallback is the RECIPIENT default, not the unauthenticated
        // one — see `@/lib/email/recipient-locale`.
        mockUserFindMany.mockResolvedValue([
            { id: 'u-x', email: 'x@example.bg', name: 'X', uiLanguage: null },
        ]);
        await dispatchDigest({ category: 'DEADLINE_DIGEST', items: [item('u-x')] });
        expect(rowsByEmail()['x@example.bg'].subject).toContain('Обобщение на сроковете');
    });

    it('and an unrecognised value does not render the raw string', async () => {
        // The column is a plain `String`; nothing stops a row holding 'de'.
        mockUserFindMany.mockResolvedValue([
            { id: 'u-d', email: 'd@example.de', name: 'D', uiLanguage: 'de' },
        ]);
        await dispatchDigest({ category: 'DEADLINE_DIGEST', items: [item('u-d')] });
        const row = rowsByEmail()['d@example.de'];
        expect(row.subject).toContain('Обобщение на сроковете');
        expect(row.subject).not.toContain('notificationEmail.');
    });
});
