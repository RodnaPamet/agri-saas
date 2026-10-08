# API compatibility policy

## Why this document exists

The web client ships **with** the server. A shape change that is harmless for it
— both sides deploy together — breaks every installed native app at once.

The asymmetry is the whole argument:

| | rollback |
|---|---|
| server | pin Watchtower back, minutes |
| installed app | **not available.** App Review takes days, and users update when they feel like it |

So the only fast remedy for a shape break is a **server revert**. That is
survivable exactly once per incident and only if the break is noticed
immediately, which is what the guard below is for.

## The version lives in the spec, not in prose

`src/generated/openapi.json` carries:

```json
"x-api-version": 1,
"x-minimum-client-version": 1,
"x-client-version-header": "x-agrent-client-version"
```

Source of truth: `src/lib/api/contract-version.ts`. Prose drifts; a generated
spec does not.

The spec is generated to `src/generated/openapi.json` and served by
**`GET /api/openapi`**, which requires a session. It used to sit at
`public/openapi.json` and be fetched anonymously; a file in `public/` is served
by Next's static handler before any application code runs, so it cannot be
gated by middleware, by a route, or by the Caddyfile. That cost nothing while
the document described zero endpoints (#944) — filling it in makes it a
complete map of the API surface, so it moved rather than staying anonymous.

**A single version, not per-route `introduced-in` metadata.** This server
deploys atomically — Watchtower updates `app` and `worker` together — so routes
never ship independently. Per-route metadata would add per-route maintenance to
buy granularity the release process cannot express.

**Not `info.version`.** That is `package.json::version`, which semantic-release
bumps every release and which the contract test *strips* before comparing so a
routine bump is not read as drift. Reusing it would make the API version
invisible to exactly the check meant to police it.

## What counts as breaking

Enforced by `scripts/openapi-breaking.ts`, run in
`tests/contracts/openapi-breaking-change.test.ts` against the committed spec:

| breaking | why |
|---|---|
| schema removed | a client decoding it fails outright |
| property removed | a client reading it gets `undefined` |
| property becomes required | a client that omits it is rejected |
| enum narrowed | a client still sending the old value is rejected |
| type narrowed | a client parsing the old type breaks |
| `$ref` repointed | the shape at that path changed, though neither schema did |

**At every depth, since #1214.** The classifier used to compare exactly
`schema.properties[prop]` and nothing below it. Measured on the committed spec,
that put **293 of 1575** described property sites — across **51 of 204**
schemas — outside the gate, reading as green: deleting
`CurrentUser.user.role` reported clean, and so did retyping it to `number`.
Findings now carry a dotted path (`user.role`, `rows[].id`, `featureFlags{}`,
`AssetDetail/allOf[1].parcels`). The depth calibration, including the sweep
over every nested site the spec has, is
`tests/contracts/openapi-breaking-depth.test.ts`.

**A `$ref` is not followed.** Every `$ref` in this spec points at a named
schema under `components.schemas`, and the classifier already compares every
named schema on its own — so a change to a `$ref` target is reported under the
target's own name, once, instead of once per referencing path. Repointing a
`$ref` at a different target is the one class that treatment would otherwise
miss, so it has its own row above. Swapping an inline object for a `$ref` (or
back) is a shape-preserving refactor and stays silent.

**Explicitly NOT breaking**, and this list is as load-bearing as the one above:

- a new schema
- a new **optional** property
- a **widened** enum
- a **widened** type (`string` → `string | null` is a superset)
- descriptions, examples, titles

> A guard that fires on every new optional field gets routed around, and then it
> protects nothing. That is not hypothetical here: the OI-3 auth guard hard-pinned
> an action version and reddened on routine Dependabot bumps until #599 relaxed
> it. A contract guard that cries wolf earns the same contempt.

## What an old client actually sees

A client declaring a version below `x-minimum-client-version` gets:

```
HTTP 426 Upgrade Required
{ "error": "client_version_unsupported",
  "minimumSupportedVersion": 1, "currentVersion": 1,
  "message": "This app version is no longer supported by the server. Please update to continue." }
```

**Never a generic 400.** An app receiving `{"error":"Bad Request"}` shows the
operator a bug and generates a support ticket; one receiving
`client_version_unsupported` shows "please update" and links the store. The
machine-readable code is the entire point — an app must be able to tell "update
me" from "you have a bug" without parsing prose.

**No header means compatible.** The web client cannot be stale, and refusing
unversioned requests would break every existing integration the day this lands.
A garbled header is treated the same way: far likelier a proxy mangling things
than an attacker, and failing those requests would turn an infrastructure quirk
into an outage for a check that is advisory by design.

## Support window

**Two minor releases, or 90 days, whichever is LONGER.**

Longer, not shorter, because the binding constraint is how fast operators update
— which we do not control — not how fast we release. A fortnight of rain keeps
people off the app; the window has to survive that.

Raising `MINIMUM_SUPPORTED_CLIENT_VERSION` is what actually cuts clients off. It
is a **separate, deliberate change** — never a side effect of bumping
`API_CONTRACT_VERSION`.

## Who decides

A breaking change requires sign-off from **the repository owner (@h0mele55)**.

Not a committee and not "whoever is on call": the cost lands on operators in
fields who cannot update on our schedule, and it needs one accountable person
who can weigh that against the engineering benefit. In practice the guard makes
this unavoidable — CI fails, and the only ways past are to make the change
additive or to get the exemption approved in review.

The decision is recorded in the PR that bumps `API_CONTRACT_VERSION`, with:

1. what broke and why it could not be additive
2. which client versions stop working
3. the release sequence (below)

## Release sequence when a break is unavoidable

**Ship the app first. Always.**

1. Release an app build that understands the NEW contract, and wait for adoption.
2. Only then deploy the server change and bump `API_CONTRACT_VERSION`.
3. Raise `MINIMUM_SUPPORTED_CLIENT_VERSION` **after** the support window, as its
   own change.

Server-first is the tempting order because the server is what we control, and it
is exactly wrong: it breaks every installed app during the gap and the only
remedy is a revert. App-first means the gap is a period where new clients work
and old ones keep working — which is what "compatible" means.

This ordering costs a release cycle. That is the price of shipping a binary you
cannot recall.

## Removing an orphaned schema

A schema can outlive the route it described. `scripts/openapi-build.ts`
registers components by walking the `@/lib/schemas` namespace, so **the export
is the registration** — nothing distinguishes "exported for a live route" from
"exported and forgotten". `AuthRegisterRequest` survived the retirement of
`POST /api/auth/register` (#1379) that way, and #1386 found two more.

Deleting one is still a removal by the table above, and the table is right to
say so: a client that generates types from the spec emits one per component
whether or not a path `$ref`s it, so the deletion can fail that client's BUILD
even though no endpoint changes. Do not reach for "but nothing references it" —
measured on the committed spec, 23 of 222 schemas are referenced by no `$ref`,
including live ones like `AssetCreateRequest`.

So there are two routes, and the cheap one is often available:

1. **It publishes no component.** Delete it. `AuthActionSchema` carried no
   `.openapi()` call, and the regenerated spec was byte-identical without it —
   so the contract could not change and no sign-off is owed.
2. **It publishes a component.** Add `deprecated: true` to its `.openapi()`
   metadata and regenerate. `deprecated` is not one of the six classes the
   classifier scores, so this is **additive** and the gate stays green. Delete
   the schema once a client build has shipped against a spec carrying the
   marker — which is the ship-the-app-first sequence below, applied to a type
   rather than to behaviour.

`tests/guards/schemas-barrel-has-no-orphans.test.ts` enforces that every orphan
takes one of those two routes, and pins the pending ones as a removal queue so
the list is cleared rather than accumulated.

## Adding a breaking change, mechanically

1. Make the change. `npm run openapi:generate`.
2. CI fails with the offending schemas and properties named.
3. Either make it additive, **or**: bump `API_CONTRACT_VERSION`, get owner
   sign-off, and follow the release sequence above.
4. Leave `MINIMUM_SUPPORTED_CLIENT_VERSION` alone until the window expires.
