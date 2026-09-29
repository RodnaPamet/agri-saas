/**
 * Which application is answering this request.
 *
 * An external probe asks "is the service healthy?" and gets back a body. The
 * body only answers that question if it also says WHOSE health it describes —
 * otherwise a probe can pass by reaching a different application entirely.
 *
 * That is not hypothetical here. On 2026-09-27, `app.agrent.bg` was served
 * intermittently by a second product for nearly six hours (#1117, fixed in
 * #1143): a sibling stack shared the `agrent_internal` Docker network and
 * declared the same `app` network alias, so Docker DNS answered with two
 * addresses and Caddy's `reverse_proxy app:3000` picked between them per
 * connection. That PR records the consequence in one line:
 *
 *   > `/api/readyz` answered 200 through the proxy while agri-saas 404'd it —
 *   > because the 200 came from the OTHER app.
 *
 * The GCP uptime check survived that only by luck. Its content matcher is
 * `"status":"ready"`, and the misrouting app happened not to emit that string.
 * The two products that DO emit it — this one and `inflect-compliance` —
 * share a GCP project, a GHCR org and, as #1143 proved, a Docker network.
 * Misrouting between those two is the case the matcher cannot catch, and it
 * is the likeliest one.
 *
 * ── Why this is a literal and not `package.json` ──
 *
 * `package.json` still reads `"name": "inflect-compliance"`, and
 * `OTEL_SERVICE_NAME` defaults to the same string — both inherited from the
 * spin-out this codebase came out of. Deriving the identity from either would
 * produce a value that matches the sibling product EXACTLY, which is worse
 * than no identity at all: a probe requiring it would go green on precisely
 * the misroute it exists to detect.
 *
 * ── Why `agri-saas` rather than `agrent` ──
 *
 * `agrent` is the deployment and the hostname; `agri-saas` is the repository
 * and the GHCR image path. CLAUDE.md records that the GHCR org is SHARED and
 * that "only the image NAME separates the two products", so this is the token
 * an operator already uses to tell them apart — and the one that matches
 * `ghcr.io/rodnapamet/agri-saas` when they go looking.
 *
 * ── Changing it is a TWO-STEP deploy, in this order ──
 *
 * The app must SERVE the new value before any probe REQUIRES it. Tighten the
 * uptime check's content matcher first and every probe fails until the image
 * rolls — a self-inflicted outage alert, and the same ordering trap
 * CLAUDE.md records for the worker healthcheck ("the image must carry the
 * probe BEFORE the compose healthcheck runs it").
 */
export const SERVICE_ID = 'agri-saas' as const;

/**
 * The exact substring an external probe should require.
 *
 * Exported as one string so the check's matcher and the response cannot drift
 * apart by a quote or a space — the two live in different systems (this repo
 * and GCP Cloud Monitoring) and nothing but this constant connects them.
 * The `external-uptime.yml` alerting record carries the deployed value.
 * (Named without its directory path on purpose: `tests/guards/infra-
 * directories-are-referenced.test.ts` treats any `infra/<dir>` string in a
 * SOURCE file as evidence that something here runs it. Nothing does — the
 * check lives in GCP — so writing the path would turn this comment into a
 * false wiring and mis-record the directory.)
 */
export const SERVICE_ID_MATCHER = `"service":"${SERVICE_ID}"` as const;
