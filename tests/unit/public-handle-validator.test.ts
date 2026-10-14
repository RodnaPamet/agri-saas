/**
 * The handle rules — P6.6 (#1815).
 *
 * Every expected slug here was MEASURED against `toSlug` rather than reasoned
 * about, because the transliteration is the Streamlined System and not a
 * character map anyone should predict: `я` is two characters (`ya`), so a
 * one-character Cyrillic name is refused as too short rather than unusable.
 */
import {
    HANDLE_MAX_LENGTH,
    MAX_HANDLE_SUGGESTIONS,
    RESERVED_HANDLES,
    checkHandleShape,
    isReservedHandle,
    suggestHandles,
} from '@/lib/public-profile/handle';

describe('checkHandleShape — normalisation', () => {
    it('stores the normalised slug, not what was typed', () => {
        const verdict = checkHandleShape('Pobeda');
        expect(verdict).toEqual({ ok: true, handle: 'pobeda', normalised: true });
    });

    it('transliterates Cyrillic, because the owner types their own name', () => {
        expect(checkHandleShape('Победа')).toEqual({
            ok: true,
            handle: 'pobeda',
            normalised: true,
        });
    });

    it('reports normalised=false only when the stored handle is what they typed', () => {
        expect(checkHandleShape('pobeda')).toEqual({
            ok: true,
            handle: 'pobeda',
            normalised: false,
        });
    });

    it('trims, so surrounding whitespace is not a different reservation', () => {
        expect(checkHandleShape('  Победа  ')).toMatchObject({ ok: true, handle: 'pobeda' });
    });

    it('case-folds, which is the whole point: the @unique index is case-sensitive', () => {
        // Without normalisation `Pobeda` and `pobeda` are two rows that
        // collapse to one projection handle, and the second farm to publish
        // takes over the first one's page.
        const upper = checkHandleShape('POBEDA');
        const lower = checkHandleShape('pobeda');
        expect(upper).toMatchObject({ ok: true, handle: 'pobeda' });
        expect(lower).toMatchObject({ ok: true, handle: 'pobeda' });
    });
});

describe('checkHandleShape — refusals', () => {
    it.each([
        ['!!!', 'FARM_HANDLE_UNUSABLE'],
        ['   ', 'FARM_HANDLE_UNUSABLE'],
        ['ab', 'FARM_HANDLE_TOO_SHORT'],
        ['я', 'FARM_HANDLE_TOO_SHORT'],
        ['support', 'FARM_HANDLE_RESERVED'],
    ])('%j is refused with %s', (raw, code) => {
        expect(checkHandleShape(raw)).toEqual({ ok: false, code });
    });

    it('refuses an over-long name instead of silently truncating it', () => {
        // The trap this pins: passing `HANDLE_MAX_LENGTH` into `toSlug` would
        // CUT the name to 40 characters and return a valid-looking handle, so
        // the owner would discover their cut-off address after publishing.
        const long = 'a'.repeat(HANDLE_MAX_LENGTH + 1);
        expect(checkHandleShape(long)).toEqual({ ok: false, code: 'FARM_HANDLE_TOO_LONG' });

        const wayTooLong = 'a'.repeat(200);
        expect(checkHandleShape(wayTooLong)).toEqual({ ok: false, code: 'FARM_HANDLE_TOO_LONG' });
    });

    it('accepts a name exactly at the cap', () => {
        const atCap = 'a'.repeat(HANDLE_MAX_LENGTH);
        expect(checkHandleShape(atCap)).toMatchObject({ ok: true, handle: atCap });
    });
});

describe('reserved handles', () => {
    it('catches the Cyrillic spelling of a reserved word', () => {
        // Measured: `toSlug('АДМИН') === 'admin'`. The check runs on the
        // NORMALISED slug, so a reserved word cannot be taken by spelling it
        // in the other script — which is the only reason this works.
        expect(checkHandleShape('АДМИН')).toEqual({ ok: false, code: 'FARM_HANDLE_RESERVED' });
        expect(checkHandleShape('Админ')).toEqual({ ok: false, code: 'FARM_HANDLE_RESERVED' });
    });

    it('does NOT reserve top-level route names, which cannot collide', () => {
        // A handle is the SECOND segment: `/f/api` is not `/api`. An earlier
        // note on #1815 listed these as reserved; reserving them would refuse
        // real farms their own names for no routing reason.
        for (const name of ['api', 'login', 'org', 'dashboard', 'tenants', 'terms']) {
            expect(checkHandleShape(name)).toMatchObject({ ok: true });
        }
    });

    it('matches exactly, not as a substring', () => {
        // `support` is reserved; a farm legitimately called `supporten` or
        // `agro-support` is not impersonating anything.
        expect(isReservedHandle('support')).toBe(true);
        expect(isReservedHandle('supporten')).toBe(false);
        expect(isReservedHandle('agro-support')).toBe(false);
    });

    it('every reserved entry is itself a valid slug', () => {
        // An entry that `toSlug` would rewrite could never be produced by
        // `checkHandleShape`, so it would sit in the list guarding nothing.
        for (const entry of RESERVED_HANDLES) {
            expect(entry).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        }
        expect(RESERVED_HANDLES.length).toBeGreaterThan(0);
    });
});

describe('suggestHandles', () => {
    const context = { oblast: 'Добрич', displayName: 'ЗП Победа' };

    it('derives from the oblast the farm already declared', () => {
        // The ruling on #1815: `pobeda-dobrich` tells a farmer something,
        // `pobeda-2` tells them only that they were second.
        expect(suggestHandles('Победа', context)).toContain('pobeda-dobrich');
    });

    it('never offers back the handle that was asked for', () => {
        expect(suggestHandles('Победа', context)).not.toContain('pobeda');
    });

    it('skips handles already known to be taken', () => {
        const taken = new Set(['pobeda-dobrich']);
        expect(suggestHandles('Победа', context, taken)).not.toContain('pobeda-dobrich');
    });

    it('returns an empty array rather than inventing a counter', () => {
        // This is the documented consequence of "derived, not random": with
        // nothing to derive from there is nothing to offer, and the caller
        // must refuse plainly instead of falling back to `pobeda-2`.
        expect(suggestHandles('Победа', { oblast: null, displayName: null })).toEqual([]);
    });

    it('only offers handles that would themselves pass the rules', () => {
        const suggestions = suggestHandles('Победа', context);
        expect(suggestions.length).toBeGreaterThan(0);
        for (const suggestion of suggestions) {
            expect(checkHandleShape(suggestion)).toMatchObject({ ok: true, handle: suggestion });
        }
    });

    it('is capped and free of duplicates', () => {
        const suggestions = suggestHandles('Победа', context);
        expect(suggestions.length).toBeLessThanOrEqual(MAX_HANDLE_SUGGESTIONS);
        expect(new Set(suggestions).size).toBe(suggestions.length);
    });

    it('is deterministic — the same input gives the same offer twice', () => {
        expect(suggestHandles('Победа', context)).toEqual(suggestHandles('Победа', context));
    });
});
