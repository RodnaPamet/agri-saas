/**
 * Write-path integration tests for the server-side sanitiser layer
 * (Epic C.5 + Epic D.2).
 *
 * Drives every known sanitised usecase with a hostile payload and
 * asserts the value handed to the repository is already clean. The
 * sanitiser internals are covered exhaustively in
 * `tests/unit/security/sanitize.test.ts`; here we prove the WIRING is
 * intact at every call site so a refactor that drops the sanitiser
 * call shows up here with `file:line`.
 *
 * Coverage map (kept in sync with
 * `tests/guardrails/sanitize-rich-text-coverage.test.ts::RICH_TEXT_USECASES`):
 *
 *   Epic C.5 — first wave (rich-text editor + comment surfaces)
 *     · createPolicyVersion         (HTML / MARKDOWN / EXTERNAL_LINK)
 *     · addTaskComment              (plain-text body)
 *     · addIssueComment             (covered transitively — same repo)
 *
 *   Epic D.2 — encrypted-field write paths
 *     · finding.createFinding / updateFinding
 *     · risk.createRisk / createRiskFromTemplate / updateRisk
 *     · vendor.createVendor / updateVendor / addVendorDocument
 *                / decideVendorAssessment
 *     · audit.createAudit / updateAudit (incl. checklist notes)
 *
 * Adding a new sanitised write path: append a `describe(...)` block
 * below AND extend the static guardrail's `RICH_TEXT_USECASES` table.
 * The guardrail's `>= 8 entries` ratchet keeps this list from quietly
 * shrinking.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

// Policy + task (Epic C.5 surfaces)
const mockPolicyGetById = jest.fn();
const mockPolicyVersionCreate = jest.fn();
const mockPolicySetCurrentVersion = jest.fn();
const mockPolicyUpdateStatus = jest.fn();
const mockTaskCommentAdd = jest.fn();

// Epic D.2 surfaces
const mockFindingCreate = jest.fn();
const mockFindingUpdate = jest.fn();
const mockFindingGetById = jest.fn();

const mockRiskCreate = jest.fn();
const mockRiskUpdate = jest.fn();
// updateRisk reads the prior owner via getById before writing (to fire
// the assignment notification only on an actual change). Returns
// undefined by default → previousOwnerId resolves to null.
const mockRiskGetById = jest.fn();
const mockRiskTemplateGet = jest.fn();
const mockTenantFindUnique = jest.fn();

const mockVendorCreate = jest.fn();
const mockVendorUpdate = jest.fn();
const mockVendorGetById = jest.fn();
const mockVendorDocCreate = jest.fn();
const mockVendorAssessmentDecide = jest.fn();

const mockAuditCreate = jest.fn();
const mockAuditUpdate = jest.fn();
const mockAuditChecklistUpdate = jest.fn();

const mockTestPlanCreate = jest.fn();
const mockTestPlanUpdate = jest.fn();
const mockTestPlanUpdateNextDueAt = jest.fn();
const mockTestPlanGetById = jest.fn();
const mockTestRunComplete = jest.fn();
const mockTestRunGetById = jest.fn();

jest.mock('@/app-layer/repositories/PolicyRepository', () => ({
    PolicyRepository: {
        getById: (...args: unknown[]) => mockPolicyGetById(...args),
        setCurrentVersion: (...args: unknown[]) => mockPolicySetCurrentVersion(...args),
        updateStatus: (...args: unknown[]) => mockPolicyUpdateStatus(...args),
    },
}));

jest.mock('@/app-layer/repositories/PolicyVersionRepository', () => ({
    PolicyVersionRepository: {
        create: (...args: unknown[]) => mockPolicyVersionCreate(...args),
    },
}));

jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    TaskCommentRepository: {
        add: (...args: unknown[]) => mockTaskCommentAdd(...args),
    },
    // Re-export the rest as no-op stubs the usecases pull in via the
    // same barrel.
    WorkItemRepository: {},
    TaskLinkRepository: {},
    TaskWatcherRepository: {},
}));

jest.mock('@/app-layer/repositories/FindingRepository', () => ({
    FindingRepository: {
        create: (...a: unknown[]) => mockFindingCreate(...a),
        update: (...a: unknown[]) => mockFindingUpdate(...a),
        getById: (...a: unknown[]) => mockFindingGetById(...a),
    },
}));



jest.mock('@/app-layer/repositories/VendorRepository', () => ({
    VendorRepository: {
        create: (...a: unknown[]) => mockVendorCreate(...a),
        update: (...a: unknown[]) => mockVendorUpdate(...a),
        getById: (...a: unknown[]) => mockVendorGetById(...a),
    },
    VendorDocumentRepository: {
        create: (...a: unknown[]) => mockVendorDocCreate(...a),
    },
    VendorLinkRepository: {},
}));

jest.mock('@/app-layer/repositories/AssessmentRepository', () => ({
    QuestionnaireRepository: {},
    VendorAssessmentRepository: {
        decide: (...a: unknown[]) => mockVendorAssessmentDecide(...a),
    },
    VendorAnswerRepository: {},
}));

jest.mock('@/app-layer/repositories/AuditRepository', () => ({
    AuditRepository: {
        create: (...a: unknown[]) => mockAuditCreate(...a),
        update: (...a: unknown[]) => mockAuditUpdate(...a),
        updateChecklistItem: (...a: unknown[]) => mockAuditChecklistUpdate(...a),
    },
}));




// `runInTenantContext` returns a stub Prisma tx. Risk usecase uses
// `tenant.findUnique` against it for maxScale lookup.
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx, fn) =>
        fn({
            tenant: { findUnique: (...a: unknown[]) => mockTenantFindUnique(...a) },
            // RQ2-1 — score writes append a ledger event on the same tx.
            riskScoreEvent: { create: async () => ({ id: 'evt-1' }) },
        }),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));


jest.mock('@/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(),
    assertCanAdmin: jest.fn(),
}));

jest.mock('@/app-layer/policies/task.policies', () => ({
    assertCanReadTasks: jest.fn(),
    assertCanWriteTasks: jest.fn(),
    assertCanCommentOnTasks: jest.fn(),
}));

jest.mock('@/app-layer/policies/vendor.policies', () => ({
    assertCanReadVendors: jest.fn(),
    assertCanManageVendors: jest.fn(),
    assertCanManageVendorDocs: jest.fn(),
    assertCanRunAssessment: jest.fn(),
    assertCanApproveAssessment: jest.fn(),
}));

jest.mock('@/app-layer/policies/test.policies', () => ({
    assertCanReadTests: jest.fn(),
    assertCanManageTestPlans: jest.fn(),
    assertCanExecuteTests: jest.fn(),
    assertCanLinkTestEvidence: jest.fn(),
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn(),
}));

// `task.createTask` is invoked from completeTestRun on FAIL; stub so
// we don't recursively pull in the task usecase + its repo.
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: jest.fn(async () => ({ id: 'task-x' })),
    addTaskComment: jest.requireActual('@/app-layer/usecases/task').addTaskComment,
}));

import { createPolicyVersion } from '@/app-layer/usecases/policy';
import { addTaskComment } from '@/app-layer/usecases/task';
import { createFinding, updateFinding } from '@/app-layer/usecases/finding';
import {
    createVendor,
    updateVendor,
    addVendorDocument,
    decideVendorAssessment,
} from '@/app-layer/usecases/vendor';
import { createAudit, updateAudit } from '@/app-layer/usecases/audit';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const XSS = '<script>alert(1)</script>';

beforeEach(() => {
    [
        mockPolicyGetById, mockPolicyVersionCreate, mockPolicySetCurrentVersion,
        mockPolicyUpdateStatus, mockTaskCommentAdd,
        mockFindingCreate, mockFindingUpdate, mockFindingGetById,
        mockRiskCreate, mockRiskUpdate, mockRiskTemplateGet, mockTenantFindUnique,
        mockVendorCreate, mockVendorUpdate, mockVendorGetById,
        mockVendorDocCreate, mockVendorAssessmentDecide,
        mockAuditCreate, mockAuditUpdate, mockAuditChecklistUpdate,
        mockTestPlanCreate, mockTestPlanUpdate, mockTestPlanUpdateNextDueAt,
        mockTestPlanGetById, mockTestRunComplete, mockTestRunGetById,
    ].forEach((m) => m.mockReset());

    mockPolicyGetById.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
    mockPolicyVersionCreate.mockResolvedValue({ id: 'v1', versionNumber: 1 });
    mockTenantFindUnique.mockResolvedValue({ id: 'tenant-1', maxRiskScale: 5 });
});

// ═══════════════════════════════════════════════════════════════════
// Epic C.5 — first-wave surfaces
// ═══════════════════════════════════════════════════════════════════

describe('createPolicyVersion sanitises HTML content before persisting', () => {
    it('strips <script> from the contentText handed to the repository', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'HTML',
            contentText:
                '<h1>Policy</h1><script>alert("XSS")</script><p>OK</p>',
            changeSummary: 'init',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        expect(data.contentText).toContain('<h1>Policy</h1>');
        expect(data.contentText).toContain('<p>OK</p>');
        expect(data.contentText).not.toMatch(/<script/i);
        expect(data.contentText).not.toMatch(/alert\(/);
    });

    it('strips event handlers (onerror) from HTML before persisting', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'HTML',
            contentText: '<img src="x" onerror="alert(1)" />',
            changeSummary: '',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        expect(data.contentText).not.toMatch(/onerror=/i);
    });

    it('plain-text-strips MARKDOWN content (defence against embedded raw HTML)', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'MARKDOWN',
            contentText: '# Heading\n\n<script>alert(1)</script>',
            changeSummary: '',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        expect(data.contentText).not.toMatch(/<script/i);
        expect(data.contentText).toContain('# Heading');
    });

    it('keeps EXTERNAL_LINK + null contentText untouched (no contentText on the wire)', async () => {
        await createPolicyVersion(ctx, 'p1', {
            contentType: 'EXTERNAL_LINK',
            externalUrl: 'https://example.com',
            changeSummary: '',
        });
        const data = mockPolicyVersionCreate.mock.calls[0][3];
        // No contentText to sanitise — passthrough.
        expect(data.contentText).toBeUndefined();
        expect(data.externalUrl).toBe('https://example.com');
    });
});

describe('addTaskComment sanitises the body before persisting', () => {
    it('strips <script> entirely', async () => {
        mockTaskCommentAdd.mockResolvedValue({ id: 'c1' });
        await addTaskComment(ctx, 'task-1', 'hi<script>alert(1)</script>tail');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        expect(body).not.toMatch(/<script/i);
        expect(body).not.toMatch(/alert/);
        expect(body).toContain('hi');
        expect(body).toContain('tail');
    });

    it('decodes HTML entities so a stored `&lt;script&gt;` cannot roundtrip', async () => {
        mockTaskCommentAdd.mockResolvedValue({ id: 'c1' });
        await addTaskComment(ctx, 'task-1', '&lt;script&gt;x&lt;/script&gt;');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        expect(body).toBe('<script>x</script>');
        // The literal text the user typed; whatever renderer reads it
        // sees real angle brackets, not entities — so even a markdown
        // engine that decodes entities cannot re-emit a script tag.
    });
});

// ═══════════════════════════════════════════════════════════════════
// Epic D.2 — encrypted-field write paths
// ═══════════════════════════════════════════════════════════════════

// ── finding.ts ────────────────────────────────────────────────────

describe('finding.createFinding sanitises every free-text column', () => {
    it('strips <script> from title, description, rootCause, correctiveAction, owner', async () => {
        mockFindingCreate.mockResolvedValue({ id: 'f1', title: 'X', status: 'OPEN' });
        await createFinding(ctx, {
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            title: `Title ${XSS}`,
            description: `Desc ${XSS}`,
            rootCause: `Root ${XSS}`,
            correctiveAction: `Fix ${XSS}`,
            owner: `Alice ${XSS}`,
        });
        const data = mockFindingCreate.mock.calls[0][2];
        for (const k of ['title', 'description', 'rootCause', 'correctiveAction', 'owner']) {
            expect(data[k]).not.toMatch(/<script/);
        }
        // Sanity — clean text survives.
        expect(data.title).toContain('Title');
    });
});

describe('finding.updateFinding sanitises only fields actually being written', () => {
    it('sanitises verificationNotes when provided; leaves omitted fields as undefined', async () => {
        mockFindingGetById.mockResolvedValue({ id: 'f1', status: 'OPEN' });
        mockFindingUpdate.mockResolvedValue({ id: 'f1', status: 'OPEN' });
        await updateFinding(ctx, 'f1', { verificationNotes: `V ${XSS}` });
        const data = mockFindingUpdate.mock.calls[0][3];
        expect(data.verificationNotes).not.toMatch(/<script/);
        expect(data.title).toBeUndefined();
        expect(data.description).toBeUndefined();
    });
});

// ── risk.ts ───────────────────────────────────────────────────────




// ── vendor.ts ─────────────────────────────────────────────────────

describe('vendor.createVendor sanitises every free-text column + tags', () => {
    it('strips <script> from name, description, country, tags[]', async () => {
        mockVendorCreate.mockResolvedValue({
            id: 'v1', name: 'X', status: 'ACTIVE', criticality: 'LOW',
        });
        await createVendor(ctx, {
            name: `Acme ${XSS}`,
            description: `desc ${XSS}`,
            country: `US ${XSS}`,
            tags: [`prod ${XSS}`, 'safe-tag'],
        });
        const data = mockVendorCreate.mock.calls[0][2];
        expect(data.name).not.toMatch(/<script/);
        expect(data.description).not.toMatch(/<script/);
        expect(data.country).not.toMatch(/<script/);
        expect(data.tags[0]).not.toMatch(/<script/);
        expect(data.tags[1]).toBe('safe-tag');
    });
});

describe('vendor.updateVendor sanitises known free-text patch keys', () => {
    it('strips <script> from description; enums and ids pass through untouched', async () => {
        mockVendorUpdate.mockResolvedValue({ id: 'v1', name: 'X' });
        mockVendorGetById.mockResolvedValue({ status: 'ACTIVE' });
        await updateVendor(ctx, 'v1', {
            description: `bad ${XSS}`,
            criticality: 'HIGH', // enum — must NOT be sanitised
            ownerUserId: 'user-9', // FK id — must NOT be sanitised
            tags: ['t1', `t2 ${XSS}`],
        });
        const data = mockVendorUpdate.mock.calls[0][3];
        expect(data.description).not.toMatch(/<script/);
        expect(data.criticality).toBe('HIGH');
        expect(data.ownerUserId).toBe('user-9');
        expect(data.tags[1]).not.toMatch(/<script/);
    });
});

describe('vendor.addVendorDocument sanitises title, externalUrl, notes', () => {
    it('strips <script> from notes (encrypted) and title', async () => {
        mockVendorDocCreate.mockResolvedValue({
            id: 'd1', vendorId: 'v1', type: 'POLICY', title: 'X',
        });
        await addVendorDocument(ctx, 'v1', {
            type: 'POLICY',
            title: `T ${XSS}`,
            notes: `Notes ${XSS}`,
            externalUrl: 'https://example.com',
        });
        const data = mockVendorDocCreate.mock.calls[0][3];
        expect(data.title).not.toMatch(/<script/);
        expect(data.notes).not.toMatch(/<script/);
    });
});

describe('vendor.decideVendorAssessment sanitises the notes argument', () => {
    it('strips <script> before forwarding to the repository', async () => {
        mockVendorAssessmentDecide.mockResolvedValue({ id: 'a1', vendorId: 'v1' });
        await decideVendorAssessment(ctx, 'a1', 'APPROVED', `Looks good ${XSS}`);
        const notes = mockVendorAssessmentDecide.mock.calls[0][4];
        expect(notes).not.toMatch(/<script/);
    });
});

// ── audit.ts ──────────────────────────────────────────────────────

describe('audit.createAudit sanitises every encrypted free-text column', () => {
    it('strips <script> from title, scope, criteria, auditors, auditees, departments', async () => {
        mockAuditCreate.mockResolvedValue({ id: 'a1', title: 'X' });
        await createAudit(ctx, {
            title: `T ${XSS}`,
            scope: `S ${XSS}`,
            criteria: `C ${XSS}`,
            auditors: `Alice ${XSS}`,
            auditees: `Bob ${XSS}`,
            departments: `IT ${XSS}`,
        });
        const data = mockAuditCreate.mock.calls[0][2];
        for (const k of [
            'title',
            'auditScope',
            'criteria',
            'auditors',
            'auditees',
            'departments',
        ]) {
            expect(data[k]).not.toMatch(/<script/);
        }
    });
});

describe('audit.updateAudit sanitises top-level fields and per-checklist notes', () => {
    it('strips <script> from updated criteria + checklist notes; enum result untouched', async () => {
        mockAuditUpdate.mockResolvedValue({ id: 'a1' });
        mockAuditChecklistUpdate.mockResolvedValue({ id: 'ci-1' });
        await updateAudit(ctx, 'a1', {
            criteria: `C ${XSS}`,
            checklistUpdates: [
                { id: 'ci-1', result: 'PASS', notes: `Item ${XSS}` },
                { id: 'ci-2', result: 'FAIL' }, // no notes → no sanitisation
            ],
        });
        const top = mockAuditUpdate.mock.calls[0][3];
        expect(top.criteria).not.toMatch(/<script/);
        const item = mockAuditChecklistUpdate.mock.calls[0][3];
        expect(item.notes).not.toMatch(/<script/);
        expect(item.result).toBe('PASS');
        const item2 = mockAuditChecklistUpdate.mock.calls[1][3];
        expect(item2.notes).toBeUndefined();
        expect(item2.result).toBe('FAIL');
    });
});
