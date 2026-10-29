/**
 * The two 2.5.3 fixes that are structural, asserted on source — #2449.
 *
 * The avatar half is a rendered test
 * (`tests/rendered/label-in-name-is-structural.test.tsx`). These two controls
 * are not cheaply renderable — `SidebarNav` wants routing and i18n context, the
 * date trigger wants a field wrapper — and the property each one must hold is a
 * fact about the markup, so it is asserted here.
 *
 * Replaces `label-in-name-sidebar-search.test.ts`, which asserted that two
 * CATALOGUE ENTRIES contained one another. That was true, stayed true, and the
 * control went on violating 2.5.3 — #2461's run on main reported the button
 * while quoting the widened label back. A guard aimed one level off its
 * subject.
 *
 * ## The mechanism these encode, measured in real Chromium with axe-core 4.14
 *
 * axe's `label-content-name-mismatch` compares the accessible name against
 * `visibleVirtual(node, screenReader=false, …)`. **`aria-hidden` is not a
 * visual property** — it hides from assistive tech, not from the screen — so
 * decorative-but-displayed text sits in the visible half and is excluded from
 * the name half, and no label wording can reconcile them. `display:none` on the
 * same element passes, which is the discriminator.
 *
 * | replica | verdict |
 * | --- | --- |
 * | visible word + `aria-hidden` ⌘K badge displayed | VIOLATION |
 * | same, badge `display:none` | passes |
 * | badge exposed, no `aria-label` (name from content) | rule inapplicable |
 * | `aria-labelledby` = field label only | VIOLATION |
 * | `aria-labelledby` = field label + value slot | passes |
 *
 * The E2E gate with 4.14 is the oracle. These are the fast checks that fail in
 * seconds when the shape comes back.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = process.cwd();
/** Comments blanked: a commented-out attribute must not satisfy any of these. */
const src = (rel: string) => blankNonCode(readFileSync(join(ROOT, rel), 'utf8'));

const SIDEBAR = 'src/components/layout/SidebarNav.tsx';
const TRIGGER = 'src/components/ui/date-picker/trigger.tsx';

describe('WCAG 2.5.3 structural invariants (#2449)', () => {
    describe('the sidebar search anchor is named by its content', () => {
        it('declares no aria-label, so the name is computed from content', () => {
            const code = src(SIDEBAR);
            expect(code).toContain('data-testid="sidebar-search-anchor"');
            // The exact shape #2441 introduced and that did not work. Asserting
            // its ABSENCE because "widen the label" is what the next reader
            // will reach for, having seen that PR.
            expect(code).not.toContain("aria-label={t('openPalette')}");
        });

        it('the ⌘K badge is NOT aria-hidden, so it is in the name as well as on screen', () => {
            const code = src(SIDEBAR);
            const badge = code.indexOf('tabular-nums text-content-subtle md:flex');
            expect(badge).toBeGreaterThan(-1);
            // Window bounded by the element's own closing tag, not a character
            // count — blanking preserves length, so prose inside the element
            // would push past any constant.
            const close = code.indexOf('</span>', badge);
            expect(close).toBeGreaterThan(badge);
            expect(code.slice(badge, close)).not.toContain('aria-hidden');
        });

        it('the destination is still announced, via sr-only text', () => {
            // Removing the aria-label without this would drop "open command
            // palette" from the announcement entirely.
            expect(src(SIDEBAR)).toContain('<span className="sr-only">{t(\'openPalette\')}</span>');
        });
    });

    describe('the date-picker trigger names itself with its value', () => {
        it('extends aria-labelledby with the value slot instead of replacing it', () => {
            const code = src(TRIGGER);
            // A LIST, so the field's label is kept and the value appended —
            // which is why no string has to be maintained as the value changes.
            expect(code).toContain('const labelledBy = [ariaLabelledBy, valueSlotId]');
            expect(code).toContain('aria-labelledby={labelledBy}');
        });

        it('the value slot carries the id that chain points at', () => {
            // The two halves must agree or the name references nothing — and a
            // dangling idref degrades silently to "label only", which is the
            // defect.
            const code = src(TRIGGER);
            expect(code).toContain('const valueSlotId = useId()');
            expect(code).toContain('id={valueSlotId}');
        });

        it('the id is generated, not caller-supplied', () => {
            // The trigger renders in many places; two on one page sharing a
            // literal id would make one of them name the other's value.
            expect(src(TRIGGER)).toContain("useId } from 'react'");
        });
    });

    it('the superseded message-level guard is gone, not left alongside', () => {
        // It asserted `openPalette.includes(search)` — true while the DOM
        // violated. Keeping it would leave a green test whose passing means
        // nothing next to these, and the next reader could not tell which one
        // to trust.
        expect(
            require('fs').existsSync(join(ROOT, 'tests/guards/label-in-name-sidebar-search.test.ts')),
        ).toBe(false);
    });
});
