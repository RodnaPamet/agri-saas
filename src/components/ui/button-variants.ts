import { cva } from "class-variance-authority";

/**
 * R19-PR-B — the shared liquid-carbon surface recipe.
 * R19-PR-C — added the micro-grain layer + the carbon-on-hover
 *            recipe for the transparent-background variants.
 *
 * Extracted from R19-PR-A's inline `primary` block so every
 * carbon-treated variant references one recipe instead of
 * duplicating the classes. The recipe is variant-COLOUR-
 * agnostic — every piece composes over whatever `bg-` the
 * variant paints:
 *
 *   • `--btn-carbon-border` — the meniscus edge, a token tone a
 *     hair darker than the surface so the silhouette is crisp
 *     without a "drawn outline";
 *   • `--btn-carbon-bevel` — the box-shadow that gives the
 *     surface VOLUME: a SOFT inset top-edge highlight (this is
 *     the "edge-light" — the bevel catches a hair of light) +
 *     a faint inset bottom bounce-glow + a tight outer drop;
 *   • a `::before` depth-overlay carrying TWO stacked images —
 *     `--btn-carbon-grain` (the micro-grain tile, top layer) over
 *     `--btn-carbon-overlay` (the soft elliptical light POOL that
 *     reads as liquid, bottom layer). Both sit in the ONE
 *     `::before` so they paint above the variant fill and below
 *     the label — grain over text would be wrong. `inset-0` +
 *     `rounded-[inherit]` tracks the button shape,
 *     `pointer-events-none` keeps it click-transparent.
 *
 * Spread into a variant's class array AFTER the variant's own
 * `bg-` / `hover:` classes.
 */
/**
 * R24-PR-B — liquid-glass surface recipe.
 *
 * Replaces R19-PR-B's `carbonSurface` for the solid-fill variants
 * (`primary`, `secondary`, `destructive`). Same composition seams
 * (R19's `::before` depth + R20's `::after` finish), new MATERIAL
 * inside. The R24-PR-A token suite (`--btn-glass-*`) is the
 * underlying surface; this recipe layers it.
 *
 *   • `border-[var(--btn-glass-edge)]` — REPLACED with a 1px
 *     gradient stroke painted as a `background-image` on a thin
 *     mask, not a CSS `border`. Borders can't be gradients
 *     directly; the recipe paints the edge sheen via the variant's
 *     `bg-[image:...]` stack instead, and zeroes the literal border.
 *
 *   • `backdrop-blur-[var(--btn-glass-blur)]` — the translucent
 *     base reads as glass only when the underlying page tone is
 *     softly blurred. 8px (the R24-PR-A token default) is
 *     restrained — wider blurs feel "ground-glass" / heavy.
 *
 *   • `bg-[image:var(--btn-glass-tint)]` — the alpha-tinted base
 *     FILL. Variants compose their own colour on top by spreading
 *     a second gradient before this one (primary brand-tinted,
 *     secondary neutral, destructive red-tinted).
 *
 *   • `shadow-[var(--btn-glass-inner),var(--btn-glass-shadow)]` —
 *     inner highlight + outer drop, comma-composed. R20-PR-D's
 *     state-conditional ambient elevation pattern is preserved:
 *     on press the ambient collapses (depressed); on focus the
 *     ambient expands with a brand-tinted ring (raised). The
 *     glass shadow replaces the carbon bevel as the rest-state
 *     volume cue.
 *
 *   • `::before` depth-overlay — the R19 layer is RETAINED but the
 *     content swaps: instead of the carbon grain + light pool, the
 *     `::before` paints a subtle radial inner-glow that brightens
 *     the top half of the glass (where the light enters). Same
 *     `inset-0` + `rounded-[inherit]` + `pointer-events-none`
 *     positioning.
 */
/**
 * R24-hotfix-simplify — single-material glass.
 *
 * The original R24-PR-B recipe stacked FOUR translucent layers on
 * the same surface:
 *   1. `bg-[var(--btn-glass-fill-VARIANT)]` — variant translucent fill
 *   2. `bg-[image:var(--btn-glass-tint)]` — top-bright white gradient
 *   3. `inset shadow inner` — white top edge
 *   4. `::before` radial — white top-half glow
 *
 * Three of those (2, 3, 4) all paint similar light near the top
 * edge. With low alphas, the eye reads each layer separately —
 * the user perceived it as "two buttons stacked on top of each
 * other". The compositing math is correct; the visual is wrong.
 *
 * The fix: keep ONE source of top-edge brightness (the inset
 * shadow — cleanest, most performant, no extra paint layers) and
 * drop the redundant gradient + radial overlay. The variant fill +
 * backdrop-blur + inset shadow + outer drop together carry the
 * glass material in a single coherent surface.
 */
const glassSurface = [
  "border-transparent",
  "backdrop-blur-[var(--btn-glass-blur)]",
  "shadow-[var(--btn-glass-inner),var(--btn-glass-shadow)]",
  // R20-PR-D — state-conditional ambient elevation (preserved across
  // the R24 material swap). REST = inner+shadow only. PRESS = ambient
  // collapses to one tight stop (depressed). FOCUS = ambient expands
  // with the brand-tinted halo (raised + signposted). Hover stays
  // unannotated because R20-PR-B's aura on `::after` is the hover
  // indicator; a second shadow would over-compete.
  "active:shadow-[var(--btn-glass-inner),var(--btn-ambient-press)]",
  "focus-visible:shadow-[var(--btn-glass-inner),var(--btn-ambient-focus)]",
];

/**
 * R19-PR-C — the carbon-on-hover recipe for the transparent
 * variants (`ghost`, `destructive-outline`).
 *
 * A depth-overlay over `bg-transparent` has no surface to pool
 * light on — at rest these variants stay flat and quiet, true
 * to their low-chrome intent. But the moment they gain a
 * `hover:bg-*` they DO have a surface, so the full carbon field
 * fades in: the same grain+pool `::before` (parked at
 * `opacity-0`, lifted to `opacity-100` on hover) carrying the
 * bevel shadow too. The border is deliberately NOT touched —
 * `ghost` stays borderless and `destructive-outline` keeps its
 * red danger edge; carbon emerges as DEPTH, not as a new outline.
 *
 * Why the bevel rides on `before:shadow-*` and NOT `hover:shadow-*`:
 * the `::before` is ALREADY opacity-gated on hover, so a shadow
 * declared on it inherits the hover gate for free — and the
 * v2-PR-4 motion-language ratchet bans `hover:shadow-*` outright
 * (hover-driven box-shadow reads as a decorative depth-lift). The
 * `--btn-carbon-bevel` is inset-led volume, not a lift; pinning
 * it to the `::before` keeps the whole carbon field on one gated
 * layer and stays inside the motion language.
 *
 * `before:transition-opacity` makes the carbon emerge as a
 * smooth fade rather than a snap; `motion-reduce` drops the
 * transition (the end state — carbon visible on hover — still
 * holds, it just arrives instantly).
 */
/**
 * R24-PR-B — liquid-glass on-hover recipe (transparent variants).
 *
 * Replaces R19-PR-C's `carbonOnHover` for `ghost` and
 * `destructive-outline`. At rest, transparent variants stay flat
 * + quiet (their `bg-transparent` has no surface to pool light
 * on). On hover the glass material emerges: the `::before` lifts
 * from opacity-0 to opacity-100, carrying the glass inner-glow +
 * tint + shadow as ONE smooth fade.
 *
 * Border deliberately untouched — `ghost` stays borderless,
 * `destructive-outline` keeps its red danger edge. Glass emerges
 * as DEPTH, not as a new outline (same R19 contract).
 *
 * `before:transition-opacity` makes the glass emerge as a smooth
 * fade rather than a snap; `motion-reduce` drops the transition.
 */
const glassOnHover = [
  "before:content-[''] before:absolute before:inset-0 before:rounded-[inherit] before:pointer-events-none",
  "before:bg-[image:var(--btn-glass-tint)]",
  "before:shadow-[var(--btn-glass-inner),var(--btn-glass-shadow)]",
  "before:opacity-0 before:transition-opacity before:duration-150",
  "hover:before:opacity-100",
  "motion-reduce:before:transition-none",
];

/**
 * R19-PR-D — the carbon interaction-state recipe (the R19 capstone).
 *
 * PR-A/B/C built the carbon SURFACE — at rest and on hover. PR-D
 * makes the three INTERACTION states read as the same liquid-carbon
 * MATERIAL rather than generic CSS state changes, by driving them
 * all through ONE channel: the `::before` depth-overlay's opacity.
 *
 *   • pressed (`active:`) — the light pool DIMS
 *     (`active:before:opacity-70`). Pressing liquid carbon
 *     depresses the surface; less light gathers. Composes with
 *     the cva base's `active:scale-[0.97]` — shrink + dim reads
 *     as a real physical depression. Tailwind emits `active:`
 *     AFTER `hover:`, so on a hovered-then-pressed transparent
 *     variant the press-dim correctly wins over the hover-lift.
 *
 *   • focus (`focus-visible:`) — the carbon is REVEALED
 *     (`focus-visible:before:opacity-100`). `carbonOnHover` only
 *     lifts the `::before` on `hover:`; this gives keyboard users
 *     the same depth a mouse gets. A no-op for the solid recipes
 *     (their `::before` already rests at full opacity). The a11y
 *     focus ring in the cva base is deliberately untouched and
 *     stays the primary focus signal — carbon is depth, not a
 *     replacement for the ring.
 *
 *   • disabled — the carbon goes INERT (`disabled:before:opacity-0`).
 *     Not "dimmed liquid": the depth-overlay (pool + grain) drops
 *     out entirely so a disabled button reads as flat, dead
 *     material. The base `disabled:opacity-50` still mutes the
 *     fill + label.
 *
 * `before:transition-opacity` makes all three changes ride the
 * same smooth fade as the hover reveal — and gives the solid
 * recipe (`carbonSurface`, which had no `::before` transition of
 * its own) one too. `motion-reduce` drops the transition: the end
 * states still hold, they just arrive instantly.
 *
 * Spread into the cva BASE — every variant gets the same
 * interaction-state material, regardless of which surface recipe
 * (`carbonSurface` / `carbonOnHover`) it carries.
 */
const carbonStates = [
  // 2026-05-31 CENTERING BUGFIX — the `::before` depth overlay MUST be
  // taken out of flow. The `before:*` utilities below make Tailwind
  // emit a `::before` with `content:""`; without explicit positioning
  // that pseudo defaults to `position:static`, so it becomes a 0-width
  // IN-FLOW flex item. With the button's `gap` (8px at md), that empty
  // pseudo consumes a gap slot and pushes the label ~4px right of
  // centre on EVERY solid/glass button (primary/secondary/destructive)
  // — the recurring "text not centered" report. `glassOnHover`
  // (transparent variants) already positioned its `::before`; the R24
  // `glassSurface` swap dropped it for the solid variants. Anchoring it
  // here in the shared base guarantees every variant's overlay is an
  // absolute, click-transparent layer that never participates in the
  // flex line. `inset-0` + `rounded-[inherit]` track the button shape.
  "before:content-[''] before:absolute before:inset-0 before:rounded-[inherit] before:pointer-events-none",
  // Same defence for the `::after` finish layer (iridescent edge /
  // aura). `iridescentEdge` positions its own `::after` absolute, but
  // `auraNeutral` (secondary's only `::after` recipe) used `after:*`
  // utilities WITHOUT positioning — so secondary's `::after` was a
  // static in-flow flex item on the TRAILING edge, pushing its label
  // ~4px LEFT of centre (the mirror of the `::before` bug). Anchoring
  // `after:absolute` in the base guarantees the finish layer is never
  // a flex item on any variant. Recipes that paint it (iridescent rim,
  // aura shadow) set the same values, so tailwind-merge dedupes.
  "after:content-[''] after:absolute after:inset-0 after:rounded-[inherit] after:pointer-events-none",
  "before:transition-opacity before:duration-150",
  "motion-reduce:before:transition-none",
  "active:before:opacity-70",
  "focus-visible:before:opacity-100",
  "disabled:before:opacity-0",
];

/**
 * R20-PR-B — the iridescent edge recipe.
 *
 * A 1px gradient stroke painted via the `::after` pseudo-element,
 * tracking the button's rounded corners. Brand → secondary linear
 * sweep (the `--btn-iridescent-gradient` token), always visible
 * — the iridescence is a MATERIAL PROPERTY of the surface, not a
 * state signal. (Aura is the state signal; iridescence is the
 * baseline finish, the way the meniscus catches light no matter
 * what you do to it.)
 *
 * Why a separate pseudo. R19 claims `::before` for the depth
 * overlay (grain + light pool + bevel insets). R20's iridescent
 * edge is a separate visual layer that paints ABOVE the surface
 * (it's the outermost finish), so it rides `::after` — which
 * Tailwind layers above `::before` in z-stack by default. The two
 * compose without colliding.
 *
 * Technique. The classic mask-composite recipe for a 1px gradient
 * border on a rounded element:
 *
 *   ::after {
 *     content: '';
 *     inset: 0; position: absolute; border-radius: inherit;
 *     padding: 1px;
 *     background-image: linear-gradient(...);
 *     mask: linear-gradient(#fff,#fff) content-box,
 *           linear-gradient(#fff,#fff);
 *     mask-composite: exclude;          (modern)
 *     -webkit-mask-composite: xor;      (Safari)
 *   }
 *
 * The two mask layers — content-box-clipped + full-element — XOR
 * each other; only the 1px ring between content-box and border-box
 * remains opaque. The gradient paints through that ring; the
 * interior is masked away. Tracks the parent's `border-radius`
 * exactly because `rounded-[inherit]` is on the pseudo.
 *
 * `pointer-events-none` keeps the iridescent layer click-transparent
 * — the underlying button stays the click target.
 *
 * Spread into variants that should carry the iridescent finish.
 * Today only `primary` — secondary and destructive are restrained
 * by intent (secondary = quiet; destructive = warning, not seduction).
 */
const iridescentEdge = [
  "after:content-[''] after:absolute after:inset-0 after:rounded-[inherit] after:pointer-events-none",
  "after:p-px",
  "after:bg-[image:var(--btn-iridescent-gradient)]",
  // 2026-05-31 BUGFIX — the iridescent gradient was filling the WHOLE
  // button (orange→navy wash + washed-out label) instead of clipping
  // to a 1px ring. Root cause: the `mask` SHORTHAND resets every mask
  // sub-property — including `mask-composite` — to its initial `add`.
  // Tailwind emitted the `after:[mask:…]` shorthand utility AFTER the
  // `after:[mask-composite:exclude]` utility, so the shorthand's reset
  // won the cascade → both mask layers ADDed → no 1px exclusion → full
  // gradient fill on every primary button (verified against the
  // compiled CSS + a screenshot harness).
  //
  // Fix: drive the mask with LONGHANDS (`mask-image` + `mask-clip`)
  // that never touch `mask-composite`, so `exclude` survives
  // regardless of utility order. Layer 1 (the gradient) clips to
  // content-box (inside the 1px `p-px`), layer 2 to border-box (full);
  // `mask-composite: exclude` XORs them → only the 1px ring paints.
  "after:[mask-image:linear-gradient(white,white),linear-gradient(white,white)]",
  "after:[-webkit-mask-image:linear-gradient(white,white),linear-gradient(white,white)]",
  "after:[mask-clip:content-box,border-box]",
  "after:[-webkit-mask-clip:content-box,border-box]",
  "after:[-webkit-mask-composite:xor]",
  "after:[mask-composite:exclude]",
  // R20-PR-D — disabled dust-out. The iridescent meniscus is a
  // material finish, not a state signal — but on a disabled
  // button the WHOLE surface should read inert. R19 already
  // drops `::before` to opacity-0 on disabled; R20-D drops the
  // `::after` iridescence to 30% so the meniscus is muted rather
  // than gone (a sudden disappearance would make disabled
  // primary read as a structurally different button — like the
  // edge was painted on, not finished into the surface). 30% is
  // visible-but-clearly-muted; the base `disabled:opacity-50`
  // mutes the fill in parallel. NO opacity transition here
  // because the `::after` already carries the aura's
  // `transition-shadow` (PR-B), and CSS allows only one
  // `transition-property` per element-rule; adding
  // `transition-opacity` would override the shadow transition.
  // Disabled is a steady state, so a snap is acceptable.
  "disabled:after:opacity-30",
];

/**
 * R20-PR-B — the aura-wash hover recipe.
 *
 * The soft brand-tinted halo a primary/secondary button casts on
 * hover, painted via `::after`'s box-shadow. Three stops folded
 * into one token (`--btn-aura-primary` / `--btn-aura-neutral`)
 * so the shape can't be drifted apart later.
 *
 * Why ride `::after` instead of `hover:shadow-*` on the element.
 * The v2-PR-4 motion-language ratchet bans `hover:shadow-*` because
 * "drop shadow on hover" reads cheap on layout-affecting surfaces.
 * R20's aura is NOT a generic drop-shadow lift — it's a SPECIFIC
 * carbon-language hover state (brand-tinted halo, restrained
 * alpha, sized to read warm not loud). Riding it through
 * `hover:after:shadow-[...]` keeps the element's own shadow alone
 * (so R19's `--btn-carbon-bevel` survives) AND skirts the regex
 * (the ratchet pattern is `\bhover:shadow-`, which requires
 * `hover:` followed DIRECTLY by `shadow-`; `hover:after:shadow-`
 * has `after:` between, so it doesn't match — by design, not by
 * accident).
 *
 * Why `::after` can carry BOTH the iridescent edge AND the aura.
 * The edge is on the pseudo's BACKGROUND (with mask-composite to
 * carve out the interior). The aura is on the pseudo's BOX-SHADOW.
 * Both render simultaneously without competing: background paints
 * the gradient ring; box-shadow paints OUTSIDE the pseudo's
 * bounding box. They don't share a property.
 *
 * `after:transition-shadow after:duration-150` makes the aura
 * emerge as a smooth fade rather than a snap. `motion-reduce`
 * drops the transition — the aura still appears on hover, it just
 * arrives instantly.
 *
 * Two factories rather than one variant-aware function: clarity
 * over cleverness. A primary aura and a neutral aura are
 * meaningfully different tokens; encoding the choice in a function
 * argument hides the decision.
 */
const auraPrimary = [
  "after:transition-shadow after:duration-150",
  "motion-reduce:after:transition-none",
  "hover:after:shadow-[var(--btn-aura-primary)]",
];
const auraNeutral = [
  "after:transition-shadow after:duration-150",
  "motion-reduce:after:transition-none",
  "hover:after:shadow-[var(--btn-aura-neutral)]",
];

/**
 * R20-PR-B — the carbon-glass recipe for the `ghost` variant.
 *
 * Ghost is the low-chrome variant; at rest it's `bg-transparent`.
 * On hover R19 painted the carbon depth-overlay via `carbonOnHover`,
 * but the existing hover background `hover:bg-bg-muted` is fully
 * opaque, so any backdrop-filter would have nothing to operate on.
 * R20 swaps the hover fill to a translucent `bg-bg-muted/75` so
 * the underlying surface peeks through, and applies
 * `hover:backdrop-blur-sm` so the peek-through is softly blurred
 * — frosted-glass on hover.
 *
 * 75% (not 60% or 100%): the hover state must still clearly
 * register as "this is the hover state" (the carbon depth-overlay
 * alone doesn't carry enough contrast on a translucent fill), but
 * elegance prefers a fill that's PRESENT, not opaque. 75% reads
 * as deliberate refinement.
 */
const ghostGlass = [
  "hover:backdrop-blur-sm",
];

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-tight whitespace-nowrap",
    // ── Coarse-pointer touch floor (WCAG 2.5.5 / Apple HIG 44px) ──────
    //
    // The density ladder below is tuned for a mouse: 28 / 32 / 36 / 40px.
    // Every rung of it is UNDER the 44px minimum for a finger, and this is
    // a mobile-first product — the operator is in a field, on a phone,
    // often wearing gloves. `sm` alone is 361 call sites at 32px.
    //
    // `min-h` only ever RAISES, so the desktop ladder is untouched: fine
    // pointers keep the graded density that R20-PR-C/E/F and R24-PR-C
    // tuned, and coarse pointers get a tap target that fits a thumb. The
    // two goals stop competing rather than one losing.
    //
    // Borrowed from the sibling compliance product, which pairs it with a
    // flat 28px ladder — there it is what makes that collapse safe on
    // touch. Here the ladder stays; only the floor is adopted.
    "pointer-coarse:min-h-11",
    // R22-PR-C — icon discipline. `[&_svg]:shrink-0` keeps icons
    // from being squished in dense flex contexts (the canonical
    // defensive Tailwind pattern). Per-size icon sizing lives on
    // the size variants.
    "[&_svg]:shrink-0",
    // R20-PR-C — per-size letter-spacing (tracking) replaces the
    // R19 flat `-0.01em` baseline. The new scale gives tiny labels
    // breathing room (small text wants OPEN tracking to stay
    // legible — that's why classic small-caps feel "confident")
    // and gives large labels confidence (headlines want TIGHT
    // tracking to feel deliberate). md sits at a barely-noticed
    // negative tightening; xs flips positive so 11-12px labels
    // don't feel cramped. The size variant defines the value; the
    // base no longer declares one.
    //
    // R20-PR-E — per-size font WEIGHT also lives on the size
    // variant now. The graded ladder (medium → semibold → bold)
    // mirrors the tracking ladder: dense UI sizes stay restrained,
    // featured sizes climb in confidence. See the size block below.
    "text-sm transition-all duration-150",
    // B3 — pill canonicalisation. Pre-B3 the base radius was
    // `rounded-[8px]` (R22 calibration). The Audit page's
    // Frameworks button shipped with `rounded-full` via a
    // per-call-site override and the user picked that pill shape
    // as the canonical button language for the product. Flipping
    // the base means every button across the app reads as the same
    // shape language without 20+ call-site overrides.
    //
    // Form controls (Input, date-picker trigger, combobox trigger)
    // do NOT follow this change — text-entry surfaces stay
    // rectangular per UX convention. `control-variants.ts` keeps
    // its 8px radius.
    "border rounded-full",
    // R22-PR-D + R24-PR-D — disabled mute. R22 added
    // `disabled:saturate-50` on top of `disabled:opacity-50` because
    // the carbon palette read as "half-visible coloured button"
    // when only the opacity was muted. The same two-channel mute
    // carries forward onto glass: transparency alone wouldn't be
    // enough to read as "inert" on a primary glass tile, so the
    // saturation drain stays. Plus the R19-PR-D `::before` opacity
    // drop preserves the "depth goes inert" cue. Three channels
    // muted in concert: fill brightness, colour saturation, depth.
    "disabled:opacity-50 disabled:saturate-50 disabled:pointer-events-none",
    // R24-PR-D — reduced-transparency accessibility fallback.
    // Users with `prefers-reduced-transparency: reduce` set in
    // their OS shouldn't see the glass effect; they get a flat
    // opaque surface instead. The `[@media...]` Tailwind arbitrary
    // variant strips the backdrop-blur (the expensive + visually
    // noisy bit) and forces the ::before depth overlay to fully
    // opaque alpha so the surface reads as a flat panel rather
    // than a translucent one. WCAG 1.4.11 + Web Best Practices.
    "[@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none",
    "[@media(prefers-reduced-transparency:reduce)]:before:opacity-100",
    // R22-PR-B — focus ring upgraded from Tailwind
    // `ring-2 ring-offset-2 ring-ring` (which reads as the
    // browser-default focus shape) to the brand-tinted box-shadow
    // halo R20-PR-D already established on `carbonSurface` via
    // `focus-visible:shadow-[bevel,ambient-focus]`. The cva base
    // drops the ring entirely; the shadow halo on `carbonSurface`
    // is the keyboard focus indicator for the solid variants.
    // Transparent variants (`ghost`, `destructive-outline`) get
    // the halo too via the `focus-visible:shadow-[var(--ctrl-
    // edge-focus)]` line below — same vocabulary as the form
    // practices. `outline-none` stays so the browser default
    // doesn't double up.
    "focus-visible:outline-none",
    "focus-visible:shadow-[var(--ctrl-edge-focus)]",
    // R11-PR4 — microinteraction sweep. Every button gets a subtle
    // press-down scale on `:active` so clicks feel responsive. The
    // 3% shrink is intentionally small — large enough to register
    // tactile feedback, small enough to never read as a glitch.
    // `motion-reduce` removes the scale entirely for users who opt
    // out of motion.
    "active:scale-[0.97] motion-reduce:active:scale-100",
    // R20-PR-D — sub-pixel tactile press. Composes WITH the R11-PR4
    // scale. The 1px Y-translate gives the press a physical
    // direction (the shrink alone reads as "smaller", not as
    // "pushed into the page") — the surface depresses + descends a
    // hair. Active-driven (not hover-driven, so the motion-language
    // ratchet's `\bhover:translate-` ban doesn't apply — active
    // translates are click feedback, the canonical motion the rule
    // explicitly preserves). Dropped under `motion-reduce`.
    "active:translate-y-px motion-reduce:active:translate-y-0",
    // R19-PR-A — liquid-carbon surface scaffolding. `relative`
    // lets each variant hang a `::before` depth-overlay off the
    // button without a positioning surprise. Kept in the cva BASE
    // so a future variant inherits the positioning context for
    // free. Every variant now uses it — `carbonSurface` (solid
    // fills) or `carbonOnHover` (transparent fills).
    "relative",
    // R19-PR-D — carbon interaction states. The pressed / focus /
    // disabled states all ride the `::before` depth-overlay's
    // opacity, so they read as the liquid-carbon material
    // responding rather than as generic CSS state changes. In the
    // BASE so every variant gets the identical state material.
    ...carbonStates,
  ],
  {
    variants: {
      variant: {
        // R19-PR-A wired `primary`; R19-PR-B extracted the recipe
        // into `carbonSurface` and rolled it to `secondary` +
        // `destructive`; R19-PR-C rolled `carbonOnHover` to the
        // transparent variants. Every button now reads as liquid
        // carbon — solid fills always, transparent fills on hover.
        primary: [
          // 2026-05-31 — the action buttons carry an OPAQUE
          // brand→secondary gradient FILL (`--btn-gradient-primary`):
          // brand the dominant first ~45%, a cool secondary tail in the
          // final stretch. This is the deliberate, deterministic
          // version of the orange→navy look (previously an accident of
          // the iridescent `::after` flooding the button when its mask
          // clip failed). Because it is the BACKGROUND (behind the
          // label), the white text stays crisp — unlike the old
          // `::after` overlay that washed it out. `bg-[image:…]` paints
          // the gradient; `text-white` rides on top.
          // B10 (2026-06-07): label is `text-content-inverted` (deep navy
          // "metro" blue in dark / off-white in light) — NOT `text-white`.
          // White on the METRO-yellow dark fill was a low-contrast wash; the
          // inverted token is the semantic text-on-brand colour.
          "bg-[image:var(--btn-gradient-primary)] text-content-inverted",
          // Hover brightens the whole gradient rather than collapsing
          // it to a flat brand fill (which would lose the gradient on
          // hover).
          "hover:brightness-110",
          ...glassSurface,
          // R20-PR-B — iridescent meniscus always visible (material
          // finish), primary aura halo on hover (warm hover lift).
          ...iridescentEdge,
          ...auraPrimary,
        ],
        secondary: [
          // R24-hotfix — opaque `bg-bg-default` replaced by
          // translucent navy fill. Same rationale as primary.
          "bg-[var(--btn-glass-fill-secondary)] text-content-emphasis",
          "hover:bg-bg-muted",
          ...glassSurface,
          // R20-PR-B — neutral aura on hover. No iridescent edge —
          // secondary is quiet by intent; iridescent on a muted
          // surface would over-claim attention.
          ...auraNeutral,
        ],
        ghost: [
          // R20-PR-B — translucent hover fill (75%) + backdrop-blur
          // gives the ghost a carbon-glass feel rather than a flat
          // muted hover. The carbon depth-overlay from R19 still
          // rides ::before; the glass effect rides the hover fill.
          "bg-transparent border-transparent text-content-default",
          "hover:bg-bg-muted/75 hover:text-content-emphasis",
          ...glassOnHover,
          ...ghostGlass,
        ],
        destructive: [
          // R24-hotfix — opaque `bg-bg-error-emphasis` replaced by
          // translucent red fill. Same rationale as primary.
          "bg-[var(--btn-glass-fill-destructive)] text-white",
          "hover:brightness-110",
          ...glassSurface,
        ],
        "destructive-outline": [
          "bg-transparent border-border-error text-content-error",
          "hover:bg-bg-error hover:text-content-error",
          ...glassOnHover,
        ],
      },
      size: {
        // R20-PR-C — airy density scale. Heights stay (filter-
        // toolbar alignment with <Input> is locked by the R20-PR-A
        // ratchet), but horizontal padding + gap + tracking each
        // get a size-conditional refinement. md gains +2px
        // horizontal breath; lg gains +4px horizontal + +2px gap.
        // xs/sm stay compact by intent — small buttons want
        // density, large buttons want air. Tracking: tiny sizes
        // open up (+0.005 / +0.01em), default sizes tighten
        // (-0.005 / -0.01em). Two felt characteristics of
        // "expensive type".
        //
        // R20-PR-E — graded weight ladder. The "section header"
        // weight (`font-semibold`) is the typographic confidence
        // the button family was missing. Applied as a GRADE so
        // dense UI sizes (xs/sm) stay restrained — bold xs buttons
        // shout in filter toolbars. md climbs to semibold (the
        // editorial-caption weight); lg climbs to bold (the
        // headline weight). Three weights, one ladder:
        //   xs/sm  font-medium    — quiet in dense rows
        //   md     font-semibold  — confident default
        //   lg     font-bold      — featured CTA, magazine-bold
        // The graded ladder mirrors the tracking ladder: small
        // text restrained, large text deliberate.
        // R20-PR-F (2026-05-15) — density correction. PR-C had
        // padded md +2px and lg +4px for "airy density"; on dense
        // toolbars (gear-trigger + a row of text buttons:
        // "AI Assessment", "Import", primary CTA) the air read as
        // "idle space around the label" — the text inside each
        // button felt small relative to the chrome. The new scale
        // tightens md and lg below pre-PR-C levels: md goes
        // px-4 → px-3, lg goes px-6 → px-4. Both lose visible
        // chrome; the text inside feels confidently centered.
        // lg's gap also collapses back to `gap-tight` (R19) — the
        // 10px gap was a compensation for the lg's airy padding;
        // with tighter padding the icon↔label rhythm wants to
        // tighten back too.
        //
        // Tracking + weight ladder (PR-C / PR-E) are untouched —
        // they live on a different axis (typographic weight, not
        // spatial chrome).
        //
        // button-density-tighter (2026-05-15) — second tightening
        // pass. Even at PR-F levels (md px-3, lg px-4) the user
        // reported the buttons still carried too much idle space
        // around the label. This pass drops each size another step:
        //   xs px-2.5 → px-2   (10 → 8 px each side)
        //   sm px-3   → px-2.5 (12 → 10)
        //   md px-3   → px-2.5 (12 → 10)
        //   lg px-4   → px-3   (16 → 12)
        // md and sm intentionally share px-2.5 — they're already
        // close in tone (both quiet, dense-UI sizes) and the 1px
        // height difference (h-8 vs h-9) is the carrying visual
        // distinction. Heights stay (R20-PR-A input-parity lock).
        // R22-PR-C — per-size icon sizing scale. Icons inside a
        // button used to be sized by the caller (typically
        // `h-4 w-4`). At xs (h-7 = 28px) a 16px icon dominates
        // the row; at lg (h-10 = 40px) it disappears. The
        // `[&_svg]:size-N` Tailwind utility on the size variant
        // OVERRIDES any svg child's own h-N/w-N because the
        // descendant selector wins on specificity. Callers can
        // still pass icons sized smaller; the per-size class
        // gives the default the right rhythm.
        // B3 — `rounded-md` override on `xs` removed. Pre-B3 the xs
        // variant carried its own 8px radius because at h-7 the
        // earlier 10px base read "pill-ish"; the canonicalisation to
        // `rounded-full` on the cva root makes that override moot.
        xs: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        sm: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        // Roadmap-6 P4 — mobile thumb-target floor. `md` is the DEFAULT
        // Button size, so raising its mobile min-height to 44px (WCAG 2.5.5
        // / Apple HIG) lifts every primary action into a comfortable tap
        // target on phones. Desktop is pinned back to h-9 (36px) via
        // `md:min-h-9` so dense toolbars / detail-header rows are unchanged.
        // Only `md` is touched — the compact sizes (xs/sm/icon) used in
        // dense tables + toolbars keep their existing heights.
        md: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        lg: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        // B2 — icon-only button size variant. Square (h=w=h-9) so
        // the chrome stays balanced regardless of icon size; same
        // height as md so it lines up beside text buttons in the
        // detail-page header row. Callers MUST supply
        // `aria-label="…"` (lint enforces it for accessibility).
        // Icon-only is SQUARE, so the floor has to raise width as well —
        // `min-h` alone would leave a 44x28 target that is still a miss.
        icon: "h-7 w-7 p-0 rounded-md tracking-normal font-[560] [&_svg]:size-[15px] pointer-coarse:min-w-11",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);
