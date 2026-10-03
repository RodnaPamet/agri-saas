/**
 * A memoized date must follow a locale SWITCH, not freeze at mount.
 *
 * ── the bug this is the regression test for ──
 *
 * P2.1c converted 65 components to `useDateFormat()`. Twenty-five of them
 * build their column sets inside `useMemo`, and those memos did not list the
 * formatter in their dependency arrays — the formatter had not been a
 * dependency before, because it used to be a module-level import.
 *
 * `useDateFormat()` returns a NEW object when the locale changes (it is
 * memoized on `[locale]`), so a memo that omits it keeps calling the formatter
 * bound to whatever locale was active when the component mounted. The dates
 * would stay en-GB for a user who switched to Bulgarian — defeating the entire
 * point of P2.1 while every test stayed green.
 *
 * `react-hooks/exhaustive-deps` reported all twenty-five, as WARNINGS. Warnings
 * do not fail this build; they only move a ratchet, and the ratchet sat exactly
 * at its ceiling (107 of 107) which is how I came to look at them at all. So
 * the class gets an executing assertion here rather than relying on someone
 * reading a warning count.
 */
import { render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { useDateFormat } from '@/lib/i18n/use-date-format';

let currentLocale = 'en';
jest.mock('next-intl', () => ({
    useLocale: () => currentLocale,
    useTranslations: () => (key: string) => key,
}));

const AT = '2026-04-16T08:00:00Z';

/** The real shape: a memo that closes over the formatter and LISTS it. */
function WithDep() {
    const { formatDate } = useDateFormat();
    const cols = useMemo(() => [formatDate(AT)], [formatDate]);
    return <span data-testid="out">{cols[0]}</span>;
}

/** The pre-fix shape, kept so the test can show the difference. */
function WithoutDep() {
    const { formatDate } = useDateFormat();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reproduces the defect on purpose
    const cols = useMemo(() => [formatDate(AT)], []);
    return <span data-testid="out">{cols[0]}</span>;
}

beforeEach(() => {
    currentLocale = 'en';
});

describe('a memoized date follows a locale switch', () => {
    it('CONTROL: the two locales really do render differently', () => {
        // Without this the whole file could pass on a build where the locale
        // was ignored everywhere.
        currentLocale = 'en';
        const { unmount } = render(<WithDep />);
        const en = screen.getByTestId('out').textContent;
        unmount();
        currentLocale = 'bg';
        render(<WithDep />);
        expect(screen.getByTestId('out').textContent).not.toBe(en);
    });

    it('re-renders the date when the locale changes', () => {
        const { rerender } = render(<WithDep />);
        expect(screen.getByTestId('out').textContent).toBe('16 Apr 2026');

        currentLocale = 'bg';
        rerender(<WithDep />);
        // bg, with the «г.» stripped from the compact form per P2.1b.
        expect(screen.getByTestId('out').textContent).toBe('16.04.2026');
    });

    it('and WITHOUT the dependency it freezes — the defect, executed', () => {
        // This is the assertion that gives the twenty-five one-line fixes a
        // reason a reader can check, rather than "lint asked for it".
        const { rerender } = render(<WithoutDep />);
        expect(screen.getByTestId('out').textContent).toBe('16 Apr 2026');

        currentLocale = 'bg';
        rerender(<WithoutDep />);
        expect(screen.getByTestId('out').textContent).toBe('16 Apr 2026'); // STALE
    });
});
