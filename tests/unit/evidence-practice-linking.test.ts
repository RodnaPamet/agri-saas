/**
 * Unit Tests — Evidence API body-parsing contract
 *
 * GRC teardown phase 2 removed the Practice surface (usecases,
 * `PracticeRepository`, the `/practices/[practiceId]` detail page and
 * its evidence tab), so everything this file used to prove about
 * Evidence ↔ Practice linking has no subject left:
 *
 *   - `createEvidence` / `uploadEvidenceFile` validating `practiceId`
 *     against the tenant and bridging a `PracticeEvidenceLink`
 *     (`INVALID_CONTROL`, `practiceEvidenceLink.createMany`,
 *     `skipDuplicates`) — the write path survives only as vestigial
 *     code until the phase-3 schema drop; nothing can create a
 *     Practice to link to.
 *   - `PracticeRepository.getById` including `evidenceLinks` + direct
 *     `evidence` (repository deleted).
 *   - The practice detail page's unified evidence tab — `evidenceSWR`,
 *     `directEvidence`, `linkedFileIds` dedupe, the summed `_count`
 *     badge (page deleted).
 *   - `buildPractice` / `buildEvidence({ practiceId })` factory
 *     coverage and `CreateEvidenceSchema`'s optional `practiceId`.
 *
 * What survives is the Evidence API's body-parsing contract, which is
 * independent of practices and is not asserted anywhere else: both the
 * tenant-scoped and legacy evidence POST routes take a JSON body via
 * `withValidatedBody` + `CreateEvidenceSchema`, NOT the old multipart
 * `withValidatedForm` + `CreateEvidenceFormSchema` pair.
 */

// ─── API Route: evidence POST accepts JSON (not FormData) ───

describe('Evidence API route — JSON body parsing', () => {
    const tenantRoutePath = require('path').resolve(
        __dirname, '../../src/app/api/t/[tenantSlug]/evidence/route.ts'
    );
    const tenantRouteContent = require('fs').readFileSync(tenantRoutePath, 'utf-8');

    const legacyRoutePath = require('path').resolve(
        __dirname, '../../src/app/api/evidence/route.ts'
    );
    const legacyRouteContent = require('fs').readFileSync(legacyRoutePath, 'utf-8');

    test('tenant evidence POST uses withValidatedBody (not withValidatedForm)', () => {
        expect(tenantRouteContent).toContain('withValidatedBody');
        expect(tenantRouteContent).not.toMatch(/withValidatedForm/);
    });

    test('tenant evidence POST uses CreateEvidenceSchema (not FormSchema)', () => {
        expect(tenantRouteContent).toContain('CreateEvidenceSchema');
        expect(tenantRouteContent).not.toMatch(/CreateEvidenceFormSchema/);
    });

    test('legacy evidence POST uses withValidatedBody', () => {
        expect(legacyRouteContent).toContain('withValidatedBody');
        expect(legacyRouteContent).not.toMatch(/withValidatedForm/);
    });
});
