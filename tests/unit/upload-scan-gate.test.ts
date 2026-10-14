/**
 * `scanOrRefuse` — the scan gate for uploads that store no `FileRecord`.
 *
 * A record-backed upload writes first, records the verdict, and lets the
 * download route decide with `isDownloadAllowed`. A record-less one
 * (`avatars/<userId>.webp`, `promotions/<id>.webp`) is streamed by key with
 * no status to consult, so the same decision has to happen before the write
 * or not at all.
 *
 * These cases EXECUTE the gate against the REAL `isDownloadAllowed` — only
 * `scanUploadedBuffer` is stubbed, so the test drives the verdict without
 * needing a live ClamAV. That is deliberate: the module's claim is that its
 * policy IS the download gate rather than a second table beside it, and a
 * test that stubbed the gate too would be asserting the copy.
 */
export {};

const mockScanVerdict = jest.fn();

/**
 * Both seams, deliberately.
 *
 * `scanOrRefuse` reads `scanUploadedBufferDetailed` since #1811, so mocking
 * only `scanUploadedBuffer` would spread the REAL detailed function through
 * `...actual` and every assertion below would silently exercise it instead of
 * the verdict it set — passing or failing for reasons unrelated to the test.
 * That is the partial-barrel-mock trap, and it is quiet here because the
 * spread makes the missing override look like a present one.
 *
 * A bare status from `mockScanVerdict` is widened to an outcome so the twelve
 * assertions written before the split keep working unchanged; a test that
 * cares about the REASON can resolve a full outcome instead.
 */
jest.mock('@/lib/storage/av-scan', () => {
    const actual = jest.requireActual('@/lib/storage/av-scan');
    const widen = (v: unknown) => {
        if (typeof v !== 'string') return v;
        if (v === 'SKIPPED') return { status: 'SKIPPED', reason: 'scanning-disabled' };
        if (v === 'PENDING') return { status: 'PENDING', reason: 'scanner-error-strict' };
        return { status: v };
    };
    return {
        ...actual,
        scanUploadedBuffer: (...args: unknown[]) => mockScanVerdict(...args),
        scanUploadedBufferDetailed: async (...args: unknown[]) =>
            widen(await mockScanVerdict(...args)),
    };
});

// `skipValidation` is on under jest, so zod's `.default('strict')` never
// runs and `env.AV_SCAN_MODE` would otherwise be undefined — which reads as
// "not strict" and would silently turn the fail-closed cases below into
// fail-open ones.
const mockEnv: { AV_SCAN_MODE: string } = { AV_SCAN_MODE: 'strict' };
jest.mock('@/env', () => ({
    get env() {
        return mockEnv;
    },
}));

import { scanOrRefuse } from '@/lib/upload/ingest';
import { isDownloadAllowed } from '@/lib/storage/av-scan';

const BYTES = Buffer.from('some image bytes');
// `private` keeps every assertion written before #1811 meaning what it
// meant: those cases are about which verdicts may be STORED, and the
// public-surface gate is a separate question tested at the bottom.
const OPTS = { component: 'test-surface', subjectId: 's-1', exposure: 'private' } as const;

beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.AV_SCAN_MODE = 'strict';
    mockScanVerdict.mockResolvedValue('CLEAN');
});

describe('scanOrRefuse — which verdicts may be stored', () => {
    it('scans the bytes it was handed', async () => {
        await scanOrRefuse(BYTES, OPTS);
        expect(mockScanVerdict).toHaveBeenCalledWith(BYTES);
    });

    it('stores CLEAN', async () => {
        expect(await scanOrRefuse(BYTES, OPTS)).toBe('CLEAN');
    });

    it('stores SKIPPED — no scanner is deployed, and saying so is honest', async () => {
        // The live stack runs `AV_SCAN_MODE=disabled` with no ClamAV, so this
        // is the branch production actually takes. Refusing here would mean
        // an operator who never deployed a scanner cannot set a photo, while
        // every `FileRecord` path in the repo stores the same bytes happily.
        mockScanVerdict.mockResolvedValue('SKIPPED');
        expect(await scanOrRefuse(BYTES, OPTS)).toBe('SKIPPED');
    });

    it('REFUSES INFECTED', async () => {
        mockScanVerdict.mockResolvedValue('INFECTED');
        await expect(scanOrRefuse(BYTES, OPTS)).rejects.toThrow(/malware/i);
    });

    it('refuses INFECTED even with scanning disabled — and so does the gate now', async () => {
        // HISTORY, because this case is the reason the bug survived so long.
        //
        // It used to assert `isDownloadAllowed('INFECTED') === true` in
        // disabled mode, with a comment stating the cause exactly: "its mode
        // short-circuit precedes its own infected rule". So the defect was
        // not unknown — it was diagnosed, compensated for HERE at the upload
        // boundary, and then pinned by this assertion. The download side was
        // left exposed, and `deploy/docker-compose.vm.yml` runs the live
        // stack in exactly that mode.
        //
        // `isDownloadAllowed` now refuses INFECTED ahead of the mode check,
        // so the two boundaries finally agree: a verdict that positively
        // identified malware is not undone by a flag on the way IN or on the
        // way OUT.
        mockEnv.AV_SCAN_MODE = 'disabled';
        expect(isDownloadAllowed('INFECTED')).toBe(false); // the gate, executed
        mockScanVerdict.mockResolvedValue('INFECTED');
        await expect(scanOrRefuse(BYTES, OPTS)).rejects.toThrow(/malware/i);
    });

    it('REFUSES PENDING under strict — a configured scanner that broke', async () => {
        // `scanUploadedBuffer` only ever returns PENDING when a scanner is
        // configured, errored, and the mode asked to fail closed.
        mockScanVerdict.mockResolvedValue('PENDING');
        await expect(scanOrRefuse(BYTES, OPTS)).rejects.toThrow(/unavailable/i);
    });

    it('tracks the download gate rather than restating it', async () => {
        // The premise, executed: for every verdict the gate admits, the
        // record-less path stores; for every verdict it blocks, the
        // record-less path refuses. Written as a loop over the gate's own
        // answers so a change to `isDownloadAllowed` reaches this file.
        // INFECTED is included now. It was excluded from this loop because
        // the gate disagreed with the upload path on it in disabled mode,
        // which would have made the loop fail; with the ordering fixed the
        // premise holds for every verdict, so the loop covers them all.
        for (const verdict of ['CLEAN', 'SKIPPED', 'PENDING', 'INFECTED'] as const) {
            mockScanVerdict.mockResolvedValue(verdict);
            const allowed = isDownloadAllowed(verdict);
            if (allowed) {
                await expect(scanOrRefuse(BYTES, OPTS)).resolves.toBe(verdict);
            } else {
                await expect(scanOrRefuse(BYTES, OPTS)).rejects.toThrow();
            }
        }
    });

    it('refuses with a sentence a user can act on, not a code', async () => {
        // These reach the browser verbatim through `withApiErrorHandling`'s
        // `{ error: { message } }`, so they have to read as English.
        mockScanVerdict.mockResolvedValue('PENDING');
        const err = await scanOrRefuse(BYTES, OPTS).catch((e: Error) => e);
        expect((err as Error).message).toMatch(/try again shortly/i);
    });
});


// ─── the public-surface gate (#1811) ───

describe('scanOrRefuse — unscanned bytes and a public surface', () => {
    it('REFUSES a SKIPPED verdict when the bytes will be public', async () => {
        // The ruling: fail closed on public, open on private. `SKIPPED` means
        // nothing examined these bytes, and `isDownloadAllowed` permits it in
        // every mode — correct for a file behind a session, and the one case
        // where that is not good enough.
        mockScanVerdict.mockResolvedValue('SKIPPED');
        await expect(
            scanOrRefuse(BYTES, { ...OPTS, exposure: 'public' }),
        ).rejects.toThrow(/cannot be published/i);
    });

    it('STORES the same verdict when the bytes stay private', async () => {
        // The control that makes the test above about EXPOSURE rather than
        // about SKIPPED. Same verdict, same bytes, opposite outcome.
        mockScanVerdict.mockResolvedValue('SKIPPED');
        await expect(scanOrRefuse(BYTES, { ...OPTS, exposure: 'private' })).resolves.toBe(
            'SKIPPED',
        );
    });

    it('does not refuse a scanned file on a public surface', async () => {
        // Otherwise the gate above would be satisfied by refusing everything
        // public, which is not the ruling.
        mockScanVerdict.mockResolvedValue('CLEAN');
        await expect(scanOrRefuse(BYTES, { ...OPTS, exposure: 'public' })).resolves.toBe('CLEAN');
    });

    it('refuses INFECTED on a private surface too — exposure never widens what is allowed', async () => {
        mockScanVerdict.mockResolvedValue('INFECTED');
        await expect(
            scanOrRefuse(BYTES, { ...OPTS, exposure: 'private' }),
        ).rejects.toThrow(/malware scanner/i);
    });

    it('distinguishes the three reasons a scan was skipped', async () => {
        // The reason is what an operator needs: `scanning-disabled` and
        // `no-scanner-configured` mean nobody deployed a scanner,
        // `scanner-error-failed-open` means one broke tonight. Collapsed into
        // `SKIPPED` they are indistinguishable in a log.
        const { scanUploadedBufferDetailed } = jest.requireActual<
            typeof import('@/lib/storage/av-scan')
        >('@/lib/storage/av-scan');

        mockEnv.AV_SCAN_MODE = 'disabled';
        await expect(scanUploadedBufferDetailed(BYTES)).resolves.toEqual({
            status: 'SKIPPED',
            reason: 'scanning-disabled',
        });

        // A scanning mode with no host. Still fails OPEN, including under
        // strict — see the note in av-scan.ts on why that is not changed here.
        mockEnv.AV_SCAN_MODE = 'strict';
        await expect(scanUploadedBufferDetailed(BYTES)).resolves.toEqual({
            status: 'SKIPPED',
            reason: 'no-scanner-configured',
        });
    });
});
