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
 * narrowed enum, a narrowed type.
 *
 * Additive change does NOT bump this. If every new optional field forced a
 * bump, the number would stop meaning "clients must update" and start meaning
 * "time passed".
 */
export const API_CONTRACT_VERSION = 1;

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
