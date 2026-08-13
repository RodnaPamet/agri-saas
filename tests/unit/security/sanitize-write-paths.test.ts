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

import { addTaskComment } from '@/app-layer/usecases/task';
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



// ── risk.ts ───────────────────────────────────────────────────────




// ── vendor.ts ─────────────────────────────────────────────────────





// ── audit.ts ──────────────────────────────────────────────────────

// GRC teardown phase 2 (T3): the policy / finding / vendor / audit
// write-path cases went with their usecases. `addTaskComment` is the
// surviving encrypted-free-text write path, and the DERIVED half of this
// contract — tests/guardrails/sanitize-rich-text-coverage.test.ts, which
// builds its inventory from ENCRYPTED_FIELDS rather than a hand-list — is
// what keeps a NEW unsanitised write path from sliding in.
