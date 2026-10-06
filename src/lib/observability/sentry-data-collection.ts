/**
 * The Sentry data-collection posture — ONE definition, server and browser.
 *
 * ## Why this module exists at all
 *
 * Sentry 10 had a single boolean, `sendDefaultPii`, and #1158/#1280 set it
 * `false` on both inits rather than inheriting a default. **Sentry 11 removes
 * that option entirely** and replaces it with the nested `dataCollection`
 * object — in which *every* field defaults to `true`.
 *
 * Measured against the published `@sentry/core@11.2.0` type definitions
 * (`build/types/types/datacollection.d.ts`), each with `@default true`:
 *
 *     userInfo              cookies            httpHeaders (request+response)
 *     httpBodies (all four) urlQueryParams     graphQL (document+variables)
 *     genAI (inputs+outputs) databaseQueryData queues
 *     stackFrameVariables
 *
 * `@sentry/nextjs@11.2.0` declares no override, so core's defaults apply.
 *
 * So deleting `sendDefaultPii: false` to make the compiler happy is not a
 * no-op: it inverts the posture from "collect nothing personal" to "collect
 * user info, cookies, both header directions, **request and response
 * bodies**, query params and database query data". On a product whose
 * `FarmProfile.egn` (a Bulgarian national identity number) and
 * `ParcelLease.lessorName` are in `ENCRYPTED_FIELDS` *because* they are
 * personal data, an incoming request body is the last thing that should reach
 * a third party. The #1280 commit comments predicted this restructure; this is
 * the translation.
 *
 * ## Why one shared constant rather than a copy in each init
 *
 * The posture has to hold on BOTH sides, and two literals are two things that
 * drift — the same failure as the `attribution()` and `outboxHeaders()`
 * helpers in this repo, each created after two paths disagreed. One object,
 * imported twice, cannot disagree with itself.
 *
 * The only import is TYPE-ONLY and is erased at compile time, so this stays
 * safe in the browser bundle — and the annotation does real work: with
 * `: DataCollection` the compiler rejects a typo'd field name and a field the
 * SDK REMOVES. It cannot catch a field the SDK ADDS, because every one is
 * optional; that is the parity test's job, and the two are complementary.
 *
 * It imports from `@sentry/nextjs`, the package this repo DECLARES, rather
 * than `@sentry/core`, which is only a transitive dependency — a type-only
 * import of an undeclared package is still a phantom dependency.
 *
 * ## Adding a field
 *
 * A new Sentry minor can add a `dataCollection` key, and it will default to
 * `true` like the rest. `tests/unit/observability-sentry.test.ts` compares
 * these keys against the installed type definition and fails when the SDK
 * grows one we have not decided about — an opt-out that silently stops
 * covering a new category is the defect this whole module exists to prevent.
 */

import type { init } from '@sentry/nextjs';

/**
 * The `dataCollection` option, derived from `init`'s OWN parameter type.
 *
 * Deliberately not `import type { DataCollection } from '@sentry/core'`: core
 * is only a TRANSITIVE dependency here (package.json declares `@sentry/nextjs`
 * alone), and a type-only import of an undeclared package is still a phantom
 * dependency. `@sentry/nextjs` does not re-export that name, so the type is
 * derived from the function this code actually calls — which is a stronger
 * pin anyway: it tracks what `init` ACCEPTS rather than a name that could be
 * re-exported, renamed or deprecated independently.
 */
type SentryDataCollection = NonNullable<
    NonNullable<Parameters<typeof init>[0]>['dataCollection']
>;

/**
 * Everything off. This app uses Sentry for stack traces, not for telemetry
 * about people, so there is no category here worth trading.
 *
 * `httpBodies` is an ARRAY of targets rather than a boolean — `[]` is its
 * "none" value, and the four members it omits are
 * `incomingRequest` / `outgoingRequest` / `incomingResponse` /
 * `outgoingResponse`.
 */
export const SENTRY_DATA_COLLECTION: SentryDataCollection = {
    /** `user.*` fields from instrumentation — the visitor's identity. */
    userInfo: false,
    /** Session cookies are credentials. */
    cookies: false,
    /** Both directions: request headers carry the caller's IP and bearer. */
    httpHeaders: { request: false, response: false },
    /** No body in either direction — this is where EGN and lessor names live. */
    httpBodies: [],
    /** A query string can carry an id; the repo bans PII there, belt and braces. */
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    /** Bound parameters and returned rows. Structural metadata still flows. */
    databaseQueryData: false,
    /** Job payloads carry tenant data. */
    queues: false,
    /** Local variables in a frame can hold a decrypted field mid-function. */
    stackFrameVariables: false,
};

/**
 * The keys above, for the guard that compares them against the SDK's own type.
 * Derived rather than restated so the two cannot drift.
 */
export const SENTRY_DATA_COLLECTION_KEYS = Object.keys(
    SENTRY_DATA_COLLECTION,
).sort();
