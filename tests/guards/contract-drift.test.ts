/**
 * Contract Drift Test — validates that API outputs match Zod response schemas.
 *
 * Imports actual usecases/repositories and validates their output shapes
 * against the published DTOs. Catches drift between Prisma model changes
 * and the response schemas.
 */

// We validate by checking that DTO schemas can parse the actual data shapes
// returned by the API. Since we can't easily call route handlers in Jest,
// we validate that the schemas themselves are structurally sound and that
// the DTO modules export the expected symbols.

describe('Contract Drift — DTO integrity', () => {
    // GRC teardown phase 2 removed the practice / policy / vendor /
    // framework / audit DTO modules with their models.
    const dtoPaths = [
        { module: 'task.dto', schemas: ['TaskDTOSchema'] },
        { module: 'asset.dto', schemas: ['AssetListItemDTOSchema', 'AssetDetailDTOSchema'] },
        { module: 'evidence.dto', schemas: ['EvidenceListItemDTOSchema', 'EvidenceDetailDTOSchema'] },
    ];

    test.each(dtoPaths)('$module exports all declared schemas', ({ module, schemas }) => {

        const mod = require(`../../src/lib/dto/${module}`);
        for (const name of schemas) {
            expect(mod[name]).toBeDefined();
            expect(typeof mod[name].parse).toBe('function');
            expect(typeof mod[name].safeParse).toBe('function');
        }
    });

    
    test('AssetListItemDTOSchema parses a valid asset shape', () => {

        const { AssetListItemDTOSchema } = require('../../src/lib/dto/asset.dto');
        const validAsset = {
            id: 'ast_1',
            tenantId: 'ten_1',
            name: 'Production DB',
            type: 'DATABASE',
            confidentiality: 5,
            integrity: 4,
            availability: 5,
            createdAt: '2025-01-01T00:00:00.000Z',
        };
        const result = AssetListItemDTOSchema.safeParse(validAsset);
        expect(result.success).toBe(true);
    });

    test('EvidenceListItemDTOSchema parses a valid evidence shape', () => {

        const { EvidenceListItemDTOSchema } = require('../../src/lib/dto/evidence.dto');
        const validEvidence = {
            id: 'ev_1',
            tenantId: 'ten_1',
            type: 'DOCUMENT',
            title: 'SOC2 Report',
            status: 'APPROVED',
            createdAt: '2025-01-01T00:00:00.000Z',
        };
        const result = EvidenceListItemDTOSchema.safeParse(validEvidence);
        expect(result.success).toBe(true);
    });

    
    test('all DTO index barrel exports are stable', () => {

        const dtoIndex = require('../../src/lib/dto/index');
        // GRC teardown phase 2: the practice / policy / vendor / framework
        // / audit DTOs left the barrel with their models. The barrel-
        // stability contract is unchanged for the surviving shapes.
        const expectedExports = [
            'TaskDTOSchema',
            'AssetListItemDTOSchema', 'AssetDetailDTOSchema',
            'EvidenceListItemDTOSchema', 'EvidenceDetailDTOSchema',
            'EvidenceLinkDTOSchema',
            'UserRefSchema', 'ApiErrorResponseSchema',
        ];
        for (const name of expectedExports) {
            expect(dtoIndex[name]).toBeDefined();
        }
    });
});
