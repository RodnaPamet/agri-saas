# 2026-11-07 — P8.3 chat primitives

**Commit:** `<pending> feat(chat): day pills, bubbles, divider, composer and a windowed timeline`

## Design

Five presentational components under `src/components/chat/`, plus one hook,
plus a dynamic-height extension to the Epic 68 primitive. Nothing here fetches,
mutates or knows a route: P8.4 mounts them on `/messages`.

```
MessageTimeline  ── flattens messages into a ROW LIST ──┬─ DayPill
  (virtualize? threshold 1000)                          ├─ NewMessagesDivider
        │                                               └─ MessageBubble
        │                                                   ├─ useLongPress (coarse)
        └─ above the threshold ─→                           └─ IconAction (always)
             VirtualizedList{dynamicRowHeight}

MessageComposer ─ Textarea + Button + useEnterSubmit + useKeyboardInset
```

The flattening is the load-bearing shape. react-window addresses rows by
index, so a nested "day → messages" tree has no index to address; day pills and
the divider therefore become rows alongside bubbles, and the windowed and plain
branches render the identical row list.

### The dynamic-height extension

`VirtualizedList` gained one optional prop, `dynamicRowHeight?: {
defaultRowHeight: number }`, and `itemSize` became optional. A chat bubble's
height is neither fixed nor a deterministic function of its index — it depends
on how its text wraps at the current width — and react-window
absolute-positions rows from the height it is given, so an estimate is not a
near-miss but overlapping rows.

What made this safe to put INSIDE the primitive rather than at the call site:
`react-window@2.5.3` exports `useDynamicRowHeight`, `List`'s `rowHeight`
accepts the `DynamicRowHeight` object it returns directly, and that object
measures through `observeRowElements` — which `List` owns. So the extension
forwards one value and changes nothing about the `renderItem` contract, and
Epic 68's two-seam rule holds: `virtualized-list.tsx` and
`virtual-table-body.tsx` are still the only two importers of react-window.

## Files

| file | role |
|---|---|
| `src/components/chat/day-pill.tsx` | `chatDayKey(at)` (Europe/Sofia) + the today/yesterday/date pill |
| `src/components/chat/new-messages-divider.tsx` | `role="separator"` carrying «Нови съобщения» |
| `src/components/chat/message-bubble.tsx` | one message: side, grouping, deleted/edited states, reactions |
| `src/components/chat/message-timeline.tsx` | `buildTimelineRows` + the plain/windowed branch |
| `src/components/chat/message-composer.tsx` | textarea + send, autosized, keyboard-inset aware |
| `src/components/chat/use-keyboard-inset.ts` | how many pixels the soft keyboard covers |
| `src/components/ui/hooks/use-long-press.ts` | coarse-pointer press-and-hold, exported from the barrel |
| `src/components/ui/virtualized-list.tsx` | `dynamicRowHeight` added; `itemSize` now optional |
| `messages/{bg,en}/app.json` | the `chat` namespace — five keys |
| `tests/rendered/chat-primitives.test.tsx` | 28 cases, both viewports |

## Decisions

- **One threshold, not two.** `virtualize?: boolean | { threshold: number }`
  mirrors `DataTable` exactly, including its raised 1000 (owner ruling
  2026-11-07). A farm with 1,200 messages in a thread and a farm with 1,200
  journal rows are the same problem; two thresholds is how one of them drifts.
  Below it the rows are plain DOM, which keeps find-in-page working on every
  normal thread.

- **The divider's position is a prop, never derived here.** `firstUnreadId` is
  held still by the caller. If the timeline recomputed it from `lastReadAt`,
  marking the thread read while the operator is looking at it would make the
  divider vanish under their eyes — the one thing a "new messages" marker must
  not do.

- **Grouping is by (sender, day), and the day half is not redundant.** Two
  messages from one person either side of Sofia midnight get a day pill between
  them, and a grouped bubble renders with no sender label and tight spacing —
  so grouping across a visible date boundary would read as one continuous run.
  A day pill and the divider each break the run for the same reason.

- **`modifier: 'auto'` is taken as-is, which means ⌘/Ctrl+Enter sends and bare
  Enter inserts a newline on EVERY device.** It does not branch on the pointer.
  A phone's return key carries no modifier, so on a phone the send button is
  the only way to send — which is why that button is always rendered and merely
  `disabled` while the body is blank, rather than appearing on the first
  keystroke and moving the layout under the thumb that is typing.

- **The keyboard inset is a hook, and it is the first `visualViewport` reader in
  the repo.** The layout viewport does not shrink when the soft keyboard opens;
  the visual one does, so the inset is `innerHeight - (vv.height +
  vv.offsetTop)`. `env(safe-area-inset-bottom)` is the home indicator, not the
  keyboard, and conflating them puts the composer 34px up on a device with no
  keyboard open. It is a hook rather than a CSS trick because a test can observe
  a number and cannot observe `100dvh` in jsdom — which would have made it a
  branch no rendered test could reach, the shape this suite keeps producing by
  accident. Absent API ⇒ zero inset, the safe direction.

- **A negative inset is clamped, and the clamp's justification was corrected.**
  The first comment said a negative value would lift the composer off the bottom
  edge. It would not: CSS forbids negative padding and the declaration is simply
  dropped. That mattered because the test asserting it was reading
  `style.paddingBottom` — so removing the clamp reddened nothing, and the
  assertion was grading the CSSOM's sanitisation rather than the code. It reads
  the hook's value now, and the mutation fails.

- **`onSend` is called from a plain closure, not inside a `setState` updater.**
  The first draft read the body inside `setBody((current) => …)` to dodge a
  stale closure. There is no stale closure — every keystroke re-renders and
  re-attaches `onKeyDown` — and React 19 invokes updaters twice precisely to
  surface that impurity, so the side effect would have fired twice per send.

- **One property is asserted on the SOURCE.** jsdom has no layout engine, so
  every row is 0px tall and a fixed `itemSize` produces byte-identical DOM to a
  measured one; the breakage is only visible in a real browser. §10 of the suite
  therefore reads `message-timeline.tsx` and requires `dynamicRowHeight` with no
  `itemSize`. Same precedent as the `take: limit + 1` bound in P8.2, which was
  likewise invisible in the response.

- **The long press is an enhancement over a control, never the control.**
  `<SwipeRow>` states the rule and `useLongPress` inherits it: a gesture is
  invisible to a keyboard and to a screen reader, so a gesture-only reaction is
  a reaction some people cannot make. The same callback therefore sits on an
  `<IconAction>` that is in the DOM whether or not anybody pressed anything —
  `opacity-0`, revealed on hover and focus, because `hidden` would not be
  tabbable. It attaches on `(hover: none), (pointer: coarse)` using the SAME
  query string as `tooltip.tsx`, so one answer governs every touch affordance
  rather than two that can disagree, and it calls `preventDefault()` nowhere:
  #449 put it on a tooltip trigger's `onPointerDown` and made every wrapped
  link inert on touch.

- **Swipe-to-reply is deliberately absent (#2829).** `DirectMessage` carries no
  `replyToMessageId`, so there is nothing for a reply to point at — the quoted
  message would live in the composer's local state and vanish on send — and
  P8's rule ships schema a release ahead of the code that writes it. Working
  around that inside a component would be the wrong place to put a schema
  decision.

- **Four of the primitive's contract rules were fine; rule 4 is the one a chat
  timeline stresses, and its answer is "not available".** react-window v2's
  measurement cache is keyed by INDEX (`getRowHeight(index)` /
  `setRowHeight(index, size)`) and v2 REMOVED `itemKey`, so prepending older
  messages re-points every cached height at a different message. The node
  budget survives — measured, 1,200 rows paged up three times by 200, ≤30
  nodes every time — but the extent of the content ABOVE the viewport is
  mis-estimated until it is scrolled through, so a prepending caller owes its
  own scroll anchoring. Recorded in `docs/list-virtualization.md` and tracked
  on #2826, a prerequisite for P8.4's paging. (The issue asked about "four"
  contract rules; the doc has five, now six.)

- **«Нови съобщения» did NOT already exist in the catalogues.** #2797 says it
  does, with 4 values in the exchange messaging namespace. Measured: those four
  are «Съобщения» (`exchange.messaging.{breadcrumbCurrent,inboxTitle,backToInbox}`
  plus `exchange.nav.messages`), and «Нови съобщения» appears nowhere. So the
  new `chat.newMessages` key is required rather than a coined synonym. The
  correction was recorded on #2797 before this PR.

## What CI caught that the local run would have

The first push went red on four contexts, every one of them a META-guard that
this diff pulled into scope rather than anything about the chat code. The
derived population (`npm run verify:changed`) covers all four; I had killed
those runs to merge main first and pushed on a targeted suite instead. That
was the mistake — the individual failures were each one line.

| failure | cause |
|---|---|
| `RENDERED_TEST_FLOOR` | 38 new rendered cases, floor left at 274 → raised to 275 |
| `comment-stripper-order` (#1497) | §10's source check stripped BLOCK comments first; `// a /* b` then opens a block that consumes to the next `*/` anywhere later, deleting real code between |
| `no-lucide` | two imports from the legacy icon package, whose allowlist only shrinks → nucleo's `PaperPlane` and `MessageSmile`, which exist (my first check grepped capitalised component names against a barrel of kebab-case paths and read the false absence as real) |
| `Selector teeth` | `ui-hooks-barrel.test.ts` — see below |

**The selector-teeth one is the finding worth keeping.** `slugToHookName` was
dead: its result went into a const nothing compared, discharged with `void`.
Deleting it was my first fix and CI refused that too — with no module-level
selector the file becomes `NOT AUDITED`, and that population has a ceiling
(200), so the count hit 201 and
`selector-teeth-reports-its-denominator` failed. A guard whose selecting
happens inside `it()` passes whether or not it selects anything, which is why
the ceiling is right: **extract the selection, do not remove it.**

Extracting then exposed what deletion would have buried. With `expected = ''`
the export regex degrades to `export \{[^}]*\}` — matching any re-export
block — and `toContain('')` is trivially true, so that guard could never fail
on a WRONG hook name at all. It now carries a control on the derivation
itself, which is what the tool's message asks for. A SURVIVED selector is a
question about the assertions, not only about dead code.

One more, four times over: a sweep tripping on my own prose. Two of those were
assertions I wrote to check my own work (`assert 'lucide' not in src` matching
the comment explaining why there is no such import). The nucleo comments
deliberately do not spell the package name, and the final checks run on
comment-stripped source.

## What is NOT here

No page, no route, no data fetching, no flag gate — P8.4 (#2798) owns all four,
and owns the composer's own copy (`placeholder` / `sendLabel` / `disabledReason`
are props so the page holds the strings). Reactions render and can be ASKED
for, but the picker itself is the page's.

Three carve-outs, each an open issue rather than a line in this file:

- **#2829 — swipe-to-reply**, blocked on a `replyToMessageId` column.
- **#2826 — scroll anchoring on prepend**, a P8.4 prerequisite.
- **#2809 — typing indicators**, blocked on a person-scoped realtime channel:
  the bus addresses a (tenant, person) or the whole deployment, and a DM has no
  tenant.
