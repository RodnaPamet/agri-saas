'use client';

/**
 * How many pixels the soft keyboard is covering — P8.3 (#2797).
 *
 * ## Why this exists at all
 *
 * A composer pinned to the bottom of the viewport is covered by the on-screen
 * keyboard on iOS. The layout viewport does not shrink when the keyboard
 * opens; the VISUAL viewport does. So the inset is
 * `layoutHeight - (visualViewport.height + visualViewport.offsetTop)`, and
 * nothing in CSS alone reports it — `env(safe-area-inset-bottom)` is about the
 * home indicator, not the keyboard, and conflating them puts the composer
 * 34px up on a device with no keyboard open.
 *
 * There is NO existing `visualViewport` handling anywhere in this repo
 * (checked), so this is the first and should stay the only one: a second
 * listener computing its own answer is how two parts of a screen disagree
 * about where the keyboard is.
 *
 * ## It degrades to zero, deliberately
 *
 * `window.visualViewport` is absent in jsdom and in older browsers. Absent
 * means zero inset — the composer sits where it would have anyway. That is the
 * safe direction: a wrongly-applied inset pushes the composer into the middle
 * of the screen, while a missing one leaves it exactly where every desktop
 * browser puts it.
 *
 * ## It is a HOOK rather than a CSS trick because the value has to be read
 *
 * A test can observe a number. `100dvh` cannot be asserted in jsdom, which has
 * no layout engine — so a CSS-only solution would be a branch no rendered test
 * could reach, which is the shape this repo's rendered suite keeps producing
 * by accident (the coarse-pointer tooltip path, the DataTable desktop branch).
 */
import { useEffect, useState } from 'react';

export function useKeyboardInset(): number {
    const [inset, setInset] = useState(0);

    useEffect(() => {
        const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
        if (!vv) return;

        const read = () => {
            // `offsetTop` matters: when the page is scrolled within the visual
            // viewport, height alone understates what is hidden.
            const covered = window.innerHeight - (vv.height + vv.offsetTop);
            // Clamped at zero. A negative value happens transiently during a
            // rotation. It would not visibly misplace the composer — CSS
            // forbids negative padding and the declaration is simply dropped —
            // which is exactly why the clamp is here: a consumer reading this
            // number for anything but padding would otherwise get a value that
            // only the CSS parser was saving it from.
            setInset(Math.max(0, Math.round(covered)));
        };

        read();
        vv.addEventListener('resize', read);
        vv.addEventListener('scroll', read);
        return () => {
            vv.removeEventListener('resize', read);
            vv.removeEventListener('scroll', read);
        };
    }, []);

    return inset;
}
