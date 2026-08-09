import { RequestContext } from '../types';
import { MappingRepository } from '../repositories/MappingRepository';
import { assertCanRead } from '../policies/common';
import {
    getSOC2Requirements,
    getNIS2Requirements,
    getFrameworkMappings as getGuidanceMappings,
} from '@/app-layer/libraries';
import { runInTenantContext } from '@/lib/db-context';

export async function getFrameworkMappings(ctx: RequestContext) {
    assertCanRead(ctx);

    // Load framework data from YAML-backed provider (with hardcoded fallback)
    const SOC2_REQS = getSOC2Requirements();
    const NIS2_REQS = getNIS2Requirements();
    const MAPPINGS = getGuidanceMappings();

    return runInTenantContext(ctx, async (db) => {
        const practices = await MappingRepository.getPracticesWithEvidence(db, ctx);

        // Build SOC 2 readiness view
        const soc2Categories = SOC2_REQS.map((req) => {
            const relatedMappings = MAPPINGS.filter((m) => m.soc2Codes.includes(req.code));
            const relatedPractices = practices.filter((c) =>
                relatedMappings.some((m) => m.isoControlId === c.code)
            );
            const implemented = relatedPractices.filter((c) => c.status === 'IMPLEMENTED').length;
            const withEvidence = relatedPractices.filter((c) => c.evidence.some((e) => e.status === 'APPROVED')).length;
            const total = relatedPractices.length;

            return {
                ...req,
                mappings: relatedMappings,
                practiceCount: total,
                implementedCount: implemented,
                evidenceCount: withEvidence,
                coverage: total > 0 ? Math.round((implemented / total) * 100) : 0,
            };
        });

        // Build NIS2 readiness view
        const nis2Areas = NIS2_REQS.map((req) => {
            const relatedMappings = MAPPINGS.filter((m) => m.nis2Codes.includes(req.code));
            const relatedPractices = practices.filter((c) =>
                relatedMappings.some((m) => m.isoControlId === c.code)
            );
            const implemented = relatedPractices.filter((c) => c.status === 'IMPLEMENTED').length;
            const total = relatedPractices.length;

            return {
                ...req,
                mappings: relatedMappings,
                practiceCount: total,
                implementedCount: implemented,
                coverage: total > 0 ? Math.round((implemented / total) * 100) : 0,
            };
        });

        return { soc2: soc2Categories, nis2: nis2Areas, mappings: MAPPINGS };
    });
}
