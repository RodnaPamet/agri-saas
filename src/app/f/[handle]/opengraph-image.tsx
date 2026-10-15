import * as fs from 'node:fs';
import * as path from 'node:path';

import { ImageResponse } from 'next/og';

import { readPublicFarmProfile } from '@/app-layer/usecases/public-farm-profile';
import { notFound } from 'next/navigation';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { getAppBaseUrl } from '@/lib/auth/app-base-url';

/**
 * The Open Graph card for `/f/[handle]` (P6.5, #1814).
 *
 * ## No new dependency, and no woff2
 *
 * The phase warns that satori rejects woff2. It does — and `next/og` bundles
 * satori already (`next/dist/compiled/@vercel/og`, Next 16.3.8), so this needs
 * no package added. That mattered rather than being convenient: the default
 * branch currently reports 20 Dependabot advisories, and a new transitive tree
 * for one image would have been the wrong trade.
 *
 * The font is `DejaVuSans.ttf`, already in this repo at `src/lib/pdf/fonts/`
 * because the ДНЕВНИК PDF needs full Cyrillic coverage. Reusing it is not
 * thrift: a farm named «Стопанство Победа» renders as tofu boxes in any font
 * without Cyrillic glyphs, and the fonts Next ships with (`Geist`) do not have
 * them. The PDF path already proved this one does.
 *
 * ## The same absence as the page
 *
 * A withdrawn or missing profile gets the SAME answer, for the same
 * anti-enumeration reason as the 404 — an OG card that rendered a distinctive
 * "not found" image would answer the question the status code refuses to. Next
 * renders nothing for a route that throws, so returning the fallback card
 * keeps both cases identical.
 *
 * ## It renders projection fields only
 *
 * `displayName` and `oblast`, both already allowlisted as public. P6.10 asks
 * for zero hits of ЕГН, ЕИК, УРН and the address in the OG image — satisfied
 * structurally, because those columns do not exist on the projection and the
 * values never reach this process.
 *
 * That also answers how "0 hits in the OG image" is checkable at all: it is
 * not a substring search over rendered pixels, it is the observation that the
 * INPUT cannot contain them.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Read once per process, not per request — the file is ~740 KB. */
let cachedFont: Buffer | null = null;
function cyrillicFont(): Buffer {
    cachedFont ??= fs.readFileSync(
        path.join(process.cwd(), 'src/lib/pdf/fonts/DejaVuSans.ttf'),
    );
    return cachedFont;
}

interface Props {
    readonly params: Promise<{ handle: string }>;
}

export default async function Image({ params }: Props) {
    const { handle } = await params;
    // The third entry point on this route, gated like the other two. An
    // ungated card would render a farm's name and oblast for a page the
    // flag has switched off — and a social preview is the one surface that
    // gets scraped and cached elsewhere.
    if (!(await isFeatureEnabled('social.public-profile', null))) notFound();
    const profile = await readPublicFarmProfile(handle);

    // One card shape for both the found and absent cases: the absent one shows
    // the host and nothing about whether a handle exists.
    //
    // The host is DERIVED, not written. A literal `agrent.bg` here would be a
    // second source of truth for the deployment's own domain — wrong the day
    // it changes, and in an image nobody re-reads. It is also why
    // `no-hardcoded-ui-strings` flagged it: not because a domain needs
    // translating, but because a literal in JSX is how copy and configuration
    // both end up pinned in a component. Deriving it answers the guard and the
    // underlying problem at once.
    const host = getAppBaseUrl().replace(/^https?:\/\//, '') || 'agrent.bg';
    const title = profile?.displayName ?? host;
    const subtitle = profile?.oblast ?? null;

    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    padding: '80px',
                    background: '#0f1b14',
                    color: '#f5f7f5',
                    fontFamily: 'DejaVu',
                }}
            >
                <div style={{ fontSize: 68, lineHeight: 1.1, display: 'flex' }}>{title}</div>
                {subtitle ? (
                    <div style={{ fontSize: 36, marginTop: 24, color: '#9db3a4', display: 'flex' }}>
                        {subtitle}
                    </div>
                ) : null}
                <div style={{ fontSize: 28, marginTop: 'auto', color: '#7f9687', display: 'flex' }}>
                    {host}
                </div>
            </div>
        ),
        {
            ...size,
            fonts: [
                {
                    name: 'DejaVu',
                    data: cyrillicFont() as unknown as ArrayBuffer,
                    style: 'normal',
                    weight: 400,
                },
            ],
        },
    );
}
