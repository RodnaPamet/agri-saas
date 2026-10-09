/**
 * The API contract version, and the minimum client we still serve.
 *
 * SINGLE VERSION, not per-route `introduced-in` metadata. The choice follows
 * the deployment shape rather than taste: this server deploys atomically —
 * Watchtower updates `app` and `worker` together — so routes never ship
 * independently of one another. Per-route metadata would add per-route
 * maintenance to buy a granularity the release process cannot express.
 *
 * These constants are exported INTO the generated spec (`x-api-version`,
 * `x-minimum-client-version`), so the contract carries its own version rather
 * than the number living only in prose that drifts.
 *
 * WHY THIS IS NOT `info.version`: that is `package.json::version`, which
 * semantic-release bumps on every release, and the contract test explicitly
 * STRIPS it before comparing so a routine bump is not read as spec drift.
 * Reusing it would make the API version invisible to exactly the check that
 * should police it.
 */

/**
 * Bumped ONLY on a breaking change — the classes `scripts/openapi-breaking.ts`
 * detects: a removed schema or property, a property becoming required, a
 * narrowed enum, a narrowed type, a repointed `$ref`. Since #1214 every one of
 * those is scored at EVERY depth, not only on a schema's top-level properties,
 * so a nested field's verdict is a verdict rather than a silent pass.
 *
 * Additive change does NOT bump this. If every new optional field forced a
 * bump, the number would stop meaning "clients must update" and start meaning
 * "time passed".
 */
export const API_CONTRACT_VERSION = 3;

/*
 * 2 -> 3 (2026-10-09): `ParcelGeo.geometry.type` and `Parcel.geometry.type`
 * narrowed from `["Polygon", "MultiPolygon"]` to `MultiPolygon` alone.
 *
 * WHAT BROKE, AND WHY IT COULD NOT BE ADDITIVE. An enum narrowing is one of
 * the six classes `scripts/openapi-breaking.ts` scores, and there is no
 * additive way to say "this value never occurs" — stating it in the
 * description alone would leave a generated client emitting a two-case enum
 * for a one-case reality, which is the defect agrent-ios reported in the
 * first place, inverted.
 *
 * The removed value CANNOT OCCUR, measured three ways:
 *   · the column is `geometry(MultiPolygon, 4326)`, so PostGIS refuses a
 *     Polygon at write time (migration 20260613090735_ag_feature1_spray_map);
 *   · `src/lib/db/geo.ts` wraps every input in `ST_Multi` (11 occurrences);
 *   · zero write sites bypass that module, which
 *     `tests/guardrails/geo-raw-sql-containment.test.ts` enforces.
 * agrent-ios independently confirms it decodes MultiPolygon only.
 *
 * WHICH CLIENT VERSIONS STOP WORKING: none. The classifier's own detail reads
 * "a client still sending it is rejected", and this is a RESPONSE field —
 * nobody sends it. The baseline being narrowed is #1455's declaration from
 * earlier the same day, which was never true of any response this server can
 * produce, so no client can have relied on it.
 *
 * RELEASE SEQUENCE: none required, which is the honest answer rather than a
 * skipped step. `docs/api-compatibility.md` asks for app-first because a
 * behaviour change strands installed builds; nothing about the wire changes
 * here, and the only known client already decodes the narrower form.
 * `MINIMUM_SUPPORTED_CLIENT_VERSION` stays at 1.
 *
 * Signed off by the repository owner on the PR, per "Who decides".
 *
 * 1 -> 2 (2026-10-08): `Task` split into `TaskListItem` and `TaskDetail`.
 *
 * Breaking by the classes above — `GET /tasks` has its `$ref` REPOINTED and
 * loses ten documented properties — and NOT breaking in behaviour: the server
 * sends the same bytes it always did. What changed is that the contract stopped
 * promising a list row carries `description`, `tenantId`, `source`,
 * `resolution`, `metadataJson`, `reviewer` and `createdBy`, which it has never
 * sent. The bump is bought by the classifier's definition, not by any client
 * being broken.
 *
 * `MINIMUM_SUPPORTED_CLIENT_VERSION` therefore stays at 1, deliberately:
 * nothing is cut off, because nothing that worked stops working. Raising it is
 * a separate act, as the note below says.
 */

/**
 * The oldest contract version this server still answers.
 *
 * Equal to the current version until the first breaking change, after which
 * `docs/api-compatibility.md` governs how long the previous one keeps working.
 * Raising this is what actually cuts off old clients, and it is a deliberate,
 * separately-reviewed act — never a side effect of a bump.
 */
export const MINIMUM_SUPPORTED_CLIENT_VERSION = 1;

/**
 * Header a native client sends to declare which contract it was built against.
 *
 * Absent = a browser or an old build. Absence is TREATED AS COMPATIBLE: the web
 * client ships with the server and cannot be stale, and refusing unversioned
 * requests would break every existing integration on the day this lands.
 */
export const CLIENT_VERSION_HEADER = 'x-agrent-client-version';

/** The distinct, machine-readable refusal an app can turn into "please update". */
export const CLIENT_TOO_OLD_CODE = 'client_version_unsupported';

export interface ClientVersionVerdict {
    ok: boolean;
    /** Parsed version, or null when the header was absent or unparseable. */
    clientVersion: number | null;
}

/**
 * Decide whether a declared client version is still served.
 *
 * Unparseable is treated exactly like absent rather than as a refusal. A
 * garbled header is far likelier to be a proxy mangling things than an
 * attacker, and failing those requests would turn an infrastructure quirk into
 * a fleet-wide outage for a check that is advisory by design.
 */
export function checkClientVersion(
    headerValue: string | null | undefined,
    /**
     * The floor to compare against. Defaults to the shipped constant; taken as
     * a parameter so the COMPARISON can be exercised before any version is
     * actually deprecated. With the floor at 1 and versions starting at 1, no
     * real client can be too old yet — testing the mechanism would otherwise
     * mean asserting on version 0, which is not a version at all.
     */
    minimum: number = MINIMUM_SUPPORTED_CLIENT_VERSION,
): ClientVersionVerdict {
    if (!headerValue) return { ok: true, clientVersion: null };

    const parsed = Number.parseInt(headerValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: true, clientVersion: null };
    }

    return {
        ok: parsed >= minimum,
        clientVersion: parsed,
    };
}

/**
 * The body an app can branch on.
 *
 * Deliberately NOT a generic 400. An app receiving `{"error":"Bad Request"}`
 * shows the operator a bug; one receiving `client_version_unsupported` shows
 * "please update" and links the store. The whole point of the machine-readable
 * code is that the two are distinguishable without parsing prose.
 */
export function clientTooOldBody() {
    return {
        error: CLIENT_TOO_OLD_CODE,
        minimumSupportedVersion: MINIMUM_SUPPORTED_CLIENT_VERSION,
        currentVersion: API_CONTRACT_VERSION,
        message:
            'This app version is no longer supported by the server. Please update to continue.',
    };
}
