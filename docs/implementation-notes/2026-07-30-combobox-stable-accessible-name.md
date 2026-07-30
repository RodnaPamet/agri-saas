# 2026-07-30 — Combobox: a stable accessible name from the FormField label

**Commit:** `ac675047` fix(a11y): name the Combobox trigger from its FormField label

## Design

`<Combobox>`'s trigger computed its accessible name like this:

```ts
buttonProps["aria-label"] ?? (selectedTriggerText || placeholder || t("combobox.selectAriaFallback"))
```

With no explicit `buttonProps["aria-label"]` — the common case — the name
was **the selected option's label**. Two harms:

- A screen-reader user hears a control whose name changes as they use it,
  and never hears the author's intended label. WAI-ARIA is explicit that a
  combobox's *name* comes from its label while its *value* is conveyed
  separately (trigger content + `aria-expanded`).
- `getByRole('combobox', { name })` was unusable as a locator, because the
  name only holds until the next selection. The wave-23 suites had to
  resolve pickers through their FormField label instead.

Note this was never "a prop is being dropped": `aria-label` is not a
declared `Combobox` prop, and the `{...props}` spread near the end of the
file goes to an inner element. The fallback chain itself was the issue.

**The fallback is deliberate and stays.** Its comment explains that it
guarantees axe's `button-name` rule passes even when the Button's children
render as a ReactNode tree assistive tech will not flatten into text. It is
now the *last* resort rather than the *only* one.

The fix threads `aria-labelledby` from the field's visible label.

```
<FormField label="Crop">                    ← owns controlId + labelId
  └─ <Label id={controlId}-label htmlFor={controlId}>Crop</Label>
  └─ cloneElement(child, { id, aria-labelledby: labelId, aria-describedby, … })
        └─ <Combobox aria-labelledby="…-label">
              └─ <button role="combobox" aria-labelledby="…-label">Wheat</button>
                                          ↑ name: "Crop" (stable)
                                                        ↑ value: content
```

`FormField` already owned the label↔control id wiring (`htmlFor`, the
`aria-describedby` chain, `aria-invalid`, `aria-required`, `invalid`), so
this is a sixth injected prop on the same `cloneElement`, not a parallel
mechanism. It previously generated only a *control* id; the `<Label>` now
also carries an id so it can be referenced.

`htmlFor` alone could not fix this. It does name a native labelable control
— and a `<button>` is labelable — but `aria-label` outranks the
host-language label in the accname algorithm, so the fallback shadowed the
field label whenever both were present.

### Final precedence

| # | Source | Emitted attribute |
|---|--------|-------------------|
| 1 | `buttonProps["aria-label"]` (caller named it outright) | `aria-label` |
| 2 | `aria-labelledby` (normally injected by `<FormField>`) | `aria-labelledby` |
| 3 | collapsed selection labels → placeholder → `combobox.selectAriaFallback` | `aria-label` |

**Exactly one of `aria-label` / `aria-labelledby` is ever emitted.** An
element carrying both, pointing at different text, is ambiguous: the
`aria-labelledby` wins in the accname algorithm and the `aria-label`
silently does nothing, so a reader of the DOM cannot predict the computed
name. Rather than emit a dead attribute, the branch that loses is left
`undefined` and React omits it.

`UserCombobox` and `AsyncCombobox` both wrap the primitive and both already
threaded `aria-describedby` by hand; `aria-labelledby` is threaded the same
way so the shared primitives behave uniformly rather than per-call-site.

## Files

| File | Role |
|---|---|
| `src/components/ui/form-field.tsx` | Gives the `<Label>` an id; injects `aria-labelledby` into the cloned child (override, not merge — see Decisions). |
| `src/components/ui/combobox/index.tsx` | Declares the `aria-labelledby` prop; splits the name computation into explicit / labelledby / fallback so exactly one attribute is emitted. |
| `src/components/ui/user-combobox.tsx` | Threads `aria-labelledby` to both the single- and multi-select `<Combobox>`. |
| `src/components/ui/async-combobox.tsx` | Same, for both branches. |
| `tests/rendered/combobox-stable-accessible-name.test.tsx` | Executing proof: name stable across a selection change, the precedence chain, the surviving fallback, axe. |
| `tests/guards/rendered-coverage-floor.test.ts` | `RENDERED_TEST_FLOOR` 223 → 224. |
| `docs/primitives-api-reference.md` | Replaces the one-line "name comes from `aria-label`" claim with the real chain. |

## Decisions

- **`aria-labelledby` overrides rather than merges**, unlike the additive
  `aria-describedby` chain right beside it in `FormField`. Descriptions
  accumulate; a *name* does not. A caller who writes
  `aria-labelledby="external"` on the child means to replace the field
  label, not to be concatenated after it.
- **`FormField` injects the prop for every child, not just comboboxes.**
  For a native control the injected `aria-labelledby` names it from the same
  `<Label>` element that `htmlFor` already pointed at, so the computed name
  is byte-identical — it is a no-op there. Gating the injection on "is this
  a Combobox?" would mean `FormField` sniffing its child's type, which is
  exactly the parallel mechanism this change avoids.
- **The name does not include the selected value.** Some select-only
  combobox implementations use `aria-labelledby="label self"` so the name
  reads "Crop Wheat". That reintroduces the drift this change exists to
  remove, and it would break the role-locator use case. The value stays
  where WAI-ARIA puts it: the trigger's own text content.
- **The required marker cannot leak into the name.** `RequiredMarker` is
  `aria-hidden`, so name-from-`aria-labelledby` computes "Crop", not
  "Crop *". A rendered test pins this, because it is the kind of thing a
  future change to `RequiredMarker` would break silently.
- **A `<FormField>` with no `label` emits no label id**, so the fallback
  stays in charge there. Pointing `aria-labelledby` at a non-existent or
  empty element would produce an empty accessible name — the exact failure
  the fallback exists to prevent.
