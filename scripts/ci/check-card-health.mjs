/**
 * Did the day's channel cards land where content existed? (#2944)
 *
 * ## The criterion, as ruled rather than as written
 *
 * P9.10 asks for "a card-health alert if a commodity channel gets no card in a
 * day". Measured on production 2026-11-16, that fires for 15 of 15 commodity
 * channels today and 12 of 15 yesterday: there are 15 commodity channels, four
 * cards have ever been written, and today's single card is a LISTING, which
 * goes to the 28 OBLAST channels. A probe that is never green destroys the
 * reason for watching it — `ci-failure-issue.yml` closes its issue on the next
 * green run, and that only means something if green is reachable.
 *
 * Owner ruling 2026-11-16: alert when a card was **DUE** and did not appear.
 *
 * `runChannelCards` already derives that and records it, so this script does
 * no derivation of its own. The property is `withContent > created` per kind —
 * "of the channels this kind can serve, the ones that had content today"
 * against `createMany`'s own count. Re-deriving eligibility here would be two
 * spellings of one rule with a silent divergence (#1664), and the probe is the
 * half nobody would check.
 *
 * ## Three verdicts, and the third is the load-bearing one
 *
 * Copied from `check-release-sboms.mjs` deliberately, because the failure
 * shape is identical: **an empty population produces zero missing cards,
 * which is byte-identical to a clean audit.** A Redis flush, a scheduler that
 * lost the repeatable, a renamed key, an unreachable host — each produces
 * "nothing short" and each means we do not know.
 *
 *   clean      — a record inside the window and no kind short. Exit 0.
 *   missing    — a record inside the window with a kind short. Exit 1.
 *   unaudited  — no record, a stale one, or Redis unreadable. Exit 1.
 *
 * Exit 0 ONLY on clean. That is the whole point of the third verdict and the
 * reason the exit code is not `shortfall > 0`.
 *
 * ## It reads `/api/readyz`, like its siblings
 *
 * `Basemap Provenance` is the pattern: a scheduled probe reads a WATCHED
 * `capabilities.*` field off the deployed app. GitHub Actions cannot reach the
 * production database — it is a local Docker volume on the VM — so an HTTP
 * reading is the only one available, and `capabilities` is documented as
 * "reported for operator observability, never part of checks/failed", so this
 * probe cannot 503 the app it is probing.
 *
 * Usage:  node scripts/ci/check-card-health.mjs [--url https://app.agrent.bg]
 */

const DEFAULT_URL = 'https://app.agrent.bg/api/readyz';

/** Separate from a content finding: a probe that could not read is not a pass. */
function unaudited(reason, detail = {}) {
    return { verdict: 'unaudited', reason, ...detail };
}

/**
 * @param {{ fetchImpl?: typeof fetch, url?: string }} [opts]
 */
export async function checkCardHealth(opts = {}) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url = opts.url ?? DEFAULT_URL;

    let res;
    try {
        res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (err) {
        return unaudited(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // A 503 is EXPECTED here and is not this probe's business: readyz 503s on a
    // dependency failure, and `capabilities` is outside `checks`. So the body
    // is read either way and only an unreadable body is unaudited.
    let body;
    try {
        body = await res.json();
    } catch {
        return unaudited(`readyz returned a body that is not JSON (status ${res.status})`);
    }

    // WHOSE readyz this is. #1117/#1143: another app served this hostname for
    // ~6h and emitted the same `"status":"ready"`, which is why `service` was
    // added. A probe that skips this check can report cheerfully about an app
    // that has no channels at all.
    if (body?.service !== 'agri-saas') {
        return unaudited(
            `readyz reports service=${JSON.stringify(body?.service)} — not agri-saas, so this says nothing about our cards`,
        );
    }

    const cap = body?.capabilities?.cardHealth;
    if (!cap || typeof cap !== 'object') {
        return unaudited('readyz carries no capabilities.cardHealth — an older image, or the field was removed');
    }

    const detail = {
        state: cap.state,
        day: cap.day,
        ageMinutes: cap.ageMinutes,
        kindsConsidered: cap.kindsConsidered,
        kindsDormant: cap.kindsDormant,
        shortfall: cap.shortfall,
        shortKinds: cap.shortKinds,
    };

    switch (cap.state) {
        case 'ok':
            // The DENOMINATOR is checked, not just the shortfall. `kinds
            // considered: 0` cannot happen through `parseCardHealthRecord`,
            // which refuses an empty `byKind` — this is the belt to that
            // braces, because "no kind was short" over no kinds is the exact
            // vacuous pass the third verdict exists for.
            if (!Number.isFinite(cap.kindsConsidered) || cap.kindsConsidered <= 0) {
                return unaudited('state is ok but the record carried no kinds — nothing was actually audited', detail);
            }
            return { verdict: 'clean', ...detail };
        case 'cards_missing':
            return { verdict: 'missing', ...detail };
        case 'stale':
            return unaudited(
                `the newest card record is ${cap.ageMinutes} minutes old (stale after ${cap.staleAfterMinutes}) — the job may have stopped`,
                detail,
            );
        case 'never_recorded':
            return unaudited('no card run has ever recorded a reading', detail);
        case 'unknown':
            return unaudited('readyz could not read the record (Redis unconfigured or unreachable)', detail);
        default:
            // A state this script does not know is unaudited, never clean. The
            // capability may gain a state before this script learns it, and
            // defaulting to clean would make that a silent downgrade.
            return unaudited(`unrecognised state ${JSON.stringify(cap.state)}`, detail);
    }
}

/* c8 ignore start -- the CLI shell; `checkCardHealth` is what the tests call */
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
    const urlArg = process.argv.indexOf('--url');
    const result = await checkCardHealth(
        urlArg > -1 ? { url: process.argv[urlArg + 1] } : {},
    );
    const prefix = '[card-health]';
    if (result.verdict === 'clean') {
        console.log(`${prefix} clean — ${result.kindsConsidered} kind(s) considered, ${result.kindsDormant} dormant, day ${result.day}`);
        process.exit(0);
    }
    if (result.verdict === 'missing') {
        console.error(`${prefix} MISSING — ${result.shortfall} card(s) due and not written, kinds: ${(result.shortKinds ?? []).join(', ')} (day ${result.day})`);
        process.exit(1);
    }
    console.error(`${prefix} UNAUDITED — ${result.reason}`);
    console.error(`${prefix} an unaudited run is NOT a pass: zero missing cards and "could not look" are the same observation.`);
    process.exit(1);
}
/* c8 ignore stop */
