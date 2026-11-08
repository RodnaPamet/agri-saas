# 2026-11-08 — scroll anchoring for a list that grows at the top (#2826)

**Commit:** `<pending>` feat(social): page up in a conversation, anchored

## Design

A chat timeline is the only surface in this product that grows at the TOP, and
`react-window@2.5.3` keys its measurement cache by INDEX — `getRowHeight(index)`
/ `setRowHeight(index, size)` — with `itemKey` removed in v2. So prepending a
page of older messages re-points every cached height at a different message.
`observeRowElements` re-measures what is on screen, so the visible window
corrects itself; the estimated extent above the reader stays wrong until it has
been scrolled through. A scroll OFFSET is therefore not restorable.

```
  page: "Older messages"
     │
     ├─ anchor = timeline.anchor()      ← BEFORE the fetch
     │     { key: 'm11', offsetInViewport: -20 }
     ├─ GET /api/social/conversations/{id}?before=<cursor>
     ├─ setOlder([...fresh, ...kept])   ← page state, deduped by id
     ▼
  useLayoutEffect  (after the commit, before paint)
     └─ timeline.restore(anchor)
            scrollTop = max(0, rowTopOf(el) - offsetInViewport)
```

## Files

| file | role |
|---|---|
| `src/components/chat/message-timeline.tsx` | owns the scroller in both branches; `anchor()` / `restore()`; `anchoredScrollTop`, `rowTopOf` |
| `src/components/ui/virtualized-list.tsx` | `data-virtualized-viewport` names react-window's scroll element |
| `…/dm/[conversationId]/DmConversationClient.tsx` | the older-page accumulator, the control, the capture/restore |
| `messages/{en,bg}/app.json` | `chat.loadOlder`, `chat.loadingOlder` |
| `tests/rendered/chat-scroll-anchoring.test.tsx` | NEW |
| `docs/list-virtualization.md` | the section this phase was tracked in |

## Decisions

- **The TIMELINE owns the scroll element; the PAGE owns the policy.** The page
  used to wrap the timeline in its own `overflow-y-auto`, which worked only
  because nothing paged up: the windowed branch scrolls itself, so with both
  branches live there were two scrollers and a prepend had to be anchored in
  whichever one happened to be real. Moving the element in is what #2826 means
  by "the timeline must own its scroll container in both branches".

  The policy stays in the page because only the page knows a prepend is
  happening. A timeline that anchored on every render would impose one policy
  on every future consumer — the argument `<SwipeRow>` makes for committing
  nothing.

- **The anchor is a row IDENTITY plus an offset**, never a scroll position.
  `{ key, offsetInViewport }`, and `restore()` recomputes from where that row
  ended up.

- **`data-virtualized-viewport` rather than a third verb on
  `VirtualizedListHandle`.** `scrollToItem` / `scrollTo` address rows by INDEX,
  and an index is exactly what a prepend invalidates — so the anchoring
  consumer needs the ELEMENT, not another verb. Epic 68's two-seam rule is the
  other reason: a third verb is a bigger thing to reimplement when the
  windowing engine is swapped.

- **`useLayoutEffect`, not `useEffect`.** An effect runs after paint, so the
  reader would see one frame at the wrong position — which is the jump this
  phase is about.

- **The anchor is captured BEFORE the fetch.** Between the two the reader may
  scroll, and an anchor read after the await would record where they ended up
  rather than where the prepend has to put them back. A failed page clears it,
  because an anchor left set would restore on some later commit and move the
  reader for no reason they can see.

- **Older pages live in PAGE state, not in the SWR cache.** The 30-second poll
  replaces the newest page wholesale; folding older pages into that cache would
  make every poll either discard them or merge them. Deduped by id, because the
  newest page is a moving window and a page boundary can overlap — a duplicate
  row would get a duplicate React key and an anchor matching two elements.

- **`restore()` is a NO-OP when the row is gone.** In the windowed branch a
  prepend keeps the anchor row rendered (it was visible) and in the plain
  branch every row is in the DOM, so a missing element means the row was
  deleted between the two calls. Guessing a position for it is worse than
  leaving the reader put.

- **The clamp at zero is not defensive tidying.** A prepend can leave the
  anchor nearer the top than it was — the reader was already at the very top
  and asked for more. The browser silently coerces a negative `scrollTop`,
  which would make a wrong answer look right, so the clamp is in a pure
  function where it can be asserted.

- **`rowTopOf` prefers an inline `style.top`** because the windowed branch
  absolute-positions rows from one: react-window writes the position it
  decided, and `offsetTop` is the browser's reading of it. It ignores a
  non-pixel value — `top: auto` is what an unpositioned element reports, and
  `parseFloat('auto')` is NaN, which would propagate into a `scrollTop`
  assignment and send the reader to the top of the thread.

- **jsdom has no layout engine**, so the arithmetic and the position reader are
  exported and tested as pure functions, and the DOM half runs with `offsetTop`
  / `offsetHeight` DEFINED on the row elements. That is not a simulation of
  layout: it supplies the one input the algorithm reads, so the real `anchor()`
  / `restore()` run against real elements.

- **The day pill is a row, and the first draft of the test forgot it.** It
  expected `m12` at `scrollTop` 120 and got `m11`; the implementation was right.
  The test now asserts the full row-key list first, so the pill is visible to a
  reader rather than being an off-by-one waiting to happen.
