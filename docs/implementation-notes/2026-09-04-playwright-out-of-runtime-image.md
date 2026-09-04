# 2026-09-04 — Playwright removed from the production runtime image

**Commit:** `<pending> fix(docker): keep test tooling out of the runtime image`

## Design

`@playwright/test` sits in `devDependencies`, so `npm prune --omit=dev` at
`Dockerfile:86` should remove it. It does not, and the reason is a graph
property rather than a Dockerfile mistake:

```
next@16.3.3
  peerDependencies:      "@playwright/test": "^1.51.1"
  peerDependenciesMeta:  "@playwright/test": { "optional": true }
```

npm resolves an optional peer through a **production** edge and marks every
node beneath it `dev: false`:

```
$ npm ls playwright-core --omit=dev
└─┬ next@16.3.3
  └─┬ @playwright/test@1.62.1
    └─┬ playwright@1.62.1
      └── playwright-core@1.62.1
```

So the prune is *correct* to keep it — by the lockfile's own graph it is a
production dependency. `COPY --from=builder /app/node_modules` then carries
~19 MB into the runner stage.

The fix is an explicit `rm -rf` after the prune, matching the existing
npm-CLI removal in the runner stage (`Dockerfile:177`), whose comment already
states the principle: *"Deleting the CLI removes the finding at the source
rather than suppressing it in `.trivyignore`."*

## Why it was more than dead weight

`playwright-core/lib/utilsBundle.js` is an esbuild bundle that inlines
`fast-uri` verbatim — the bundle preserves the original path comments. That
copy is invisible to **both** security gates:

- **npm audit** reads `package-lock.json`, where a bundled copy has no entry;
- **Trivy** walks package manifests, and `playwright-core@1.62.1` declares no
  dependencies of any kind.

So a future advisory on a bundled library would ship silently, and neither
gate could be pointed at it.

## Files

| file | role |
|---|---|
| `Dockerfile` | explicit `rm -rf` after the prune; the prune comment corrected |
| `scripts/verify-image-deps.mjs` | new — runs **inside the built image**, asserts absence + a positive control |
| `.github/workflows/ci.yml` | new `Gate: no test tooling in the runtime image`, beside the CSP-nonce gate |
| `tests/unit/deploy/verify-image-deps.test.ts` | executes the script against fixture trees, all three outcomes |
| `CLAUDE.md` | records in-image verification as the house pattern |

## Decisions

- **The comment was the actual defect.** `Dockerfile:81` listed `playwright`
  among the packages the prune removed. Two of its three examples were right,
  which is why nobody checked the third. Correcting the comment matters as
  much as the `rm` — a false comment is worse than none, because it answers
  the question a reader would otherwise ask.

- **The check runs in the image, not over the Dockerfile.** A shape assertion
  (`grep 'rm -rf node_modules/playwright' Dockerfile`) would pass while the
  image shipped dirty for any reason the Dockerfile text does not capture. The
  repo already learned this from the CSP-nonce patch, whose gate comment says
  it plainly: *"A Dockerfile-shape assertion is a proxy; this is not."*

- **A positive control is mandatory, not decorative.** "Banned package absent"
  and "I resolved the wrong `node_modules`" are the same observation, and the
  second fails toward green — a verifier pointed at an empty path would
  certify every image forever. The script therefore asserts that `next`,
  `react`, `react-dom` and `@prisma/client` are present *before* concluding
  anything from an absence, and the test suite proves that control fires.

- **Removal is safe for `next start`, verified rather than assumed.** Every
  reference to `@playwright/test` inside `next/dist` is under `docs/`,
  `cli/next-test.js`, or `experimental/testmode/` — **zero** hits in
  `dist/server/` or `dist/shared/`. The peer dependency is optional precisely
  because Next runs without it.

- **`@axe-core/playwright` is removed alongside**, though it has no production
  edge today. It is a sibling of the same tooling and would arrive by the same
  route if a future package declared it an optional peer.

- **Not folded into the advisory-remediation PR (#800).** It is not a blocker
  on that work, and a dependency-graph change riding inside a security fix
  makes both harder to review and to revert.
