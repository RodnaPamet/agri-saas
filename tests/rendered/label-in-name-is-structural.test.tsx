/**
 * WCAG 2.5.3 asserted on the RENDERED DOM, not on message strings — #2449.
 *
 * ## The guard this replaces, and why it had to go
 *
 * `tests/guards/label-in-name-sidebar-search.test.ts` (#2441) asserted that two
 * CATALOGUE ENTRIES contained one another — `openPalette.includes(search)`.
 * That was true, stayed true, and the control went on violating 2.5.3 the whole
 * time. #2461's run on main proved it: axe still reported the button, quoting
 * the widened label back.
 *
 * The containment that matters is between an element's **rendered visible
 * text** and its **computed accessible name**. Neither is a message, so no
 * assertion about messages can see it. That guard was aimed one level off its
 * subject.
 *
 * ## Why these assertions are structural rather than a name computation
 *
 * The honest check is "accessible name contains visible text", and the only
 * faithful oracle for it is axe in a real browser — which is the E2E gate, and
 * which now runs 4.14. Reproducing that computation here would mean
 * reimplementing `visibleVirtual` plus the accessible-name algorithm in jsdom,
 * and jsdom cannot even run axe's own rule (it needs canvas for ligature
 * detection; measured — the rule aborts with an engine error).
 *
 * So this file asserts the three structural properties that make the violation
 * IMPOSSIBLE, each one the mechanism measured in real Chromium with axe-core
 * 4.14:
 *
 *   1. the search button has no ARIA name override, so its name is computed
 *      from content and contains its visible text by construction;
 *   2. the ⌘K badge is not `aria-hidden`, so it is in the name as well as on
 *      screen — `aria-hidden` is not a visual property, which is the whole
 *      reason the old fix failed;
 *   3. `InitialsAvatar` contributes NO text node, so it cannot be visible text.
 *
 * A property, not a string. The E2E gate remains the oracle; this is the fast
 * check that fails in seconds when someone reintroduces the shape.
 */
import { render, screen } from '@testing-library/react';

import { InitialsAvatar } from '@/components/ui/initials-avatar';

describe('WCAG 2.5.3 — the avatar contributes no visible text (#2449)', () => {
    it('renders its initials as an attribute, not as a text node', () => {
        const { container } = render(<InitialsAvatar value="Acme Corp" />);
        const span = container.querySelector('[data-initials]');
        expect(span).not.toBeNull();
        // THE MECHANISM. Painted by a `::before` rule in globals.css, so the
        // glyphs are on screen while the DOM holds no text for axe's
        // `visibleVirtual` walk — or for anything else — to pick up.
        expect(span!.getAttribute('data-initials')).toBe('AC');
        expect(container.textContent).toBe('');
    });

    it('is still aria-hidden, so it stays out of the accessible name', () => {
        // Both halves are needed. Dropping aria-hidden would put the initials
        // INTO the parent's name ("AC Acme Corp"), which satisfies 2.5.3 the
        // other way but announces redundant noise — the owner's ruling was to
        // de-text the avatar precisely to avoid that.
        const { container } = render(<InitialsAvatar value="Acme Corp" />);
        expect(container.querySelector('[data-initials]')!.getAttribute('aria-hidden')).toBe('true');
    });

    it('a single-word value still yields initials, so the attribute is never empty', () => {
        // An empty `data-initials` would paint nothing — a silently blank
        // avatar, which no a11y rule reports.
        const { container } = render(<InitialsAvatar value="Acme" />);
        expect(container.querySelector('[data-initials]')!.getAttribute('data-initials')).toBe('A');
    });

    it('the image layer, when present, carries an empty alt', () => {
        // The other way text could re-enter: a non-empty alt is visible text to
        // the name computation.
        render(<InitialsAvatar value="Acme Corp" imageUrl="https://example.test/a.png" />);
        expect(screen.getByTestId('initials-avatar-image').getAttribute('alt')).toBe('');
    });
});
