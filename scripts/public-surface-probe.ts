/**
 * Are the surfaces that are supposed to be publicly reachable actually
 * reachable? — #2009, option 3.
 *
 * Its instance 3: `social.public-profile` gated twelve call sites — `/f/{handle}`,
 * the OG image, the sitemap, the share card, the publication and handle routes,
 * the public farms API — and the `FeatureFlag` row **did not exist**. A missing
 * row is OFF by design, so every one of those surfaces returned `notFound()`
 * for everybody, and nothing noticed. CI proved the code worked; it cannot
 * prove the deployment reaches it.
 *
 * ## Why a 404 alone is not the signal
 *
 * `assertFeatureEnabled` answers **404, not 403**, deliberately — anti-
 * enumeration, so "disabled" is indistinguishable from "no such farm". Correct
 * for the threat model, and the exact reason this went unnoticed. A probe that
 * only said "this 404s" would be just as blind, because the same 404 arrives
 * when the whole site is down.
 *
 * So the probe carries an UNGATED CONTROL — `/robots.txt`, which no flag gates.
 * The control is what separates the two worlds:
 *
 *   - control OK  + a gated surface 404s  → **DARK**: the flag row is missing,
 *     the feature is off for everybody, and nobody asked for that.
 *   - control fails                       → **OUTAGE**: the site is not serving.
 *     Reported as its own state, because sending someone to hunt a missing
 *     flag row during an outage wastes the one thing an outage has least of.
 *
 * Without the control, both read as DARK and the second verdict is a lie.
 */

/** The ungated surface. If this fails, nothing else the probe says is trustworthy. */
export const CONTROL = { path: '/robots.txt', why: 'ungated — no FeatureFlag gates it' };

/**
 * The gated public surfaces, each with the reason it must not 404.
 *
 * Kept short on purpose. #2009: "the honest version is not a probe per feature
 * but a short list of surfaces that are supposed to be publicly reachable".
 */
/**
 * The directory, named once: `main()` must recognise it among `GATED` to keep
 * its body, and a second literal would drift from the entry below.
 */
export const DIRECTORY_PATH = '/api/public/farms';

export const GATED = [
    {
        path: '/sitemap.xml',
        why: 'gated by social.public-profile; a missing row makes it notFound() for crawlers',
    },
    {
        path: DIRECTORY_PATH,
        why: 'gated by social.public-profile; the public farms list. 200 with an EMPTY '
            + 'array is still reachable — content is not what this checks',
    },
];

/** Classify a set of results. Pure, so it can be tested without a network. */
export interface SurfaceResult {
    path: string;
    status: number | null;
}

/**
 * Whether `/f/{handle}` — the actual public farm page — was covered (#2328).
 *
 * The page needs a published handle to have an address at all, and production
 * had none when #2326 shipped: 0 `PublicFarmProfile`, 0 published `FarmBrand`.
 * Hard-coding a handle then would have meant a permanent 404 the probe reads as
 * DARK, or an invented one that cannot express failure.
 *
 * So the target is DERIVED from `/api/public/farms`, which the probe already
 * fetches. Two consequences worth being explicit about:
 *
 *   - the probe starts covering the real surface on its own the first time
 *     there is one to cover, with no edit;
 *   - when there is none, the verdict SAYS so. That is the whole point: a green
 *     reading over a population that excludes the interesting case is the same
 *     shape as the defect #2009 was filed for.
 */
export type DerivedTarget =
    | { probed: true; path: string }
    | { probed: false; why: string };

/**
 * First usable `/f/{handle}` in a `/api/public/farms` body, or why there is none.
 *
 * Pure, so the interesting cases — empty directory, a malformed body, a handle
 * with characters that cannot sit in a path — are testable without a network.
 * The endpoint returns a BARE ARRAY (no envelope), which this relies on and
 * therefore checks rather than assumes.
 */
export function deriveFarmPage(body: unknown): DerivedTarget {
    if (!Array.isArray(body)) {
        return {
            probed: false,
            why: `/api/public/farms did not return an array (got ${typeof body})`
                + ' — the directory shape changed and this derivation is stale',
        };
    }
    if (body.length === 0) {
        return {
            probed: false,
            why: 'no published farm profile exists, so /f/{handle} has no address to probe',
        };
    }
    for (const hit of body) {
        const handle = (hit as { handle?: unknown })?.handle;
        // A handle is a path SEGMENT. Anything that would need escaping is not
        // a handle this probe can address, and silently encoding it would make
        // the probe assert about a URL the product never serves.
        if (typeof handle === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(handle)) {
            return { probed: true, path: `/f/${handle}` };
        }
    }
    return {
        probed: false,
        why: `${body.length} directory entr(ies) but none carried a usable handle`,
    };
}

export type ProbeState = 'OK' | 'DARK' | 'OUTAGE' | 'BROKEN';

/**
 * `derived` is REQUIRED, not defaulted.
 *
 * A default would let a caller omit the coverage statement and still get a
 * clean OK — which is precisely the defect #2328 describes. The parameter
 * exists to make "what did this NOT cover" impossible to leave out.
 */
export function classify(
    controlStatus: number | null,
    gatedResults: SurfaceResult[],
    derived: DerivedTarget,
): { state: ProbeState; detail: string } {
    if (controlStatus === null || controlStatus >= 500 || controlStatus === 0) {
        return {
            state: 'OUTAGE',
            detail: `the ungated control ${CONTROL.path} answered ${controlStatus ?? 'nothing'}`
                + ' — the site is not serving, so nothing below is a verdict about a flag',
        };
    }
    if (controlStatus !== 200) {
        return {
            state: 'BROKEN',
            detail: `the ungated control ${CONTROL.path} answered ${controlStatus}, which is`
                + ' neither reachable nor an outage — the probe cannot interpret the rest',
        };
    }
    const dark = gatedResults.filter((r) => r.status === 404);
    if (dark.length > 0) {
        return {
            state: 'DARK',
            detail: `${dark.length} gated surface(s) answered 404 while the control is fine: `
                + dark.map((d) => d.path).join(', ')
                + ' — a missing FeatureFlag row is OFF by design and looks exactly like this',
        };
    }
    const odd = gatedResults.filter((r) => r.status === null || r.status >= 500);
    if (odd.length > 0) {
        return {
            state: 'BROKEN',
            detail: 'gated surface(s) errored: '
                + odd.map((d) => `${d.path}=${d.status ?? 'no response'}`).join(', '),
        };
    }
    // OK states its own blind spot. `gatedResults` already INCLUDES the derived
    // page when there was one, so the count is honest either way; what this adds
    // is naming the surface that was skipped when it was skipped.
    return {
        state: 'OK',
        detail: `${gatedResults.length} gated surface(s) reachable, control ${controlStatus}`
            + (derived.probed
                ? `, including the farm page ${derived.path}`
                : ` — NOT covering /f/{handle}: ${derived.why}`),
    };
}

async function getSurface(
    base: string,
    path: string,
): Promise<{ status: number | null; text: string | null }> {
    try {
        const res = await fetch(new URL(path, base), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(20_000),
        });
        // Body read only where a caller needs it; a 404 has nothing to parse.
        return { status: res.status, text: res.status === 200 ? await res.text() : null };
    } catch {
        return { status: null, text: null };
    }
}

async function statusOf(base: string, path: string): Promise<number | null> {
    return (await getSurface(base, path)).status;
}

async function main() {
    const base = process.env.PROBE_BASE_URL || 'https://app.agrent.bg';
    const controlStatus = await statusOf(base, CONTROL.path);
    const gatedResults: SurfaceResult[] = [];
    // The directory's BODY is kept, because the farm page's address is in it.
    let directoryBody: string | null = null;
    for (const s of GATED) {
        const r = await getSurface(base, s.path);
        gatedResults.push({ path: s.path, status: r.status });
        if (s.path === DIRECTORY_PATH) directoryBody = r.text;
    }

    // Derive, then probe. A failure to PARSE is not a failure of the site, so
    // it becomes a stated non-coverage rather than a BROKEN verdict — the
    // directory's own status is already in `gatedResults` and speaks for it.
    let derived: DerivedTarget;
    if (directoryBody === null) {
        derived = {
            probed: false,
            why: `${DIRECTORY_PATH} did not answer 200, so no handle could be read from it`,
        };
    } else {
        try {
            derived = deriveFarmPage(JSON.parse(directoryBody));
        } catch (err) {
            derived = { probed: false, why: `${DIRECTORY_PATH} returned unparseable JSON: ${String(err)}` };
        }
    }
    if (derived.probed) {
        // Pushed into the SAME list, so a 404 here is DARK exactly as it is for
        // the other surfaces rather than a separate special case.
        gatedResults.push({ path: derived.path, status: await statusOf(base, derived.path) });
    }

    const { state, detail } = classify(controlStatus, gatedResults, derived);
    // The verdict LINE, not the exit code alone — OK is the only state that
    // means nothing is wrong, and the others need telling apart by a human.
    console.log(`PROBE_RESULT=${state} ${detail}`);
    process.exit(state === 'OK' ? 0 : 1);
}

// Guarded rather than a bare `require.main === module`: the named exports
// above are imported from a test, and `module` is undefined in real ESM.
// Same reasoning as `scripts/lint-ceiling.ts`.
if (typeof module !== 'undefined' && require.main === module) {
    main().catch((err) => {
        console.log(`PROBE_RESULT=BROKEN the probe itself failed: ${String(err)}`);
        process.exit(1);
    });
}
