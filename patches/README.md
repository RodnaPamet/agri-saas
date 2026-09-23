# `patches/`

`patch-package` applies every `*.patch` here on `postinstall`. **This
directory currently holds no patches, and that is a state with a history —
not an accident.**

## The CSP nonce patch, and why it is gone

From the Next 14 line through **16.3.4**, `createComponentStylesAndScripts`
built a `<script>` element with no `nonce`, which
`script-src 'nonce-…' 'strict-dynamic'` blocks. We carried
`next+<version>.patch` adding `nonce: ctx.nonce`, and every Next bump had to
regenerate it across SIX files — the two readable sources and all four
`dist/compiled/next-server/app-page*.runtime.prod.js` bundles, which are what
`next start` actually executes.

**Next 16.3.5 fixes it upstream**, in the sources and in all four bundles.
Verified against a pristine install (`npm ci --ignore-scripts`, so
`patch-package` never ran) using the guard's own regexes: zero unnonced sites,
and the positive-control fingerprint still matching one site per bundle. The
ordering is the tell — our patch inserted `nonce` BEFORE `key:`, while 16.3.5
carries it AFTER, so the nonce present is upstream's and not a stale
application of ours.

Re-adding a patch would therefore be patching a fix.

## What still holds the property

The patch was never the guarantee; it was the mechanism. The guarantee is
that no component-script site ships without a nonce, and that is asserted in
two places that read BYTES rather than trusting a file to exist:

- `tests/guards/csp-nonce-component-scripts-patch.test.ts` — against the local
  `node_modules`, on every CI run.
- `scripts/verify-image-patches.mjs` — inside the BUILT IMAGE, which is the
  only signal that describes what production runs.

Both assert an ABSENCE plus a positive control, so a Next release that
restructures the minified output fails loudly instead of passing by no longer
knowing how to look.

## If a future Next regresses

Add the patch back — the machinery is deliberately still wired
(`postinstall: patch-package`, and the Dockerfile COPYs `patches/` before
`npm ci` WITHOUT `--ignore-scripts`, both asserted by that guard). The
procedure is in `CLAUDE.md` under **Bumping Next**. Name it
`next+<exact version>.patch`: the guard requires any patch present to match
the INSTALLED version, because a patch silently drifting against a newer Next
is exactly how #929 shipped an unpatched image for ~7 weeks.
