/**
 * Breaking changes the owner has authorised, and the window they are valid in.
 *
 * ## Why the gate needed one (#1463)
 *
 * `openapi-breaking-change.test.ts` asserts `breaking: []` — unconditionally,
 * with no allowlist, and `API_CONTRACT_VERSION` is read by neither the test nor
 * the classifier. So a deliberate, owner-approved breaking change had exactly
 * two routes through the gate: edit the assertion, or route around it. Both are
 * how a safety gate stops meaning anything.
 *
 * That was not academic. agrent backend-2's correct narrowing of
 * `ParcelGeo.geometry.type` — removing `Polygon`, a value the database
 * physically cannot hold — sat blocked behind a gate with no legitimate exit,
 * while #1390's repoint that took ten documented properties off a response
 * went through green because the gate could not see paths at all. Severity
 * tracked detectability rather than impact.
 *
 * ## The lifecycle, which is the whole design
 *
 * An entry is honoured ONLY while `API_CONTRACT_VERSION` equals its
 * `contractVersion`. That single rule does the garbage collection:
 *
 *   - while the PR is open, the entry lets its authorised break through;
 *   - once merged, the base contains the change, nothing is detected, and the
 *     entry is inert;
 *   - at the NEXT version bump the entry becomes invalid and the test refuses
 *     it, so you cannot bump again without clearing the previous window.
 *
 * So the list cannot silently accumulate. An acknowledgement is a temporary
 * note attached to one contract version, not a permanent exemption — which is
 * the failure mode of every allowlist that outlives the thing it allowed.
 *
 * ## Keyed coarsely on purpose
 *
 * Omitting `property` acknowledges every finding of that `kind` on that
 * `schema`. #1390 produces **22** `property-removed` findings for one
 * decision — eleven properties across two `anyOf` branches of the same
 * envelope — and a list requiring 22 lines to express one authorised change
 * would not be used. The coarse key is what keeps it writable; `property` is
 * there for when a narrower record is the honest one.
 *
 * ## What an entry must carry
 *
 * `pr`, `date` and `why`, all asserted non-empty. A bare `{kind, schema}`
 * would make the list a place to put things, and the point is that it is a
 * place to JUSTIFY things — reviewable in a diff, which an edited assertion
 * is not.
 */
import { API_CONTRACT_VERSION } from '../../src/lib/api/contract-version';

export interface AcknowledgedBreakingChange {
    /** The classifier's kind, e.g. `enum-narrowed`. */
    kind: string;
    /** A component name, or an operation label like `GET /api/t/{x}/y -> 200`. */
    schema: string;
    /** Omit to cover every property of this kind on this schema. */
    property?: string;
    /** Honoured ONLY while `API_CONTRACT_VERSION` equals this. */
    contractVersion: number;
    /** The pull request that authorised it. */
    pr: number;
    /** ISO date the owner approved it. */
    date: string;
    /** Why it is correct, in one sentence a reviewer can disagree with. */
    why: string;
}

/**
 * EMPTY, deliberately, in the change that introduces the mechanism.
 *
 * An entry belongs in the same diff as the break it authorises and the version
 * bump that scopes it, so a reviewer sees all three together. Adding
 * backend-2's `ParcelGeo` entry here would separate the justification from the
 * change, and would also be me recording an approval relayed to me rather than
 * given on the PR that needs it.
 *
 * The shape, for the next person:
 *
 *     {
 *         kind: 'enum-narrowed',
 *         schema: 'ParcelGeo',
 *         property: 'geometry.type',
 *         contractVersion: 3,
 *         pr: 1461,
 *         date: '2026-10-09',
 *         why: 'Polygon cannot occur: the column is geometry(MultiPolygon,4326) and ST_Multi wraps every write.',
 *     }
 */
export const ACKNOWLEDGED_BREAKING_CHANGES: readonly AcknowledgedBreakingChange[] = [
    {
        kind: 'enum-narrowed',
        schema: 'ParcelGeo',
        property: 'geometry.type',
        contractVersion: 3,
        pr: 1461,
        date: '2026-10-09',
        why:
            'Polygon cannot occur. The column is geometry(MultiPolygon, 4326) so PostGIS ' +
            'refuses one at write time, every write path in src/lib/db/geo.ts wraps the input ' +
            'in ST_Multi (11 occurrences), and zero write sites bypass that module — which ' +
            'geo-raw-sql-containment enforces. agrent-ios independently confirms it decodes ' +
            'MultiPolygon only, and this is a RESPONSE field, so the classifier\'s own harm ' +
            'statement ("a client still sending it is rejected") cannot apply. The declaration ' +
            'being narrowed landed hours earlier in #1455 and was never true of any response ' +
            'this server can produce.',
    },
    {
        kind: 'type-changed',
        schema: 'POST /api/auth/accept-terms -> 400',
        property: 'error',
        contractVersion: 3,
        pr: 1467,
        date: '2026-10-09',
        why:
            'The spec was wrong, not the server. src/app/api/auth/accept-terms/route.ts ' +
            'answers jsonResponse({ error: \'terms_not_accepted\' }, { status: 400 }) and ' +
            '{ error: \'terms_version_stale\', ... } — `error` is a bare string on every ' +
            'branch, and no code path on this route has ever built the rich ErrorResponse ' +
            'object the spec declared. So this narrows a DECLARATION to what the ' +
            'implementation already did; no response any client can receive changes shape. ' +
            'A generated client that typed `error` as an object was already mis-decoding ' +
            'every 400 from this route.',
    },
    {
        // No `property`: this is one decision about one envelope, and it
        // produces five findings (code, message, requestId, details, params).
        kind: 'property-removed',
        schema: 'POST /api/auth/accept-terms -> 400',
        contractVersion: 3,
        pr: 1467,
        date: '2026-10-09',
        why:
            'The same single fact as the type-changed entry above: `error` is a string here, ' +
            'so it has no sub-properties to remove. Each of the five was documented and ' +
            'never sent — a client reading error.code got undefined BEFORE this change, ' +
            'which is what makes the removal a correction rather than a withdrawal. ' +
            'Verified against the route rather than inferred from the request shape, after ' +
            'doing exactly that inference wrong on #1443 earlier today.',
    },
];

/** True when `entry` covers `finding`. */
export function acknowledges(
    entry: AcknowledgedBreakingChange,
    finding: { kind: string; schema?: string; property?: string },
): boolean {
    if (entry.contractVersion !== API_CONTRACT_VERSION) return false;
    if (entry.kind !== finding.kind) return false;
    if (entry.schema !== finding.schema) return false;
    // No `property` on the entry means "every property of this kind here".
    if (entry.property !== undefined && entry.property !== finding.property) return false;
    return true;
}

/** The findings no entry covers. */
export function unacknowledged<T extends { kind: string; schema?: string; property?: string }>(
    findings: readonly T[],
): T[] {
    return findings.filter(
        (f) => !ACKNOWLEDGED_BREAKING_CHANGES.some((entry) => acknowledges(entry, f)),
    );
}
