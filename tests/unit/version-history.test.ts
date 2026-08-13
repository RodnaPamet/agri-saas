/**
 * Tests for Version History — Tracking & Rule-of-Three Analysis.
 *
 * Covers:
 * - History entry creation and appending
 * - Version lookup by number
 * - Recent entries retrieval
 * - Stably-removed code analysis (rule-of-three)
 * - Stably-added code analysis
 * - Stably-changed code analysis
 * - Metadata JSON serialization/deserialization
 * - Edge cases (empty history, corrupt metadata)
 */
import {
    createHistoryEntry,
    appendHistoryEntry,
    emptyHistory,
    getRecentEntries,
    getEntryByVersion,
    getLatestEntry,
    getStablyRemovedCodes,
    getStablyAddedCodes,
    getStablyChangedCodes,
    parseHistoryFromMetadata,
    mergeHistoryIntoMetadata,
    type VersionHistoryEntry,
    type FrameworkVersionHistory,
} from '@/app-layer/libraries/version-history';

// ─── Test Fixtures ───────────────────────────────────────────────────

function makeEntry(overrides: Partial<VersionHistoryEntry> & { version: number }): VersionHistoryEntry {
    return {
        contentHash: `hash-v${overrides.version}`,
        importedAt: `2026-01-0${overrides.version}T00:00:00.000Z`,
        requirementCodes: overrides.requirementCodes ?? ['R1', 'R2', 'R3'],
        addedCodes: overrides.addedCodes ?? [],
        removedCodes: overrides.removedCodes ?? [],
        changedCodes: overrides.changedCodes ?? [],
        ...overrides,
    };
}

/** Build a multi-version history for testing rule-of-three. */
function buildHistory(entries: Array<Partial<VersionHistoryEntry> & { version: number }>): FrameworkVersionHistory {
    let h = emptyHistory();
    for (const entry of entries) {
        h = appendHistoryEntry(h, makeEntry(entry));
    }
    return h;
}

// ─── History Construction Tests ──────────────────────────────────────

describe('History Construction', () => {
    it('should create an empty history', () => {
        const h = emptyHistory();
        expect(h.entries).toEqual([]);
    });

    it('should create a history entry with sorted codes', () => {
        const entry = createHistoryEntry({
            version: 1,
            contentHash: 'abc',
            requirementCodes: ['R3', 'R1', 'R2'],
            addedCodes: ['R2', 'R1'],
            removedCodes: ['R5'],
            changedCodes: ['R3'],
        });
        expect(entry.requirementCodes).toEqual(['R1', 'R2', 'R3']);
        expect(entry.addedCodes).toEqual(['R1', 'R2']);
        expect(entry.removedCodes).toEqual(['R5']);
        expect(entry.changedCodes).toEqual(['R3']);
        expect(entry.importedAt).toBeDefined();
    });

    it('should append entries immutably', () => {
        const h1 = emptyHistory();
        const entry = makeEntry({ version: 1 });
        const h2 = appendHistoryEntry(h1, entry);

        expect(h1.entries).toHaveLength(0);
        expect(h2.entries).toHaveLength(1);
        expect(h2.entries[0]).toEqual(entry);
    });

    it('should maintain insertion order', () => {
        const h = buildHistory([
            { version: 1 },
            { version: 2 },
            { version: 3 },
        ]);
        expect(h.entries.map(e => e.version)).toEqual([1, 2, 3]);
    });
});

// ─── History Query Tests ─────────────────────────────────────────────

describe('History Queries', () => {
    const history = buildHistory([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
    ]);

    it('should get recent entries (most recent first)', () => {
        const recent = getRecentEntries(history, 2);
        expect(recent).toHaveLength(2);
        expect(recent[0].version).toBe(4);
        expect(recent[1].version).toBe(3);
    });

    it('should handle requesting more entries than available', () => {
        const recent = getRecentEntries(history, 10);
        expect(recent).toHaveLength(4);
    });

    it('should find entry by version', () => {
        const entry = getEntryByVersion(history, 2);
        expect(entry).toBeDefined();
        expect(entry!.version).toBe(2);
    });

    it('should return undefined for missing version', () => {
        expect(getEntryByVersion(history, 99)).toBeUndefined();
    });

    it('should get the latest entry', () => {
        expect(getLatestEntry(history)!.version).toBe(4);
    });

    it('should return undefined for latest on empty history', () => {
        expect(getLatestEntry(emptyHistory())).toBeUndefined();
    });
});

// ─── Rule-of-Three: Stably Removed Codes ────────────────────────────

describe('getStablyRemovedCodes', () => {
    it('should return empty set with insufficient history', () => {
        const h = buildHistory([{ version: 1 }, { version: 2 }]);
        expect(getStablyRemovedCodes(h, 3).size).toBe(0);
    });

    it('should detect code removed and absent for 3 versions', () => {
        const h = buildHistory([
            { version: 1, requirementCodes: ['R1', 'R2', 'R3'], removedCodes: [] },
            { version: 2, requirementCodes: ['R1', 'R2'],       removedCodes: ['R3'] },
            { version: 3, requirementCodes: ['R1', 'R2'],       removedCodes: [] },
            { version: 4, requirementCodes: ['R1', 'R2'],       removedCodes: [] },
        ]);
        const stable = getStablyRemovedCodes(h, 3);
        expect(stable.has('R3')).toBe(true);
    });

    it('should NOT detect code that reappeared', () => {
        const h = buildHistory([
            { version: 1, requirementCodes: ['R1', 'R2', 'R3'], removedCodes: [] },
            { version: 2, requirementCodes: ['R1', 'R2'],       removedCodes: ['R3'] },
            { version: 3, requirementCodes: ['R1', 'R2'],       removedCodes: [] },
            { version: 4, requirementCodes: ['R1', 'R2', 'R3'], removedCodes: [] }, // R3 reappeared!
        ]);
        const stable = getStablyRemovedCodes(h, 3);
        expect(stable.has('R3')).toBe(false);
    });

    it('should require exactly threshold versions of absence', () => {
        // Only 2 versions of absence, threshold is 3
        const h = buildHistory([
            { version: 1, requirementCodes: ['R1', 'R2', 'R3'], removedCodes: [] },
            { version: 2, requirementCodes: ['R1', 'R2', 'R3'], removedCodes: [] },
            { version: 3, requirementCodes: ['R1', 'R2'],       removedCodes: ['R3'] },
            { version: 4, requirementCodes: ['R1', 'R2'],       removedCodes: [] },
        ]);
        // Recent 3 entries (v2, v3, v4) — R3 present in v2!
        const stable = getStablyRemovedCodes(h, 3);
        expect(stable.has('R3')).toBe(false);
    });

    it('should handle multiple stably removed codes', () => {
        const h = buildHistory([
            { version: 1, requirementCodes: ['R1', 'R2', 'R3', 'R4'], removedCodes: [] },
            { version: 2, requirementCodes: ['R1'],                    removedCodes: ['R2', 'R3', 'R4'] },
            { version: 3, requirementCodes: ['R1'],                    removedCodes: [] },
            { version: 4, requirementCodes: ['R1'],                    removedCodes: [] },
        ]);
        const stable = getStablyRemovedCodes(h, 3);
        expect(stable.has('R2')).toBe(true);
        expect(stable.has('R3')).toBe(true);
        expect(stable.has('R4')).toBe(true);
    });
});

// ─── Rule-of-Three: Stably Added Codes ──────────────────────────────

describe('getStablyAddedCodes', () => {
    it('should return empty set with insufficient history', () => {
        const h = buildHistory([{ version: 1 }]);
        expect(getStablyAddedCodes(h, ['R1'], 3).size).toBe(0);
    });

    it('should detect code present in all recent versions', () => {
        const h = buildHistory([
            { version: 1, requirementCodes: ['R1'] },
            { version: 2, requirementCodes: ['R1', 'R2'] },
            { version: 3, requirementCodes: ['R1', 'R2'] },
            { version: 4, requirementCodes: ['R1', 'R2'] },
        ]);
        const stable = getStablyAddedCodes(h, ['R2'], 3);
        expect(stable.has('R2')).toBe(true);
    });

    it('should NOT detect intermittently present code', () => {
        const h = buildHistory([
            { version: 1, requirementCodes: ['R1'] },
            { version: 2, requirementCodes: ['R1', 'R2'] },
            { version: 3, requirementCodes: ['R1'] },       // R2 missing!
            { version: 4, requirementCodes: ['R1', 'R2'] },
        ]);
        const stable = getStablyAddedCodes(h, ['R2'], 3);
        expect(stable.has('R2')).toBe(false);
    });
});

// ─── Rule-of-Three: Stably Changed Codes ────────────────────────────

describe('getStablyChangedCodes', () => {
    it('should return empty set with insufficient history', () => {
        const h = buildHistory([{ version: 1 }]);
        expect(getStablyChangedCodes(h, ['R1'], 3).size).toBe(0);
    });

    it('should detect code changed and then stable for threshold versions', () => {
        const h = buildHistory([
            { version: 1, changedCodes: ['R1'] },
            { version: 2, changedCodes: [] },
            { version: 3, changedCodes: [] },
            { version: 4, changedCodes: [] },
        ]);
        const stable = getStablyChangedCodes(h, ['R1'], 3);
        expect(stable.has('R1')).toBe(true);
    });

    it('should NOT detect code that was changed again', () => {
        const h = buildHistory([
            { version: 1, changedCodes: ['R1'] },
            { version: 2, changedCodes: ['R1'] }, // Changed again!
            { version: 3, changedCodes: [] },
            { version: 4, changedCodes: [] },
        ]);
        // Last change at v2, only 2 entries after (v3, v4) which is < threshold of 3
        const stable = getStablyChangedCodes(h, ['R1'], 3);
        expect(stable.has('R1')).toBe(false);
    });
});

// ─── Metadata JSON Serialization ─────────────────────────────────────

describe('Metadata JSON serialization', () => {
    it('should parse history from valid metadata', () => {
        const history = buildHistory([{ version: 1 }, { version: 2 }]);
        const json = mergeHistoryIntoMetadata(null, history);
        const parsed = parseHistoryFromMetadata(json);
        expect(parsed.entries).toHaveLength(2);
        expect(parsed.entries[0].version).toBe(1);
    });

    it('should return empty history from null metadata', () => {
        expect(parseHistoryFromMetadata(null).entries).toEqual([]);
    });

    it('should return empty history from undefined metadata', () => {
        expect(parseHistoryFromMetadata(undefined).entries).toEqual([]);
    });

    it('should return empty history from corrupt JSON', () => {
        expect(parseHistoryFromMetadata('not-json').entries).toEqual([]);
    });

    it('should return empty history from JSON without versionHistory key', () => {
        expect(parseHistoryFromMetadata('{"foo": "bar"}').entries).toEqual([]);
    });

    it('should preserve existing metadata fields when merging', () => {
        const existing = JSON.stringify({
            locale: 'en',
            provider: 'ISO',
            importedAt: '2026-01-01',
        });
        const history = buildHistory([{ version: 1 }]);
        const merged = mergeHistoryIntoMetadata(existing, history);
        const parsed = JSON.parse(merged);

        expect(parsed.locale).toBe('en');
        expect(parsed.provider).toBe('ISO');
        expect(parsed.importedAt).toBe('2026-01-01');
        expect(parsed.versionHistory.entries).toHaveLength(1);
    });

    it('should overwrite stale versionHistory', () => {
        const existing = JSON.stringify({
            versionHistory: { entries: [{ version: 1 }] },
        });
        const newHistory = buildHistory([{ version: 1 }, { version: 2 }]);
        const merged = mergeHistoryIntoMetadata(existing, newHistory);
        const parsed = JSON.parse(merged);
        expect(parsed.versionHistory.entries).toHaveLength(2);
    });
});

// ─── Integration: Rule-of-Three with applyMigrationStrategy ─────────
//
// GRC teardown phase 2 deleted `@/app-layer/services/library-updater`
// (the framework-library import/diff service) along with the Framework
// model it updated, so the four `applyMigrationStrategy` wiring tests
// that lived here have no subject left to exercise. The pure
// rule-of-three analysis they were wired into — `getStablyRemovedCodes`
// / `getStablyAddedCodes` / `getStablyChangedCodes` — lives in
// `@/app-layer/libraries/version-history`, which survives, and is
// still covered directly by the describes above.
