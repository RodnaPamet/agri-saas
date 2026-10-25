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
export const GATED = [
    {
        path: '/sitemap.xml',
        why: 'gated by social.public-profile; a missing row makes it notFound() for crawlers',
    },
    {
        path: '/api/public/farms',
        why: 'gated by social.public-profile; the public farms list. 200 with an EMPTY '
            + 'array is still reachable — content is not what this checks',
    },
];

/** Classify a set of results. Pure, so it can be tested without a network. */
export interface SurfaceResult {
    path: string;
    status: number | null;
}

export type ProbeState = 'OK' | 'DARK' | 'OUTAGE' | 'BROKEN';

export function classify(
    controlStatus: number | null,
    gatedResults: SurfaceResult[],
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
    return {
        state: 'OK',
        detail: `${gatedResults.length} gated surface(s) reachable, control ${controlStatus}`,
    };
}

async function statusOf(base: string, path: string): Promise<number | null> {
    try {
        const res = await fetch(new URL(path, base), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(20_000),
        });
        return res.status;
    } catch {
        return null;
    }
}

async function main() {
    const base = process.env.PROBE_BASE_URL || 'https://app.agrent.bg';
    const controlStatus = await statusOf(base, CONTROL.path);
    const gatedResults: SurfaceResult[] = [];
    for (const s of GATED) {
        gatedResults.push({ path: s.path, status: await statusOf(base, s.path) });
    }
    const { state, detail } = classify(controlStatus, gatedResults);
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
