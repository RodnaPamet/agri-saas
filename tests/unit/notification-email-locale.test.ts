/**
 * Notification emails are written in the RECIPIENT's language (#694 step 2).
 *
 * The existing `notification-templates.test.ts` passes `'en'` and asserts the
 * English copy, which is the right regression net for the templates — but it
 * would pass just as happily against a builder that ignored its `locale`
 * argument entirely. This file is the half that cannot.
 *
 * ## Why the locale is a REQUIRED field on `EnqueueEmailInput`
 *
 * The outbox row stores RENDERED text (`prisma/schema/automation.prisma:80-100`
 * has `subject` / `bodyText` / `bodyHtml`, and no locale column), so the
 * language is frozen at enqueue time. A defaulted locale would be
 * indistinguishable from a chosen one and would silently ship `bg` to an
 * English speaker. Making it required cost three call sites and TypeScript
 * found all three.
 *
 * ## Sender vs recipient
 *
 * `getTranslations()` resolves from the request cookie — the SENDER's language.
 * On task assignment the sender is the assigner and the recipient is the
 * assignee, and they are routinely different people. `translateFor` takes an
 * explicit locale for exactly that reason; the assertions below pin it.
 */
import {
    buildTaskAssignedEmail,
    buildAccessReviewReminderEmail,
    buildAccessReviewOverdueEscalationEmail,
} from '@/app-layer/notifications/templates';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const EN = en.notificationEmail as unknown as Record<string, Record<string, string>>;
const BG = bg.notificationEmail as unknown as Record<string, Record<string, string>>;

const taskPayload = {
    taskTitle: 'Repair the east irrigation line',
    taskKey: 'TSK-42',
    taskType: 'TASK',
    assigneeName: 'Ivan Petrov',
    assignerName: 'Bob Manager',
    tenantSlug: 'acme-farm',
};

const reviewPayload = {
    reviewerName: 'Ivan Petrov',
    campaignName: 'Q3 access review',
    daysUntilDue: 3,
    pendingDecisions: 4,
    totalDecisions: 9,
    tenantSlug: 'acme-farm',
    accessReviewId: 'ar-1',
};

const overduePayload = {
    adminName: 'Ivan Petrov',
    campaignName: 'Q3 access review',
    daysOverdue: 5,
    pendingDecisions: 4,
    totalDecisions: 9,
    tenantSlug: 'acme-farm',
    accessReviewId: 'ar-1',
    reviewerName: 'Maria Ivanova',
    reviewerEmail: 'maria@example.bg',
};

describe('buildTaskAssignedEmail', () => {
    it('writes Bulgarian for a bg recipient', async () => {
        const res = await buildTaskAssignedEmail(taskPayload, 'bg');
        expect(res.subject).toContain('Възложена ви е задача');
        expect(res.bodyText).toContain('Здравейте, Ivan Petrov,');
        expect(res.subject).not.toContain('Task assigned');
    });

    it('writes English for an en recipient', async () => {
        const res = await buildTaskAssignedEmail(taskPayload, 'en');
        expect(res.subject).toContain('Task assigned to you');
        expect(res.subject).not.toContain('Възложена');
    });

    it('keeps the task key, title and link identical in both languages', async () => {
        // Data is data. Only the prose is translated — a bug here would show up
        // as a Bulgarian email that has lost its deep link.
        const [e, b] = await Promise.all([
            buildTaskAssignedEmail(taskPayload, 'en'),
            buildTaskAssignedEmail(taskPayload, 'bg'),
        ]);
        for (const res of [e, b]) {
            expect(res.subject).toContain('[TSK-42]');
            expect(res.subject).toContain('Repair the east irrigation line');
            expect(res.bodyHtml).toContain('/t/acme-farm/farm-tasks');
        }
    });

    it('translates the with-assigner and without-assigner branches separately', async () => {
        // Two different catalogue keys, and the fallback branch is the one a
        // single happy-path test would miss.
        const withAssigner = await buildTaskAssignedEmail(taskPayload, 'bg');
        const without = await buildTaskAssignedEmail(
            { ...taskPayload, assignerName: undefined },
            'bg',
        );
        expect(withAssigner.bodyText).toContain('Bob Manager');
        expect(without.bodyText).not.toContain('Bob Manager');
        expect(without.bodyText).toContain(BG.taskAssigned.intro.replace('{taskType}', 'task'));
    });
});

describe('buildAccessReviewReminderEmail', () => {
    it('writes Bulgarian, including the computed due label', async () => {
        // `dueLabel` is interpolated into three other strings, so a builder
        // that translated the frame but not the label would read as a
        // half-translated email — the most likely partial-wiring bug.
        const res = await buildAccessReviewReminderEmail(reviewPayload, 'bg');
        expect(res.subject).toContain('Преглед на достъпа');
        expect(res.subject).toContain(BG.accessReviewReminder.dueInDays.replace('{days}', '3'));
        expect(res.bodyText).not.toContain('due in');
    });

    it('translates every due-label branch', async () => {
        const cases: Array<[number, string]> = [
            [-2, BG.accessReviewReminder.dueOverdue.replace('{days}', '2')],
            [0, BG.accessReviewReminder.dueToday],
            [1, BG.accessReviewReminder.dueTomorrow],
            [5, BG.accessReviewReminder.dueInDays.replace('{days}', '5')],
        ];
        for (const [days, expected] of cases) {
            const res = await buildAccessReviewReminderEmail(
                { ...reviewPayload, daysUntilDue: days },
                'bg',
            );
            expect(res.bodyText).toContain(expected);
        }
    });

    it('keeps the urgency marker in code, not in the catalogue', async () => {
        // `no-decorative-emoji-in-messages` bans emoji in messages/*.json, so
        // the marker is concatenated onto the translated subject. It must
        // therefore survive translation.
        const urgent = await buildAccessReviewReminderEmail(
            { ...reviewPayload, daysUntilDue: 0 },
            'bg',
        );
        expect(urgent.subject.startsWith('⏰ ')).toBe(true);
        expect(JSON.stringify(BG.accessReviewReminder)).not.toContain('⏰');
    });
});

describe('buildAccessReviewOverdueEscalationEmail', () => {
    it('writes Bulgarian, and keeps the reviewer identity untranslated', async () => {
        const res = await buildAccessReviewOverdueEscalationEmail(overduePayload, 'bg');
        expect(res.subject).toContain('просрочен');
        expect(res.bodyText).toContain('Maria Ivanova (maria@example.bg)');
        expect(res.bodyText).not.toContain('Days overdue');
    });

    it('translates the three admin options', async () => {
        // A bulleted list is the easiest place to localise the frame and leave
        // the items in English.
        const res = await buildAccessReviewOverdueEscalationEmail(overduePayload, 'bg');
        for (const key of ['optionReassign', 'optionForceClose', 'optionChase'] as const) {
            expect(res.bodyText).toContain(BG.accessReviewOverdue[key]);
        }
    });

    it('carries the alert marker in both languages', async () => {
        for (const locale of ['en', 'bg'] as const) {
            const res = await buildAccessReviewOverdueEscalationEmail(overduePayload, locale);
            expect(res.subject.startsWith('⚠️ ')).toBe(true);
        }
    });
});

describe('the catalogues themselves', () => {
    it('are genuinely different — bg is not a copy of en', async () => {
        // The failure this guards is a translation PR that adds the keys and
        // pastes the English values. `i18n-completeness` flags prose-shaped
        // duplicates, but this asserts it at the rendered-output level.
        for (const ns of ['taskAssigned', 'accessReviewReminder', 'accessReviewOverdue', 'evidenceExpiring'] as const) {
            expect(Object.keys(EN[ns]).sort()).toEqual(Object.keys(BG[ns]).sort());
            for (const key of Object.keys(EN[ns])) {
                expect(BG[ns][key]).not.toBe(EN[ns][key]);
            }
        }
    });

    it('keep every interpolation placeholder in both languages', async () => {
        // A dropped `{days}` renders as a sentence with a hole in it, and
        // nothing else in the stack would notice.
        const placeholders = (v: string) => (v.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
        for (const ns of ['taskAssigned', 'accessReviewReminder', 'accessReviewOverdue', 'evidenceExpiring'] as const) {
            for (const key of Object.keys(EN[ns])) {
                expect(placeholders(BG[ns][key])).toEqual(placeholders(EN[ns][key]));
            }
        }
    });
});
