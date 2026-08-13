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
 * `tests/guardrails/sanitize-rich-text-coverage.test.ts`, which DERIVES
 * its inventory from `ENCRYPTED_FIELDS` rather than a hand-list):
 *
 *   Epic C.5 — comment surfaces over `TaskComment.body`
 *     · task.addTaskComment   (plain-text body)
 *     · issue.addIssueComment (plain-text body — same repository)
 *
 * GRC teardown phase 2 removed the policy / finding / risk / vendor /
 * audit / control-test write-path blocks along with their usecases,
 * repositories and models. `addIssueComment` used to be described here
 * as "covered transitively — same repo"; it is now driven explicitly,
 * because after the teardown a transitive claim is the only thing
 * standing between that call site and an unsanitised comment body.
 * (`usecases/issue.ts` is a deprecated shim over the farm-task system
 * and is KEEP.)
 *
 * WHAT THIS FILE DOES **NOT** COVER — read before adding to it.
 * `TaskComment.body` is one of TWELVE surviving encrypted
 * business-content models, not "the" surface. The derived guardrail
 * lists Task, TaskComment, ParcelLease, Company, PromotionLead,
 * AccessReview, AccessReviewDecision, Contract, YieldRecord, CostEntry
 * and FarmProfile as covered, plus EvidenceReview as a named gap. None
 * of those is GRC; the teardown did not shrink that set.
 *
 * And there is a live gap the derived guardrail CANNOT see, because its
 * check is file-level ("does task.ts call a sanitiser anywhere?"):
 *
 *   **`Task.description` and `Task.resolution` are in ENCRYPTED_FIELDS
 *   and are written UNSANITISED.** `createTask` (task.ts:~137) and
 *   `updateTask` (~:223) pass `input.description` straight to
 *   `WorkItemRepository`. The only `sanitizePlainText` calls in that
 *   module are the TaskLink note and the comment body — which is
 *   exactly why the model shows green upstream.
 *
 * That is a PRE-EXISTING defect on the farm-task surface, not something
 * the teardown caused, and fixing it is a source change that belongs in
 * its own reviewed PR rather than buried in a deletion diff. It is
 * recorded here because this per-call-site file is the mechanism that
 * would have caught it, and a docblock claiming the surface is complete
 * is what kept it hidden.
 *
 * Adding a new sanitised write path: append a `describe(...)` block
 * below. The derived guardrail is what fails when a NEW encrypted
 * business-content model arrives unclassified; this file is what fails
 * when an EXISTING call site quietly loses its `sanitizePlainText`.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockTaskCommentAdd = jest.fn();

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

// `runInTenantContext` returns a stub Prisma tx; neither comment path
// touches it beyond handing it to the (mocked) repository + audit writer.
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn({})),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));

jest.mock('@/app-layer/policies/task.policies', () => ({
    assertCanReadTasks: jest.fn(),
    assertCanWriteTasks: jest.fn(),
    assertCanCommentOnTasks: jest.fn(),
}));

jest.mock('@/app-layer/policies/issue.policies', () => ({
    assertCanReadIssues: jest.fn(),
    assertCanCreateIssue: jest.fn(),
    assertCanUpdateIssue: jest.fn(),
    assertCanAssignIssue: jest.fn(),
    assertCanResolveIssue: jest.fn(),
    assertCanComment: jest.fn(),
    assertCanManageLinks: jest.fn(),
    assertCanManageBundles: jest.fn(),
    assertCanFreeze: jest.fn(),
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn(),
}));

import { addTaskComment } from '@/app-layer/usecases/task';
import { addIssueComment } from '@/app-layer/usecases/issue';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

beforeEach(() => {
    mockTaskCommentAdd.mockReset();
    mockTaskCommentAdd.mockResolvedValue({ id: 'c1' });
});

// ═══════════════════════════════════════════════════════════════════
// Epic C.5 — comment surfaces (TaskComment.body, encrypted at rest)
// ═══════════════════════════════════════════════════════════════════

describe('addTaskComment sanitises the body before persisting', () => {
    it('strips <script> entirely', async () => {
        await addTaskComment(ctx, 'task-1', 'hi<script>alert(1)</script>tail');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        expect(body).not.toMatch(/<script/i);
        expect(body).not.toMatch(/alert/);
        expect(body).toContain('hi');
        expect(body).toContain('tail');
    });

    it('decodes HTML entities so a stored `&lt;script&gt;` cannot roundtrip', async () => {
        await addTaskComment(ctx, 'task-1', '&lt;script&gt;x&lt;/script&gt;');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        expect(body).toBe('<script>x</script>');
        // The literal text the user typed; whatever renderer reads it
        // sees real angle brackets, not entities — so even a markdown
        // engine that decodes entities cannot re-emit a script tag.
    });
});

describe('addIssueComment sanitises the body before persisting', () => {
    it('strips <script> entirely', async () => {
        await addIssueComment(ctx, 'issue-1', 'hi<script>alert(1)</script>tail');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        expect(body).not.toMatch(/<script/i);
        expect(body).not.toMatch(/alert/);
        expect(body).toContain('hi');
        expect(body).toContain('tail');
    });

    it('decodes HTML entities so a stored `&lt;script&gt;` cannot roundtrip', async () => {
        await addIssueComment(ctx, 'issue-1', '&lt;script&gt;x&lt;/script&gt;');
        const body = mockTaskCommentAdd.mock.calls[0][3];
        expect(body).toBe('<script>x</script>');
    });
});
