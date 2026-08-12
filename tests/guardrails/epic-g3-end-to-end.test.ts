/**
 * Epic G-3 — end-to-end readiness guardrail.
 *
 * Locks the entire chain that turns "create a template" into "this
 * vendor's risk profile carries the reviewed result". If any link
 * is silently dewired by a future PR, this test fires.
 *
 * Coverage map:
 *
 *   [1] Schema: AnswerType enum carries SCALE + FILE_UPLOAD;
 *       AssessmentStatus carries the G-3 lifecycle;
 *       VendorAssessmentTemplate + Section + Question models
 *       exist; VendorAssessment carries the workflow fields.
 *   [2] EmailNotificationType has all 4 G-3 values.
 *   [3] Usecase exports: createTemplate, addSection, addQuestion,
 *       cloneTemplate, reorderTemplate, getTemplateTree,
 *       listTemplates, sendAssessment, sendAssessmentReminder,
 *       loadResponseByToken, submitResponse, reviewAssessment,
 *       closeAssessment, getReviewView.
 *   [4] Public routes: GET + POST/submit under /api/vendor-assessment.
 *   [5] Internal routes: vendor-assessment-templates CRUD + reorder
 *       + clone; vendor-assessment-reviews GET + review + close +
 *       reminder.
 *   [6] Pages: builder + reviewer mount their client components.
 *   [7] Public path carve-out includes /vendor-assessment/.
 *   [8] Notifications wiring: 4 EmailNotificationType cases handled
 *       in the enqueue dispatch.
 *   [9] Runtime imports: every G-3 entry point resolves under jsdom.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}
function exists(rel: string): boolean {
    return fs.existsSync(path.join(REPO_ROOT, rel));
}

describe('Epic G-3 — end-to-end readiness', () => {
    // [1] Schema
    test('AnswerType + AssessmentStatus carry the G-3 values', () => {
        const enums = read('prisma/schema/enums.prisma');
        expect(enums).toMatch(/enum AnswerType[\s\S]*SCALE[\s\S]*FILE_UPLOAD/);
        expect(enums).toMatch(
            /enum AssessmentStatus[\s\S]*SENT[\s\S]*IN_PROGRESS[\s\S]*SUBMITTED[\s\S]*REVIEWED[\s\S]*CLOSED/,
        );
    });

    test('VendorAssessmentTemplate / Section / Question models exist with key fields', () => {
        const vendor = read('prisma/schema/vendor.prisma');
        expect(vendor).toMatch(/model VendorAssessmentTemplate \{/);
        expect(vendor).toMatch(/model VendorAssessmentTemplateSection \{/);
        expect(vendor).toMatch(/model VendorAssessmentTemplateQuestion \{/);
        expect(vendor).toMatch(/scoringConfigJson\s+Json\?/);
    });

    test('VendorAssessment carries the workflow fields', () => {
        const vendor = read('prisma/schema/vendor.prisma');
        for (const f of [
            'sentAt',
            'sentByUserId',
            'respondentEmail',
            'externalAccessTokenHash',
            'externalAccessTokenExpiresAt',
            'reviewedAt',
            'reviewedByUserId',
            'reviewerNotes',
            'closedAt',
            'closedByUserId',
            'templateVersionId',
        ]) {
            expect(vendor).toMatch(new RegExp(`\\n\\s+${f}\\s+`));
        }
    });

    // [2] EmailNotificationType
    test('EmailNotificationType has all 4 vendor-assessment values', () => {
        const enums = read('prisma/schema/enums.prisma');
        for (const v of [
            'VENDOR_ASSESSMENT_INVITATION',
            'VENDOR_ASSESSMENT_REMINDER',
            'VENDOR_ASSESSMENT_SUBMITTED',
            'VENDOR_ASSESSMENT_REVIEWED',
        ]) {
            expect(enums).toMatch(new RegExp(`\\b${v}\\b`));
        }
    });

    // [3] Usecase exports
    test('every G-3 usecase exports the documented entry points', () => {
        const tpl = read(
            'src/app-layer/usecases/vendor-assessment-template.ts',
        );
        for (const fn of [
            'createTemplate',
            'addSection',
            'addQuestion',
            'cloneTemplate',
            'reorderTemplate',
            'getTemplateTree',
            'listTemplates',
        ]) {
            expect(tpl).toMatch(
                new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`),
            );
        }
        const send = read('src/app-layer/usecases/vendor-assessment-send.ts');
        expect(send).toMatch(/export\s+async\s+function\s+sendAssessment\b/);
        const rem = read(
            'src/app-layer/usecases/vendor-assessment-reminder.ts',
        );
        expect(rem).toMatch(
            /export\s+async\s+function\s+sendAssessmentReminder\b/,
        );
        const resp = read(
            'src/app-layer/usecases/vendor-assessment-response.ts',
        );
        expect(resp).toMatch(
            /export\s+async\s+function\s+loadResponseByToken\b/,
        );
        expect(resp).toMatch(/export\s+async\s+function\s+submitResponse\b/);
        const rev = read(
            'src/app-layer/usecases/vendor-assessment-review.ts',
        );
        for (const fn of ['reviewAssessment', 'closeAssessment', 'getReviewView']) {
            expect(rev).toMatch(
                new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`),
            );
        }
    });

    // [4] Public routes
    test('public vendor-assessment routes exist', () => {
        expect(
            exists(
            ),
        ).toBe(true);
        expect(
            exists(
            ),
        ).toBe(true);
    });

    // [5] Internal routes
    test('internal admin routes exist for templates + reviews', () => {
        for (const rel of [
        ]) {
            expect(exists(rel)).toBe(true);
        }
    });

    // [6] Pages mount their client components
    test('builder + reviewer pages mount the right client components', () => {
        const builder = read(
            'src/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/page.tsx',
        );
        expect(builder).toMatch(/<VendorTemplateBuilderClient\b/);
        const reviewer = read(
            'src/app/t/[tenantSlug]/(app)/admin/vendor-assessment-reviews/[assessmentId]/page.tsx',
        );
        expect(reviewer).toMatch(/<VendorAssessmentReviewClient\b/);
    });

    // [7] Public path carve-out
    test('PUBLIC_PATH_PREFIXES includes /vendor-assessment/', () => {
        const guard = read('src/lib/auth/guard.ts');
        expect(guard).toMatch(/\/vendor-assessment\//);
        expect(guard).toMatch(/\/api\/vendor-assessment\//);
    });

    // [8] Notification dispatch
    test('enqueue dispatch handles all 4 vendor-assessment email types', () => {
        const enq = read('src/app-layer/notifications/enqueue.ts');
        for (const v of [
            "case 'VENDOR_ASSESSMENT_INVITATION'",
            "case 'VENDOR_ASSESSMENT_REMINDER'",
            "case 'VENDOR_ASSESSMENT_SUBMITTED'",
            "case 'VENDOR_ASSESSMENT_REVIEWED'",
        ]) {
            expect(enq).toContain(v);
        }
    });

    // [9] Runtime imports
    test('every G-3 entry point resolves at runtime', async () => {
        await expect(
            import('@/app-layer/usecases/vendor-assessment-template'),
        ).resolves.toHaveProperty('createTemplate');
        await expect(
            import('@/app-layer/usecases/vendor-assessment-template'),
        ).resolves.toHaveProperty('reorderTemplate');
        await expect(
            import('@/app-layer/usecases/vendor-assessment-send'),
        ).resolves.toHaveProperty('sendAssessment');
        await expect(
            import('@/app-layer/usecases/vendor-assessment-reminder'),
        ).resolves.toHaveProperty('sendAssessmentReminder');
        await expect(
            import('@/app-layer/usecases/vendor-assessment-response'),
        ).resolves.toHaveProperty('submitResponse');
        await expect(
            import('@/app-layer/usecases/vendor-assessment-review'),
        ).resolves.toHaveProperty('reviewAssessment');
        await expect(
            import('@/app-layer/usecases/vendor-assessment-review'),
        ).resolves.toHaveProperty('closeAssessment');
        await expect(
            import('@/app-layer/usecases/vendor-assessment-review'),
        ).resolves.toHaveProperty('getReviewView');
    });
});
