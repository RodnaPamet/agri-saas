"use client";

/**
 * `<RequiredMarker>` — Roadmap-4 PR-4.
 *
 * The visual cue that a form field is required: a red asterisk
 * inline next to the label. Centralised so every required field —
 * inside `<FormField>` or hand-composed labels (modal forms, dynamic
 * field arrays, vendor-assessment questions) — paints the same shape:
 *
 *   • `aria-hidden="true"` so screen readers don't announce a
 *     literal "asterisk" — the `aria-required="true"` on the form
 *     practice is the canonical signal for assistive tech, and the
 *     visual asterisk is only there for sighted users. Many drift
 *     sites omitted this, polluting screen-reader output.
 *
 *   • `ml-1` so the asterisk sits one space character away from the
 *     label text — visually distinct, not bumping against the last
 *     letter.
 *
 *   • `text-content-error` — semantic token, matches the rest of
 *     the form's error vocabulary.
 *
 * Pages MUST NOT hand-roll `<span className="text-content-error">*</span>`
 * — the ratchet at `tests/guards/required-marker-discipline.test.ts`
 * fails CI on new drift.
 *
 * When NOT to use:
 *
 *   - Inside `<FormField required>`. The wrapper renders the marker
 *     itself; passing `required` is enough.
 *
 *   - For an asterisk that ISN'T a required-field marker (footnote
 *     reference, "edited" star, etc.). Those should render whatever
 *     glyph fits, not via this primitive.
 */

import { cn } from "@/lib/cn";

export interface RequiredMarkerProps {
    /** Layout overrides on the marker `<span>`. */
    className?: string;
}

export function RequiredMarker({ className }: RequiredMarkerProps) {
    return (
        <span
            aria-hidden="true"
            data-required-marker
            className={cn("ml-1 text-content-error", className)}
        >
            *
        </span>
    );
}
