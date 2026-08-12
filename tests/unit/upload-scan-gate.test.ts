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

jest.mock('@/lib/storage/av-scan', () => {
    const actual = jest.requireActual('@/lib/storage/av-scan');
    return {
        ...actual,
        scanUploadedBuffer: (...args: unknown[]) => mockScanVerdict(...args),
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
const OPTS = { component: 'test-surface', subjectId: 's-1' };

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

    it('refuses INFECTED even with scanning disabled', async () => {
        // `isDownloadAllowed` returns true for everything in `disabled` mode
        // — its mode short-circuit precedes its own infected rule. A verdict
        // that positively identified malware must not be undone by a flag.
        mockEnv.AV_SCAN_MODE = 'disabled';
        expect(isDownloadAllowed('INFECTED')).toBe(true); // the gate, executed
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
        for (const verdict of ['CLEAN', 'SKIPPED', 'PENDING'] as const) {
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
