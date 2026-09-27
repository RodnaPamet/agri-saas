import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getFarmProfile, upsertFarmProfile } from '@/app-layer/usecases/farm-profile';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

// БАБХ farm-record — the one-per-tenant FarmProfile identity block. Most
// fields are optional free text (the paper form tolerates blanks). Gated by
// admin.manage (tenant configuration) — see route-permissions.ts.
//
// `sizeHa` and `grainProduced` are NOT free text, and the difference matters:
// a size that accepts "abc" is bad data on a page whose figures reach a state
// form, and one grain string cannot express a farm that grows three.
const UpdateFarmProfileSchema = z
    .object({
        producerName: z.string().max(300).nullable().optional(),
        egn: z.string().max(20).nullable().optional(),
        eik: z.string().max(20).nullable().optional(),
        // УРН — the HOLDING's registration number, distinct from eik/egn.
        urn: z.string().max(40).nullable().optional(),
        address: z.string().max(500).nullable().optional(),
        municipality: z.string().max(200).nullable().optional(),
        settlement: z.string().max(200).nullable().optional(),
        agricultureDirectorateCity: z.string().max(200).nullable().optional(),
        registrationPlace: z.string().max(200).nullable().optional(),
        registrationEkatte: z.string().max(20).nullable().optional(),
        odbhCity: z.string().max(200).nullable().optional(),
        /**
         * Declared hectares, as a NUMBER. Bounded at a million: the largest
         * Bulgarian holdings are five figures, so anything beyond this is a
         * mis-keyed unit rather than a farm, and a 400 is kinder than storing
         * it. Negative is refused for the same reason.
         */
        sizeHa: z.number().nonnegative().max(1_000_000).nullable().optional(),
        /**
         * Declared grains. Capped at 50 entries and 120 characters each — a
         * bound, not a vocabulary: a farm may grow something the market does
         * not quote, and a picker that refused it would be wrong.
         */
        grainProduced: z.array(z.string().max(120)).max(50).nullable().optional(),
    })
    .strip();

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        return jsonResponse(await getFarmProfile(ctx));
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = UpdateFarmProfileSchema.parse(await req.json());
        return jsonResponse(await upsertFarmProfile(ctx, body));
    }),
);
