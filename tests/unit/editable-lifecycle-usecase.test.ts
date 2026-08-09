/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Editable Lifecycle Usecase Tests — Publish Workflow Integration
 *
 * Validates the auditable publish workflow that bridges the pure lifecycle
 * state machine to the persistence + audit layer.
 *
 * Test strategy:
 * - In-memory EditableRepository implementation (no DB)
 * - Mock audit/logger to verify events are emitted correctly
 * - Full publish lifecycle including draft → publish → history → version
 * - Validation hooks
 * - Error conditions (missing entity, archived entity, no draft)
 * - Repeated publish preserves ordered history
 */

import type { EditableState } from '@/app-layer/domain/editable-lifecycle.types';
import { LifecycleError } from '@/app-layer/domain/editable-lifecycle.types';
import { createEditableState } from '@/app-layer/services/editable-lifecycle';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Mocks ───────────────────────────────────────────────────────────

const mockLogEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Import AFTER mocks
import {
    updateDraftWithAudit,
    publishWithAudit,
    revertWithAudit,
    archiveWithAudit,
    type EditableRepository,
    type LifecycleAuditConfig,
    type PublishValidator,
} from '@/app-layer/usecases/editable-lifecycle-usecase';

// ─── Test Fixtures ───────────────────────────────────────────────────

interface TestPayload {
    content: string;
    title?: string;
}

const TEST_CTX: RequestContext = {
    requestId: 'req-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'test-corp',
    role: 'ADMIN' as Role,
    permissions: {
        canRead: true,
        canWrite: true,
        canAdmin: true,
        canAudit: true,
        canExport: true,
    },
    appPermissions: getPermissionsForRole('ADMIN'),
};

const AUDIT_CONFIG: LifecycleAuditConfig = {
    entityType: 'Policy',
    actionPrefix: 'POLICY',
};

const MOCK_DB = {} as any; // Pure functions don't use DB

// ─── In-Memory Repository ────────────────────────────────────────────

function createInMemoryRepo(): EditableRepository<TestPayload> & {
    store: Map<string, EditableState<TestPayload>>;
} {
    const store = new Map<string, EditableState<TestPayload>>();
    return {
        store,
        loadState: async (_db, entityId) => store.get(entityId) ?? null,
        saveState: async (_db, entityId, state) => { store.set(entityId, state); },
    };
}

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

describe('Editable Lifecycle Usecase — Publish Workflow', () => {
    let repo: ReturnType<typeof createInMemoryRepo>;

    beforeEach(() => {
        jest.clearAllMocks();
        repo = createInMemoryRepo();
    });

    // ─── updateDraftWithAudit ────────────────────────────────────
    describe('updateDraftWithAudit', () => {
        it('updates draft and emits audit event', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            const result = await updateDraftWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { content: 'v1-updated' },
                repo, AUDIT_CONFIG,
            );

            expect(result.draft).toEqual({ content: 'v1-updated' });
            expect(result.phase).toBe('DRAFT');
            expect(mockLogEvent).toHaveBeenCalledTimes(1);
            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'POLICY_DRAFT_UPDATED',
                    entityType: 'Policy',
                    entityId: 'e1',
                }),
            );
        });

        it('persists updated state to repository', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            await updateDraftWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { content: 'updated' },
                repo, AUDIT_CONFIG,
            );

            const saved = repo.store.get('e1')!;
            expect(saved.draft).toEqual({ content: 'updated' });
        });

        it('throws for non-existent entity', async () => {
            await expect(
                updateDraftWithAudit(
                    MOCK_DB, TEST_CTX, 'nonexistent',
                    { content: 'x' },
                    repo, AUDIT_CONFIG,
                ),
            ).rejects.toThrow(LifecycleError);
        });

        it('audit event includes phase transition', async () => {
            // Start from PUBLISHED phase
            repo.store.set('e1', {
                phase: 'PUBLISHED',
                currentVersion: 2,
                draft: null,
                published: { content: 'live' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [],
            });

            await updateDraftWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { content: 'new-draft' },
                repo, AUDIT_CONFIG,
            );

            const auditPayload = mockLogEvent.mock.calls[0][2];
            expect(auditPayload.detailsJson.previousPhase).toBe('PUBLISHED');
            expect(auditPayload.detailsJson.newPhase).toBe('DRAFT');
        });
    });

    // ─── publishWithAudit ────────────────────────────────────────
    describe('publishWithAudit', () => {
        it('publishes draft to live and clears draft', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'draft-v1' }));

            const result = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'Initial publish' },
                repo, AUDIT_CONFIG,
            );

            expect(result.phase).toBe('PUBLISHED');
            expect(result.published).toEqual({ content: 'draft-v1' });
            expect(result.draft).toBeNull();
            expect(result.currentVersion).toBe(2);
        });

        it('bumps version from 1 to 2 on first publish', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            const result = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1' },
                repo, AUDIT_CONFIG,
            );

            expect(result.currentVersion).toBe(2);
        });

        it('first publish creates no history entry', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            const result = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1' },
                repo, AUDIT_CONFIG,
            );

            expect(result.history).toHaveLength(0);
        });

        it('second publish snapshots prior live state to history', async () => {
            // Setup: published v1
            repo.store.set('e1', {
                phase: 'DRAFT',
                currentVersion: 2,
                draft: { content: 'v2-draft' },
                published: { content: 'v1-live' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [],
            });

            const result = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'v2 release' },
                repo, AUDIT_CONFIG,
            );

            expect(result.currentVersion).toBe(3);
            expect(result.published).toEqual({ content: 'v2-draft' });
            expect(result.history).toHaveLength(1);
            expect(result.history[0].version).toBe(2);
            expect(result.history[0].payload).toEqual({ content: 'v1-live' });
        });

        it('history snapshot preserves exact prior published payload', async () => {
            const priorPayload: TestPayload = {
                content: 'Original content with special chars: <>&"',
                title: 'Detailed Title',
            };

            repo.store.set('e1', {
                phase: 'DRAFT',
                currentVersion: 2,
                draft: { content: 'new draft' },
                published: priorPayload,
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [],
            });

            const result = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1' },
                repo, AUDIT_CONFIG,
            );

            expect(result.history[0].payload).toEqual(priorPayload);
        });

        it('repeated publishes preserve ordered history', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            // Publish v1
            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'v1' },
                repo, AUDIT_CONFIG,
            );

            // Prepare and publish v2
            let state = repo.store.get('e1')!;
            repo.store.set('e1', { ...state, phase: 'DRAFT', draft: { content: 'v2' } });
            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-2', changeSummary: 'v2' },
                repo, AUDIT_CONFIG,
            );

            // Prepare and publish v3
            state = repo.store.get('e1')!;
            repo.store.set('e1', { ...state, phase: 'DRAFT', draft: { content: 'v3' } });
            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'v3' },
                repo, AUDIT_CONFIG,
            );

            const finalState = repo.store.get('e1')!;
            expect(finalState.currentVersion).toBe(4);
            expect(finalState.published).toEqual({ content: 'v3' });
            expect(finalState.history).toHaveLength(2);
            expect(finalState.history[0].version).toBe(2);
            expect(finalState.history[0].payload).toEqual({ content: 'v1' });
            expect(finalState.history[1].version).toBe(3);
            expect(finalState.history[1].payload).toEqual({ content: 'v2' });
        });

        it('emits PUBLISHED audit event', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'Initial release' },
                repo, AUDIT_CONFIG,
            );

            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'POLICY_PUBLISHED',
                    entityType: 'Policy',
                    entityId: 'e1',
                }),
            );
        });

        it('emits VERSION_CREATED audit event when history snapshot is created', async () => {
            repo.store.set('e1', {
                phase: 'DRAFT',
                currentVersion: 2,
                draft: { content: 'v2' },
                published: { content: 'v1' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [],
            });

            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1' },
                repo, AUDIT_CONFIG,
            );

            // Should emit two events: PUBLISHED + VERSION_CREATED
            expect(mockLogEvent).toHaveBeenCalledTimes(2);
            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'POLICY_VERSION_CREATED',
                }),
            );
        });

        it('does NOT emit VERSION_CREATED on first publish', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1' },
                repo, AUDIT_CONFIG,
            );

            // Only PUBLISHED event, no VERSION_CREATED
            expect(mockLogEvent).toHaveBeenCalledTimes(1);
            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'POLICY_PUBLISHED',
                }),
            );
        });

        it('PUBLISHED audit event includes version metadata', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'First draft' },
                repo, AUDIT_CONFIG,
            );

            const auditPayload = mockLogEvent.mock.calls[0][2];
            expect(auditPayload.metadata.version).toBe(2);
            expect(auditPayload.metadata.previousVersion).toBe(1);
            expect(auditPayload.metadata.changeSummary).toBe('First draft');
            expect(auditPayload.detailsJson.category).toBe('status_change');
        });

        it('rejects publish with no draft', async () => {
            repo.store.set('e1', {
                phase: 'PUBLISHED',
                currentVersion: 2,
                draft: null,
                published: { content: 'live' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [],
            });

            await expect(
                publishWithAudit(
                    MOCK_DB, TEST_CTX, 'e1',
                    { publishedBy: 'user-1' },
                    repo, AUDIT_CONFIG,
                ),
            ).rejects.toThrow(LifecycleError);
            expect(mockLogEvent).not.toHaveBeenCalled();
        });

        it('rejects publish of archived entity', async () => {
            repo.store.set('e1', {
                phase: 'ARCHIVED',
                currentVersion: 2,
                draft: null,
                published: { content: 'frozen' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [{ version: 1, payload: { content: 'v1' }, publishedAt: '2026-01-01', publishedBy: 'user-1' }],
            });

            await expect(
                publishWithAudit(
                    MOCK_DB, TEST_CTX, 'e1',
                    { publishedBy: 'user-1' },
                    repo, AUDIT_CONFIG,
                ),
            ).rejects.toThrow(LifecycleError);
        });

        it('rejects publish for non-existent entity', async () => {
            await expect(
                publishWithAudit(
                    MOCK_DB, TEST_CTX, 'nonexistent',
                    { publishedBy: 'user-1' },
                    repo, AUDIT_CONFIG,
                ),
            ).rejects.toThrow(LifecycleError);
        });

        it('persists state to repository', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1' }));

            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1' },
                repo, AUDIT_CONFIG,
            );

            const saved = repo.store.get('e1')!;
            expect(saved.phase).toBe('PUBLISHED');
            expect(saved.currentVersion).toBe(2);
            expect(saved.published).toEqual({ content: 'v1' });
        });
    });

    // ─── publishWithAudit + Validation ───────────────────────────
    describe('publish validation', () => {
        it('runs pre-publish validator before publishing', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: '' }));

            const validator: PublishValidator<TestPayload> = (draft) => {
                if (!draft.content) {
                    throw new Error('Content is required before publishing');
                }
            };

            await expect(
                publishWithAudit(
                    MOCK_DB, TEST_CTX, 'e1',
                    { publishedBy: 'user-1' },
                    repo, AUDIT_CONFIG,
                    validator,
                ),
            ).rejects.toThrow('Content is required before publishing');

            // State should NOT be changed
            const state = repo.store.get('e1')!;
            expect(state.phase).toBe('DRAFT');
            expect(state.currentVersion).toBe(1);
        });

        it('publishes successfully when validation passes', async () => {
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'valid content' }));

            const validator: PublishValidator<TestPayload> = (draft) => {
                if (!draft.content) throw new Error('Content required');
            };

            const result = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1' },
                repo, AUDIT_CONFIG,
                validator,
            );

            expect(result.phase).toBe('PUBLISHED');
            expect(result.currentVersion).toBe(2);
        });
    });

    // ─── revertWithAudit ─────────────────────────────────────────
    describe('revertWithAudit', () => {
        it('loads historical version into draft', async () => {
            repo.store.set('e1', {
                phase: 'PUBLISHED',
                currentVersion: 3,
                draft: null,
                published: { content: 'v2-live' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [{
                    version: 2,
                    payload: { content: 'v1-original' },
                    publishedAt: '2026-01-01T00:00:00Z',
                    publishedBy: 'user-1',
                }],
            });

            const result = await revertWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { targetVersion: 2 },
                repo, AUDIT_CONFIG,
            );

            expect(result.draft).toEqual({ content: 'v1-original' });
            expect(result.published).toEqual({ content: 'v2-live' }); // untouched
            expect(result.phase).toBe('DRAFT');
        });

        it('emits REVERTED audit event', async () => {
            repo.store.set('e1', {
                phase: 'PUBLISHED',
                currentVersion: 3,
                draft: null,
                published: { content: 'v2' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [{
                    version: 2,
                    payload: { content: 'v1' },
                    publishedAt: '2026-01-01',
                    publishedBy: 'user-1',
                }],
            });

            await revertWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { targetVersion: 2 },
                repo, AUDIT_CONFIG,
            );

            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'POLICY_REVERTED',
                    entityType: 'Policy',
                }),
            );
        });

        it('rejects revert to non-existent version', async () => {
            repo.store.set('e1', {
                phase: 'PUBLISHED',
                currentVersion: 2,
                draft: null,
                published: { content: 'v1' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [],
            });

            await expect(
                revertWithAudit(
                    MOCK_DB, TEST_CTX, 'e1',
                    { targetVersion: 99 },
                    repo, AUDIT_CONFIG,
                ),
            ).rejects.toThrow(LifecycleError);
        });
    });

    // ─── archiveWithAudit ────────────────────────────────────────
    describe('archiveWithAudit', () => {
        it('archives entity and emits audit event', async () => {
            repo.store.set('e1', {
                phase: 'PUBLISHED',
                currentVersion: 3,
                draft: null,
                published: { content: 'v2' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [{
                    version: 2,
                    payload: { content: 'v1' },
                    publishedAt: '2026-01-01',
                    publishedBy: 'user-1',
                }],
            });

            const result = await archiveWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                repo, AUDIT_CONFIG,
            );

            expect(result.phase).toBe('ARCHIVED');
            expect(result.published).toEqual({ content: 'v2' }); // preserved
            expect(result.history).toHaveLength(1); // preserved
            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'POLICY_ARCHIVED',
                }),
            );
        });

        it('rejects archive of already archived entity', async () => {
            repo.store.set('e1', {
                phase: 'ARCHIVED',
                currentVersion: 2,
                draft: null,
                published: { content: 'frozen' },
                publishedBy: 'user-1',
                publishedChangeSummary: null,
                history: [],
            });

            await expect(
                archiveWithAudit(
                    MOCK_DB, TEST_CTX, 'e1',
                    repo, AUDIT_CONFIG,
                ),
            ).rejects.toThrow(LifecycleError);
        });
    });

    // ─── Custom Action Prefix ────────────────────────────────────
    describe('custom audit configuration', () => {
        it('uses custom action prefix', async () => {
            const practiceConfig: LifecycleAuditConfig = {
                entityType: 'Practice',
                actionPrefix: 'CTRL',
            };

            repo.store.set('c1', createEditableState<TestPayload>({ content: 'practice draft' }));

            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'c1',
                { publishedBy: 'user-1' },
                repo, practiceConfig,
            );

            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'CTRL_PUBLISHED',
                    entityType: 'Practice',
                }),
            );
        });

        it('defaults action prefix to uppercased entity type', async () => {
            const riskConfig: LifecycleAuditConfig = {
                entityType: 'Risk',
                // no actionPrefix
            };

            repo.store.set('r1', createEditableState<TestPayload>({ content: 'risk draft' }));

            await publishWithAudit(
                MOCK_DB, TEST_CTX, 'r1',
                { publishedBy: 'user-1' },
                repo, riskConfig,
            );

            expect(mockLogEvent).toHaveBeenCalledWith(
                MOCK_DB, TEST_CTX,
                expect.objectContaining({
                    action: 'RISK_PUBLISHED',
                }),
            );
        });
    });

    // ─── Full End-to-End Publish Lifecycle ────────────────────────
    describe('full publish lifecycle (integration)', () => {
        it('draft → publish → edit → publish → revert → publish → archive', async () => {
            // 1. Create entity with draft
            repo.store.set('e1', createEditableState<TestPayload>({ content: 'v1 draft' }));

            // 2. Update draft
            await updateDraftWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { content: 'v1 final' },
                repo, AUDIT_CONFIG,
            );

            // 3. First publish (v1→v2)
            let state = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'First release' },
                repo, AUDIT_CONFIG,
            );
            expect(state.currentVersion).toBe(2);
            expect(state.published).toEqual({ content: 'v1 final' });
            expect(state.history).toHaveLength(0); // no prior state

            // 4. Edit draft for v2
            await updateDraftWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { content: 'v2 improvements' },
                repo, AUDIT_CONFIG,
            );

            // 5. Second publish (v2→v3) — snapshots v2 to history
            state = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-2', changeSummary: 'Major update' },
                repo, AUDIT_CONFIG,
            );
            expect(state.currentVersion).toBe(3);
            expect(state.published).toEqual({ content: 'v2 improvements' });
            expect(state.history).toHaveLength(1);
            expect(state.history[0].version).toBe(2);
            expect(state.history[0].payload).toEqual({ content: 'v1 final' });

            // 6. Revert to v2 (loads into draft, does NOT change live)
            state = await revertWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { targetVersion: 2 },
                repo, AUDIT_CONFIG,
            );
            expect(state.draft).toEqual({ content: 'v1 final' });
            expect(state.published).toEqual({ content: 'v2 improvements' }); // still live

            // 7. Re-publish reverted content (v3→v4)
            state = await publishWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                { publishedBy: 'user-1', changeSummary: 'Reverted to v2' },
                repo, AUDIT_CONFIG,
            );
            expect(state.currentVersion).toBe(4);
            expect(state.published).toEqual({ content: 'v1 final' });
            expect(state.history).toHaveLength(2);
            expect(state.history[1].version).toBe(3);
            expect(state.history[1].payload).toEqual({ content: 'v2 improvements' });

            // 8. Archive
            state = await archiveWithAudit(
                MOCK_DB, TEST_CTX, 'e1',
                repo, AUDIT_CONFIG,
            );
            expect(state.phase).toBe('ARCHIVED');
            expect(state.currentVersion).toBe(4);
            expect(state.history).toHaveLength(2);

            // 9. Verify all operations are now blocked
            await expect(
                updateDraftWithAudit(MOCK_DB, TEST_CTX, 'e1', { content: 'nope' }, repo, AUDIT_CONFIG),
            ).rejects.toThrow(LifecycleError);

            await expect(
                publishWithAudit(MOCK_DB, TEST_CTX, 'e1', { publishedBy: 'user-1' }, repo, AUDIT_CONFIG),
            ).rejects.toThrow(LifecycleError);

            // 10. Verify audit trail completeness
            // Expected events: DRAFT_UPDATED, PUBLISHED, DRAFT_UPDATED, PUBLISHED + VERSION_CREATED,
            //                  REVERTED, PUBLISHED + VERSION_CREATED, ARCHIVED
            // Total: 9 events
            const publishEvents = mockLogEvent.mock.calls.filter(
                (c: any) => c[2].action === 'POLICY_PUBLISHED'
            );
            const versionEvents = mockLogEvent.mock.calls.filter(
                (c: any) => c[2].action === 'POLICY_VERSION_CREATED'
            );
            expect(publishEvents).toHaveLength(3); // v1, v2, v3
            expect(versionEvents).toHaveLength(2); // v1→v2, v2→v3
        });
    });
});
