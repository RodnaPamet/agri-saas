# List virtualization — the windowed-rendering convention

Epic 68 introduced a single shared windowing primitive
(`<VirtualizedList>`) and rolled it out across two high-volume
surfaces (`<DataTable>` row bodies + `<Combobox>` / `<UserCombobox>`
dropdowns). Every future high-scale list MUST use the same primitive.

This doc is the contract. If you find yourself importing
`react-window` directly, or hand-rolling a windowed renderer in a
component file, you're inventing a one-off and review will ask you
to convert it.

## Why this pattern

A non-virtualized 1000-row table or 1000-option dropdown puts every
row/option in the DOM:

- Initial render scales O(n) — expensive for large datasets.
- Browser layout + paint costs scale with DOM count.
- Memory + GC pressure scale with React's virtual DOM size.
- Scroll perf degrades as the browser re-paints sticky decorations
  on every scroll event.

Virtualization renders only the visible window plus a small overscan.
Initial render is constant-time relative to the viewport. The DOM
stays under ~30 nodes regardless of dataset size.

## The primitive — `<VirtualizedList>`

```tsx
import { VirtualizedList } from '@/components/ui/virtualized-list';

<VirtualizedList
  itemCount={1000}
  itemSize={44}
  renderItem={({ index, style }) => (
    <div style={style}>{rows[index].name}</div>
  )}
/>
```

Rules:

1. **Spread `style` on the outer element of `renderItem`.** react-window
   absolute-positions rows; without `style` they all stack at top.
2. **Provide `height` (and optionally `width`) when AutoSizer can't
   reach a sized parent.** In production code paths (inside
   `<ListPageShell.Body>`'s flex chain) AutoSizer measures correctly.
   In test harnesses or ad-hoc layouts, pass `height` explicitly.
3. **Use the `ref` for keyboard-driven surfaces.** The exposed
   `VirtualizedListHandle` carries `scrollToItem(index)`,
   `scrollTo(offset)`, and `resetAfterIndex(index)` (variable-size).
4. **Use `itemKey` only when row identity matters across sorts/shuffles.**
   For static lists the index-keyed default is fine.
5. **Don't import `react-window` directly.** The primitive is the
   single seam — replacing the engine later is a one-file change.
6. **Rows that must be MEASURED take `dynamicRowHeight`, not `itemSize`**
   (P8.3, #2797). `itemSize` covers a fixed height and a deterministic
   function of the index; a chat bubble is neither, because its height
   depends on how its text wraps at the current width. react-window
   absolute-positions rows from the height it is given, so an estimate
   there is not a near-miss but overlapping rows.

   ```tsx
   <VirtualizedList
     itemCount={rows.length}
     dynamicRowHeight={{ defaultRowHeight: 64 }}   // first paint only
     height={600}
     renderItem={({ index, style }) => <div style={style}>…</div>}
   />
   ```

   `defaultRowHeight` is the pre-measurement estimate and decides nothing
   after the first frame. Pass `dynamicRowHeight` OR `itemSize`; passing
   neither throws, because without one row positions cannot be computed
   and silently defaulting would produce a broken layout with nothing
   failing.

## Measured heights and a list that grows at the TOP

A chat timeline is the one surface here that grows at the top while the
viewport is pinned to the bottom, and it is worth knowing what that costs
before building a second one.

**react-window v2's measurement cache is keyed by INDEX**, not by row
identity — `DynamicRowHeight` is `getRowHeight(index)` /
`setRowHeight(index, size)` — and v2 **removed `itemKey`** (rule 4 above;
`<VirtualizedList>` still accepts the prop and ignores it, with the reason
in its docblock). So prepending a page of older rows re-points every
cached height at a different row. The visible window corrects itself —
`observeRowElements` re-measures what is on screen — but the rows above
keep heights that now belong to their neighbours, so the estimated extent
of the content above the viewport is wrong until it has been scrolled
through.

**What that does NOT break: the node budget.** Measured 2026-11-07 on a
1,200-row timeline paged up three times by 200 — ≤30 rendered row nodes
after every prepend
(`tests/rendered/chat-primitives.test.tsx` → "keeps the node budget after
PREPENDING older pages").

**What it does mean for a caller:** a surface that prepends owes its own
scroll anchoring — hold the previously-top row and restore to it after the
rerender, rather than trusting the scroll offset.

**Built for the chat timeline in #2826**, and the split is worth copying:

- `MessageTimeline` owns its SCROLL ELEMENT in both branches, and exposes
  `anchor()` / `restore()` on a ref. It had to: the windowed branch scrolls
  itself while the plain branch was scrolled by the page, so with both live
  there were two scrollers and a prepend had to be anchored in whichever one
  happened to be real.
- The PAGE decides WHEN — capture before the fetch, restore in a
  `useLayoutEffect` after the commit that adds the rows. Only the page knows a
  prepend is happening, and a timeline that anchored on every render would
  impose one policy on every future consumer.
- The anchor is `{ key, offsetInViewport }` — a row IDENTITY plus how far below
  the viewport's top edge it was sitting. Never an offset: inserting rows above
  the viewport moves every row down by a distance nobody knows until they are
  measured, which is this whole section.
- `<VirtualizedList>` gained `data-virtualized-viewport` so a consumer can
  reach react-window's scroll element. An ATTRIBUTE rather than a third verb on
  `VirtualizedListHandle`, because `scrollToItem` / `scrollTo` address rows by
  INDEX and an index is exactly what a prepend invalidates.
- `restore()` is a NO-OP when the anchor row is no longer rendered. Guessing a
  position for a row that was deleted between the two calls is worse than
  leaving the reader put.
- `useLayoutEffect`, not `useEffect`: an effect runs after paint, so the reader
  would see one frame at the wrong position — which IS the jump.

jsdom has no layout engine, so the arithmetic (`anchoredScrollTop`) and the
position reader (`rowTopOf`) are exported and tested as pure functions, and the
DOM half runs with `offsetTop` / `offsetHeight` DEFINED on the row elements.
That is not a simulation of layout: it supplies the one input the algorithm
reads, so the real `anchor()` / `restore()` run against real elements.

## Rolled-out surfaces

### `<DataTable>` rows (auto above 1000)

`<DataTable>` accepts `virtualize?: boolean | { threshold: number }`:

| Caller passes | Result |
|---|---|
| Nothing (default) | Auto-virtualize when `data.length > 1000` |
| `virtualize={true}` | Always virtualize |
| `virtualize={false}` | Never virtualize (Controls page contract) |
| `virtualize={{ threshold: N }}` | Auto with custom threshold |

The default threshold was raised from 100 → 1000 in a follow-up
because the lower threshold caused click-intercept regressions in
medium-sized tables (100-1000 rows) where the virtualized div
wrapper sat above row interactions in Playwright. The 1000 default
scopes auto-virtualization to genuinely large unpaginated tables;
pages that need it for smaller datasets should opt in explicitly.

When virtualized, `<DataTable>` renders via `<VirtualTable>` (file:
`virtual-table-body.tsx`):

- `display: grid` for headers + every body row.
- A single `gridTemplateColumns` value derived from
  `column.getSize()` — header + body share it, alignment cannot drift.
- Sticky header inside react-window's outer scroll container.
- Identical contract for: `data-selected`, `group/row`, click handlers
  with `isClickOnInteractiveChild` guard, sort buttons.

Auto-disable conditions (even when threshold met): server-side
pagination, `error` / `loading` / empty states. The non-virtual
`<Table>` retains the richer chrome.

Limitations vs `<Table>` — DataTable falls back automatically:
- column resizing
- column pinning

### `<Combobox>` / `<UserCombobox>` dropdowns (auto above 50)

`<Combobox>` switches to `<VirtualizedComboboxOptions>` when the
visible (post-search-filter) option count exceeds
`COMBOBOX_VIRTUALIZE_THRESHOLD = 50`.

What's preserved:
- Selection state (single + multi).
- Search filtering (cmdk's input + our internal `sortOptions`).
- Keyboard nav: ArrowDown / ArrowUp / Home / End / Enter — bound to
  the search input via a CAPTURE-phase listener that runs BEFORE
  cmdk's nav.
- Hover ↔ keyboard agreement: hovering a row updates the active
  index just like ArrowDown would.
- Scroll-to-active: `VirtualizedListHandle.scrollToItem(activeIndex)`
  fires every time the active index changes.
- ARIA: outer `role="listbox"` + `aria-activedescendant` pointing to
  a stable id; each option is `role="option"` + `aria-selected`.

What changes for users: nothing visually. The visual-parity test
(`tests/rendered/combobox-virtualize.test.tsx::"first option's visual
contract matches at the 50/51 boundary"`) locks the visual contract
in: the same flex structure, padding, and class fragments at 50 vs
51 options.

`<UserCombobox>` is a thin wrapper over `<Combobox>` — it
auto-virtualizes for free when an org has >50 members.

## Performance budget

The benchmark test in `tests/rendered/combobox-virtualize.test.tsx::"1000-option
mount stays under a sane wall-clock budget AND DOM stays small"`
guards two invariants:

1. **DOM count** — for any list above the threshold, the visible
   option/row count is `<= 30`. This is the load-bearing perf win;
   if it regresses (e.g. accidental `data` prop carrying all rows),
   the test fails.
2. **Wall-clock initial render** — 1000-option mount + open completes
   in `<2s` on the CI runner. Generous to absorb jitter; the point is
   to catch order-of-magnitude regressions, not to enforce a tight
   budget.

The DataTable side has its own DOM-count test
(`tests/rendered/data-table-virtualize.test.tsx::"5000-row virtualized
table renders far fewer than 5000 row nodes"`).

## Adding a new high-scale list

Decision tree:

1. **Is it a table?** Use `<DataTable>` — virtualization is automatic
   above 100 rows. Don't think about it.
2. **Is it a combobox-style picker?** Use `<Combobox>` — virtualization
   is automatic above 50 options. Don't think about it.
3. **Is it neither (e.g. activity feed, comment list)?** Use
   `<VirtualizedList>` directly with the contract above. Add the
   surface to a structural ratchet so future PRs can't silently swap
   in a non-windowed renderer.

When NOT to virtualize:

- Lists with **inherently variable, hard-to-measure row heights** that
  change AFTER mount (e.g. content with images that finish loading
  later). `VariableSizeList` mode requires deterministic per-index
  heights; for true dynamic measurement use the lower-level
  `react-window` API directly.
- Lists where **every row is independently focusable** in a way that
  needs roving tabindex across all items. The combobox bespoke
  keyboard layer covers most cases — but if you need full menu-style
  navigation, talk to the platform team first.
- Lists **smaller than the threshold**. Virtualization adds
  overhead; below the threshold the cost outweighs the benefit. Both
  primitives auto-disable for this reason.

## Foundation reference

| File | Role |
|---|---|
| `src/components/ui/virtualized-list.tsx` | Shared primitive — wraps `react-window` `Fixed/VariableSizeList` + `AutoSizer`; exposes `VirtualizedListHandle` (scrollToItem/scrollTo/resetAfterIndex) |
| `src/components/ui/table/virtual-table-body.tsx` | `<VirtualTable>` — DataTable's virtualized body + sticky header |
| `src/components/ui/table/data-table.tsx` | `decideVirtualization()` + threshold prop wiring |
| `src/components/ui/combobox/virtualized-options.tsx` | Combobox's virtualized option list with bespoke keyboard layer |
| `tests/rendered/virtualized-list.test.tsx` | 11-case primitive contract |
| `tests/rendered/data-table-virtualize.test.tsx` | 22-case DataTable rollout |
| `tests/rendered/combobox-virtualize.test.tsx` | 14-case Combobox rollout (threshold + DOM-count + keyboard + perf benchmark + visual parity) |
