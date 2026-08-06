/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/certification-scheme.ts`.
 *
 * A certification scheme is a GLOBAL `Framework` (kind = 'AG_SCHEME')
 * with `FrameworkRequirement` rows; this usecase is a thin, kind-filtered
 * facade over the framework catalog. Mocks the global prisma client, the
 * reused catalog / coverage usecases, the audit emitter, and the
 * sanitiser.
 *
 * Covers:
 *   - listSchemes — AG_SCHEME `where` filter + count include + read gate.
 *   - getScheme — AG_SCHEME kind validation (notFound when the resolved
 *     framework is a non-scheme), happy path returns framework + reqs.
 *   - createScheme — admin gate, sanitisation of name + requirement
 *     titles, duplicate-code + missing-requirement + duplicate-key
 *     rejections, framework + requirement (createMany) writes, audit
 *     shape.
 */

const mockPrisma = {
    framework: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
    },
    frameworkRequirement: {
        createMany: jest.fn(),
    },
} as any;

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: mockPrisma,
    prisma: mockPrisma,
}));

// Reused catalog / coverage usecases — mocked so getScheme / readiness
// delegation is observable without a DB.
jest.mock('@/app-layer/usecases/framework/catalog', () => ({
    getFramework: jest.fn(),
    getFrameworkRequirements: jest.fn(),
}));
jest.mock('@/app-layer/usecases/framework/coverage', () => ({
    generateReadinessReport: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import { getFramework, getFrameworkRequirements } from '@/app-layer/usecases/framework/catalog';
import { generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    listSchemes,
    getScheme,
    createScheme,
} from '@/app-layer/usecases/certification-scheme';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    (sanitizePlainText as jest.Mock).mockImplementation((s: string) => `SAN::${s}`);
});

/**
 * Scheme AUTHORING is now a PLATFORM operation, not a tenant one: it writes a
 * row into the global Framework table that every tenant reads, and burns a
 * globally-unique key with no delete path. The admin context therefore has to
 * be an admin OF THE PLATFORM TENANT — a farm admin is refused, which is the
 * whole point of the change and is covered in
 * tests/unit/security/catalogue-write-isolation.test.ts.
 */
const PLATFORM_SLUG = 'platform-support';
process.env.PLATFORM_TENANT_SLUG = PLATFORM_SLUG;

const adminCtx = makeRequestContext('ADMIN', {
    userId: 'user-admin',
    tenantSlug: PLATFORM_SLUG,
});
const editorCtx = makeRequestContext('EDITOR', { userId: 'user-editor' });
const readerCtx = makeRequestContext('READER');

// ─── listSchemes ───────────────────────────────────────────────────

describe('listSchemes', () => {
    it('selects the demo-disclosure fields, AG_SCHEME only, key-asc', async () => {
        // `include` became `select` so `isDemo` and `coverageNote` reach the
        // list. Without them it can only show a name — and a name is exactly
        // what makes a 7-control-point demo look like GlobalG.A.P.
        mockPrisma.framework.findMany.mockResolvedValue([{ id: 'fw-1', key: 'ORG', kind: 'AG_SCHEME' }]);
        const rows = await listSchemes(readerCtx);
        expect(rows).toEqual([{ id: 'fw-1', key: 'ORG', kind: 'AG_SCHEME' }]);

        const args = mockPrisma.framework.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ kind: 'AG_SCHEME' });
        expect(args.orderBy).toEqual({ key: 'asc' });
        expect(args.select.isDemo).toBe(true);
        expect(args.select.coverageNote).toBe(true);
        expect(args.select._count).toEqual({ select: { requirements: true, packs: true } });
    });
});

// ─── getScheme ─────────────────────────────────────────────────────

describe('getScheme', () => {
    it('returns the framework + requirements when the kind is AG_SCHEME', async () => {
        (getFramework as jest.Mock).mockResolvedValue({ id: 'fw-1', key: 'ORG', kind: 'AG_SCHEME', name: 'Organic' });
        (getFrameworkRequirements as jest.Mock).mockResolvedValue([{ id: 'r-1', code: 'OC-1' }]);
        const result = await getScheme(readerCtx, 'ORG');
        expect(result.framework.key).toBe('ORG');
        expect(result.requirements).toEqual([{ id: 'r-1', code: 'OC-1' }]);
        expect(getFramework).toHaveBeenCalledWith(readerCtx, 'ORG');
        expect(getFrameworkRequirements).toHaveBeenCalledWith(readerCtx, 'ORG');
    });

    it('throws notFound when the resolved framework is NOT an AG_SCHEME', async () => {
        (getFramework as jest.Mock).mockResolvedValue({ id: 'fw-2', key: 'ISO27001', kind: 'ISO_STANDARD' });
        await expect(getScheme(readerCtx, 'ISO27001')).rejects.toThrow(/Scheme not found/);
        // Must not leak requirements of a non-scheme framework.
        expect(getFrameworkRequirements).not.toHaveBeenCalled();
    });
});

// ─── createScheme ──────────────────────────────────────────────────

describe('createScheme', () => {
    const validInput = {
        key: 'ORGANIC-DEMO',
        name: 'Organic',
        description: 'desc',
        requirements: [
            { code: 'OC-1', title: 'Req one', description: 'd1' },
            { code: 'OC-2', title: 'Req two' },
        ],
    };

    function wireHappyPath() {
        mockPrisma.framework.findFirst.mockResolvedValue(null); // key free
        mockPrisma.framework.create.mockResolvedValue({ id: 'fw-new', key: 'ORGANIC-DEMO' });
        mockPrisma.frameworkRequirement.createMany.mockResolvedValue({ count: 2 });
        // getScheme re-fetch at the end of createScheme.
        (getFramework as jest.Mock).mockResolvedValue({ id: 'fw-new', key: 'ORGANIC-DEMO', kind: 'AG_SCHEME', name: 'Organic' });
        (getFrameworkRequirements as jest.Mock).mockResolvedValue([{ id: 'r-1' }, { id: 'r-2' }]);
    }

    it('rejects a non-admin caller before any write', async () => {
        await expect(createScheme(editorCtx, validInput)).rejects.toThrow();
        await expect(createScheme(readerCtx, validInput)).rejects.toThrow();
        expect(mockPrisma.framework.create).not.toHaveBeenCalled();
    });

    it('rejects when no requirements are supplied', async () => {
        await expect(
            createScheme(adminCtx, { ...validInput, requirements: [] }),
        ).rejects.toThrow(/At least one requirement/);
        expect(mockPrisma.framework.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate requirement codes', async () => {
        await expect(
            createScheme(adminCtx, {
                ...validInput,
                requirements: [
                    { code: 'DUP', title: 'a' },
                    { code: 'DUP', title: 'b' },
                ],
            }),
        ).rejects.toThrow(/Duplicate requirement codes/);
        expect(mockPrisma.framework.create).not.toHaveBeenCalled();
    });

    it('rejects a key that already names a framework', async () => {
        mockPrisma.framework.findFirst.mockResolvedValue({ id: 'fw-existing' });
        await expect(createScheme(adminCtx, validInput)).rejects.toThrow(/already exists/);
        expect(mockPrisma.framework.create).not.toHaveBeenCalled();
    });

    it('creates the AG_SCHEME framework + requirements with sanitised free text', async () => {
        wireHappyPath();
        await createScheme(adminCtx, validInput);

        // Framework write — kind pinned to AG_SCHEME, name sanitised.
        expect(mockPrisma.framework.create).toHaveBeenCalledWith({
            data: {
                key: 'ORGANIC-DEMO',
                name: 'SAN::Organic',
                description: 'SAN::desc',
                kind: 'AG_SCHEME',
            },
        });

        // Requirement batch — titles sanitised, sortOrder by index,
        // optional description three-stated (string sanitised, absent → undefined).
        expect(mockPrisma.frameworkRequirement.createMany).toHaveBeenCalledWith({
            data: [
                { frameworkId: 'fw-new', code: 'OC-1', title: 'SAN::Req one', description: 'SAN::d1', sortOrder: 0 },
                { frameworkId: 'fw-new', code: 'OC-2', title: 'SAN::Req two', description: undefined, sortOrder: 1 },
            ],
        });

        // Sanitiser hit name + both titles + the present description.
        expect(sanitizePlainText).toHaveBeenCalledWith('Organic');
        expect(sanitizePlainText).toHaveBeenCalledWith('Req one');
        expect(sanitizePlainText).toHaveBeenCalledWith('Req two');
    });

    it('emits a CERTIFICATION_SCHEME_CREATED audit event with the entity-lifecycle shape', async () => {
        wireHappyPath();
        await createScheme(adminCtx, validInput);

        expect(logEvent).toHaveBeenCalledTimes(1);
        const [, ctxArg, payload] = (logEvent as jest.Mock).mock.calls[0];
        expect(ctxArg).toBe(adminCtx);
        expect(payload.action).toBe('CERTIFICATION_SCHEME_CREATED');
        expect(payload.entityType).toBe('Framework');
        expect(payload.entityId).toBe('fw-new');
        expect(payload.detailsJson).toMatchObject({
            category: 'entity_lifecycle',
            entityName: 'Framework',
            operation: 'created',
            after: { key: 'ORGANIC-DEMO', name: 'SAN::Organic', kind: 'AG_SCHEME' },
        });
    });

    it('returns the freshly-read scheme', async () => {
        wireHappyPath();
        const result = await createScheme(adminCtx, validInput);
        expect(result.framework.key).toBe('ORGANIC-DEMO');
        expect(result.requirements).toHaveLength(2);
    });
});

