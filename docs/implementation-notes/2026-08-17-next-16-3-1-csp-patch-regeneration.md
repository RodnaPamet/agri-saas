# 2026-08-17 — Next 16.2.12 → 16.3.1 + CSP nonce patch regeneration

**Commit:** `<pending> chore(deps): bump next to 16.3.1 and regenerate the CSP nonce patch`

## Why this was blocked

`patches/next+16.2.11.patch` re-injects the CSP `nonce` that Next's
`createComponentStylesAndScripts` omits. 16.3.x restructures that function, so
the patch stopped applying and `postinstall` failed — which is what held PR #572
and, through the Dependabot `production` group, 25 unrelated packages with it.
#584 split `next` out of that group; this note is the bump itself.

**The patch is still load-bearing.** Verified against the published 16.3.1
tarball rather than assumed:

```js
// next@16.3.1 dist/server/app-render/create-component-styles-and-scripts.js
scripts.push(createElement('script', {
    src: `${ctx.assetPrefix}/_next/${encodeURIPath(href)}${getAssetQueryString(ctx, true)}`,
    async: true,
    key: `script-${scriptIndex}`      // ← still no nonce
}));
```

## What changed upstream

16.2.x built the array with `.map()`; 16.3.x uses a `for…of` + `push`
accumulator and renames the loop variable `index` → `scriptIndex`. That is the
whole reason the old patch fails: the context lines moved.

One consequence matters more than the refactor itself. Each bundle used to
contain **two** sites matching the component-script fingerprint —
`createComponentStylesAndScripts` (ours) and the sibling `getLayerAssets`
(nonced upstream, never broken). In 16.3.1 `getLayerAssets` hoists its `src` to
a local (`{src:r,async:!0,…}`), so it no longer matches the shape at all and the
per-bundle count is **1**.

## Design

Patch generation was done by a script that refuses to guess, rather than by
hand-editing 5 MB minified files:

- **Unbundled sources** (CJS + ESM): insert `nonce: ctx.nonce` after the
  ``key: `script-${scriptIndex}` `` line, matching Next's own indentation.
- **Four bundles**: match
  ``{src:`${V.assetPrefix}…`,async:!0,key:`script-${C}`}`` and insert
  `,nonce:V.nonce`, taking `V` from the `assetPrefix` interpolation in the same
  object literal rather than hardcoding it. The script **asserts exactly one
  match per file and aborts otherwise** — with two similar sites in the file,
  a greedy replace is the obvious way to corrupt the bundle.

`V` resolved to `a` in all four bundles, which the minified
`,ctx:a}){let{componentMod:{createElement:i}}=a` destructuring confirms is
genuinely `ctx`.

## Files

| file | role |
|---|---|
| `package.json` / `package-lock.json` | `next` 16.2.12 → 16.3.1, still exact-pinned |
| `patches/next+16.3.1.patch` | regenerated; **six** files, replaces `next+16.2.11.patch` |
| `tests/guards/csp-nonce-component-scripts-patch.test.ts` | adds the positive control |
| `scripts/verify-image-patches.mjs` | same positive control, for the built image |
| `CLAUDE.md` | version corrected; adds the "Bumping Next" procedure |

## Decisions

- **The guard failed OPEN, and this was the release to find out.** The existing
  check asserts the ABSENCE of an unnonced site — the right shape, with one hole:
  it also passes when it matches **nothing**. If Next restructures its minified
  output, the regex quietly stops describing reality and a fully unpatched bundle
  ships green — precisely in the release where the patch most likely broke.

  Not hypothetical. The 2 → 1 site-count change above is real drift in this very
  bump; a larger refactor could take it to 0. Both the guard and the image
  verifier now require the fingerprint to still match something, so "no unnonced
  site" means *we looked and found none* rather than *we no longer know how to
  look*. The failure message says to re-derive the regex and names both copies.

  Proved by mutation: hoisting the `src` to a local in one bundle (simulating
  exactly what `getLayerAssets` did) makes the new test fail with that message;
  restoring it returns 14/14.

- **`>= 1`, not a pinned count.** Pinning 2 would have failed on 16.3.1 for a
  reason that is not a security problem. The invariant worth holding is "the
  shape still exists", not "there are exactly N of them".

- **The patch was verified by clean-install round-trip, not by reading the
  diff.** `rm -rf node_modules/next && npm ci` → `patch-package` applied it, and
  all six files came back patched. Reading the generated patch would not have
  caught a hunk that fails to apply against a fresh download, which is the #929
  failure mode.

- **The old patch file was deleted before regenerating.** `patch-package next`
  diffs `node_modules` against a fresh download; it does not read the old patch.
  Keeping it would only have risked `postinstall` trying to apply a 16.2.11 patch
  to a 16.3.1 tree.

- **Still no end-to-end nonce test.** Every check here is structural — source
  text, or byte reads of `node_modules` / the image. Nothing renders a page and
  asserts the `<script>` carries a nonce, even though `playwright.config.ts`
  already runs the app under `next start` in production mode. The positive
  control narrows the blind spot but does not close it; that is tracked
  separately rather than smuggled into a dependency bump.

## Verification

- 16.3.1 confirmed to still ship the bug in all four bundles AND both sources
  before patching.
- After patching: 0 unnonced sites, `nonce: ctx.nonce` present in both sources.
- Clean `npm ci` round-trip: patch applies, all six files patched.
- `tsc --noEmit` clean.
- `next build --webpack` under `NODE_ENV=production` succeeds.
- `csp-nonce-component-scripts-patch` 14/14; `swc-version-coherence`,
  `deterministic-install`, `no-legacy-peer-deps` all pass (`@next/swc-*`
  resolved to 16.3.1 in step with `next`).
