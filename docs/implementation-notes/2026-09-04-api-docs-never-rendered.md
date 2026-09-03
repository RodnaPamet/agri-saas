# 2026-09-04 — The interactive API docs had never rendered

**Commit:** `<pending> fix(docs): nonce the Swagger UI scripts and serve them same-origin`

## Design

Filed as #798 — *"loads Swagger UI from jsDelivr — a remote script on a served
page"*. Reading the route showed the reported risk does not exist and a larger
defect does.

**Where the page renders: local development only.**
`isDocsEnabled()` hard-404s under `NODE_ENV` of `production` or `test`. The
route's docblock claimed *"Development + staging: true"*, which was wrong —
`docker-compose.staging.yml:117` sets `NODE_ENV: production` deliberately
(GAP-03: *"staging runs NODE_ENV=production and is treated as production"*), so
staging takes the same 404. There is no environment where the page is served to
anyone but a developer on localhost.

**And on localhost it never worked.** `src/middleware.ts:402-403` applies CSP to
every response, development included:

```
script-src 'self' 'nonce-<…>' 'strict-dynamic' [+ 'unsafe-eval' in dev]
```

`csp.ts:19-20` states it plainly: **no `unsafe-inline` in any environment**. The
route emitted three scripts — two CDN `<script src>` and one inline bootstrap —
and nonced none of them. All three were blocked. The page returned **HTTP 200
with well-formed HTML** and rendered a yellow banner over an empty
`<div id="swagger-ui">`.

**Removing jsDelivr would not have fixed it.** Under CSP Level 3
`'strict-dynamic'` makes browsers ignore `'self'` and every host-source
expression, so a same-origin script with no nonce is blocked by the identical
rule. The nonce is the mechanism; the origin is incidental. A PR that only
swapped the URLs would have closed the issue while leaving the page dead.

## Files

| file | role |
|---|---|
| `src/app/api/docs/route.ts` | nonces all three scripts; same-origin asset URLs; both false docblock claims corrected |
| `src/app/api/docs/enabled.ts` | new — the gate, shared so page and assets cannot diverge |
| `src/app/api/docs/assets/[asset]/route.ts` | new — serves the three files from `swagger-ui-dist`, same gate, allowlist lookup |
| `package.json` | `swagger-ui-dist` as a **devDependency** (pruned from the runtime image) |
| `tests/unit/api/docs-route-csp.test.ts` | executes the route; asserts each script carries the nonce from that same response |
| `tests/unit/api/docs-assets-route.test.ts` | allowlist, traversal, env gate, absent-package |

## Decisions

- **A missing nonce returns 503 with a diagnosis, not a blank 200.** The
  original defect survived because a broken page and a working one produced the
  same observable — 200, valid HTML. If the nonce is ever absent the page now
  says so on screen. Reproducing the ambiguity would have been the one
  unforgivable outcome of fixing it.

- **The dynamic segment is a lookup key, never a path component.** `ASSETS` maps
  three literal filenames to content types; a segment that misses the map 404s
  before any filesystem call, and the tests assert `readFile` was not called at
  all for `../../../etc/passwd`. Joining a request segment onto a directory
  under `node_modules` would have been the obvious implementation and a
  traversal surface.

- **The asset route shares `isDocsEnabled()` with the page.** An asset route
  that outlived its gate would be a public read path into `node_modules` on
  every deployment; the page's 404 protects nothing on its own.

- **`process.cwd()` join instead of `createRequire`.** `createRequire` survives
  nested install layouts, but mocking `node:module` to test it also replaces
  `createRequire` for pino's thread-stream transport, which real-requires it
  from a **worker thread** — that crashed the jest worker while all 11 tests
  passed, producing a red shard with no summary. Exactly the over-broad-mock
  hazard CLAUDE.md records. npm installs flat and the route is dev-only, so the
  simpler resolution is sufficient and leaves only `readFile` to stub.

- **`swagger-ui-dist` is a devDependency (11.3 MB unpacked).** It never reaches
  the production image — `npm prune --omit=dev` removes it, and the route 404s
  there regardless. Lockfile regenerated with **npm 11**: npm 10 strips the 22
  `libc` entries from optional cross-platform packages (see #802), and the count
  was verified unchanged at 22 after the install.

- **Left open on the issue: whether the page is worth keeping.** It has never
  worked and nobody noticed for the life of the feature, so deleting the route
  is a legitimate alternative. Fixed rather than deleted because the issue asked
  for the CDN removed, which implies the page is wanted.
