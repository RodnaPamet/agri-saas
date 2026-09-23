import { NextRequest } from 'next/server';
import { getNdmiTileUrl } from '@/lib/agro/earth-engine';
import { handleIndexTiles } from '@/lib/agro/index-tiles-handler';
import { withApiErrorHandling } from '@/lib/errors/api';

/**
 * NDMI tile source (Agro-intel) — tenant + location scoped, authenticated.
 *
 * Recent cloud-masked Sentinel-2 NDMI (Gao canopy/soil moisture) composite
 * for the location's field via Google Earth Engine; the shared
 * `handleIndexTiles` runs the fetch + Redis cache. See
 * `@/lib/agro/index-tiles-handler` for the response contract.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ tenantSlug: string; locationId: string }> }) =>
        handleIndexTiles('ndmi', getNdmiTileUrl, req, params),
);
