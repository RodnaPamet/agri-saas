# 2026-11-08 — one coarse-pointer detector (#2828)

**Commit:** `<pending>` refactor(ui): one useCoarsePointer, and SwipeRow asks the pointer question

## Design

There were three answers to "is this a touch device", and they were not all the
same question:

| consumer | before | query |
|---|---|---|
| `tooltip.tsx` | a module-private `useCoarsePointer` | `(hover: none), (pointer: coarse)` |
| `use-long-press.ts` | a byte-for-byte copy | the same |
| `<SwipeRow>` | `useMediaQuery().isMobile` | a `min-width` probe |

One hook now, in the Epic 60 barrel. The first two import it; `<SwipeRow>`
switches from the width question to the pointer one, which is what its own
docblock had been arguing for.

```
  src/components/ui/hooks/use-coarse-pointer.ts
      COARSE_POINTER_QUERY = '(hover: none), (pointer: coarse)'
      useCoarsePointer()  — useSyncExternalStore, server snapshot false
          ↑              ↑              ↑
     tooltip.tsx   use-long-press   swipe-row

  NOT migrated, deliberately — a NARROWER query, one-shot:
      usePullToRefresh          '(pointer: coarse)'
      lib/view-transitions      '(pointer: coarse)'
```

## Files

| file | role |
|---|---|
| `src/components/ui/hooks/use-coarse-pointer.ts` | NEW — the one detector and its query constant |
| `src/components/ui/hooks/index.ts` | the barrel export |
| `src/components/ui/tooltip.tsx` | drops its private copy |
| `src/components/ui/hooks/use-long-press.ts` | drops its copy |
| `src/components/ui/swipe-row.tsx` | pointer, not viewport |
| `tests/rendered/viewport.ts` | `setViewport` answers the pointer queries too |
| `tests/rendered/use-coarse-pointer.test.tsx` | NEW — the hook's own behaviour |
| `tests/guards/one-coarse-pointer-detector.test.ts` | NEW — one asker, and the narrow query recorded |
| `tests/guards/tooltip-touch-uniformity.test.ts` | the property restated |

## Decisions

- **`<SwipeRow>` is the real fix here, not the deduplication.** Its docblock
  argued for a coarse pointer and the code asked about width, and the two
  disagree in BOTH directions: a desktop window narrowed to phone width
  rendered the swipe wrapper (inert, because `onPointerDown` already refuses
  `pointerType === 'mouse'`), and a LARGE TABLET got no wrapper at all — so a
  finger had no swipe on the device class most likely to want it. Strictly
  better both ways: less dead DOM on the first, a working gesture on the
  second.

- **#2828's premise was wrong on one point, and the distinction is kept.** It
  describes all the copies as identical. Measured, there are TWO policies:
  `usePullToRefresh` and `src/lib/view-transitions` ask `(pointer: coarse)`
  with no `(hover: none)` arm, one-shot, inside an effect or a predicate. That
  is narrower — it excludes a stylus tablet, which cannot hover and reports a
  fine pointer — and it answers a different question: "attach this gesture /
  run this transition on this device right now" rather than "render a touch
  affordance". Folding them in would WIDEN both, which is a behaviour change
  nobody asked for, so the guard records them with that reason instead.

- **`setViewport('mobile')` used to mean a phone-width window with a MOUSE.**
  The helper interpreted `min-width` only and answered `false` to everything
  else, so the moment `<SwipeRow>` started asking the pointer question two
  tests broke — correctly. A phone and a tablet are coarse, a desktop is not,
  and `{ coarsePointer }` decouples the two for the real devices this gets
  wrong: a touch laptop is wide AND coarse.

- **The guard matches a literal whose WHOLE value is the query**, not the
  pattern anywhere in the file. The first draft reported
  `filter/filter-list.tsx`, which carries
  `[@media(hover:none)]:hover:bg-transparent` — a Tailwind arbitrary variant
  in a `className`, i.e. CSS doing exactly the right thing. A guard that calls
  that a second detector reports the fix as the defect. Scoping to
  `matchMedia(...)` call sites would have been the other obvious narrowing and
  is WORSE: the detector calls `matchMedia(COARSE_POINTER_QUERY)`, so a
  call-site scan misses the one file that matters and the positive control
  fails.

- **The tooltip guard's assertion changed shape, not subject.** It asserted
  `^function useCoarsePointer(` in `tooltip.tsx`, which was the same property
  — "DERIVED, never supplied" — while the detector was private. It now
  requires the import from the one module, still refuses a re-export, and
  additionally refuses a local shadowing definition, which would make the
  import dead while every other assertion passed.

- **One mutation survived twice**: flipping the hook's `getServerSnapshot` from
  `false` to `true` reddened nothing, because jsdom always has a `window` and
  that argument is only read during SSR and hydration. A `renderToString` case
  covers it. The value must be `false` even on a device that IS coarse,
  because the server cannot know the device and a server emitting the touch
  branch is a hydration mismatch on every mouse user's first paint.
