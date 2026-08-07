/**
 * RQ-10 ratchet — executive reporting + BIA stays wired: BIA fields on Risk,
 * three report models + migration (RLS), the renderers + report service, the
 * delivery cron, the routes, and the reports page.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('RQ-10 reporting & BIA', () => {
    it('BIA fields on Risk + three report models + migration with RLS', () => {
        const schema = read('prisma/schema/compliance.prisma');
        expect(schema).toMatch(/rtoHours\s+Int\?/);
        expect(schema).toMatch(/revenueAtRisk\s+Float\?/);
        for (const m of ['model ReportTemplate', 'model ReportRun', 'model ReportSchedule']) expect(schema).toMatch(new RegExp(m));
        const mig = 'prisma/migrations/20260610280000_rq10_reporting/migration.sql';
        expect(exists(mig)).toBe(true);
        expect(read(mig)).toMatch(/CREATE POLICY tenant_isolation ON %I|tenant_isolation ON "ReportTemplate"|FOREACH t/);
    });

    it('renderers (CSV pure + PDF + PPTX) + report service', () => {
        const r = read('src/app-layer/reports/risk-report-render.ts');
        expect(r).toMatch(/export function renderCsv/);
        expect(r).toMatch(/export async function renderPdf/);
        // RQ-10 follow-up: PPTX export landed (pptxgenjs).
        expect(r).toMatch(/export async function renderPptx/);
        const s = read('src/app-layer/usecases/risk-report.ts');
        expect(s).toMatch(/export function computeNextRun/);
        expect(s).toMatch(/PPTX:.*presentationml/); // FORMAT_META wires the PPTX mime
        for (const fn of ['assembleReportData', 'generateReport', 'listTemplates', 'getReport', 'listReports', 'createSchedule', 'listSchedules']) {
            expect(s).toContain(`export async function ${fn}`);
        }
    });

    it('pptxgenjs is a declared dependency', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.dependencies?.pptxgenjs ?? pkg.devDependencies?.pptxgenjs).toBeTruthy();
    });

    it('the delivery cron is registered + scheduled', () => {
        expect(exists('src/app-layer/jobs/report-delivery-jobs.ts')).toBe(true);
        expect(read('src/app-layer/jobs/executor-registry.ts')).toMatch(/register\('report-delivery'/);
        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/'report-delivery'/);
    });

    it('the delivery cron actually emails the artefact (RQ-10 follow-up)', () => {
        // The mailer carries attachments + the cron emails the generated report.
        expect(read('src/lib/mailer.ts')).toMatch(/attachments\?: EmailAttachment\[\]/);
        expect(read('src/app-layer/usecases/risk-report.ts')).toMatch(/export async function deliverReportByEmail/);
        expect(read('src/app-layer/jobs/report-delivery-jobs.ts')).toMatch(/deliverReportByEmail/);
    });

    it('the delivery cron pushes to SharePoint via the SP-3 Graph client (RQ-10 follow-up)', () => {
        expect(read('prisma/schema/compliance.prisma')).toMatch(/sharePointDriveId\s+String\?/);
        const s = read('src/app-layer/usecases/risk-report.ts');
        expect(s).toMatch(/export async function deliverReportToSharePoint/);
        expect(s).toMatch(/uploadNewFile/);
        expect(read('src/app-layer/jobs/report-delivery-jobs.ts')).toMatch(/deliverReportToSharePoint/);
    });

    it('routes + reports page', () => {
        expect(exists('src/app/api/t/[tenantSlug]/risks/reports/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/risks/reports/[reportId]/download/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/risks/reports/schedules/route.ts')).toBe(true);
    });
});
