/**
 * R20 — form-control parity recipes.
 *
 * The button primitive carries the liquid-carbon vocabulary (R19:
 * bevel + light pool + micro-grain; R20: ambient elevation,
 * iridescent edge, aura wash, airy density, tactile press). The
 * form controls — `<Input>`, `<Select>`, combobox triggers,
 * date-picker triggers — share the same VISUAL LANGUAGE but a
 * different SURFACE MODEL: they are hollow containers for text,
 * not filled surfaces.
 *
 * This file is the form-control mirror of `button-variants.ts`.
 * Buttons carbon-FILL; controls carbon-EDGE. The recipes here drive
 * the input-style controls' rest / hover / focus / invalid states
 * through the same token palette (`--ctrl-edge-*`, `--btn-ambient-*`,
 * `--btn-iridescent-gradient`) so a focused input feels like a
 * cousin of a focused button rather than an unrelated control.
 *
 * PR-A SCOPE: only the SCAFFOLD lands here. The recipes are exported
 * but not yet wired into `input.tsx` / `combobox/index.tsx` /
 * `date-picker/trigger.tsx` — that wiring happens in PR-B (liquid
 * edges → focus + hover treatment) and PR-D (tactile press →
 * focus-ring ambient lift). PR-A only proves the FOUNDATION is in
 * place: the file exists, the recipes resolve to the new R20
 * tokens, and the parity surface is structurally locked by the
 * R20-PR-A ratchet.
 *
 * The split into a SEPARATE file (vs extending button-variants.ts)
 * is deliberate:
 *   - Buttons and form controls are sized differently (controls
 *     need `read-only:` + `invalid:` states; buttons don't). A
 *     shared CVA would over-fit.
 *   - The R19 carbon RECIPES (`carbonSurface`, `carbonOnHover`,
 *     `carbonStates`) are surface-fill recipes. Form-control
 *     parity is an EDGE recipe — different channel, different
 *     contract.
 *   - Future controls (steppers, switches, segmented controls)
 *     can adopt `controlEdge` without dragging the surface-fill
 *     recipes along.
 */
import { cva } from "class-variance-authority";

/**
 * R20 — the form-control edge recipe.
 *
 * Three border states driven by the same R20 token scale that
 * powers the button family. Spread into a control's cva alongside
 * its size variant. Carries NO height/padding — those stay in the
 * control's own size variant (an `<Input size="md">` is `h-9`; a
 * combobox trigger is whatever the wrapping `<Button size>` gives
 * it). Edge-only, so it composes over any control without
 * conflicting with its layout.
 *
 *   - `border-[var(--ctrl-edge-rest)]` — quiet at rest. The control
 *     reads as containment, not as a competing element.
 *   - `hover:border-[var(--ctrl-edge-hover)]` — emphasis on hover.
 *     Same channel as the rest border, just lifted.
 *   - `focus-visible:shadow-[var(--ctrl-edge-focus)]` — a 3px
 *     brand-tinted outer glow when focused. NOT a `ring-` utility
 *     because the ring stacks behind the border; a `shadow-[...]`
 *     box-shadow stops above the border, so the focus halo sits
 *     ON TOP of the iridescent edge (PR-B) without occluding it.
 *
 * `motion-reduce:transition-none` keeps the transition opt-out
 * coherent with the button primitive — every R20 state change can
 * drop its fade.
 */
export const controlEdge = [
    "border border-[var(--ctrl-edge-rest)]",
    "hover:border-[var(--ctrl-edge-hover)]",
    "focus-visible:shadow-[var(--ctrl-edge-focus)]",
    "transition-colors duration-150",
    "motion-reduce:transition-none",
];

/**
 * R20 — control sizing scale, mirrored from the button size scale.
 *
 * Same heights and horizontal padding as the button family so an
 * `<Input size="md">` and a `<Button size="md">` line up perfectly
 * when they share a row (the canonical filter-toolbar shape).
 * Kept in lockstep with `button-variants.ts::size` — if one
 * shifts, the other shifts too; the R20-PR-A ratchet asserts the
 * heights match.
 */
export const controlSize = {
    xs: "h-7 px-2.5 text-[11px] rounded-md",
    sm: "h-8 px-3 text-xs",
    md: "h-9 px-3 text-sm",
    lg: "h-10 px-3.5 text-sm",
} as const;

/**
 * R20 — the form-control CVA itself.
 *
 * Composed today as the foundation for PR-B's wiring; PR-A
 * deliberately leaves `<Input>` etc. on their existing inline
 * `inputVariants` so this PR is a pure foundation drop. PR-B
 * migrates `inputVariants` to compose `controlVariants` and adds
 * the iridescent focus-ring on top.
 */
export const controlVariants = cva(
    [
        // R22-PR-A — radius mirror of button-variants.ts.
        // Form controls + buttons share corner shape so a
        // filter-toolbar row reads as one chassis.
        "w-full rounded-[8px] text-sm",
        "bg-bg-default text-content-emphasis placeholder-content-subtle",
        "focus:outline-none",
        "disabled:cursor-not-allowed disabled:bg-bg-muted disabled:text-content-muted disabled:hover:border-[var(--ctrl-edge-rest)]",
        "read-only:bg-bg-muted read-only:text-content-muted read-only:hover:border-[var(--ctrl-edge-rest)]",
        ...controlEdge,
    ],
    {
        variants: {
            size: controlSize,
            invalid: {
                true: "border-border-error text-content-error placeholder-content-error/60 focus-visible:shadow-[0_0_0_3px_rgb(220_38_38_/_0.20)] hover:border-border-error",
                false: "",
            },
        },
        defaultVariants: { size: "md", invalid: false },
    },
);
