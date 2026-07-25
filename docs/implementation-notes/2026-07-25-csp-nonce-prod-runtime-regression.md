# 2026-07-25 — CSP nonce regression in Next's bundled prod runtime

**Commit:** `<pending> fix(csp): restore the nonce patch to Next's bundled prod runtimes`

## Problem

PR #484 (2026-05-14) patched Next's `createComponentStylesAndScripts` to pass
`nonce: ctx.nonce`, fixing a `<script>` tag that rendered without a nonce and was
blocked by our `script-src 'nonce-…' 'strict-dynamic'` policy. That patch covered
six files: the two unbundled sources plus all four `app-page*.prod.js` bundled
prod runtimes — 80 lines.

PR #929 (2026-06-08) bumped next 16.2.6 → 16.2.7 and regenerated the patch with
`patch-package next`. `patch-package` regenerates by diffing the local
`node_modules` against a **freshly downloaded** copy of the package. After a
version bump the fresh copy's bundles are pristine, so the four bundle hunks had
nothing to diff against and were silently dropped. The patch shrank 80 → 28
lines, keeping only the two unbundled sources.

Those two files are the *cosmetic* half — they exist so the fix is legible for an
eventual upstream PR. The `.prod.js` bundle is what `next start` executes. So for
~7 weeks main shipped a production runtime with the original CSP bug live, while
the source-level fix made it look patched.

The guard test at `tests/guards/csp-nonce-component-scripts-patch.test.ts` was
written to prevent exactly this ("locked here so a future `npm install` that drops
the patch breaks CI") and did not fire. It asserted that a `nonce:` fingerprint
appeared **somewhere** in a 5 MB minified file. The sibling `getLayerAssets`
function builds an identically-shaped script element and has always carried
`nonce:` upstream, so it satisfied the assertion on its own. The test passed
whether or not the vulnerable function was patched.

## Design

Two independent failures, so two independent fixes.

**The runtime fix.** Re-inject `,nonce:<ctx>.nonce` into the component-script
element in all four bundles, then regenerate the patch — back to 80 lines / 6
files, matching the pre-#929 shape. The injection is anchored on the
`${<ctx>.assetPrefix}` interpolation inside the same object literal, which yields
the minifier-assigned ctx variable for that occurrence (it differs per bundle and
per release). It cannot touch `getLayerAssets`, whose element already ends in
`,nonce:…}` rather than `}`.

**The detection fix.** Invert the assertion. Instead of requiring the presence of
a good pattern — which any bystander match satisfies — assert the **absence** of
the bad one, per bundle:

```
/\{src:`\$\{\w+\.assetPrefix\}[^`]*`,async:!0,key:`script-\$\{\w+\}`\}/
```

An unnonced site closes with `}` straight after the key. A nonced one cannot
match. Nothing unrelated can satisfy an absence assertion, so the weakness that
let #929 through is structurally gone.

Plus a second lock at a different layer: assert the patch file's own **file
coverage** lists all six paths. That catches a regenerated-but-incomplete patch
in the PR that regenerates it, without needing a built `node_modules`.

## Files

| File | Role |
| --- | --- |
| `patches/next+16.2.11.patch` | Regenerated: 80 lines, 6 files. Replaces the 28-line `next+16.2.7.patch` (also renamed for the 16.2.7 → 16.2.11 drift). |
| `tests/guards/csp-nonce-component-scripts-patch.test.ts` | Absence-based per-bundle assertion; patch file-coverage lock; version-agnostic patch discovery; failure output trimmed to the offending snippet. |

## Decisions

- **Absence over presence.** The root cause of the missed detection was asserting
  a good pattern exists in a large file. Any incidental match satisfies it. The
  bad-pattern-absent form has no such escape hatch. Applied per-bundle via
  `it.each` so the failure names the specific runtime.

- **Patch discovery by glob, not pinned version.** The old test hardcoded
  `patches/next+16.2.7.patch`, so every routine bump required editing this test.
  That friction is part of how #929 went wrong. The glob removes it while the new
  file-coverage assertion *adds* the guarantee the pin was standing in for.

- **Assert on the extracted match, not the bundle.** `expect(bundle).not.toMatch()`
  dumps megabytes of minified JS into the CI log on failure. Extracting the match
  first and asserting `toBeNull()` prints one line — which is also the snippet
  needed to write the fix.

- **Verified by clean-install round-trip, not by inspection.** After regenerating,
  `node_modules` was wiped and rebuilt with `npm ci`; all four bundles came out
  with zero unnonced sites purely via the `postinstall` hook. Each bundle also
  passes `node --check`, since hand-editing minified output risks a syntax error
  that would only surface at runtime.

- **Not fixed upstream-first.** The proper fix is a Next PR adding the nonce to
  `createComponentStylesAndScripts`; the unbundled hunks exist to make that patch
  legible. Until it lands, the bundle hunks are load-bearing and must survive
  every version bump — hence the coverage lock.

- **Left for the operator:** this is live in production, so it needs a rebuild +
  redeploy rather than waiting on watchtower's image cycle, and browser-level
  confirmation (no CSP violations in console on an authenticated page) is worth
  doing after deploy — the guard test proves the bundle is patched, not that the
  browser is happy.

## Follow-up — the image never applied the patch at all

**Commit:** `<pending> fix(docker): copy patches/ before npm ci so patch-package applies`

Restoring the bundle hunks above did **not** fix production. Deploying the new
image and running the detector inside the live container still reported the
unnonced site. The image build log explains why:

```
> patch-package
patch-package 8.0.1
Applying patches...
No patch files found
```

The Dockerfile's deps stage copied only `package.json` + `package-lock.json`
before `npm ci`. `patch-package` resolves `patches/` relative to CWD, so it
found nothing and no-op'd, producing an unpatched `node_modules` that the
builder inherits (`COPY --from=deps`) and the runner ships
(`COPY --from=builder`). The builder's `COPY . .` does bring `patches/` in — but
after the install, and nothing re-runs the hook.

Consequences worth being precise about:

- **The scope is wider than #929.** This path has never applied the patch, so
  the CSP bug has been live in every deployed container since #484 landed
  (2026-05-14), not since #929 (2026-06-08). #929 dropped the bundle hunks from
  a patch that was already not reaching production.
- **#484's verification could not have caught it.** Its own diagnosis path
  records confirming the fix by *manually* patching the running prod runtime.
  That validates the code change, not the delivery mechanism, and no redeploy
  preserves it.
- **The existing assertions were misleading, not wrong.** Assertions 4 and 5
  read the LOCAL `node_modules`, where `npm ci` *does* see `patches/` and the
  patch *does* apply. Locally patched, in-image unpatched — a green CI and a
  broken production, with no contradiction between them.

Fix: `COPY patches ./patches` before `RUN npm ci`, plus a sixth assertion
checking that ordering in the Dockerfile. That assertion is the only one in the
file that reflects what production actually runs, which is precisely why it was
the one missing.

**Generalisation:** any repo-level artefact that must exist at install time
(patches, `.npmrc`, `prisma/` for a postinstall generate) has to be COPY'd
before the install in a layer-cached Dockerfile. A test asserting the local
`node_modules` cannot see that class of bug — the assertion has to read the
build definition.

## Follow-up 2 — verifying the artefact, not the inputs (#385)

**Commit:** `<pending> ci(docker): verify the built image applied patch-package`

The Dockerfile-ordering assertion added above is still a **proxy**. It encodes
"these inputs usually produce a good artefact" and sits on the same side of the
line as the assertions that failed us. Two concrete holes proved it:

- `RUN npm ci --ignore-scripts` satisfies the ordering assertion while skipping
  `postinstall` entirely — reproducing the original bug.
- `ghcr-publish.yml` never inspected what it built: Checkout → Buildx → Login →
  Extract tags → Build and push.

The fix reads the artefact. `scripts/verify-image-patches.mjs` runs **inside the
built image** and asserts no unnonced component-script site survives in any of
the four prod runtimes, failing closed if a bundle is missing.

It hooks into the existing `Docker Build & Scan` job in `ci.yml`, which already
builds with `load: true` to hand the image to Trivy — so it costs **no extra
build**, the same consolidation reasoning that folded the standalone Trivy job
in. It runs before the scan so a delivery bug fails in seconds rather than after
a multi-minute vulnerability scan.

Verified two-sided against real artefacts rather than by inspection: run inside
the published patched image it PASSes (exit 0); run against the same image with
one bundle's nonce stripped it FAILs (exit 1) naming the bundle and printing the
offending element.

**Residual gap, stated rather than hidden:** `ghcr-publish.yml` runs in parallel
with CI on push to `main`, so it does not gate on this. In practice `main` is
protected and every change arrives via a PR whose CI must be green, so the image
built from `main` was already verified at PR time. The uncovered paths are
`workflow_dispatch` and an admin direct-push. Closing those means moving the
publish to `build (load: true)` → verify → push, which costs a multi-GB export on
every deploy — deliberately not paid yet.

**The durable lesson:** prefer a check that reads the artefact over one that reads
the inputs that produce it. Every signal in this incident described the
developer's machine; the one that would have caught it in ten seconds runs the
thing we ship.
