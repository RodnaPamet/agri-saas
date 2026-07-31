# Primitives API reference

Concise prop tables + usage patterns for the Epic 54/55 primitives. Complements the decision-tree docs (`modal-sheet-strategy.md`, `combobox-form-strategy.md`) — use those to *pick* a primitive, use this to *call* one.

All primitives live under `src/components/ui/`. Every one:
- is a client component (`"use client"` at the top),
- paints on semantic tokens (`bg-bg-*`, `content-*`, `border-border-*`),
- supports `aria-*` forwarding,
- has source-contract tests under `tests/unit/epic5?-*.test.ts` and (for Epic 55 primitives) rendered tests under `tests/rendered/`.

---

## `<Modal>`

CRUD dialog with responsive mobile fallback (Radix Dialog on desktop → Vaul Drawer on mobile).

```tsx
<Modal
  showModal={open}
  setShowModal={setOpen}
  size="lg"
  title="New control"
  description="Create a custom control for your register."
  preventDefaultClose={saving}
>
  <Modal.Header title="New control" description="…" />
  <Modal.Form onSubmit={handleSubmit} id="new-control-form">
    <Modal.Body>{/* fields */}</Modal.Body>
    <Modal.Actions>
      <button type="button">Cancel</button>
      <button type="submit">Save</button>
    </Modal.Actions>
  </Modal.Form>
</Modal>
```

| Prop | Type | Notes |
|---|---|---|
| `showModal` | `boolean` | Controlled open state. |
| `setShowModal` | `Dispatch<SetStateAction<boolean>>` | Required when `showModal` is set. |
| `size` | `"xs" \| "sm" \| "md" \| "lg" \| "xl" \| "full"` | Default `"md"`. `xs` for confirm, `sm` for single-field, `lg` for CRUD forms. |
| `title` | `string` | Accessible name. Falls back to `"Dialog"`. |
| `description` | `string` | Supplemental `aria-describedby`. |
| `preventDefaultClose` | `boolean` | Blocks Escape / outside-click close; used during in-flight submit. |
| `desktopOnly` | `boolean` | Forces desktop Dialog on mobile (rare). |
| `drawerRootProps` | Vaul `DrawerProps` | Passed through to Vaul on mobile. |

Slots: `Modal.Header`, `Modal.Body`, `Modal.Form`, `Modal.Actions`.

---

## `<Sheet>`

Persistent side panel for inspect + quick-edit flows. Right-side on desktop, bottom-drawer on mobile.

```tsx
<Sheet
  open={!!selectedId}
  onOpenChange={(v) => { if (!v) setSelectedId(null); }}
  size="md"
  title="Control detail"
  description="Quick edit"
>
  <Sheet.Header title="Control detail" description="…" />
  <Sheet.Body>{/* read-only summary + editable fields */}</Sheet.Body>
  <Sheet.Actions align="between">
    <Link href={…}>Open full detail →</Link>
    <div>
      <Sheet.Close asChild><Button variant="secondary" size="sm">Cancel</Button></Sheet.Close>
      <Button type="submit" disabled={!canSave}>Save</Button>
    </div>
  </Sheet.Actions>
</Sheet>
```

| Prop | Type | Notes |
|---|---|---|
| `open` | `boolean` | Vaul DialogProps — controlled open. |
| `onOpenChange` | `(open: boolean) => void` | Vaul DialogProps callback. |
| `size` | `"sm" \| "md" \| "lg" \| "xl"` | Desktop widths: 420/540/720/960 px. Default `"md"`. |
| `direction` | `"responsive" \| "right" \| "bottom"` | Default `"responsive"` — right on desktop, bottom on mobile. |
| `title` | `string` | Accessible name. |
| `description` | `string` | `aria-describedby`. |
| `nested` | `boolean` | Use `Drawer.NestedRoot` when inside another drawer. |

---

## `<Combobox>`

Searchable single/multi-select picker. Replaces native `<select>` across CRUD forms.

```tsx
<Combobox<false, MyMeta>
  id="risk-template-select"
  name="templateId"
  options={templates}
  selected={selectedOpt}
  setSelected={setSelectedOpt}
  loading={query.isLoading}
  placeholder="— No template"
  searchPlaceholder="Search templates…"
  emptyState="No templates match"
  matchTriggerWidth
  forceDropdown       // use inside Modal/Sheet
  invalid={hasError}
  aria-describedby={descriptionId}
  caret
/>
```

| Prop | Type | Notes |
|---|---|---|
| `options` | `ComboboxOption<TMeta>[]` | Each has `value`, `label`, optional `icon` / `meta` / `disabledTooltip` / `first` / `separatorAfter`. |
| `selected` | `ComboboxOption \| null` (single) / `ComboboxOption[]` (multi) | Controlled selection. |
| `setSelected` | setter matching the multi-ness | Required when `selected` is set. |
| `multiple` | `boolean` | Default false. Discriminates the above two signatures at the type level. |
| `loading` | `boolean` | Shows a spinner in the results panel. `undefined options` also triggers this. |
| `placeholder` | `ReactNode` | Trigger text when empty. |
| `searchPlaceholder` | `string` | Default from `COMBOBOX_DEFAULT_MESSAGES.searchPlaceholder` (localisable via `getComboboxMessages(t)`). |
| `emptyState` | `ReactNode` | Shown when filtering returns 0 rows. |
| `onCreate` | `(search: string) => Promise<boolean>` | Enables async "Create …" row. Return true on success. |
| `invalid` | `boolean` | Paints error-border trigger + sets `aria-invalid`. |
| `id` / `name` | `string` | Preserves E2E selectors + enables native form serialisation. |
| `matchTriggerWidth` | `boolean` | Popover width matches the trigger. |
| `forceDropdown` | `boolean` | Desktop popover even on mobile (use inside Modal/Sheet). |
| `hideSearch` | `boolean` | Drop cmdk's search input — compact 4–7 option menus. |
| `trigger` | `ReactNode` | Custom trigger. Pass-through `id`/`aria-*`/`invalid` via cloneElement. |

Accessible name precedence, highest first:

1. `buttonProps["aria-label"]` — an explicit caller-supplied name.
2. `aria-labelledby` — the id of the element holding the visible label.
   `<FormField>` injects its own `<Label>` id, so a combobox inside a
   field is named after that label. This is the branch you want: the
   name stays **stable** while the selection changes (WAI-ARIA puts the
   name on the label and conveys the value separately, via the trigger's
   text content + `aria-expanded`), which also makes
   `getByRole('combobox', { name })` usable as a test locator.
3. Collapsed selection labels, then the placeholder — the last-resort
   `aria-label` fallback that guarantees axe's `button-name` rule passes
   even when the trigger's children are a ReactNode tree assistive tech
   won't flatten. Do not remove it.

Exactly one of `aria-label` / `aria-labelledby` is emitted — never both.
Trigger gets `role="combobox"` + `aria-haspopup="listbox"`.

Messages module: `import { COMBOBOX_DEFAULT_MESSAGES, getComboboxMessages } from "@/components/ui/combobox"` — pass through next-intl translator.

---

## `<UserCombobox>`

People picker. Tenant-scoped member fetch, single or multi.

```tsx
<UserCombobox
  id="sheet-owner-input"
  name="ownerUserId"
  tenantSlug={tenantSlug}
  selectedId={form.owner || null}
  onChange={(userId) => update('owner', userId ?? '')}
  placeholder="Unassigned"
  forceDropdown
  disabled={!canWrite}
/>
```

| Prop | Type | Notes |
|---|---|---|
| `tenantSlug` | `string` | Required — fetch is scoped to this tenant. |
| `selectedId` / `selectedIds` | `string \| null` / `string[]` | Discriminated by `multiple`. |
| `onChange` | `(userId, member)` / `(userIds, members)` | Typed member rides along. |
| `preloadedMembers` | `Member[]` | Skip the fetch when server-rendered pages already have the list. |
| `filter` | `(m: Member) => boolean` | Client-side scoping (only certain roles, only ACTIVE, …). |
| `multiple` | `boolean` | Opt-in for reviewer/subscriber flows. |
| `invalid`, `disabled`, `required`, `aria-describedby` | FormField-compatible | Forwarded to the underlying Combobox. |

Shared hook: `useTenantMembers(tenantSlug)` — direct fetch if you need the list outside a Combobox.

---

## `<FormField>`

One field: label + control + description + error. Auto-wires `htmlFor`, `aria-describedby`, `aria-invalid`, `aria-required`, and `invalid` (via cloneElement) into a single child control.

```tsx
<FormField
  label="Title"
  description="Shown on audit reports."
  error={errors.title}
  required
>
  <Input value={form.title} onChange={…} />
</FormField>
```

| Prop | Type | Notes |
|---|---|---|
| `label` | `ReactNode` | Omit for label-less fields. |
| `description` | `ReactNode` | Hidden when `error` is set. |
| `error` | `string` | Sets `invalid` + renders `<FormError>` with `role="alert"` + `aria-live="polite"`. |
| `required` | `boolean` | Visual `*` (`aria-hidden`) + `aria-required` on the control. |
| `orientation` | `"vertical" \| "horizontal"` | Horizontal for checkbox/switch rows. |
| `children` | Single React element | Must accept the injected props. |

Composes: `<FormDescription>`, `<FormError>` (both exported standalone).

---

## `<FieldGroup>`

Grid/stack layout for multiple fields with optional section header.

```tsx
<FieldGroup title="Contact" description="How we'll reach you" columns={2}>
  <FormField label="Email"><Input /></FormField>
  <FormField label="Phone"><Input /></FormField>
</FieldGroup>
```

| Prop | Type | Notes |
|---|---|---|
| `title` | `ReactNode` | Adds `role="group"` + `aria-labelledby`. |
| `description` | `ReactNode` | Muted hint under title. |
| `columns` | `1 \| 2 \| 3` | Responsive grid. `2` → `grid-cols-1 sm:grid-cols-2`. |
| `gap` | `"sm" \| "md" \| "lg"` | Default `"md"` (`gap-4`). |
| `titleAs` | `"h2" \| "h3" \| "h4"` | Default `"h3"`. |

---

## `<Input>` / `<Textarea>` / `<Checkbox>` / `<RadioGroup>` / `<Switch>` / `<Label>`

CVA-sized primitives on semantic tokens. Shared props across all:

- `invalid?: boolean` — paints error border (+ `data-invalid=""` on Radix-based primitives).
- `aria-invalid` / `aria-describedby` / `aria-required` forwarded.
- `size?: "sm" | "md" | "lg"` on Input/Checkbox/RadioGroup/Switch.
- Native element attributes passthrough.

Example:

```tsx
<Input
  size="md"
  value={email}
  onChange={(e) => setEmail(e.target.value)}
  error={errors.email}      // renders inline role=alert
  description="Audit reports only."
/>
```

---

## `useZodForm`

Client-side form state + validation from a server-side Zod schema.

```tsx
const form = useZodForm({
  schema: CreateControlSchema.pick({ name: true, category: true }),
  defaults: { name: '', category: '' },
  serverErrors,
});

<FormField label="Name" error={form.fieldError('name')} required>
  <Input
    value={form.values.name}
    onChange={(e) => form.setField('name', e.target.value)}
    onBlur={() => form.touchField('name')}
    invalid={form.isFieldInvalid('name')}
  />
</FormField>

<button disabled={!form.canSubmit} onClick={async () => {
  const result = form.validate();
  if (result.success) await submit(result.data);
}}>Save</button>
```

Returns: `values`, `setField`, `setValues`, `touchField`, `touched`, `errors`, `fieldError`, `isFieldInvalid`, `reset`, `validate`, `canSubmit`. Errors are hidden until the field is touched (or `validate()` is called, which touches everything).

---

## `useFormTelemetry`

Lifecycle instrumentation on any form. Events flow to a global sink registered at app boot via `registerFormTelemetrySink(sink)`.

```tsx
const telemetry = useFormTelemetry('NewControlModal');

const handleSubmit = async () => {
  telemetry.trackSubmit({ hasCategory: !!form.category });
  try {
    const control = await createControl();
    telemetry.trackSuccess({ controlId: control.id });
  } catch (err) {
    telemetry.trackError(err);
  }
};
```

Emits: `open` (on mount), `submit`, `success`, `error`, `abandon` (on unmount without a success). Sink throws are swallowed — never bubble into user-facing code.

---

## Related docs

- `docs/modal-sheet-strategy.md` — when to use each overlay.
- `docs/combobox-form-strategy.md` — when to use each form primitive.
- `docs/adr/0001-ui-primitive-stack.md` — stack-choice rationale.
- `tests/rendered/` — render tests demonstrating every primitive interactively.
