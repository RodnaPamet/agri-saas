import { PrismaTx } from '@/lib/db-context';

export class FrameworkRepository {
    static async listFrameworks(db: PrismaTx) {
        return db.framework.findMany({
            orderBy: { key: 'asc' },
            include: {
                _count: { select: { requirements: true } },
                packs: { select: { id: true, key: true, name: true, version: true } },
            },
        });
    }

    static async getFrameworkByKey(db: PrismaTx, key: string) {
        // `findFirst`: Framework.key lost its single-column unique so two
        // revisions of a standard can coexist. Newest version first — a caller
        // that names no version means "the current one".
        return db.framework.findFirst({
            where: { key },
            orderBy: { version: 'desc' },
            include: {
                requirements: { orderBy: { sortOrder: 'asc' } },
                packs: {
                    include: {
                    },
                },
            },
        });
    }

    static async listRequirements(db: PrismaTx, frameworkKey: string) {
        const framework = await db.framework.findFirst({
            // `findFirst`, not `findUnique`: the single-column unique on `key`
            // was dropped so two versions of a standard can coexist (see the
            // versioning migration). Without a version this asks for "a
            // framework with this key" — which is what the caller means, and
            // is now genuinely a first-of rather than a the-one.
            where: { key: frameworkKey },
            orderBy: { version: 'desc' },
        });
        if (!framework) return null;
        return db.frameworkRequirement.findMany({
            where: { frameworkId: framework.id },
            orderBy: { sortOrder: 'asc' },
            include: { framework: { select: { key: true, name: true } } },
        });
    }

    static async getPackByKey(db: PrismaTx, packKey: string) {
        // `findUnique` is correct here: only FRAMEWORK.key lost its
        // single-column unique (so a standard can carry two revisions).
        // `FrameworkPack.key` is still `@unique`.
        return db.frameworkPack.findUnique({
            where: { key: packKey },
            include: {
                framework: true,
            },
        });
    }

    static async getCoverage(db: PrismaTx, frameworkKey: string, tenantId: string) {
        const framework = await db.framework.findFirst({
            // `findFirst`, not `findUnique`: the single-column unique on `key`
            // was dropped so two versions of a standard can coexist (see the
            // versioning migration). Without a version this asks for "a
            // framework with this key" — which is what the caller means, and
            // is now genuinely a first-of rather than a the-one.
            where: { key: frameworkKey },
            orderBy: { version: 'desc' },
        });
        if (!framework) return null;

        const requirements = await db.frameworkRequirement.findMany({
            where: { frameworkId: framework.id },
            orderBy: { sortOrder: 'asc' },
            select: { id: true, code: true, title: true, theme: true, themeNumber: true },
        });

        // Find which requirements have mapped controls for this tenant
        const mappings = await db.frameworkMapping.findMany({
            where: {
                fromRequirement: { frameworkId: framework.id },
                toControl: { tenantId },
            },
            select: { fromRequirementId: true, toControlId: true },
        });

        const mappedReqIds = new Set(mappings.map(m => m.fromRequirementId));

        const mapped = requirements.filter(r => mappedReqIds.has(r.id));
        const unmapped = requirements.filter(r => !mappedReqIds.has(r.id));

        return {
            total: requirements.length,
            mappedCount: mapped.length,
            unmappedCount: unmapped.length,
            coveragePercent: requirements.length > 0 ? Math.round((mapped.length / requirements.length) * 100) : 0,
            mapped,
            unmapped,
        };
    }

    /**
     * Is this pack installed for the tenant?
     *
     * This used to answer "does the tenant hold controls whose codes match
     * the pack's control templates". The compliance uproot removed the
     * template library, so the pack no longer carries a code list to match
     * against — installation is now judged by whether the tenant has mapped
     * any control to a requirement of the pack's framework.
     */
    static async isPackInstalled(db: PrismaTx, packKey: string, tenantId: string) {
        // `findUnique`: only Framework.key lost its single-column unique.
        const pack = await db.frameworkPack.findUnique({
            where: { key: packKey },
            select: { frameworkId: true },
        });
        if (!pack) return false;

        const linkCount = await db.controlRequirementLink.count({
            where: { tenantId, requirement: { frameworkId: pack.frameworkId } },
        });

        return linkCount > 0;
    }
}
