/**
 * Epic 57 — pure unit tests for the shortcut parser and matcher.
 *
 * These exercise `parseShortcut` / `matchShortcut` in isolation so
 * shortcut-grammar regressions are caught without spinning up React.
 *
 * Runs under the NODE project. It used to live in `tests/rendered/`
 * (jsdom) solely so `new KeyboardEvent(...)` would resolve, and carried
 * a 90s per-test timeout because jsdom boot-up under full-suite memory
 * pressure pushed individual tests past 30s — a pure string-parsing
 * test taking 30s is a symptom, and the timeout was treating it.
 *
 * Nothing here needs a DOM. `matchShortcut` and `describePressedKey`
 * read exactly five plain properties off the event — metaKey, ctrlKey,
 * altKey, shiftKey, key — and never call a DOM method. The factory
 * below builds that shape directly, which is both faster and a more
 * honest statement of what the functions actually require. If either
 * ever starts calling a real DOM API, this stops compiling.
 */

import {
    __setIsMacForTests,
    describePressedKey,
    matchShortcut,
    parseShortcut,
} from '@/lib/hooks/keyboard-shortcut-internals';

/**
 * The exact slice of KeyboardEvent the shortcut layer reads. Building a
 * plain object keeps this suite in the node project — no jsdom, no
 * 90-second timeout, no flake under parallel load.
 */
type KeyEventShape = Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

function keyEvent(shape: Partial<KeyEventShape> & Pick<KeyEventShape, 'key'>): KeyboardEvent {
    return {
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...shape,
    } as KeyboardEvent;
}

afterEach(() => {
    __setIsMacForTests(null);
});

describe('parseShortcut', () => {
    it('parses a bare single-character key', () => {
        const p = parseShortcut('k');
        expect(p.key).toBe('k');
        expect(p.modifiers).toEqual({ meta: false, ctrl: false, alt: false, shift: false });
        expect(p.usesMod).toBe(false);
    });

    it('lowercases letter keys', () => {
        const p = parseShortcut('K');
        expect(p.key).toBe('k');
    });

    it('normalises named keys ("Escape" → "escape")', () => {
        const p = parseShortcut('Escape');
        expect(p.key).toBe('escape');
    });

    it('accepts modifier+key combos', () => {
        const p = parseShortcut('meta+k');
        expect(p.key).toBe('k');
        expect(p.modifiers.meta).toBe(true);
    });

    it('accepts multi-modifier combos in any order', () => {
        const p = parseShortcut('shift+alt+ctrl+/');
        expect(p.key).toBe('/');
        expect(p.modifiers).toEqual({ meta: false, ctrl: true, alt: true, shift: true });
    });

    it('treats `mod` as platform-aware (Mac: meta; non-Mac: ctrl)', () => {
        const p = parseShortcut('mod+k');
        expect(p.usesMod).toBe(true);
        expect(p.modifiers.meta).toBe(false);
        expect(p.modifiers.ctrl).toBe(false);
    });

    it('resolves aliases: cmd→meta, opt→alt, control→ctrl, return→enter', () => {
        expect(parseShortcut('cmd+k').modifiers.meta).toBe(true);
        expect(parseShortcut('opt+j').modifiers.alt).toBe(true);
        expect(parseShortcut('control+a').modifiers.ctrl).toBe(true);
        expect(parseShortcut('return').key).toBe('enter');
    });

    it('preserves `+` when it is the key literal', () => {
        const p = parseShortcut('mod++');
        expect(p.key).toBe('+');
        expect(p.usesMod).toBe(true);
    });

    it('rejects an unknown modifier with a helpful message', () => {
        expect(() => parseShortcut('hyper+k')).toThrow(/unknown modifier/i);
    });

    it('rejects empty input', () => {
        expect(() => parseShortcut('')).toThrow();
    });
});

describe('matchShortcut', () => {
    function evt(key: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}): KeyboardEvent {
        return keyEvent({
            key,
            metaKey: !!mods.meta,
            ctrlKey: !!mods.ctrl,
            altKey: !!mods.alt,
            shiftKey: !!mods.shift,
        });
    }

    it('matches a bare key with no modifiers', () => {
        expect(matchShortcut(evt('k'), parseShortcut('k'))).toBe(true);
    });

    it('rejects when an unexpected meta/ctrl is held', () => {
        // "k" alone must not fire while Cmd or Ctrl is pressed — we'd
        // hijack Cmd+K / Ctrl+K that the browser or OS may own.
        expect(matchShortcut(evt('k', { meta: true }), parseShortcut('k'))).toBe(false);
        expect(matchShortcut(evt('k', { ctrl: true }), parseShortcut('k'))).toBe(false);
    });

    it('rejects when a required modifier is missing', () => {
        expect(matchShortcut(evt('k'), parseShortcut('meta+k'))).toBe(false);
        expect(matchShortcut(evt('k', { meta: true }), parseShortcut('meta+k'))).toBe(true);
    });

    it('allows shift-symbol keys without the shift modifier being declared', () => {
        // "?" on a US layout is Shift+/. Author writes "?", user hits
        // Shift+/ → event.key="?" with shiftKey=true. Must still match.
        expect(matchShortcut(evt('?', { shift: true }), parseShortcut('?'))).toBe(true);
    });

    it('enforces shift when the author asked for it', () => {
        expect(matchShortcut(evt('k'), parseShortcut('shift+k'))).toBe(false);
        expect(matchShortcut(evt('K', { shift: true }), parseShortcut('shift+k'))).toBe(true);
    });

    it('compares letter keys case-insensitively', () => {
        expect(matchShortcut(evt('K'), parseShortcut('k'))).toBe(true);
        expect(matchShortcut(evt('k'), parseShortcut('K'))).toBe(true);
    });

    it('resolves `mod` to meta on Mac', () => {
        __setIsMacForTests(true);
        const p = parseShortcut('mod+k');
        expect(matchShortcut(evt('k', { meta: true }), p)).toBe(true);
        expect(matchShortcut(evt('k', { ctrl: true }), p)).toBe(false);
    });

    it('resolves `mod` to ctrl on non-Mac', () => {
        __setIsMacForTests(false);
        const p = parseShortcut('mod+k');
        expect(matchShortcut(evt('k', { ctrl: true }), p)).toBe(true);
        expect(matchShortcut(evt('k', { meta: true }), p)).toBe(false);
    });

    it('matches named keys', () => {
        expect(matchShortcut(evt('Escape'), parseShortcut('Escape'))).toBe(true);
        expect(matchShortcut(evt('Enter'), parseShortcut('Enter'))).toBe(true);
        expect(matchShortcut(evt('ArrowUp'), parseShortcut('ArrowUp'))).toBe(true);
    });
});

describe('describePressedKey', () => {
    it('serialises modifiers in canonical order', () => {
        const e = keyEvent({ key: 'K', metaKey: true, shiftKey: true });
        expect(describePressedKey(e)).toBe('meta+shift+k');
    });
});
