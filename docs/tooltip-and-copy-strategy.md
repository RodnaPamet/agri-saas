# Tooltip & Copy Strategy

Epic 56's close-out guide. Keep this open when you reach for `title=`, an info icon, or `navigator.clipboard` in Inflect Compliance.

## TL;DR decision tree

```
Need to explain a control?
├─ Icon-only button / disabled state hint
│    └─ <Tooltip content="…">            wrap the trigger
│
├─ Form-field label that needs optional context
│    └─ <FormField hint="…">             InfoTooltip renders next to the label
│
├─ Inline question-mark next to a heading or chip
│    └─ <InfoTooltip content="…">        focusable help button
│
├─ Rich content (title + body + shortcut)
│    └─ <Tooltip title="…" content="…" shortcut="…">
│
└─ Interactive content (links, form controls, "stay open while reading")
     └─ use a <Popover>, not a Tooltip
```

```
Need to let the user copy a value?
├─ Icon-only button next to a display value
│    └─ <CopyButton value={…} label="Copy API key">
│
├─ Inline value that IS the display (id, code, hash, key)
│    └─ <CopyText value={…}>{displayed}</CopyText>
│
├─ Same value displayed AND copied, but with masking
│    └─ <CopyText value={rawSecret}>{mask(rawSecret)}</CopyText>
│
├─ Need to use the clipboard from a page-specific control
│    └─ const { copy, copied } = useCopyToClipboard()
│       then wire the hook to your own <button>
│
└─ Anywhere else
     └─ DO NOT import navigator.clipboard — the ratchet guard will fail
```

Everything else in this doc is the reasoning behind those decisions.

---

## Primitives

### `<Tooltip>` — the canonical hover/focus hint

**Use for:**
- Icon-only buttons with no visible label (`×`, trash, gear, eye).
- Disabled buttons that need an explanation (`<Tooltip content={disabledReason}>`).
- Status chips whose meaning benefits from a short sentence (sync conflict, SLA breach).
- Keyboard-shortcut hints (pass `shortcut="Esc"` and a `<kbd>` renders in the header).

**Do not use for:**
- Interactive content. Tooltips disappear on blur and are announced as `role="tooltip"`. Anything the user needs to click into belongs in a `<Popover>`.
- Duplicating a visible label. "Copy" button with `title="Copy"` / `Tooltip content="Copy"` is noise.

**Accessibility contract:**
- The trigger's `aria-describedby` is linked to the tooltip content (Radix handles this).
- If the trigger has no text content, **you** must supply `aria-label` — Tooltip content is a *description*, not a *name*.
- Escape closes an open tooltip. Tab opens it on the focused trigger. No additional wiring required.

**Mounted at the root.** `TooltipProvider` is installed in `src/app/providers.tsx`. Do not nest another one inside your component tree.

**Z-index.** The tooltip sits at `z-[99]`, above every modal/sheet/popover at `z-40`/`z-50`. Don't override.

**Touch devices — tap to toggle (#449).** Radix gives touch users nothing: its Trigger early-returns from `onPointerMove` for `pointerType === "touch"` and wires `onPointerDown`/`onClick` to CLOSE. On a mobile-first product that made every help icon pure decoration, so the primitive drives `open` itself on a coarse pointer: **tap toggles**, and the tooltip dismisses on the next tap outside, on scroll, or after `TOUCH_AUTO_DISMISS_MS`. Everything else is identical — same content, same surface, same side/align/offset. Only the *gesture* differs, because a phone has no hover to offer.

That second behaviour lives **inside the primitive and nowhere else**:

- **Never re-implement it at a call site.** No `matchMedia('(pointer: coarse)')`, no `'ontouchstart' in window`, no `onTouchStart` on a tooltip trigger. A call site that grows its own touch path is a control that behaves differently from every other tooltip in the app.
- **Never add a prop to fork it.** `TooltipProps` is a closed interface with no `extends` — a caller cannot inject `onPointerDown`/`onClick` into the trigger, and a `disableTouch`-shaped prop is exactly the divergence the primitive exists to prevent. `disabled` is the sanctioned escape hatch and it short-circuits for *everyone*.
- **Do not tidy away the `preventDefault()`** in the tap handler. It looks redundant; it is what makes Radix skip its own composed close-handlers. Without it the tooltip opens and closes on the same tap.
- **Do not drop a dismissal path.** Outside-tap, scroll, and timeout are three separate paths and losing any one lets a tapped-open popup sit over the UI intercepting the next touch — the exact failure that had tooltips switched off app-wide for months (#395).

`tests/guards/tooltip-touch-uniformity.test.ts` asserts all four. Note what it does *not* do: it is a source-text scan with no runtime coverage. The coarse-pointer branch has no executing test yet — jsdom's `matchMedia` stub answers `matches: false` to every query, so `tests/rendered/tooltip.test.tsx` exercises the hover/focus path only.

### `<InfoTooltip>` — the question-mark help icon

A focusable help button rendered as `?` (help circle), wrapping any `Tooltip` content. Use it when the hint belongs *next to* a label or heading but isn't triggered by hovering the label itself. The common case is the new `hint` prop on `<FormField>` and `<FieldGroup>`.

```tsx
<FormField
  label="Session max age"
  hint="Absolute login lifetime, regardless of activity."
>
  <Input type="number" />
</FormField>
```

If you need `InfoTooltip` standalone (not inside a form wrapper):

```tsx
<InfoTooltip content="…" aria-label="More info about scope"  />
```

Always pass a specific `aria-label`. The default is `"More information"`, which is ambiguous when multiple info icons coexist on a page.

### `<CopyButton>` — isolated copy action

Icon-only button that copies a string. Auto-wraps in a `Tooltip` using its `label` so the hover hint tells the user what they're about to copy. Emits a sonner toast on success and on failure.

```tsx
<CopyButton
  value={shareLink}
  label="Copy share link"
  successMessage="Share link copied"
  onCopy={audit.copy}
/>
```

Guarantees:
- Never auto-fires — requires explicit click / keyboard activation.
- `event.stopPropagation()` so parent row/accordion click handlers don't fire.
- `onCopy(value)` fires *only* on success, once per click, so secret-reveal audit logging doesn't double-log on retries.
- Failed writes flip the icon back to Copy and surface an error toast. No silent failures.

### `<CopyText>` — inline copyable value

Same semantics as `<CopyButton>` but the value itself is clickable, with a small copy glyph on the trailing edge. Perfect for technical identifiers shown in headers, tables, or metadata grids.

```tsx
<CopyText value={taskKey} label={`Copy ${taskKey}`}>{taskKey}</CopyText>
```

**Masking pattern.** The `value` prop is the clipboard payload; `children` is what the user sees. To mask sensitive data while preserving the copy contract:

```tsx
<CopyText value={fullSecret} label="Copy enrollment secret">
  {mask(fullSecret)}
</CopyText>
```

### `useCopyToClipboard` — the shared hook

```ts
const { copy, copied, error, reset } = useCopyToClipboard({ timeout: 2000 });
```

Returns:
- `copy(value)` → `Promise<boolean>` (`false` on failure, never throws).
- `copied` — success flag, auto-resets after `timeout`.
- `error` — captured `Error | null` for inline messaging.
- `reset()` — clear both flags.

Use this hook when a page needs a prominently-labeled "Copy" button (the show-once banners on `/admin/api-keys`, `/admin/scim`, `/security/mfa`). The `<CopyButton>` component is icon-only; when you need a button with a visible "Copy" label and bespoke placement, call the hook directly:

```tsx
const { copy, copied } = useCopyToClipboard({ timeout: 2500 });

async function handleCopy() {
  const ok = await copy(plaintext);
  if (ok) toast.success('API key copied — paste it into your tool now.');
  else    toast.error('Copy failed — select the key and copy manually.');
}

<button onClick={handleCopy}>
  {copied ? <Check /> : <Copy />}
  {copied ? 'Copied!' : 'Copy'}
</button>
```

The hook has:
- SSR-safe guard (`typeof navigator` check).
- Legacy `document.execCommand('copy')` fallback for hosts that aren't served over HTTPS (MFA enrollment on preview envs).
- Auto-reset timer with unmount cleanup.

---

## When to use `title=`

You *may* keep the native HTML `title` attribute for these cases, and only these:

1. **Truncation fallback** on `max-w-* truncate` spans where the full value is useful but a tooltip per element would be excessive. Example: `reports/soa/SoAClient.tsx` justification cell, `controls/[controlId]/page.tsx` syncError pre.
2. **Density visualisations** (heatmaps, progress bars, calendar cells) — tens to hundreds of elements where portalising a Radix Tooltip per cell is the wrong cost. Example: `RiskHeatmap`, `ExpiryCalendar`, `StatusBreakdown`, `ProgressCard`, the admin/roles permission matrix, risks/dashboard matrix.
3. **Row-select checkboxes** with an existing `aria-label`. Adding a visible tooltip to every row's select checkbox is clutter.

Anywhere else, reach for `<Tooltip>`. The `title=` ratchet (`tests/guards/no-ad-hoc-tooltip-title.test.ts`) caps the count and fails CI if it grows beyond the documented baseline.

### `title=` as a component prop is NOT the same thing

Several shared primitives expose a `title` prop that renders visible header text or styled bold heading. **These are semantic component props, not HTML tooltip attributes.** The ratchet explicitly ignores them (filters by lowercase tag name + no dot in the tag, i.e. components like `<Modal>` and `<Modal.Header>` are out of scope).

Legit component-prop usages you will see in code — keep these:

```tsx
// Modal / Sheet header — renders the visible dialog title bar.
<Modal title="Edit Control" description="Update the control's metadata.">
<Modal.Header title="Edit Control" description="…" />

// Shared Tooltip's own `title` prop — bold heading rendered above `content`.
<Tooltip title="SLA Breached" content={slaLabel}>
    <span className="badge badge-danger">SLA</span>
</Tooltip>
```

What the ratchet actually flags is a lowercase-tag HTML attribute:

```tsx
// ❌ raw HTML title attribute on a DOM element — this is what the ratchet catches
<button title="Delete row" onClick={…}>
<span  title="Custom role">…</span>
```

If a future code audit surfaces a "raw `title=` usage" list, cross-check the enclosing tag: uppercase / dotted → component prop (valid); lowercase → real HTML attribute (migrate).

---

## When NOT to add any micro-interaction

- **Labels that already explain themselves.** "Email" does not need a tooltip.
- **Fields with inline descriptions.** If `<FormField description=…>` is sufficient, don't stack a `hint=` on top.
- **Pages already dense with controls.** Pagination's `Previous/Next` buttons already have visible text — a tooltip would duplicate the label.
- **Row-level icons in a long list.** If each row has the same icon (unlink, edit), one `<Tooltip>` on the header or toolbar is enough; don't add one per row unless the semantics genuinely differ.
- **Values the user will never quote.** Full-text descriptions, free-form notes. Copy affordances belong on technical identifiers (codes, keys, slugs, hashes) that users actually paste into tickets.

Tooltip density is a real cost. Reviewers: treat "add a tooltip here" as a trade-off, not a default.

---

## Reference call sites

**Tooltip:**
- `src/components/ui/modal.tsx` — Close × on every modal (Tooltip with `shortcut="Esc"`).
- `src/components/ui/sheet.tsx` — same for Sheet.
- `src/components/ui/table/selection-toolbar.tsx` — batch actions, select-all, clear-selection.
- `src/components/ui/table/columns-dropdown.tsx` — Edit columns trigger.
- `src/components/ui/date-picker/calendar.tsx` — prev/next month + year navigation.
- `src/components/theme/ThemeToggle.tsx` — icon-only theme toggle.

**InfoTooltip / FormField hint:**
- `src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx` — scope `*` warning + No-expiry warning.
- `src/app/t/[tenantSlug]/(app)/admin/security/page.tsx` — MFA policy impact + session max age.
- `src/app/t/[tenantSlug]/(app)/admin/sso/page.tsx` — Enforce SSO + NameID Format.
- `src/app/t/[tenantSlug]/(app)/risks/NewRiskModal.tsx` — likelihood / impact scales.
- `src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx` — frequency + applicability justification.
- `src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx` — retention semantics.
- `src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx` — framework hint (via `<FormField hint="…">`).

**CopyButton / CopyText / useCopyToClipboard:**
- `src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx` — `KeyDisplay` show-once key (hook).
- `src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx` — new-token alert (hook) + endpoint URL (CopyButton).
- `src/app/t/[tenantSlug]/(app)/security/mfa/page.tsx` — setup key (hook).
- `src/app/t/[tenantSlug]/(app)/audits/packs/[packId]/page.tsx` — share link (CopyButton).
- `src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx` — task key (CopyText).
- `src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx` — control code + requirement codes in mappings table (CopyText).
- `src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx` — external ref (CopyText).

---

## Guardrails

Three ratchet tests enforce this strategy:

1. **`tests/guards/no-inline-clipboard.test.ts`** — fails if any file outside `src/components/ui/hooks/use-copy-to-clipboard.tsx` calls `navigator.clipboard.writeText`/`.write`. Forces migration to the hook or `CopyButton`/`CopyText`.
2. **`tests/guards/no-ad-hoc-tooltip-title.test.ts`** — caps the count of interactive `title=` attributes in `src/app/`. Lower it when you migrate a surface; never raise it.
3. **`tests/guards/tooltip-touch-uniformity.test.ts`** — keeps the tap-to-toggle path inside the primitive: one Radix Tooltip importer in `src/`, no pointer-class logic in any consumer, the pointer class derived from the internal hook rather than a prop, the `preventDefault()` and all three dismissal paths intact, and the rendered popup identical for both pointer classes. Its consumer sweep is derived, not curated, so a new call site is covered the day it is written.

All three run in the `node` Jest project and are cheap (~100 ms each). When they fire, the error message points at the exact file+line so the fix is obvious.
