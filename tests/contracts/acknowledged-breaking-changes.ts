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
        kind: 'type-changed',
        schema: 'POST /api/t/{tenantSlug}/locations/{id}/spatial-import -> 400',
        contractVersion: 3,
        // 1633, not 1630. Corrected in #1612's change: this entry was added in
        // c286ae751, which is #1633's squash. #1630 is an unrelated P5.5b
        // notice-scoring PR from another session, so a reviewer following this
        // field — whose stated purpose is "the pull request that authorised
        // it" — landed on a PR saying nothing about spatial-import. My error.
        pr: 1633,
        date: '2026-10-11',
        why:
            'A FARMER was reading English. The route answered a bare ' +
            '`{ error: "<sentence>" }`, honestly declared as `RawErrorResponse` \u2014 so this is ' +
            'a deliberate contract change, not a spec correction. agrent-ios passes a refusal ' +
            'sentence straight through when there is no `error.code` to translate by, so ' +
            '\u00abFile exceeds the 5 MB limit\u00bb appeared verbatim on a Bulgarian upload screen. These ' +
            'are the ONLY bare refusals the phone can reach: agrent-ios confirmed from their ' +
            'route contract that of 36 such routes it builds exactly two, both of them here. ' +
            'Now `ErrorResponse` with FILE_REQUIRED / FILE_EMPTY / SPATIAL_UPLOAD_TOO_LARGE ' +
            '(carrying size, limit and format as params) / UNSUPPORTED_FILE_TYPE, so the client ' +
            'composes its own sentence. The 413, 415 and the job poll\u2019s 404 change the same way ' +
            'and are the same decision. Cadastre-import was deliberately EXCLUDED \u2014 the phone ' +
            'does not upload cadastre files, so nobody meets those refusals, and an approval for ' +
            'one route is not an approval for the next. Owner authorised directly on 2026-10-11, ' +
            'asked because this file records the owner\u2019s approval rather than an agent\u2019s ' +
            'judgement.',
    },
    {
        kind: 'schema-removed',
        schema: 'AuthRegisterRequest',
        contractVersion: 3,
        pr: 1628,
        date: '2026-10-11',
        why:
            'It describes a request nobody can make. The route it was the body of, ' +
            'POST /api/auth/register, was RETIRED in #1379 and now 404s; the schema was left ' +
            'behind because `openapi-build.ts` registers components by walking the module ' +
            'namespace, so an exported-but-unimported schema publishes itself. Importers under ' +
            'src/: ZERO, and the orphan guard (#1438) has been pinning it as a known orphan ' +
            'ever since. The classifier\'s harm statement — "a client decoding it fails ' +
            'outright" — is true only of a client decoding a 404. Leaving it published is the ' +
            'inverse of #1370: there the wire had a field the spec lacked, so a client could ' +
            'not use something real; here the spec advertises something that does not exist, so ' +
            'a client can implement a call that cannot succeed. Owner authorised the removal ' +
            'directly on 2026-10-11, asked because this file records the owner\'s approval and ' +
            'not an agent\'s own judgement.',
    },
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
    {
        kind: 'property-removed',
        schema: 'GET /api/t/{tenantSlug}/grain/costs/defaults -> 200',
        property: 'overheads',
        contractVersion: 3,
        pr: 1641,
        date: '2026-10-11',
        why:
            'The route returns TWO disjoint shapes and the 200 declared one, so the spec told a ' +
            'reader something false for half the route\'s inputs: omit `commodity` and you get ' +
            '`{ overheads }`, send it and you get `{ commodity, lines }`. The 200 is now ' +
            '`z.union([CostDefaults, CropCostDefaults])`, which moves `overheads` from a ' +
            'top-level property into an `anyOf` member \u2014 hence `property-removed`. NO byte any ' +
            'caller receives changes: one that never sends `commodity` gets exactly what it got ' +
            'before. The break is codegen-only and there is no codegen consumer to break \u2014 no ' +
            '`openapi-typescript` in the tree, nothing imports generated API types, and ' +
            'agrent-ios reviewed #1611 and confirmed every response is a hand-written ' +
            '`Decodable`. The now-redundant `registry.register(\'CropCostDefaults\')` goes in the ' +
            'same change: the union makes the component reachable, and keeping both would leave ' +
            'two divergent copies of one shape. Owner authorised on 2026-10-11, having been ' +
            'shown the codegen measurement and the alternative of splitting the route into two ' +
            'paths \u2014 which would have needed an agrent-ios change and a deprecation window. ' +
            'Tracked as #1612; found by agrent-ios reviewing #1611 against its head rather than ' +
            'against my description of it.',
    },
    {
        kind: 'property-now-required',
        schema: 'SuspendAccount',
        property: 'reason',
        contractVersion: 3,
        pr: 1674,
        date: '2026-10-12',
        why:
            'A direct suspension now RECORDS its reason, so the route cannot accept a request ' +
            'without one. `POST /api/admin/moderation/suspensions` took an optional `reason` and ' +
            'DISCARDED the text: only `hasReason: true|false` reached `PlatformAuditLog`, under a ' +
            'comment correctly saying the rationale "belongs on `ModerationAction.rationale`, ' +
            'which is [encrypted]" — a comment describing a row this path never created. So a ' +
            'moderator typed a reason and nothing kept it, and a proactive suspension had no ' +
            'recorded justification at all. It is now the `rationale` of a PROACTIVE ' +
            '`ModerationAction` (`reportId: null`, which the schema anticipated in terms), ' +
            'encrypted at rest, and it is what an Art 17 statement of reasons is composed from. ' +
            'The caller population is ONE: a platform admin holding ' +
            '`PLATFORM_ADMIN_API_KEY`, which is the owner — there is no third-party ' +
            'integration and agrent-ios does not call admin routes. Owner ruling on #1667 ' +
            '(2026-10-12) is that a suspension carries a statement and "the moderator still ' +
            'writes the reason", so requiring it is the ruling rather than a side effect of it. ' +
            'The alternative — keeping it optional and writing an empty rationale — would put ' +
            'an unexplained decision in a legal record, which is the defect in the other ' +
            'direction. Found while implementing that ruling; the route\'s LOCAL `SuspendBody` ' +
            'and the published `SuspendAccount` schema are separate zod objects, so narrowing ' +
            'one left the other documenting the old contract until this change.',
    },
    {
        kind: 'schema-removed',
        schema: 'RestoredLogEntry',
        contractVersion: 3,
        pr: 2254,
        date: '2026-10-24',
        why:
            'Nothing can be restored any more. It was the response body of POST ' +
            '/api/t/{tenantSlug}/journal/{id}/restore, which this same PR RETIRES under the ' +
            'owner\'s «Кошче» ruling: the journal-entry DELETE is physical now, so there is no ' +
            'soft-deleted row for a restore to return. Importers under src/: ZERO — it existed ' +
            'only as that route\'s declared response, so the removal takes the schema and its ' +
            'single producer out together. That is the DIFFERENCE from the AuthRegisterRequest ' +
            'entry above, which was an orphan the spec kept publishing for a route retired ' +
            'hundreds of PRs earlier; here the spec never gets to advertise a restore response ' +
            'for a route that 404s, because both leave in one change. The classifier\'s harm ' +
            'statement — "a client decoding it fails outright" — needs a client: the only ' +
            'decoder was the phone\'s trash screen, and agrent-ios removed «Кошче» in its #413, ' +
            'MERGED 2026-10-23, so the client change landed BEFORE this removal rather than ' +
            'chasing it. The web decoder, DeletedJournalView.tsx, is deleted in this PR. The ' +
            'undo a farmer actually uses is now client-side and fires before the request is ' +
            'sent, so it needs no route and no schema. Owner authorised directly on 2026-10-24 ' +
            '— asked whether entry-level trash went too and ruled "everything deleted is gone" ' +
            '— recorded here because this file carries the owner\'s approval and not an ' +
            'agent\'s own judgement.',
    },
    {
        kind: 'property-removed',
        schema: 'FarmProfile',
        property: 'egn',
        contractVersion: 3,
        pr: 2257,
        date: '2026-10-24',
        why:
            'The column is gone, so the response has nothing to put there. Owner ruling ' +
            '2026-10-24: the product does not hold a Bulgarian national identity number. ' +
            'The migration overwrites every value with NULL and then drops the column, and ' +
            'the ДНЕВНИК cover prints ЕИК + УРН where the boxed ЕГН was.\n\n' +
            'The client population is KNOWN rather than assumed, which is the whole reason ' +
            'this is acknowledgeable. agrent-ios confirmed on 2026-10-24 that its current ' +
            'build (#414, TestFlight since 0.1.0) declares no `egn` property at all, so a ' +
            'missing key decodes fine; and that builds ≤13.1 declared `let egn: String?` ' +
            'with the synthesised decoder, where a missing key decodes to nil rather than ' +
            'failing. So no shipped build breaks on the absence — which is a stronger ' +
            'statement than "the field is optional", because an optional field can still be ' +
            'required by a hand-written decoder.\n\n' +
            'The REQUEST schema deliberately keeps `egn`, so this is a one-sided removal ' +
            'and `UpdateFarmProfileRequest` produces no finding. That is not an oversight: ' +
            '`UpdateFarmProfileSchema` ends in `.strip()`, so deleting the property would ' +
            'make zod discard an `egn` a client sent without a word, and a client that ' +
            'believes it stored a national identity number would be told it succeeded. It ' +
            'is refused with a coded 400 instead — conditionally, only for a non-null ' +
            'value, because the iOS editor PUTs every field on every save and #1352 records ' +
            'that an unconditional refusal on `eik` 400d every farm-profile save from the ' +
            'owner\'s phone.\n\n' +
            'Owner authorised the removal directly on 2026-10-24, asked as "all of it" — ' +
            'erase the values, drop the column, change what the cover prints, update the ' +
            'consent text — and recorded here because this file carries the owner\'s ' +
            'approval and not an agent\'s own judgement.',
    },
    {
        kind: 'type-changed',
        schema: 'TreatmentDefinitionLine',
        property: 'locationId',
        contractVersion: 3,
        pr: 2305,
        date: '2026-10-25',
        why:
            'The same shape as the #1467 entry above: this narrows a DECLARATION to what the '
            + 'implementation already did, so no response any client can receive changes. '
            + '`Parcel.locationId` is NOT NULL with a required relation to `Location`, and '
            + '`recordDiaryTreatment` keys its per-block grouping on it with no null check and no '
            + 'fallback bucket \u2014 which only works because the column is non-null: a parcel without '
            + 'a block could not be grouped, so it could not be recorded as a treatment at all. '
            + 'There is no orphan path either (the relation is `onDelete: Cascade`, and a '
            + 'soft-deleted parcel keeps its `locationId`), so no stored row can produce the null '
            + 'the spec admitted. A consumer sees strictly FEWER shapes than before, and nothing '
            + 'round-trips the field \u2014 the correction PUT carries '
            + '`parcels: [{parcelId, treatedAreaHa}]` and no `locationId`. '
            + 'Prompted by the agrent-ios session asking whether a real treatment could carry a '
            + 'null here, because it was about to write a branch for the case. That is the cost '
            + 'of a nullable-but-never-null field, and the type is where the answer belongs.',
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
