/**
 * Setup for the jsdom Jest project.
 *
 *   - Registers `@testing-library/jest-dom` matchers (toBeInTheDocument,
 *     toHaveAccessibleName, toBeVisible, etc.) so the rendered tests
 *     read like a WCAG contract rather than a DOM dump.
 *   - Extends `expect` with `toHaveNoViolations` from jest-axe so every
 *     primitive can gate on axe-core WCAG 2.1 AA rules.
 *   - Cleans up the DOM between tests (React Testing Library's default).
 *   - Polyfills matchMedia + IntersectionObserver + ResizeObserver so
 *     the primitives that depend on them (useMediaQuery in Modal/Sheet,
 *     Vaul's scroll observer) don't throw in jsdom.
 *   - Sets the project-wide test timeout (see below).
 */

import '../setup/jsdom-shims';
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';

/**
 * Project-wide test timeout for the jsdom project.
 *
 * `jest.config.js` has always documented that the default is "set via
 * `jest.setTimeout()` in tests/rendered/setup.ts (project-level
 * testTimeout is ignored)" — but the call was never actually here, so
 * every jsdom test ran at Jest's 5s default. That is fine in isolation
 * and not fine under the sharded full-suite run, where an RTL render
 * competing with bcrypt and chart-renderer suites for CPU can cross 5s
 * on machine noise alone. The symptom was two suites that passed with
 * `--runInBand` and failed in the full run
 * (`use-toast-with-undo`, `keyboard-shortcut-parse`), and a 90s
 * per-file bump in the latter compensating locally for a gap that
 * belonged here.
 *
 * 30s is chosen to absorb scheduling noise while still failing fast on
 * a genuine hang — a test that legitimately needs longer is a test
 * doing too much, and an infinite loop still trips this well inside the
 * CI job budget.
 */
jest.setTimeout(30_000);

expect.extend(toHaveNoViolations);

// ─── next-intl (project-wide mock) ──────────────────────────────
//
// The jsdom project doesn't wrap render trees in a
// `NextIntlClientProvider`, and `next-intl` ships ESM that this
// project's transform doesn't process — so ANY component importing
// `next-intl` (Combobox, DatePicker, and the migrated UI
// primitives, plus everything that mounts them transitively) would
// otherwise fail to load with `SyntaxError: Unexpected token
// 'export'`.
//
// This mock replaces the module project-wide and resolves the REAL
// English strings from `messages/en.json` through ICU, so rendered
// assertions stay byte-identical to production output. Individual
// test files that need the key-echo behaviour (e.g. the ag-domain
// a11y suite, which relies on `t.has() === false` to exercise a
// component's English fallback) still override this with their own
// `jest.mock('next-intl', …)` — a test-file factory wins over this
// setup-file one.
//
// `require` inside the factory (not top-level imports) keeps
// babel-jest's out-of-scope-variable check happy.
jest.mock('next-intl', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const enMessages = require('../../messages/en.json');

    const get = (path: string): unknown =>
        path
            .split('.')
            .reduce<unknown>(
                (o, k) =>
                    o == null ? undefined : (o as Record<string, unknown>)[k],
                enMessages,
            );

    // Minimal ICU formatter — the message catalogue only uses simple
    // `{var}` interpolation and a basic `{n, plural, one {# x} other
    // {# xs}}` shape, so a full ICU engine (and its ESM deps) isn't
    // worth pulling into the transform. Renders byte-identical English.
    const formatIcu = (msg: string, values: Record<string, unknown>): string => {
        let out = msg;
        const pluralStart = /\{(\w+),\s*plural,/;
        let m: RegExpExecArray | null;
        while ((m = pluralStart.exec(out))) {
            const varName = m[1];
            const start = m.index;
            let depth = 0;
            let end = start;
            for (; end < out.length; end++) {
                if (out[end] === '{') depth++;
                else if (out[end] === '}') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            const block = out.slice(start, end + 1);
            const branchesStr = block.slice(
                block.indexOf('plural,') + 'plural,'.length,
                -1,
            );
            const branches: Record<string, string> = {};
            const branchRe = /(=\d+|zero|one|two|few|many|other)\s*\{/g;
            let bm: RegExpExecArray | null;
            while ((bm = branchRe.exec(branchesStr))) {
                let d = 0;
                let k = bm.index + bm[0].length - 1; // at '{'
                const open = k;
                for (; k < branchesStr.length; k++) {
                    if (branchesStr[k] === '{') d++;
                    else if (branchesStr[k] === '}') {
                        d--;
                        if (d === 0) break;
                    }
                }
                branches[bm[1]] = branchesStr.slice(open + 1, k);
                branchRe.lastIndex = k + 1;
            }
            const val = Number(values[varName]);
            const chosen =
                branches['=' + val] ??
                branches[val === 1 ? 'one' : 'other'] ??
                branches.other ??
                '';
            out =
                out.slice(0, start) +
                chosen.replace(/#/g, String(values[varName])) +
                out.slice(end + 1);
        }
        return out.replace(/\{(\w+)\}/g, (_, k) =>
            values[k] != null ? String(values[k]) : `{${k}}`,
        );
    };

    const makeT = (namespace?: string) => {
        const full = (key: string) => (namespace ? `${namespace}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const msg = get(full(key));
            if (typeof msg !== 'string') return full(key);
            if (!msg.includes('{')) return msg;
            return formatIcu(msg, values ?? {});
        };
        t.has = (key: string) => typeof get(full(key)) === 'string';
        // Render rich messages: interpolate {values}, then turn each
        // <tag>chunk</tag> into its callback's output (so tags like <b>/<pct>
        // — and any data-testid they carry — actually render in the DOM).
        t.rich = (key: string, values?: Record<string, unknown>) => {
            const raw = get(full(key));
            if (typeof raw !== 'string') return full(key);
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const React = require('react');
            const interp = formatIcu(raw, (values ?? {}) as Record<string, unknown>);
            const nodes: unknown[] = [];
            const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
            let last = 0;
            let m: RegExpExecArray | null;
            let i = 0;
            while ((m = re.exec(interp)) !== null) {
                if (m.index > last) nodes.push(interp.slice(last, m.index));
                const cb = values?.[m[1]];
                nodes.push(
                    typeof cb === 'function'
                        ? React.createElement(React.Fragment, { key: i++ }, (cb as (c: unknown) => unknown)(m[2]))
                        : m[2],
                );
                last = re.lastIndex;
            }
            if (last < interp.length) nodes.push(interp.slice(last));
            return React.createElement(React.Fragment, null, ...nodes);
        };
        t.markup = (key: string) => full(key);
        t.raw = (key: string) => get(full(key));
        return t;
    };

    const PassThrough = ({ children }: { children?: unknown }) => children;

    return {
        useTranslations: (namespace?: string) => makeT(namespace),
        useFormatter: () => ({
            number: (v: unknown) => String(v),
            dateTime: (v: unknown) => String(v),
            relativeTime: (v: unknown) => String(v),
        }),
        useLocale: () => 'en',
        useNow: () => new Date(0),
        useTimeZone: () => 'UTC',
        useMessages: () => enMessages,
        NextIntlClientProvider: PassThrough,
        IntlProvider: PassThrough,
    };
});

// R32-task-64 — flag the jsdom project as a React-act environment.
//
// React 19's `act()` runtime reads `globalThis.IS_REACT_ACT_ENVIRONMENT`;
// when unset, every async state update that lands AFTER an
// `await act(...)` block resolves emits
// "The current testing environment is not configured to support act(...)".
// In multi-suite parallel jest runs this surfaces as a flake
// (`tests/rendered/org-drilldown-load-more.test.tsx`) — the warning
// is escalated to a failure when worker memory pressure makes the
// microtask queue drain land outside the act window.
//
// Setting the flag opts the jsdom project into act semantics for
// every rendered test, the same way React Testing Library
// configures `vitest` / `mocha` runners. No-op for non-React-19
// runtimes. Has to run BEFORE any test file imports React, which
// `setupFilesAfterEnv` (this file) guarantees.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

afterEach(() => {
    cleanup();
});

// ─── jsdom polyfills ────────────────────────────────────────────

// matchMedia — useMediaQuery() relies on it.
if (typeof window !== 'undefined' && !window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        }),
    });
}

// IntersectionObserver — Radix / Vaul occasionally probe this.
if (typeof window !== 'undefined' && !('IntersectionObserver' in window)) {
    class MockIntersectionObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
            return [];
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).IntersectionObserver = MockIntersectionObserver;
}

// ResizeObserver — Radix Popover measures triggers for positioning.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
    class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).ResizeObserver = MockResizeObserver;
}

// PointerEvent polyfill — Radix Dialog emits pointer events on focus
// trap enter/leave; jsdom doesn't ship PointerEvent natively.
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
    class MockPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(type: string, props: PointerEventInit = {}) {
            super(type, props);
            this.pointerId = props.pointerId ?? 0;
            this.pointerType = props.pointerType ?? 'mouse';
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).PointerEvent = MockPointerEvent;
}

// HTMLElement.scrollIntoView — cmdk uses it for keyboard nav; jsdom
// doesn't implement it.
if (
    typeof window !== 'undefined' &&
    !Element.prototype.scrollIntoView
) {
    Element.prototype.scrollIntoView = jest.fn();
}

// Element.hasPointerCapture — Radix relies on it.
if (
    typeof window !== 'undefined' &&
    !Element.prototype.hasPointerCapture
) {
    Element.prototype.hasPointerCapture = jest.fn(() => false);
}
if (
    typeof window !== 'undefined' &&
    !Element.prototype.setPointerCapture
) {
    Element.prototype.setPointerCapture = jest.fn();
}
if (
    typeof window !== 'undefined' &&
    !Element.prototype.releasePointerCapture
) {
    Element.prototype.releasePointerCapture = jest.fn();
}
