# 2026-08-21 — payload URL fields pin their scheme (#667)

**Commit:** `see git log` fix(schemas): pin every payload URL field to https

## Design

One shared helper (`src/lib/schemas/url.ts::httpsUrl`), applied to every
URL-shaped field in `src/app-layer/schemas/` + `src/lib/schemas/`, held by a
filesystem-derived guard with a reasoned allowlist.

`z.url({ protocol: /^https$/ }).max(2000)` — the spelling #652 introduced
inline in `promotion-admin.schemas.ts`, now extracted so there is one of it.
The `.max(2000)` is uniform on purpose: it was previously present on some
fields and absent on others with no reason for the difference.

## The classification, which is the actual deliverable

#667 asked for a per-field decision and predicted three fields would be wrong
to pin. **Measuring each one inverted all three.**

| field | #667's prediction | what measurement showed |
|---|---|---|
| `sso-config.issuer` | "a URN is legitimate" | OIDC Discovery 1.0 §2 requires "a URI with a scheme component that MUST be https, **a host component**". A URN has no host and is not a legal OIDC issuer. The URN intuition belongs to SAML entity IDs — and `SamlConfigSchema.entityId` is already correctly *not* a `.url()`. Independently: `discoverOidc` reads `issuer` in exactly one place, concatenating `/.well-known/openid-configuration` and passing it to `fetch`; a URN there fails with `TypeError: fetch failed … unknown scheme`. Non-https was already broken at first sign-in. |
| `automation.url` (webhook) | "self-hosted may want internal http" | `checkWebhookUrl` already refuses non-https at execution time (`webhook-safety.ts:56`). The loose schema was not permissive — it was **contradicting the runtime**, accepting a rule at save time that could only fail when it fired. |
| `push.endpoint` | "rejecting one silently breaks a device" | It is a **server-side fetch target from client input**, and `web-push@3.6.7` does no scheme validation: measured, it attempts `http://169.254.169.254/latest/meta-data/`. Leaving it open was the riskier half. |

The peer-review candidate for exemption, `automation.linkUrl`, went the same
way: it is the one path by which an absolute URL can reach `<Link href>` in the
notifications bell. All ten in-repo producers write relative in-app paths, and
production agrees — 3660 notification rows carry a link, **0** absolute.

## Files

| file | role |
|---|---|
| `src/lib/schemas/url.ts` | **new** — the one spelling of `httpsUrl()`, with what the loose form accepts (measured) and what the pin does *not* close |
| `src/app-layer/schemas/{sso-config,automation,agri-event,support-scheme,push,product-safety}` | 13 fields pinned, each with the reasoning that survived measurement |
| `src/lib/schemas/index.ts` | task + asset evidence links pinned |
| `src/app-layer/schemas/promotion-admin.schemas.ts` | drops its private copy of the helper |
| `tests/helpers/url-field-parser.ts` | **new** — the AST detector, extracted from `promotions-drift.test.ts` so two guards share one |
| `tests/guards/payload-url-scheme.test.ts` | **new** — repo-wide scan + `OPEN_BY_DESIGN` + no-stale-entries + mechanism mutation proofs |

## Decisions

- **Production data was measured before narrowing any contract.** Zero
  `PushSubscription` rows, zero `TenantIdentityProvider` rows, zero
  `AutomationRule` rows, zero non-https `AgriEvent.url`, zero absolute
  `Notification.linkUrl` (agrent DB, 2026-08-21). No live row can be orphaned
  by any of these pins — which is what turned "confirm before tightening" from
  a worry into an answer.

- **The scan is filesystem-derived, and it found two fields the issue's table
  missed.** `portfolio.ts` has two `drillDownUrl` fields the hand-count of 15
  omitted, because they are not `.url()` at all — the detector also matches on
  a **name** ending in `Url`. Both are output-DTO fields carrying server-minted
  relative paths that `httpsUrl()` would reject, so they are the allowlist's
  two real entries. That is an argument for scanning by name rather than by
  call.

- **The detector parses, it does not grep.** Several pinned schemas now carry
  docblocks that *quote* `z.string().url()` while explaining why the field no
  longer uses it. A regex guard would flag the prose. The guard asserts this
  against the real `automation.schemas.ts`, not only a probe.

- **The SSRF finding was split out, not bundled.** #696. A scheme pin removes
  `http://` but not `https://169.254.169.254/`, and the fix wants a host policy
  plus a decision about dev carve-outs and send-time re-checks. Bundling a
  security fix into a contract-narrowing PR would hide it.

- **The published OpenAPI spec does not express the constraint.** Regenerating
  produced a byte-identical schema for the changed fields (`type: string,
  maxLength: 2000, format: uri`) — `@asteasolutions/zod-to-openapi` maps
  `z.url({protocol})` exactly as it mapped `z.string().url()`. So API consumers
  still read "any URI". Left as-is rather than hand-editing the generator;
  worth knowing before anyone treats the spec as the contract.

- **`.max(2000)` now applies to fields that had no cap** (the SSO URLs,
  `labelUrl`, the automation pair). A narrowing, and 2000 is far above any
  legitimate value — the longest real one is a Web Push endpoint at ~200 chars.
