/**
 * Unit tests for email notification templates.
 */
// Email links must be ABSOLUTE (a bare `/t/…` path renders as a host-less
// `http:///t/…` in mail clients — the "Redirect Notice" bug). The templates
// prefix APP_URL; mock it so the link-format assertions exercise the real path.
jest.mock('@/env', () => ({ env: { APP_URL: 'https://app.agrent.bg', NEXTAUTH_URL: undefined } }));

import {
    buildTaskAssignedEmail,
} from '@/app-layer/notifications/templates';

describe('Notification Templates', () => {
    describe('buildTaskAssignedEmail', () => {
        const payload = {
            taskTitle: 'Fix ISMS gap in access control',
            taskKey: 'TSK-42',
            taskType: 'TASK',
            assigneeName: 'Alice Smith',
            assignerName: 'Bob Manager',
            tenantSlug: 'acme-corp',
        };

        it('returns subject with task key and title', async () => {
            const result = await buildTaskAssignedEmail(payload, 'en');
            expect(result.subject).toBe('Task assigned to you: [TSK-42] Fix ISMS gap in access control');
        });

        it('returns bodyText mentioning assignee name', async () => {
            const result = await buildTaskAssignedEmail(payload, 'en');
            expect(result.bodyText).toContain('Hi Alice Smith');
        });

        it('returns bodyText mentioning task type', async () => {
            const result = await buildTaskAssignedEmail(payload, 'en');
            expect(result.bodyText).toContain('task');
        });

        it('returns bodyText mentioning assigner', async () => {
            const result = await buildTaskAssignedEmail(payload, 'en');
            expect(result.bodyText).toContain('by Bob Manager');
        });

        it('returns bodyHtml with styled content', async () => {
            const result = await buildTaskAssignedEmail(payload, 'en');
            expect(result.bodyHtml).toContain('Task assigned to you');
            expect(result.bodyHtml).toContain('font-family');
        });

        it('handles missing taskKey gracefully', async () => {
            const result = await buildTaskAssignedEmail({ ...payload, taskKey: null }, 'en');
            expect(result.subject).toBe('Task assigned to you: Fix ISMS gap in access control');
        });

        it('handles missing assignerName gracefully', async () => {
            const result = await buildTaskAssignedEmail({ ...payload, assignerName: undefined }, 'en');
            expect(result.bodyText).not.toContain('by');
        });

        it('returns link to tenant tasks page', async () => {
            const result = await buildTaskAssignedEmail(payload, 'en');
            expect(result.bodyText).toContain('/t/acme-corp/farm-tasks');
        });

        it('builds an ABSOLUTE link (no host-less http:///) for the mail client', async () => {
            const result = await buildTaskAssignedEmail(payload, 'en');
            expect(result.bodyText).toContain('https://app.agrent.bg/t/acme-corp/farm-tasks');
            expect(result.bodyHtml).toContain('href="https://app.agrent.bg/t/acme-corp/farm-tasks"');
            expect(result.bodyText).not.toContain('http:///');
            expect(result.bodyHtml).not.toContain('http:///');
        });
    });
});
