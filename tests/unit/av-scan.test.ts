/**
 * AV Scan — Unit Tests
 *
 * Tests the download gate logic and scan result parsing.
 * ClamAV integration tests are skipped if ClamAV is not running.
 */
import { isDownloadAllowed, getBlockedReason } from '../../src/lib/storage/av-scan';

// ─── Mock env for testing ───
// av-scan reads env.AV_SCAN_MODE — we mock it per test via process.env

describe('AV Scan - Download Gate', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset module cache to pick up env changes
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('strict mode', () => {
        beforeEach(() => {
            process.env.AV_SCAN_MODE = 'strict';
        });

        test('CLEAN files are downloadable', () => {
            expect(isDownloadAllowed('CLEAN')).toBe(true);
        });

        test('INFECTED files are blocked', () => {
            expect(isDownloadAllowed('INFECTED')).toBe(false);
        });

        test('PENDING files are blocked in strict mode', () => {
            expect(isDownloadAllowed('PENDING')).toBe(false);
        });

        test('null scan status is blocked in strict mode', () => {
            expect(isDownloadAllowed(null)).toBe(false);
        });

        test('SKIPPED files are downloadable', () => {
            expect(isDownloadAllowed('SKIPPED')).toBe(true);
        });
    });

    describe('permissive mode', () => {
        beforeEach(() => {
            process.env.AV_SCAN_MODE = 'permissive';
        });

        test('CLEAN files are downloadable', () => {
            expect(isDownloadAllowed('CLEAN')).toBe(true);
        });

        test('INFECTED files are still blocked', () => {
            expect(isDownloadAllowed('INFECTED')).toBe(false);
        });

        test('PENDING files are allowed in permissive mode', () => {
            expect(isDownloadAllowed('PENDING')).toBe(true);
        });

        test('null scan status is allowed in permissive mode', () => {
            expect(isDownloadAllowed(null)).toBe(true);
        });
    });

    describe('disabled mode', () => {
        beforeEach(() => {
            process.env.AV_SCAN_MODE = 'disabled';
        });

        test('unscanned statuses are downloadable when disabled', () => {
            expect(isDownloadAllowed('CLEAN')).toBe(true);
            expect(isDownloadAllowed('PENDING')).toBe(true);
            expect(isDownloadAllowed(null)).toBe(true);
        });

        test('INFECTED is STILL refused in disabled mode', () => {
            // This assertion used to read `.toBe(true)`, sitting inside a
            // case called "all statuses are downloadable when disabled". The
            // bug was therefore not overlooked — it was ASSERTED, and the
            // green test is what kept it: `if (mode === 'disabled') return
            // true;` ran ahead of the INFECTED check, directly under a
            // comment promising "NEVER downloadable regardless of mode".
            //
            // It mattered because `deploy/docker-compose.vm.yml` sets
            // AV_SCAN_MODE: disabled on the live agrent stack. Latent rather
            // than exploited — that stack runs no ClamAV and sets no
            // CLAMAV_HOST, so nothing is ever marked INFECTED (all 5
            // production FileRecords sit at PENDING) — but it would have
            // surfaced on the first file a newly-deployed scanner flagged.
            //
            // `disabled` means "we are not scanning", not "serve known
            // malware".
            expect(isDownloadAllowed('INFECTED')).toBe(false);
        });
    });
});

describe('AV Scan - Blocked Reasons', () => {
    test('infected reason', () => {
        const reason = getBlockedReason('INFECTED');
        expect(reason).toContain('infected');
    });

    test('pending reason', () => {
        const reason = getBlockedReason('PENDING');
        expect(reason).toContain('pending');
    });

    test('null reason', () => {
        const reason = getBlockedReason(null);
        expect(reason).toContain('pending');
    });
});
