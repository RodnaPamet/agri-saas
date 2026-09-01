'use client';

/**
 * DownloadBasemapButton — "Download offline map" affordance (Roadmap-6 P1b).
 *
 * A deliberate, USER-INITIATED, bounded download of ONE location's basemap
 * backdrop. On tap it computes the small set of tiles covering the location's
 * bbox (over the demotiles native zoom range) and fetches each SAME-ORIGIN
 * basemap tile URL, which the service worker stores in its dedicated basemap
 * cache. Offline, MapCanvas then renders that cached backdrop instead of the
 * cross-origin MapTiler/demotiles style (which blanks with no signal).
 *
 * Renders nothing when the location has no bbox (no fields yet → nothing to
 * frame) or when the browser has no service worker (no cache to fill).
 *
 * Licensing + source rationale live in `src/lib/offline/basemap-pack.ts`.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Cloud, Download } from '@/components/ui/icons/nucleo';
import { useToast } from '@/components/ui/hooks';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { tilesForBbox } from '@/lib/offline/basemap-pack';

interface DownloadBasemapButtonProps {
    locationId: string;
    /** [west, south, east, north] — the location's bbox, or null. */
    bounds: [number, number, number, number] | null;
    className?: string;
    /**
     * Render just the download icon (no text label). The label still names
     * the practice via `aria-label`, so screen readers + the button-name a11y
     * rule are satisfied. Used where the button sits in a compact action row
     * (e.g. the location-detail header).
     */
    iconOnly?: boolean;
}

type Status = 'idle' | 'downloading' | 'done';

export function DownloadBasemapButton({ locationId, bounds, className, iconOnly = false }: DownloadBasemapButtonProps) {
    const t = useTranslations('locations.detail');
    const buildUrl = useTenantApiUrl();
    const toast = useToast();
    const [status, setStatus] = useState<Status>('idle');
    const [done, setDone] = useState(0);
    const [total, setTotal] = useState(0);

    const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

    const download = useCallback(async () => {
        if (!bounds) return;
        const tiles = tilesForBbox(bounds);
        setStatus('downloading');
        setDone(0);
        setTotal(tiles.length);
        // `stored` counts tiles that are actually IN the cache. `absent` is
        // the honest zero — ocean or out-of-coverage, where a complete pack
        // legitimately holds nothing. `lost` is a tile we wanted and did not
        // get.
        //
        // The old code was `if (res.ok || res.status === 204) ok += 1`, and
        // its comment said "204 = ocean/no-coverage (fine)". That was true
        // when the route only 204'd for out-of-coverage. It also soft-fails to
        // 204 when the upstream is UNREACHABLE — so an outage produced a full
        // sweep of 204s, `ok === tiles.length`, and a confident "Offline map
        // ready" over a pack with nothing in it (#780). An operator who then
        // drove out of signal found an empty map.
        //
        // The two 204s are told apart by `X-Basemap-Source`, not guessed at.
        let stored = 0;
        let absent = 0;
        let lost = 0;
        // Sequential, bounded — a location pack is a handful of tiles, and a
        // serial fetch keeps well under the tenant read-rate limit while the
        // service worker caches each response.
        for (const tile of tiles) {
            try {
                const res = await fetch(
                    buildUrl(`/locations/${locationId}/basemap/${tile.z}/${tile.x}/${tile.y}`),
                    { credentials: 'same-origin' },
                );
                if (res.status === 200) {
                    // Read the LENGTH, never the body: the service worker
                    // caches `res.clone()` on the way past, and consuming the
                    // body here would race that. `tileResponse` sets
                    // Content-Length on every 200, so the bytes are knowable
                    // without touching the stream. A 200 with no bytes is not
                    // a tile.
                    const len = Number(res.headers.get('Content-Length') ?? '0');
                    if (len > 0) stored += 1;
                    else lost += 1;
                } else if (res.status === 204) {
                    if (res.headers.get('X-Basemap-Source') === 'upstream-empty') absent += 1;
                    else lost += 1;
                } else {
                    lost += 1;
                }
            } catch {
                /* a single failed tile shouldn't abort the pack */
                lost += 1;
            }
            setDone((d) => d + 1);
        }

        if (lost === 0) {
            // Everything we asked for either landed or legitimately does not
            // exist. That, and only that, is a finished pack.
            setStatus('done');
            toast.success(t('offlineMapReady'));
        } else if (stored > 0) {
            // Deliberately NOT `status: 'done'`. Labelling the button
            // "Offline map ready" over an admittedly incomplete pack is a
            // milder version of the very over-claim this fixes — and leaving
            // it on the download affordance is what lets the operator retry.
            setStatus('idle');
            toast.warning(t('offlineMapPartial', { stored, missing: lost }));
        } else {
            setStatus('idle');
            toast.error(t('offlineMapFailed'));
        }
        // `absent` is deliberately not surfaced: a tile that legitimately does
        // not exist is not something an operator can act on.
    }, [bounds, buildUrl, locationId, t, toast]);

    if (!bounds || !swSupported) return null;

    const label =
        status === 'downloading'
            ? t('offlineMapDownloading', { done, total })
            : status === 'done'
              ? t('offlineMapDownloaded')
              : t('offlineMapDownload');

    return (
        <Button
            variant="secondary"
            size="sm"
            className={className}
            icon={status === 'done' ? <Cloud className="size-4" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
            loading={status === 'downloading'}
            disabled={status === 'downloading'}
            onClick={() => void download()}
            id="download-offline-map-btn"
            aria-label={iconOnly ? label : undefined}
        >
            {iconOnly ? null : label}
        </Button>
    );
}

export default DownloadBasemapButton;
