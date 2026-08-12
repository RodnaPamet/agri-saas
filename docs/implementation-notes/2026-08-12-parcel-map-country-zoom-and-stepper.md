# 2026-08-12 — Getting around the parcel map: country zoom, two fingers, a stepper

**Commit:** (pending — see PR)

Three changes to `ParcelOverviewMap` (#527). They ship together because
each one moves the same pan/zoom state, and two of them are only worth
having because of the third: a map that reaches country scale needs a way
back to a parcel, and a phone that can zoom needs a way to pan.

## Design

### 1. The zoom floor was a constant; it is now a measurement

Establishing what the limit actually was, before changing it: not the
projection and not the tier table, but one clamp in `zoomAt` —

```ts
const nk = Math.max(v.fit * 0.35, Math.min(v.fit * 64, v.k * factor));
```

`fit` frames the holding, so the floor let the view out to about three
times the holding's own framing. The country outlines were already being
drawn — `oblastPaths` re-placed through `projectionBridge` — and in this
world space the country is many times the holding's box (≈78× for a 6 km
holding, ≈6.7× for a 40 km one). So the outlines were there and
unreachable.

The floor is now `minZoomScale(fit, countryExtent, cw, ch)`, where
`countryExtent` is the national geometry's box read through the same
bridge that draws it. It is `Math.min` with the old `fit * 0.35`, so the
range can only grow: with no geometry loaded, or a pane with no size, the
behaviour is byte-for-byte what shipped.

Two things follow from the view being able to go out that far:

- **The pan clamp needs a bigger box, but only out there.** Widening it
  everywhere would let a drag at farm zoom wander off the holding into
  empty world space. `clampExtentFor` returns the farm box while
  `k >= fit` — exactly today's behaviour — and the farm ∪ country box
  only in the newly-reachable range below it. `clampTranslation` centres
  an extent smaller than the pane, which is what makes "zoom all the way
  out" land on a centred *country* rather than a centred *holding* with
  half the country off-screen.

- **The outlines have to stop.** A hundred parcels inside a holding that
  is now forty pixels wide are a hundred one-pixel marks, which reads as
  damage to the country outline rather than as fields.
  `shouldDrawParcelShapes` is a sibling of the existing
  `shouldDrawParcels(zoomTier)`, not a replacement, because the two ask
  different questions: the tier is about visible ground span, this is
  about whether a shape is big enough to read. Neither implies the other
  — a large holding can sit at the tier floor while still filling the
  pane. When the shapes drop out the cluster markers take over, which also
  covers the frame or two between a zoom-out and the payload for the new
  tier arriving.

  It takes a SHARE of the pane, not a pixel count. A pixel count answers
  differently on a 290 px phone card and a 900 px desktop slot while the
  question does not, and the first draft's 140 px would have dropped the
  outlines at `0.4 × fit` on a small phone — inside the zoom range that
  already shipped. The share has one hard boundary (still drawing at the
  old `fit * 0.35` floor, on every pane size) and deliberately no second
  one: how small a holding gets at country scale depends on how big it is,
  from ~0.03 of the pane for a 6 km holding to ~0.29 for one spanning a
  third of Bulgaria. The last of those keeps its outlines all the way out,
  which is right — they are still legible.

A fourth control (globe) snaps between the two framings. Reaching country
scale on the minus button alone is eight presses, which on a phone is not
a feature anyone finds.

### 2. Two fingers pan as well as zoom

The pinch already existed and was half a gesture: the midpoint was
captured at `touchstart` and never updated, so two fingers scaled the map
about a fixed point and could not move it. `ExchangeMap` had the other
half all along —

```ts
v.tx += m.x - p.mx;
v.ty += m.y - p.my;
```

Since one finger is deliberately left to the page here (so the document
scrolls and the tab panel's swipe navigation survives), two-finger drag is
the *only* way to pan on a phone. Without it a user can magnify a corner
they cannot then move away from.

### 3. A stepper that walks north to south

One button that advances to the next parcel, centring and framing it.

**The order is stated, not incidental.** Creation order records when a
parcel was typed in and says nothing about where it is, so a stepper using
it reads as a shuffle. `orderParcelsForStepping` sorts by latitude
descending, longitude ascending, then id — total, so the same press from
the same position always lands on the same parcel. With a cluster
selected it walks that group, because the map and the table below it
should be answering the same question.

The position renders as text (`Нива 4 · 1 of 4, north to south`) beside
the canvas, in an `aria-live` region. A stepper with no position readout
leaves the operator unable to tell whether they have seen everything or
gone round twice — and canvas pixels are not text.

## Files

| file | role |
|---|---|
| `src/components/locations/parcel-overview-model.ts` | the new arithmetic: extents, the measured zoom floor, the clamp, the walk order |
| `src/components/locations/ParcelOverviewMap.tsx` | wiring, the two new controls, the flight |
| `tests/unit/locations/parcel-overview-model.test.ts` | the arithmetic, executed |
| `tests/rendered/parcel-overview-map-gestures.test.tsx` | the canvas branch, executed — see below |
| `messages/{en,bg}.json` | four strings |

## Decisions

- **The stepper's index is the one thing React is told about.** Pan and
  zoom live in a ref precisely so a drag never re-renders the tree, and a
  flight that set state per frame would undo that for the sake of an
  animation. So `flyTo` mutates `view.current` and repaints directly, as
  `onPointerMove` already does; React hears about the step INDEX, because
  that is what the position readout renders, and about `atCountry`,
  because the toggle's label has to say which way it goes. The second is
  written from `reportTier` — which already runs after every zoom — and
  React bails out of a set to the same value, so it costs a render exactly
  when the answer flips rather than once per drag frame.

- **The flight is an ease, not a jump.** On a map that now reaches country
  scale, teleporting between two parcels destroys the only cue for how far
  apart they are. Under `prefers-reduced-motion` it is a jump, because
  there the cue is worth less than the discomfort.

- **The toggle's ACTION never reads its own state flag.**
  `toggleCountry` re-derives from `view.current.k`, so a wheel or a pinch
  that left country scale cannot make the button do the opposite of what
  its label says. The flag is for the label only.

- **The gesture tests install a 2D context rather than asserting around
  it.** CLAUDE.md's standing warning is that under jsdom a whole branch
  can be unreachable and a suite green about it anyway — and this
  component's entire draw and hit-test path is that branch, because
  `getContext('2d')` returns null. Everything this change touches lives
  there. So the new suite supplies a recording context, a `Path2D` and a
  laid-out pane, dispatches real touch events, and reads the resulting pan
  and zoom back out of the `setTransform` calls: the view is written to a
  ref nothing outside the component can see, and the transform is where it
  becomes observable. The reduced-motion case installs its own
  `matchMedia`, because the project stub answers `matches: false` to every
  query and would leave that branch unrun.

  All sixteen passed on the first run, which for a suite this fiddly is a
  reason for suspicion rather than confidence — so four mutations were
  applied to the source (drop the two-finger pan, restore the old floor,
  always draw the shapes, walk creation order) and each was caught by the
  test that claims to cover it.
