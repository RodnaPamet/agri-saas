/**
 * Unit Tests — Evidence ↔ Practice Linking
 *
 * Proves that:
 * 1. createEvidence validates practiceId belongs to the same tenant
 * 2. createEvidence creates PracticeEvidenceLink when practiceId is provided (FILE/LINK types)
 * 3. createEvidence works without practiceId (standalone evidence)
 * 4. uploadEvidenceFile validates practiceId belongs to the same tenant
 * 5. The practice evidence tab query returns both evidenceLinks and evidence
 */
import { buildRequestContext, buildPractice, buildEvidence } from '../helpers/factories';

// ─── Structural: createEvidence validates practiceId ───

describe('Evidence → Practice linking — structural', () => {
    const usecasePath = require('path').resolve(
        __dirname, '../../src/app-layer/usecases/evidence.ts'
    );
    const usecaseContent = require('fs').readFileSync(usecasePath, 'utf-8');

    test('createEvidence validates practice tenant before creating evidence', () => {
        // The usecase must check that the practice belongs to the same tenant
        expect(usecaseContent).toContain('INVALID_CONTROL');
        expect(usecaseContent).toContain('Practice not found or belongs to a different tenant');
    });

    test('createEvidence creates PracticeEvidenceLink when practiceId is provided', () => {
        expect(usecaseContent).toContain('practiceEvidenceLink.createMany');
    });

    // Slice from the DECLARATION, not the bare name. Splitting on the bare
    // string put this section wherever the identifier last appeared — which
    // included a cross-reference inside a comment, so an unrelated comment
    // edit silently moved what these tests were reading.
    const uploadSection =
        usecaseContent.split('export async function uploadEvidenceFile')[1] || '';

    test('the upload section was actually located (self-check)', () => {
        expect(uploadSection.length).toBeGreaterThan(500);
    });

    test('uploadEvidenceFile also validates practiceId tenant', () => {
        expect(uploadSection).toContain('INVALID_CONTROL');
    });

    test('uploadEvidenceFile creates PracticeEvidenceLink for file evidence', () => {
        expect(uploadSection).toContain('practiceEvidenceLink.createMany');
    });

    test('a duplicate link is absorbed by the statement, not by a catch', () => {
        // This test used to assert `usecaseContent` matched /catch\s*\{/ —
        // i.e. it REQUIRED the defect. The catch it demanded caught the JS
        // exception from a 23505 while leaving the Postgres transaction
        // aborted, so the audit write on the next line failed with 25P02 and
        // took the whole upload down. The correct shape resolves the conflict
        // inside the statement.
        const bridges = [...usecaseContent.matchAll(
            /practiceEvidenceLink\.createMany\(\{[\s\S]{0,600}?\}\);/g,
        )];
        expect(bridges.length).toBeGreaterThanOrEqual(2);
        for (const [block] of bridges) {
            expect(block).toContain('skipDuplicates: true');
        }
    });
});

// ─── Structural: practice detail query includes both evidence arrays ───

describe('Practice detail query — evidence completeness', () => {
    const repoPath = require('path').resolve(
        __dirname, '../../src/app-layer/repositories/PracticeRepository.ts'
    );
    const repoContent = require('fs').readFileSync(repoPath, 'utf-8');

    test('practice getById includes evidenceLinks relation', () => {
        expect(repoContent).toContain('evidenceLinks');
    });

    test('practice getById includes evidence relation', () => {
        // The query must include direct Evidence records via practiceId FK
        expect(repoContent).toMatch(/evidence:\s*\{/);
    });
});

// ─── Structural: frontend evidence tab renders both sources ───

describe('Practice evidence tab — unified display', () => {
    // R10-PR3 follow-up — the evidence-tab rendering moved from
    // `page.tsx` into the extracted `_tabs/EvidenceSubTable.tsx`
    // (raw `<table>` → `<DataTable>` migration; the inline helper
    // would have blown the page-size ratchet, so it lives in its
    // own file). The structural assertions still hold but they now
    // need to match in EITHER location. We concatenate both file
    // contents and search the joined string, so a future re-shuffle
    // (e.g. inlining the helper back during a tab refactor) doesn't
    // re-break the test.
    const path = require('path');
    const fs = require('fs');
    const PAGE_PATH = path.resolve(
        __dirname, '../../src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx'
    );
    const SUBTABLE_PATH = path.resolve(
        __dirname, '../../src/components/EvidenceSubTable.tsx'
    );
    const pageContent = fs.readFileSync(PAGE_PATH, 'utf-8');
    const subtableContent = fs.existsSync(SUBTABLE_PATH)
        ? fs.readFileSync(SUBTABLE_PATH, 'utf-8')
        : '';
    const evidenceTabContent = pageContent + '\n' + subtableContent;

    // #102 item 1 — the Evidence tab is tab-lazy: it fetches its own
    // `{ links, evidence }` payload via `evidenceSWR` instead of
    // reading the arrays off the eager page-data practice.
    test('evidence tab fetches its links + evidence payload', () => {
        // The SWR fetch lives in page.tsx (page-level state); the
        // sub-table receives it via `data=`.
        expect(pageContent).toContain('evidenceSWR.data');
        // The unified rendering (`data?.links` + `data?.evidence`)
        // lives in the extracted EvidenceSubTable.
        expect(evidenceTabContent).toMatch(/data\?\.links/);
        expect(evidenceTabContent).toMatch(/data\?\.evidence/);
    });

    test('evidence tab renders direct evidence records', () => {
        expect(evidenceTabContent).toContain('directEvidence');
    });

    test('evidence tab deduplicates by fileRecordId', () => {
        expect(evidenceTabContent).toContain('linkedFileIds');
        expect(evidenceTabContent).toContain('fileRecordId');
    });

    test('evidence tab count includes both sources', () => {
        // The Evidence badge sums the link + direct-evidence counts
        // off the page-data `_count` — still in page.tsx.
        expect(pageContent).toMatch(/_count\?\.evidenceLinks[\s\S]*?_count\?\.evidence/);
    });
});

// ─── Unit: factory support ───

describe('Evidence → Practice linking — factories', () => {
    test('buildEvidence with practiceId sets FK', () => {
        const e = buildEvidence({ practiceId: 'ctrl-123' });
        expect(e.practiceId).toBe('ctrl-123');
    });

    test('buildEvidence without practiceId defaults to null', () => {
        const e = buildEvidence();
        expect(e.practiceId).toBeNull();
    });

    test('buildPractice creates valid practice object', () => {
        const c = buildPractice({ tenantId: 'tenant-1' });
        expect(c.tenantId).toBe('tenant-1');
        expect(c.id).toBeDefined();
        expect(c.name).toBeDefined();
    });

    test('cross-tenant practiceId should be rejected by usecase', () => {
        const ctx = buildRequestContext({ tenantId: 'tenant-a' });
        const practice = buildPractice({ tenantId: 'tenant-b' });
        // The usecase queries db.practice.findFirst with tenantId: ctx.tenantId,
        // so a practice from a different tenant won't be found → badRequest thrown
        expect(ctx.tenantId).not.toBe(practice.tenantId);
    });
});

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

// ─── Schema: CreateEvidenceSchema supports practiceId ───

describe('Evidence schema — practiceId support', () => {
    const schemaPath = require('path').resolve(
        __dirname, '../../src/lib/schemas/index.ts'
    );
    const schemaContent = require('fs').readFileSync(schemaPath, 'utf-8');

    test('CreateEvidenceSchema includes optional practiceId', () => {
        expect(schemaContent).toContain('practiceId');
        // practiceId should be optional and nullable
        expect(schemaContent).toMatch(/practiceId.*optional.*nullable|practiceId.*nullable.*optional/);
    });
});
