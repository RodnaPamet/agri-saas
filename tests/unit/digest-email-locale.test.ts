/**
 * Digest emails are written in the RECIPIENT's language (#694 step 3).
 *
 * ## Why `DueItem.reason` had to stop being a sentence
 *
 * It used to be rendered English prose built in the monitor jobs —
 * `Task overdue by 3 day(s)`. That cannot be localised where it is built, and
 * not because of translation mechanics: a monitor produces each item ONCE, and
 * the dispatcher can route that same item to SEVERAL recipients whose
 * `uiLanguage` differs. The language is not knowable until the item is
 * addressed.
 *
 * So `reason` is a descriptor (`{ key, params }`) and the digest resolves it
 * per recipient. The alternative — localising only the frame — produces a
 * half-Bulgarian email whose every row detail is still English, which is the
 * most visible partial-wiring failure there is. The `mixed languages` test
 * below is the one that would catch it.
 */
import {
    buildDeadlineDigestEmail,
    buildEvidenceExpiryDigestEmail,
} from '@/app-layer/notifications/digest-templates';
import type { DueItem } from '@/app-layer/jobs/types';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

type Cat = Record<string, Record<string, string>>;
const EN = (en.notificationEmail as unknown as { digest: Cat }).digest;
const BG = (bg.notificationEmail as unknown as { digest: Cat }).digest;

const item = (over: Partial<DueItem> = {}): DueItem =>
    ({
        entityType: 'TASK',
        entityId: 'task-1',
        tenantId: 't1',
        name: 'Repair the east irrigation line',
        reason: { key: 'taskOverdue', params: { days: 3 } },
        urgency: 'OVERDUE',
        dueDate: '2026-08-01T00:00:00.000Z',
        daysRemaining: -3,
        ...over,
    }) as DueItem;

const payload = (items: DueItem[]) => ({
    recipientName: 'Ivan Petrov',
    tenantSlug: 'acme-farm',
    items,
});

describe('buildDeadlineDigestEmail', () => {
    it('writes Bulgarian for a bg recipient', async () => {
        const res = await buildDeadlineDigestEmail(payload([item()]), 'bg');
        expect(res.subject).toContain('Обобщение на сроковете');
        expect(res.bodyText).toContain('Здравейте, Ivan Petrov,');
        expect(res.subject).not.toContain('Deadline digest');
    });

    it('writes English for an en recipient', async () => {
        const res = await buildDeadlineDigestEmail(payload([item()]), 'en');
        expect(res.subject).toContain('Deadline digest');
        expect(res.subject).not.toContain('Обобщение');
    });

    it('translates the ROW DETAIL, not just the frame', async () => {
        // The half-translated failure this design exists to prevent: headers
        // and greeting in Bulgarian, every row still reading
        // "Task overdue by 3 day(s)".
        const res = await buildDeadlineDigestEmail(payload([item()]), 'bg');
        expect(res.bodyText).toContain(BG.reason.taskOverdue.replace('{days}', '3'));
        expect(res.bodyText).not.toContain('Task overdue by');
        expect(res.bodyHtml).not.toContain('Task overdue by');
    });

    it('translates the table headers and the urgency/entity labels', async () => {
        const res = await buildDeadlineDigestEmail(payload([item()]), 'bg');
        for (const k of ['status', 'type', 'name', 'details'] as const) {
            expect(res.bodyHtml).toContain(BG.table[k]);
        }
        expect(res.bodyHtml).toContain(BG.urgency.OVERDUE);
        expect(res.bodyHtml).toContain(BG.entity.TASK);
        // …and the English ones are gone.
        expect(res.bodyHtml).not.toContain(EN.urgency.OVERDUE);
    });

    it('translates the summary line while keeping its emoji', async () => {
        const res = await buildDeadlineDigestEmail(
            payload([
                item(),
                item({ entityId: 't2', urgency: 'URGENT', reason: { key: 'taskDue', params: { days: 2 } } }),
            ]),
            'bg',
        );
        const overdueText = BG.summary.overdue.replace('{count}', '1');
        const dueSoonText = BG.summary.dueSoon.replace('{count}', '1');
        expect(res.bodyText).toContain(overdueText);
        expect(res.bodyText).toContain(dueSoonText);
        // The emoji must be attached to the SUMMARY entry, not merely present
        // somewhere in the body — every item row emits an urgency emoji too,
        // so a bare `toContain('🔴')` passes even with the summary stripped.
        // Measured: that weaker assertion let the mutation through.
        expect(res.bodyText).toContain(`🔴 ${overdueText}`);
        expect(res.bodyText).toContain(`🟡 ${dueSoonText}`);
        expect(JSON.stringify(BG.summary)).not.toContain('🔴');
    });

    it('leaves the DATA alone in both languages', async () => {
        for (const locale of ['en', 'bg'] as const) {
            const res = await buildDeadlineDigestEmail(payload([item()]), locale);
            expect(res.bodyHtml).toContain('Repair the east irrigation line');
            expect(res.bodyHtml).toContain('/t/acme-farm/farm-tasks');
        }
    });
});

describe('buildEvidenceExpiryDigestEmail', () => {
    const evidence = item({
        entityType: 'EVIDENCE',
        reason: { key: 'evidenceExpires', params: { days: 4 } },
        urgency: 'URGENT',
    });

    it('writes Bulgarian, row details included', async () => {
        const res = await buildEvidenceExpiryDigestEmail(payload([evidence]), 'bg');
        expect(res.subject).toContain('Изтичащи доказателства');
        expect(res.bodyText).toContain(BG.reason.evidenceExpires.replace('{days}', '4'));
        expect(res.bodyText).not.toContain('Evidence expires in');
    });

    it('keeps the alert marker in code, not the catalogue', async () => {
        const overdue = item({ entityType: 'EVIDENCE', urgency: 'OVERDUE' });
        const res = await buildEvidenceExpiryDigestEmail(payload([overdue]), 'bg');
        expect(res.subject.startsWith('⚠️ ')).toBe(true);
        expect(JSON.stringify(BG.evidenceExpiry)).not.toContain('⚠️');
    });
});

describe('the same item, two recipients, two languages', () => {
    it('renders independently — this is why reason is a descriptor', async () => {
        // One `DueItem`, produced once by a monitor, addressed to two people.
        // A pre-rendered `reason` string would force one language on both, and
        // no amount of frame translation could fix it.
        const shared = item();
        const [e, b] = await Promise.all([
            buildDeadlineDigestEmail(payload([shared]), 'en'),
            buildDeadlineDigestEmail(payload([shared]), 'bg'),
        ]);
        expect(e.bodyText).toContain(EN.reason.taskOverdue.replace('{days}', '3'));
        expect(b.bodyText).toContain(BG.reason.taskOverdue.replace('{days}', '3'));
        expect(e.bodyText).not.toBe(b.bodyText);
    });
});

describe('the digest catalogues', () => {
    it('cover every reason key a monitor can emit', async () => {
        // The failure this catches: a monitor gains a new reason branch and
        // the catalogue does not, so `translateFor` falls through to
        // returning the KEY and the email shows `evidenceReviewDue` verbatim.
        const emitted = [
            'taskOverdue',
            'taskDue',
            'evidenceRetentionExpired',
            'evidenceExpires',
            'evidenceExpired',
            'evidenceReviewOverdue',
            'evidenceReviewDue',
        ];
        for (const key of emitted) {
            expect(Object.keys(EN.reason)).toContain(key);
            expect(Object.keys(BG.reason)).toContain(key);
            expect(BG.reason[key]).not.toBe(EN.reason[key]);
        }
    });

    it('keep every placeholder in both languages', async () => {
        const ph = (v: string) => (v.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
        for (const ns of Object.keys(EN)) {
            for (const key of Object.keys(EN[ns])) {
                expect(ph(BG[ns][key])).toEqual(ph(EN[ns][key]));
            }
        }
    });
});
