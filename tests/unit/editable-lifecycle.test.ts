/**
 * Editable Lifecycle Tests
 *
 * Comprehensive validation of the draft/publish lifecycle state machine.
 *
 * Test strategy:
 * - Pure function tests — no mocks, no DB (lifecycle is side-effect-free)
 * - Uses a simple string payload for clarity; production payloads
 *   would be domain-specific objects (policy content, practice description, etc.)
 * - Validates all invariants: version increments, history append-only,
 *   phase transitions, error conditions
 * - Validates draft/published isolation end-to-end
 */

import type {
    EditableState,
    PublishCommand,
} from '@/app-layer/domain/editable-lifecycle.types';
import { LifecycleError } from '@/app-layer/domain/editable-lifecycle.types';

import {
    createEditableState,
    updateDraft,
    publish,
    revertToVersion,
    archive,
    hasPendingChanges,
    hasBeenPublished,
    getHistoryEntry,
    getRecentHistory,
    getEffectivePayload,
} from '@/app-layer/services/editable-lifecycle';

// ─── Test Payload Types ──────────────────────────────────────────────

/** Simple payload for testing. Production payloads would be richer. */
interface TestPayload {
    content: string;
    metadata?: string;
}

const DRAFT_V1: TestPayload = { content: 'Draft version 1' };
const DRAFT_V2: TestPayload = { content: 'Draft version 2', metadata: 'updated' };
const DRAFT_V3: TestPayload = { content: 'Draft version 3', metadata: 'final' };

const PUBLISH_CMD: PublishCommand = {
    publishedBy: 'user-1',
    changeSummary: 'Initial publish',
};

const PUBLISH_CMD_V2: PublishCommand = {
    publishedBy: 'user-2',
    changeSummary: 'Updated content',
};

const PUBLISH_CMD_V3: PublishCommand = {
    publishedBy: 'user-1',
    changeSummary: 'Third version',
};

// ═════════════════════════════════════════════════════════════════════
// Test Suites
// ═════════════════════════════════════════════════════════════════════

describe('Editable Lifecycle', () => {
    // ─── createEditableState ─────────────────────────────────────
    describe('createEditableState', () => {
        it('creates initial state in DRAFT phase', () => {
            const state = createEditableState(DRAFT_V1);

            expect(state.phase).toBe('DRAFT');
        });

        it('sets version to 1 (initial content, never published)', () => {
            const state = createEditableState(DRAFT_V1);

            expect(state.currentVersion).toBe(1);
        });

        it('sets draft to the provided payload', () => {
            const state = createEditableState(DRAFT_V1);

            expect(state.draft).toEqual(DRAFT_V1);
        });

        it('sets published to null', () => {
            const state = createEditableState(DRAFT_V1);

            expect(state.published).toBeNull();
        });

        it('starts with empty history', () => {
            const state = createEditableState(DRAFT_V1);

            expect(state.history).toEqual([]);
        });

        it('works with complex payload shapes', () => {
            const complexPayload = {
                content: 'test',
                metadata: 'meta',
            };
            const state = createEditableState(complexPayload);

            expect(state.draft).toEqual(complexPayload);
        });
    });

    // ─── updateDraft ─────────────────────────────────────────────
    describe('updateDraft', () => {
        it('updates draft payload', () => {
            const state = createEditableState(DRAFT_V1);
            const updated = updateDraft(state, DRAFT_V2);

            expect(updated.draft).toEqual(DRAFT_V2);
        });

        it('preserves version number', () => {
            const state = createEditableState(DRAFT_V1);
            const updated = updateDraft(state, DRAFT_V2);

            expect(updated.currentVersion).toBe(1);
        });

        it('keeps phase as DRAFT when already DRAFT', () => {
            const state = createEditableState(DRAFT_V1);
            const updated = updateDraft(state, DRAFT_V2);

            expect(updated.phase).toBe('DRAFT');
        });

        it('transitions PUBLISHED → DRAFT when draft is updated', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            expect(state.phase).toBe('PUBLISHED');

            const updated = updateDraft(state, DRAFT_V2);
            expect(updated.phase).toBe('DRAFT');
        });

        it('preserves published payload when updating draft', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            const updated = updateDraft(state, DRAFT_V2);

            expect(updated.published).toEqual(DRAFT_V1);
            expect(updated.draft).toEqual(DRAFT_V2);
        });

        it('preserves history when updating draft', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);
            state = updateDraft(state, DRAFT_V3);

            expect(state.history).toHaveLength(1); // v1 snapshot
            expect(state.draft).toEqual(DRAFT_V3);
        });

        it('throws when entity is ARCHIVED', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = archive(state);

            expect(() => updateDraft(state, DRAFT_V2))
                .toThrow(LifecycleError);
        });

        it('throws with ALREADY_ARCHIVED error code', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = archive(state);

            try {
                updateDraft(state, DRAFT_V2);
                fail('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(LifecycleError);
                expect((err as LifecycleError).code).toBe('ALREADY_ARCHIVED');
            }
        });
    });

    // ─── publish ─────────────────────────────────────────────────
    describe('publish', () => {
        it('promotes draft to published', () => {
            const state = createEditableState(DRAFT_V1);
            const published = publish(state, PUBLISH_CMD);

            expect(published.published).toEqual(DRAFT_V1);
        });

        it('clears draft after publish', () => {
            const state = createEditableState(DRAFT_V1);
            const published = publish(state, PUBLISH_CMD);

            expect(published.draft).toBeNull();
        });

        it('sets phase to PUBLISHED', () => {
            const state = createEditableState(DRAFT_V1);
            const published = publish(state, PUBLISH_CMD);

            expect(published.phase).toBe('PUBLISHED');
        });

        it('bumps version from 1 to 2 on first publish', () => {
            const state = createEditableState(DRAFT_V1);
            const published = publish(state, PUBLISH_CMD);

            expect(published.currentVersion).toBe(2);
        });

        it('does NOT create history entry on first publish (no prior state)', () => {
            const state = createEditableState(DRAFT_V1);
            const published = publish(state, PUBLISH_CMD);

            expect(published.history).toHaveLength(0);
        });

        it('snapshots prior version to history on second publish', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD); // v1→v2
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2); // v2→v3

            expect(state.history).toHaveLength(1);
            expect(state.history[0].version).toBe(2);
            expect(state.history[0].payload).toEqual(DRAFT_V1);
        });

        it('snapshots version 2 to history on third publish', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);       // v1
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);    // v2
            state = updateDraft(state, DRAFT_V3);
            state = publish(state, PUBLISH_CMD_V3);    // v3

            expect(state.currentVersion).toBe(4);
            expect(state.history).toHaveLength(2);
            expect(state.history[0].version).toBe(2);
            expect(state.history[0].payload).toEqual(DRAFT_V1);
            expect(state.history[1].version).toBe(3);
            expect(state.history[1].payload).toEqual(DRAFT_V2);
            expect(state.published).toEqual(DRAFT_V3);
        });

        it('captures publishedBy in history snapshot (original publisher, not replacer)', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);       // v2 published by user-1
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);    // v3 published by user-2

            // History[0] records who originally published v2, NOT who replaced it
            expect(state.history[0].publishedBy).toBe('user-1');
        });

        it('captures changeSummary in history snapshot (original summary, not replacer)', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);       // v2: "Initial publish"
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);    // v3: "Updated content"

            // History[0] records the summary from when v2 was published, not v3's summary
            expect(state.history[0].changeSummary).toBe('Initial publish');
        });

        it('throws when no draft exists', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD); // draft is now null

            expect(() => publish(state, PUBLISH_CMD_V2))
                .toThrow(LifecycleError);
        });

        it('throws with NO_DRAFT error code', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);

            try {
                publish(state, PUBLISH_CMD_V2);
                fail('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(LifecycleError);
                expect((err as LifecycleError).code).toBe('NO_DRAFT');
            }
        });

        it('throws when entity is ARCHIVED', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = archive(state);

            expect(() => publish(state, PUBLISH_CMD_V2))
                .toThrow(LifecycleError);
        });
    });

    // ─── revertToVersion ─────────────────────────────────────────
    describe('revertToVersion', () => {
        it('loads historical payload into draft', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);       // v1→v2
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);    // v2→v3, v2 in history

            const reverted = revertToVersion(state, { targetVersion: 2 });

            expect(reverted.draft).toEqual(DRAFT_V1);
        });

        it('does NOT change published state', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);

            const reverted = revertToVersion(state, { targetVersion: 2 });

            expect(reverted.published).toEqual(DRAFT_V2); // v2 still live
        });

        it('sets phase to DRAFT after revert', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);

            const reverted = revertToVersion(state, { targetVersion: 2 });

            expect(reverted.phase).toBe('DRAFT');
        });

        it('does NOT modify history', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);

            const historyBefore = state.history.length;
            const reverted = revertToVersion(state, { targetVersion: 2 });

            expect(reverted.history).toHaveLength(historyBefore);
        });

        it('preserves version number on revert', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);

            const reverted = revertToVersion(state, { targetVersion: 2 });

            expect(reverted.currentVersion).toBe(3); // still v3
        });

        it('throws for non-existent version', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);

            expect(() => revertToVersion(state, { targetVersion: 99 }))
                .toThrow(LifecycleError);
        });

        it('throws with VERSION_NOT_FOUND error code', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);

            try {
                revertToVersion(state, { targetVersion: 99 });
                fail('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(LifecycleError);
                expect((err as LifecycleError).code).toBe('VERSION_NOT_FOUND');
            }
        });

        it('throws when entity is ARCHIVED', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);
            state = archive(state);

            expect(() => revertToVersion(state, { targetVersion: 2 }))
                .toThrow(LifecycleError);
        });
    });

    // ─── archive ─────────────────────────────────────────────────
    describe('archive', () => {
        it('sets phase to ARCHIVED', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = archive(state);

            expect(state.phase).toBe('ARCHIVED');
        });

        it('preserves published payload', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = archive(state);

            expect(state.published).toEqual(DRAFT_V1);
        });

        it('preserves history', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);
            state = archive(state);

            expect(state.history).toHaveLength(1);
            expect(state.history[0].version).toBe(2);
        });

        it('preserves version number', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = archive(state);

            expect(state.currentVersion).toBe(2);
        });

        it('can archive from DRAFT phase', () => {
            const state = createEditableState(DRAFT_V1);
            const archived = archive(state);

            expect(archived.phase).toBe('ARCHIVED');
            expect(archived.draft).toEqual(DRAFT_V1);
        });

        it('throws when already ARCHIVED', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = archive(state);

            expect(() => archive(state))
                .toThrow(LifecycleError);
        });

        it('throws with ALREADY_ARCHIVED error code', () => {
            let state = createEditableState(DRAFT_V1);
            state = archive(state);

            try {
                archive(state);
                fail('Should have thrown');
            } catch (err) {
                expect(err).toBeInstanceOf(LifecycleError);
                expect((err as LifecycleError).code).toBe('ALREADY_ARCHIVED');
            }
        });
    });

    // ─── Draft/Live Separation ───────────────────────────────────
    describe('draft/live separation', () => {
        it('draft edits do not affect published payload', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);

            const publishedBefore = state.published;
            state = updateDraft(state, DRAFT_V2);

            expect(state.published).toEqual(publishedBefore);
            expect(state.draft).toEqual(DRAFT_V2);
            expect(state.published).not.toEqual(state.draft);
        });

        it('multiple draft edits between publishes only affect draft', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);

            state = updateDraft(state, { content: 'edit 1' });
            state = updateDraft(state, { content: 'edit 2' });
            state = updateDraft(state, { content: 'edit 3' });

            expect(state.published).toEqual(DRAFT_V1);
            expect(state.draft).toEqual({ content: 'edit 3' });
        });

        it('publishing replaces published but does not affect history', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);       // v1
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);    // v2

            const historySnapshot = state.history[0];
            state = updateDraft(state, DRAFT_V3);
            state = publish(state, PUBLISH_CMD_V3);    // v3

            // History entries should be unchanged
            expect(state.history[0]).toEqual(historySnapshot);
            expect(state.published).toEqual(DRAFT_V3);
        });
    });

    // ─── Version Correctness ─────────────────────────────────────
    describe('version correctness', () => {
        it('version increments only on publish', () => {
            let state = createEditableState(DRAFT_V1);
            expect(state.currentVersion).toBe(1);

            state = updateDraft(state, DRAFT_V2);
            expect(state.currentVersion).toBe(1); // draft edit, no increment

            state = publish(state, PUBLISH_CMD);
            expect(state.currentVersion).toBe(2); // publish, increment

            state = updateDraft(state, DRAFT_V3);
            expect(state.currentVersion).toBe(2); // draft edit, no increment

            state = publish(state, PUBLISH_CMD_V2);
            expect(state.currentVersion).toBe(3); // publish, increment
        });

        it('version never decrements', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);

            // Revert to v2 — version stays at 3
            state = revertToVersion(state, { targetVersion: 2 });
            expect(state.currentVersion).toBe(3);

            // Re-publish the reverted content — version goes to 4
            state = publish(state, PUBLISH_CMD_V3);
            expect(state.currentVersion).toBe(4);
        });

        it('history entries have correct version numbers', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);       // v1
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);    // v2
            state = updateDraft(state, DRAFT_V3);
            state = publish(state, PUBLISH_CMD_V3);    // v3

            expect(state.history).toHaveLength(2);
            expect(state.history[0].version).toBe(2);
            expect(state.history[1].version).toBe(3);
        });

        it('revert + re-publish creates correct history chain', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);       // v1
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);    // v2

            // Revert to v2 and re-publish
            state = revertToVersion(state, { targetVersion: 2 });
            state = publish(state, PUBLISH_CMD_V3);    // v3

            expect(state.currentVersion).toBe(4);
            expect(state.history).toHaveLength(2);
            expect(state.history[0].version).toBe(2); // original v2 snapshot
            expect(state.history[1].version).toBe(3); // v3 snapshot before revert-publish
            expect(state.published).toEqual(DRAFT_V1); // reverted content is now live
        });
    });

    // ─── Query Helpers ───────────────────────────────────────────
    describe('query helpers', () => {
        it('hasPendingChanges returns true when draft exists', () => {
            const state = createEditableState(DRAFT_V1);
            expect(hasPendingChanges(state)).toBe(true);
        });

        it('hasPendingChanges returns false after publish', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            expect(hasPendingChanges(state)).toBe(false);
        });

        it('hasPendingChanges returns true after draft update post-publish', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            expect(hasPendingChanges(state)).toBe(true);
        });

        it('hasBeenPublished returns false for new entity', () => {
            const state = createEditableState(DRAFT_V1);
            expect(hasBeenPublished(state)).toBe(false);
        });

        it('hasBeenPublished returns true after first publish', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            expect(hasBeenPublished(state)).toBe(true);
        });

        it('getHistoryEntry returns correct snapshot', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);

            const entry = getHistoryEntry(state, 2);
            expect(entry).toBeDefined();
            expect(entry!.payload).toEqual(DRAFT_V1);
        });

        it('getHistoryEntry returns undefined for unknown version', () => {
            const state = createEditableState(DRAFT_V1);
            expect(getHistoryEntry(state, 99)).toBeUndefined();
        });

        it('getRecentHistory returns most-recent-first', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);
            state = publish(state, PUBLISH_CMD_V2);
            state = updateDraft(state, DRAFT_V3);
            state = publish(state, PUBLISH_CMD_V3);

            const recent = getRecentHistory(state, 2);
            expect(recent).toHaveLength(2);
            expect(recent[0].version).toBe(3); // most recent
            expect(recent[1].version).toBe(2);
        });

        it('getEffectivePayload returns draft when it exists', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);
            state = updateDraft(state, DRAFT_V2);

            expect(getEffectivePayload(state)).toEqual(DRAFT_V2);
        });

        it('getEffectivePayload returns published when no draft', () => {
            let state = createEditableState(DRAFT_V1);
            state = publish(state, PUBLISH_CMD);

            expect(getEffectivePayload(state)).toEqual(DRAFT_V1);
        });

        it('getEffectivePayload returns null for empty state', () => {
            const state: EditableState<TestPayload> = {
                phase: 'DRAFT',
                currentVersion: 1,
                draft: null,
                published: null,
                publishedBy: null,
                publishedChangeSummary: null,
                history: [],
            };

            expect(getEffectivePayload(state)).toBeNull();
        });
    });

    // ─── Full Lifecycle Integration ──────────────────────────────
    describe('full lifecycle integration', () => {
        it('complete lifecycle: create → edit → publish → edit → publish → revert → publish → archive', () => {
            // 1. Create
            let state = createEditableState<TestPayload>({ content: 'v1 draft' });
            expect(state.phase).toBe('DRAFT');
            expect(state.currentVersion).toBe(1);

            // 2. Edit draft
            state = updateDraft(state, { content: 'v1 final' });
            expect(state.currentVersion).toBe(1);

            // 3. First publish (v1→v2)
            state = publish(state, { publishedBy: 'admin', changeSummary: 'First release' });
            expect(state.phase).toBe('PUBLISHED');
            expect(state.currentVersion).toBe(2);
            expect(state.published).toEqual({ content: 'v1 final' });
            expect(state.draft).toBeNull();
            expect(state.history).toHaveLength(0); // no prior state

            // 4. Edit again
            state = updateDraft(state, { content: 'v2 draft' });
            expect(state.phase).toBe('DRAFT');
            expect(state.published).toEqual({ content: 'v1 final' }); // unchanged

            // 5. Second publish (v2→v3)
            state = publish(state, { publishedBy: 'admin', changeSummary: 'Improvements' });
            expect(state.currentVersion).toBe(3);
            expect(state.published).toEqual({ content: 'v2 draft' });
            expect(state.history).toHaveLength(1);
            expect(state.history[0].version).toBe(2);
            expect(state.history[0].payload).toEqual({ content: 'v1 final' });

            // 6. Revert to v2
            state = revertToVersion(state, { targetVersion: 2 });
            expect(state.phase).toBe('DRAFT');
            expect(state.draft).toEqual({ content: 'v1 final' });
            expect(state.published).toEqual({ content: 'v2 draft' }); // still live

            // 7. Re-publish reverted content (v3→v4)
            state = publish(state, { publishedBy: 'admin', changeSummary: 'Reverted to v2' });
            expect(state.currentVersion).toBe(4);
            expect(state.published).toEqual({ content: 'v1 final' });
            expect(state.history).toHaveLength(2);

            // 8. Archive
            state = archive(state);
            expect(state.phase).toBe('ARCHIVED');
            expect(state.currentVersion).toBe(4);
            expect(state.history).toHaveLength(2);

            // 9. Verify all operations are blocked
            expect(() => updateDraft(state, { content: 'nope' })).toThrow(LifecycleError);
            expect(() => publish(state, { publishedBy: 'admin' })).toThrow(LifecycleError);
            expect(() => revertToVersion(state, { targetVersion: 1 })).toThrow(LifecycleError);
            expect(() => archive(state)).toThrow(LifecycleError);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════
// CQ-3: Publisher Attribution in History Snapshots
// ═════════════════════════════════════════════════════════════════════

describe('CQ-3: Publisher Attribution', () => {
    const PAYLOAD_A: TestPayload = { content: 'Version A' };
    const PAYLOAD_B: TestPayload = { content: 'Version B' };
    const PAYLOAD_C: TestPayload = { content: 'Version C' };

    it('stores publishedBy on state after publish', () => {
        let state = createEditableState(PAYLOAD_A);
        state = publish(state, { publishedBy: 'alice', changeSummary: 'First' });

        expect(state.publishedBy).toBe('alice');
        expect(state.publishedChangeSummary).toBe('First');
    });

    it('publishedBy is null before first publish', () => {
        const state = createEditableState(PAYLOAD_A);
        expect(state.publishedBy).toBeNull();
        expect(state.publishedChangeSummary).toBeNull();
    });

    it('preserves publishedBy through draft updates', () => {
        let state = createEditableState(PAYLOAD_A);
        state = publish(state, { publishedBy: 'alice', changeSummary: 'First' });
        state = updateDraft(state, PAYLOAD_B);

        // After draft edit, attribution still reflects who published the current live version
        expect(state.publishedBy).toBe('alice');
        expect(state.publishedChangeSummary).toBe('First');
    });

    it('history snapshot records ORIGINAL publisher, not the new one', () => {
        let state = createEditableState(PAYLOAD_A);
        // v2: Alice publishes
        state = publish(state, { publishedBy: 'alice', changeSummary: 'Alice initial' });
        // v3: Bob publishes (snapshotting Alice's v2)
        state = updateDraft(state, PAYLOAD_B);
        state = publish(state, { publishedBy: 'bob', changeSummary: 'Bob update' });

        // History[0] should say Alice published v2, NOT Bob
        expect(state.history[0].publishedBy).toBe('alice');
        expect(state.history[0].changeSummary).toBe('Alice initial');
        // Current state should say Bob is the publisher of v3
        expect(state.publishedBy).toBe('bob');
        expect(state.publishedChangeSummary).toBe('Bob update');
    });

    it('multi-publisher chain has correct attribution across 3 versions', () => {
        let state = createEditableState(PAYLOAD_A);
        // v2: Alice publishes
        state = publish(state, { publishedBy: 'alice', changeSummary: 'Alice v2' });
        // v3: Bob publishes (snapshotting Alice's v2)
        state = updateDraft(state, PAYLOAD_B);
        state = publish(state, { publishedBy: 'bob', changeSummary: 'Bob v3' });
        // v4: Carol publishes (snapshotting Bob's v3)
        state = updateDraft(state, PAYLOAD_C);
        state = publish(state, { publishedBy: 'carol', changeSummary: 'Carol v4' });

        // History should have 2 entries
        expect(state.history).toHaveLength(2);
        // History[0]: v2 published by Alice
        expect(state.history[0].version).toBe(2);
        expect(state.history[0].publishedBy).toBe('alice');
        expect(state.history[0].changeSummary).toBe('Alice v2');
        // History[1]: v3 published by Bob
        expect(state.history[1].version).toBe(3);
        expect(state.history[1].publishedBy).toBe('bob');
        expect(state.history[1].changeSummary).toBe('Bob v3');
        // Current: v4 published by Carol
        expect(state.publishedBy).toBe('carol');
        expect(state.publishedChangeSummary).toBe('Carol v4');
    });

    it('preserves publishedBy through archive', () => {
        let state = createEditableState(PAYLOAD_A);
        state = publish(state, { publishedBy: 'alice', changeSummary: 'Published' });
        state = archive(state);

        expect(state.publishedBy).toBe('alice');
        expect(state.publishedChangeSummary).toBe('Published');
    });
});
