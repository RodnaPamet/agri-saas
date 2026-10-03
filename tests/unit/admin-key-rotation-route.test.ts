/**
 * The platform master-KEK rotation route: gated, reachable, and honest about
 * whether a sweep could have done anything.
 *
 * Why the reachability half is here and not left to a guard: every assertion
 * that drives a handler directly would still pass on a route the Edge 401s
 * before the handler runs — the SCIM / `iflk_` / signed-webhook shape, now
 * seven prior instances in this repo. `isPublicPath` is the real function.
 */
import type { NextRequest } from 'next/server';
import { isPublicPath } from '@/lib/auth/guard';

export {};

const HEADER = 'x-platform-admin-key';
const REAL_KEY = 'r'.repeat(48); // pragma: allowlist secret -- test fixture

const sweepMock = jest.fn();
const countMock = jest.fn();
const dekCountMock = jest.fn();
const misplacedMock = jest.fn();
const auditMock = jest.fn();
const repairMock = jest.fn();
const inFlightMock = jest.fn();

function makeReq(opts: { method?: string; key?: string; body?: string } = {}): NextRequest {
    const headers = new Headers();
    if (opts.key !== undefined) headers.set(HEADER, opts.key);
    const url = new URL('http://localhost:3000/api/admin/key-rotation');
    return {
        method: opts.method ?? 'GET',
        headers,
        nextUrl: url,
        url: url.toString(),
        text: async () => opts.body ?? '',
    } as unknown as NextRequest;
}

type Handler = (req: NextRequest) => Promise<Response>;

/** A request aimed at the CHILD path, so the gate and the URL agree. */
function makeRepairReq(opts: { method?: string; key?: string } = {}): NextRequest {
    const headers = new Headers();
    if (opts.key !== undefined) headers.set(HEADER, opts.key);
    const url = new URL('http://localhost:3000/api/admin/key-rotation/repair-v2');
    return {
        method: opts.method ?? 'GET',
        headers,
        nextUrl: url,
        url: url.toString(),
        text: async () => '',
    } as unknown as NextRequest;
}

function loadRepairRoute(key: string | undefined): { GET: Handler; POST: Handler } {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { PLATFORM_ADMIN_API_KEY: key, PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined },
    }));
    // P1.9 — the repair route appends to the platform audit chain (it rewrites
    // ciphertext nobody else can read, so WHEN it ran and over how many rows
    // belongs in a durable record). Doubled so the route stays the subject.
    jest.doMock('@/lib/audit/platform-audit-writer', () => ({
        appendPlatformAuditEntry: (...a: unknown[]) => auditMock(...a),
    }));
    jest.doMock('@/app-layer/usecases/global-key-rotation', () => ({
        repairMisplacedV2: repairMock,
        countMisplacedV2: misplacedMock,
    }));
    return require('@/app/api/admin/key-rotation/repair-v2/route');
}

function loadRoute(key: string | undefined): { GET: Handler; POST: Handler } {
    jest.resetModules();
    jest.doMock('@/env', () => ({
        env: { PLATFORM_ADMIN_API_KEY: key, PLATFORM_ADMIN_API_KEY_PREVIOUS: undefined },
    }));
    jest.doMock('@/app-layer/usecases/global-key-rotation', () => ({
        sweepGlobalKeyRotation: sweepMock,
        countUnmigrated: countMock,
        countUnwrappedDeks: dekCountMock,
        countMisplacedV2: misplacedMock,
        sweepableColumns: () => [
            { model: 'User', table: 'User', manifestName: 'emailEncrypted', column: 'emailEncrypted', manifest: 'pii' },
            { model: 'Task', table: 'Task', manifestName: 'description', column: 'description', manifest: 'encrypted-fields' },
        ],
    }));
    // P1.9 — this route appends to the platform audit chain, which opens a
    // prisma transaction. Doubled so the route stays the subject.
    jest.doMock('@/lib/audit/platform-audit-writer', () => ({
        appendPlatformAuditEntry: jest.fn(async () => ({
            id: 'audit-1', entryHash: 'h', previousHash: null, occurredAt: 'now',
        })),
    }));
    jest.doMock('@/lib/security/encryption', () => ({
        ...jest.requireActual('@/lib/security/encryption'),
        kekRotationInFlight: inFlightMock,
    }));
    return require('@/app/api/admin/key-rotation/route');
}

beforeEach(() => {
    jest.clearAllMocks();
    countMock.mockResolvedValue({ total: 0, perColumn: [] });
    dekCountMock.mockResolvedValue(0);
    misplacedMock.mockResolvedValue(0);
    auditMock.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null, occurredAt: 'now' });
    repairMock.mockResolvedValue([]);
    inFlightMock.mockReturnValue(true);
    sweepMock.mockResolvedValue({
        rotationInFlight: true,
        columns: 2,
        perColumn: [],
        totalScanned: 4,
        totalRewritten: 4,
        totalAlreadyPrimary: 0,
        totalErrors: 0,
        remaining: 0,
        deks: { scanned: 3, rewrapped: 3, alreadyPrimary: 0, errors: 0 },
        durationMs: 12,
    });
});

describe('the route is REACHABLE, which the gate below cannot tell you', () => {
    it('bypasses the Edge session gate', () => {
        expect(isPublicPath('/api/admin/key-rotation')).toBe(true);
    });

    it('and the opening does not widen to a neighbour', () => {
        // Exact entry + children prefix, so a future sibling needs its own.
        expect(isPublicPath('/api/admin/key-rotation-report')).toBe(false);
        expect(isPublicPath('/api/admin/key-rotationX')).toBe(false);
        // Control: the predicate discriminates.
        expect(isPublicPath('/api/admin/diagnostics')).toBe(false);
        expect(isPublicPath('/api/readyz')).toBe(true);
    });

    it('the TENANT-scoped sibling stays behind the session gate', () => {
        // Unrelated route, different auth model (requirePermission). Opening it
        // would strip a real permission check.
        expect(isPublicPath('/api/t/acme/admin/key-rotation')).toBe(false);
    });
});

describe('the repair is REACHABLE — it shipped once with no caller', () => {
    /**
     * `repairMisplacedV2` landed in #1248 defined, tested and callable from
     * nothing: no route, no job. The tests proved it worked and production
     * could not run it — on two live rows it was written for. This is the
     * assertion that the migration has a door.
     */
    it('the repair path bypasses the Edge session gate', () => {
        expect(isPublicPath('/api/admin/key-rotation/repair-v2')).toBe(true);
    });

    it('it rides the parent\'s CHILDREN prefix — no new Edge opening was needed', () => {
        // `'/api/admin/key-rotation/'` was already in PUBLIC_PATH_PREFIXES as
        // the children prefix of the parent's exact entry, so adding this route
        // required no change to guard.ts. Pinned because the tempting
        // alternative — a second bare prefix — would also have opened
        // `/api/admin/key-rotation-anything`.
        expect(isPublicPath('/api/admin/key-rotation/anything-else')).toBe(true);
        expect(isPublicPath('/api/admin/key-rotation-report')).toBe(false);
    });

    /**
     * These go through the HANDLER with the usecase doubled, which is the only
     * shape that can actually fail. The tempting version — `require` the
     * usecase and assert `typeof repairMisplacedV2 === 'function'` — is VACUOUS
     * here: this suite `doMock`s that module, so the require returns the double
     * and the assertion proves the double has the key I just typed into it.
     * Calling the route and watching the mock get hit proves the ROUTE reaches
     * it; `tests/integration/exchange-message-v2-repair.test.ts` proves the
     * implementation preserves the plaintext. Those are the two halves.
     */
    it('GET reports the outstanding count — the operator can SEE the work', async () => {
        misplacedMock.mockResolvedValue(2); // production's two rows
        const res = await loadRepairRoute(REAL_KEY).GET(makeRepairReq({ key: REAL_KEY }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { misplacedV2: number; repairComplete: boolean };
        expect(misplacedMock).toHaveBeenCalled();
        expect(body.misplacedV2).toBe(2);
        expect(body.repairComplete).toBe(false);
    });

    it('POST actually invokes the repair', async () => {
        repairMock.mockResolvedValue([
            { model: 'ExchangeMessage', column: 'body', found: 2, repaired: 2, errors: 0 },
        ]);
        misplacedMock.mockResolvedValue(0); // re-counted AFTER the repair
        const res = await loadRepairRoute(REAL_KEY).POST(
            makeRepairReq({ key: REAL_KEY, method: 'POST' }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            totalFound: number;
            totalRepaired: number;
            totalErrors: number;
            misplacedV2: number;
            repairComplete: boolean;
        };
        expect(repairMock).toHaveBeenCalledTimes(1);
        expect(body.totalFound).toBe(2);
        expect(body.totalRepaired).toBe(2);
        expect(body.totalErrors).toBe(0);
        // The verdict is a FRESH count, not `found - repaired`. A row that threw
        // is still misplaced, and arithmetic on the result would report success
        // for it; re-reading the table cannot.
        expect(body.misplacedV2).toBe(0);
        expect(body.repairComplete).toBe(true);
    });

    it('a row that ERRORED leaves repairComplete false', async () => {
        repairMock.mockResolvedValue([
            { model: 'ExchangeMessage', column: 'body', found: 2, repaired: 1, errors: 1 },
        ]);
        misplacedMock.mockResolvedValue(1); // the failed row is still there
        const res = await loadRepairRoute(REAL_KEY).POST(
            makeRepairReq({ key: REAL_KEY, method: 'POST' }),
        );
        const body = (await res.json()) as { totalErrors: number; repairComplete: boolean };
        expect(body.totalErrors).toBe(1);
        expect(body.repairComplete).toBe(false);
    });

    it('both methods are gated, and the repair does NOT run for an unauthenticated caller', async () => {
        const route = loadRepairRoute(REAL_KEY);
        for (const method of ['GET', 'POST'] as const) {
            const res = await route[method](makeRepairReq({ method }));
            expect(res.status).toBe(401);
        }
        // The point of this assertion: a gate that refuses AFTER doing the work
        // returns 401 and still rewrites the table.
        expect(repairMock).not.toHaveBeenCalled();
        expect(misplacedMock).not.toHaveBeenCalled();
    });
});

describe('the gate covers both methods', () => {
    it('503s with no platform key configured, touching nothing', async () => {
        const { GET, POST } = loadRoute(undefined);
        expect((await GET(makeReq({ key: REAL_KEY }))).status).toBe(503);
        expect((await POST(makeReq({ method: 'POST', key: REAL_KEY }))).status).toBe(503);
        expect(countMock).not.toHaveBeenCalled();
        expect(sweepMock).not.toHaveBeenCalled();
    });

    it.each([
        ['missing header', undefined],
        ['wrong key', 'q'.repeat(48)],
        ['empty key', ''],
    ])('401s on %s — and does NOT run a sweep', async (_l, key) => {
        const { GET, POST } = loadRoute(REAL_KEY);
        expect((await GET(makeReq({ key }))).status).toBe(401);
        expect((await POST(makeReq({ method: 'POST', key }))).status).toBe(401);
        expect(sweepMock).not.toHaveBeenCalled();
    });
});

describe('GET answers "may I remove DATA_ENCRYPTION_KEY_PREVIOUS yet?"', () => {
    it('remaining 0 -> previousKeyRetirable true', async () => {
        countMock.mockResolvedValue({
            total: 0,
            perColumn: [{ model: 'User', column: 'emailEncrypted', unmigrated: 0, v1Total: 6 }],
        });
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        // Note v1Total is 6 while unmigrated is 0 — the whole reason the field
        // exists. `LIKE 'v1:%'` would have reported 6 rows of outstanding work
        // forever, because a migrated row is still `v1:`.
        expect(body.remaining).toBe(0);
        expect(body.previousKeyRetirable).toBe(true);
        expect(body.columns[0].v1Total).toBe(6);
    });

    it('remaining > 0 -> previousKeyRetirable false', async () => {
        countMock.mockResolvedValue({
            total: 3,
            perColumn: [{ model: 'User', column: 'emailEncrypted', unmigrated: 3, v1Total: 6 }],
        });
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.remaining).toBe(3);
        expect(body.previousKeyRetirable).toBe(false);
    });

    it('an UNWRAPPED DEK blocks the verdict even with every column done', async () => {
        // The defect this closes. `Tenant.encryptedDek` is master-KEK ciphertext
        // in NEITHER manifest, so the column union does not reach it. Reporting
        // `previousKeyRetirable: true` here would green-light removing the
        // previous key while every DEK still needed it — making every DEK
        // unwrappable and every v2 ciphertext unreadable.
        countMock.mockResolvedValue({ total: 0, perColumn: [] });
        dekCountMock.mockResolvedValue(2);
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.columnsRemaining).toBe(0);
        expect(body.unwrappedDeks).toBe(2);
        expect(body.remaining).toBe(2);
        expect(body.previousKeyRetirable).toBe(false);
    });

    it('both at zero -> retirable, and the two counts are reported separately', async () => {
        // Separately, because "columns done, DEKs outstanding" and the reverse
        // are different operator situations and a single total hides which.
        countMock.mockResolvedValue({ total: 0, perColumn: [] });
        dekCountMock.mockResolvedValue(0);
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.columnsRemaining).toBe(0);
        expect(body.unwrappedDeks).toBe(0);
        expect(body.previousKeyRetirable).toBe(true);
    });

    it('a FILTERED report never counts DEKs, and is never retirable', async () => {
        // A filter names manifest columns; a DEK is not one. And "these columns
        // are done" is not "the previous key is retirable".
        countMock.mockResolvedValue({ total: 0, perColumn: [] });
        dekCountMock.mockResolvedValue(5);
        const { GET } = loadRoute(REAL_KEY);
        const req = makeReq({ key: REAL_KEY });
        (req as unknown as { nextUrl: URL }).nextUrl = new URL(
            'http://localhost:3000/api/admin/key-rotation?only=User.emailEncrypted',
        );
        const body = await (await GET(req)).json();
        expect(body.filtered).toBe(true);
        expect(body.unwrappedDeks).toBe(0);
        expect(dekCountMock).not.toHaveBeenCalled();
        expect(body.previousKeyRetirable).toBe(false);
    });

    it('reports whether a rotation is in flight', async () => {
        inFlightMock.mockReturnValue(false);
        const { GET } = loadRoute(REAL_KEY);
        const body = await (await GET(makeReq({ key: REAL_KEY }))).json();
        expect(body.rotationInFlight).toBe(false);
    });
});

describe('POST runs a pass and reports the manifest union', () => {
    it('returns the sweep result plus the retirable verdict', async () => {
        const { POST } = loadRoute(REAL_KEY);
        const res = await POST(makeReq({ method: 'POST', key: REAL_KEY }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.totalRewritten).toBe(4);
        expect(body.remaining).toBe(0);
        expect(body.previousKeyRetirable).toBe(true);
        // Surfaced so an operator can SEE that both manifests are covered —
        // the whole defect was a sweep that silently knew only one.
        expect(body.manifests).toEqual(['encrypted-fields', 'pii']);
        // The DEK re-wrap rides along on an unfiltered pass, so one call
        // finishes a master rotation without needing a tenant admin session.
        expect(body.deks.rewrapped).toBe(3);
    });

    it('an empty body is fine; a malformed one is 400 without sweeping', async () => {
        const { POST } = loadRoute(REAL_KEY);
        expect((await POST(makeReq({ method: 'POST', key: REAL_KEY, body: '' }))).status).toBe(200);

        jest.clearAllMocks();
        const { POST: P2 } = loadRoute(REAL_KEY);
        expect((await P2(makeReq({ method: 'POST', key: REAL_KEY, body: '{not json' }))).status).toBe(400);
        expect(sweepMock).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range batchSize rather than clamping silently', async () => {
        const { POST } = loadRoute(REAL_KEY);
        const res = await POST(makeReq({ method: 'POST', key: REAL_KEY, body: '{"batchSize":5000}' }));
        expect(res.status).toBe(400);
        expect(sweepMock).not.toHaveBeenCalled();
    });

    it('passes a valid batchSize through', async () => {
        const { POST } = loadRoute(REAL_KEY);
        await POST(makeReq({ method: 'POST', key: REAL_KEY, body: '{"batchSize":50}' }));
        expect(sweepMock).toHaveBeenCalledWith({ batchSize: 50 });
    });
});
