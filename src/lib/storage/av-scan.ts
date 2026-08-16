/**
 * AV Scan — Antivirus Scanning Module
 *
 * Provides file scanning via ClamAV (clamd TCP protocol) or external
 * webhook-based scanning. Every uploaded file passes through this module
 * before being treated as safe/usable.
 *
 * Scanning Modes (controlled by AV_SCAN_MODE env var):
 *   - strict:      downloads blocked until scan completes (default)
 *   - permissive:  downloads allowed while scan is pending
 *   - disabled:    no scanning (dev/test only)
 *
 * Architecture:
 *   - scanFile(): triggers ClamAV scan via TCP (clamd protocol)
 *   - scanBuffer(): scans a Buffer directly
 *   - isDownloadAllowed(): gate check for download routes
 *   - triggerAsyncScan(): enqueues scan via BullMQ (future)
 *
 * @module lib/storage/av-scan
 */
import net from 'net';
import { Readable } from 'stream';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

// ─── Types ───

export type ScanResult = {
    status: 'CLEAN' | 'INFECTED' | 'ERROR';
    /** Virus/threat name if infected */
    threat?: string;
    /** Scan engine identifier */
    engine: string;
    /** Duration of scan in ms */
    durationMs: number;
    /** Raw engine output */
    rawOutput?: string;
};

export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED';

// ─── ClamAV Integration ───

const CLAMAV_DEFAULT_PORT = 3310;
const CLAMAV_TIMEOUT = 30_000; // 30s timeout for scanning

/**
 * Parse CLAMAV_HOST into host:port.
 * Supports formats: "clamav:3310", "localhost", "clamav"
 */
function parseClamavHost(): { host: string; port: number } | null {
    const raw = env.CLAMAV_HOST;
    if (!raw) return null;

    const parts = raw.split(':');
    return {
        host: parts[0],
        port: parts[1] ? parseInt(parts[1], 10) : CLAMAV_DEFAULT_PORT,
    };
}

/**
 * Scan a buffer using ClamAV's clamd INSTREAM protocol.
 *
 * Protocol:
 *   1. Send "zINSTREAM\0"
 *   2. For each chunk: send 4-byte big-endian length + chunk data
 *   3. Send 4 zero bytes to indicate end of stream
 *   4. Read response: "stream: OK\0" or "stream: <virus> FOUND\0"
 */
export async function scanBuffer(buffer: Buffer): Promise<ScanResult> {
    const startTime = performance.now();
    const clamav = parseClamavHost();

    if (!clamav) {
        // ClamAV not configured — check scan mode
        const mode = env.AV_SCAN_MODE;
        if (mode === 'disabled') {
            return {
                status: 'CLEAN',
                engine: 'disabled',
                durationMs: 0,
                rawOutput: 'AV scanning disabled',
            };
        }

        logger.warn('ClamAV not configured (CLAMAV_HOST not set)', {
            component: 'av-scan',
            scanMode: mode,
        });

        return {
            status: 'ERROR',
            engine: 'none',
            durationMs: Math.round(performance.now() - startTime),
            rawOutput: 'ClamAV not configured',
        };
    }

    return new Promise<ScanResult>((resolve) => {
        const socket = new net.Socket();
        let response = '';

        socket.setTimeout(CLAMAV_TIMEOUT);

        socket.connect(clamav.port, clamav.host, () => {
            // Send INSTREAM command
            socket.write('zINSTREAM\0');

            // Send data in chunks (max 2MB per chunk for clamd)
            const CHUNK_SIZE = 2 * 1024 * 1024;
            for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
                const chunk = buffer.subarray(offset, Math.min(offset + CHUNK_SIZE, buffer.length));
                const lengthBuf = Buffer.alloc(4);
                lengthBuf.writeUInt32BE(chunk.length, 0);
                socket.write(lengthBuf);
                socket.write(chunk);
            }

            // End of stream: 4 zero bytes
            socket.write(Buffer.alloc(4, 0));
        });

        socket.on('data', (data) => {
            response += data.toString();
        });

        socket.on('end', () => {
            const durationMs = Math.round(performance.now() - startTime);
            const cleaned = response.replace(/\0/g, '').trim();

            if (cleaned.includes('OK')) {
                resolve({
                    status: 'CLEAN',
                    engine: 'clamav',
                    durationMs,
                    rawOutput: cleaned,
                });
            } else if (cleaned.includes('FOUND')) {
                // Extract virus name: "stream: Eicar-Signature FOUND"
                const match = cleaned.match(/stream:\s*(.+?)\s*FOUND/);
                resolve({
                    status: 'INFECTED',
                    threat: match?.[1] || 'unknown',
                    engine: 'clamav',
                    durationMs,
                    rawOutput: cleaned,
                });
            } else {
                resolve({
                    status: 'ERROR',
                    engine: 'clamav',
                    durationMs,
                    rawOutput: cleaned || 'empty response',
                });
            }
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve({
                status: 'ERROR',
                engine: 'clamav',
                durationMs: Math.round(performance.now() - startTime),
                rawOutput: 'scan timed out',
            });
        });

        socket.on('error', (err) => {
            const durationMs = Math.round(performance.now() - startTime);
            logger.error('ClamAV scan error', {
                component: 'av-scan',
                err: err instanceof Error ? err : new Error(String(err)),
            });
            resolve({
                status: 'ERROR',
                engine: 'clamav',
                durationMs,
                rawOutput: err.message,
            });
        });
    });
}

/**
 * Scan a Readable stream by collecting it into a buffer first.
 * For very large files, consider streaming to ClamAV directly.
 */
export async function scanStream(stream: Readable, maxBytes = 100 * 1024 * 1024): Promise<ScanResult> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > maxBytes) {
            return {
                status: 'ERROR',
                engine: 'clamav',
                durationMs: 0,
                rawOutput: `File too large for scanning (${size} > ${maxBytes} bytes)`,
            };
        }
        chunks.push(buf);
    }

    return scanBuffer(Buffer.concat(chunks));
}

// ─── Download Gate ───

/**
 * Check whether a file with the given scan status should be downloadable.
 * Respects the AV_SCAN_MODE environment variable.
 *
 * @param scanStatus - current scan status of the file
 * @returns true if download should be allowed, false to block
 */
export function isDownloadAllowed(scanStatus: ScanStatus | string | null): boolean {
    const mode = env.AV_SCAN_MODE;

    // INFECTED is refused FIRST, ahead of the mode check, because the
    // comment below it used to be false.
    //
    // The two rules were the other way round: `if (mode === 'disabled')
    // return true;` came first, so in disabled mode this returned true
    // for INFECTED — while the line immediately under it asserted
    // "regardless of mode". `deploy/docker-compose.vm.yml` sets
    // AV_SCAN_MODE: disabled on the live agrent stack, so the invariant
    // this function documents was not the one it implemented in
    // production.
    //
    // It was latent rather than exploited: agrent runs no ClamAV service
    // and sets no CLAMAV_HOST, so nothing scans and nothing is ever
    // marked INFECTED — all 5 production FileRecords sit at PENDING.
    // That is exactly what made it dangerous. The bug was invisible
    // until the moment someone deployed a scanner, at which point the
    // first file it flagged would still have been served.
    //
    // `disabled` means "we are not scanning", not "serve anything we
    // already know is malware".
    if (scanStatus === 'INFECTED') return false;

    // Disabled mode: allow everything else through unscanned.
    if (mode === 'disabled') return true;

    // Clean and skipped files are always allowed
    if (scanStatus === 'CLEAN' || scanStatus === 'SKIPPED') return true;

    // PENDING (or null/undefined): depends on mode
    if (mode === 'strict') {
        // Strict: block until scan completes
        return false;
    }

    // Permissive: allow pending downloads
    return true;
}

/**
 * Get a human-readable reason for download denial.
 */
export function getBlockedReason(scanStatus: ScanStatus | string | null): string {
    if (scanStatus === 'INFECTED') {
        return 'This file has been flagged as infected by antivirus scanning and cannot be downloaded.';
    }
    if (scanStatus === 'PENDING' || !scanStatus) {
        return 'This file is pending antivirus scanning and cannot be downloaded yet. Please try again shortly.';
    }
    return 'Download not available.';
}

// ─── ClamAV Health Check ───

/**
 * Check if ClamAV daemon is reachable.
 * Sends PING and expects PONG response.
 */
export async function isClamavAvailable(): Promise<boolean> {
    const clamav = parseClamavHost();
    if (!clamav) return false;

    return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);

        socket.connect(clamav.port, clamav.host, () => {
            socket.write('zPING\0');
        });

        socket.on('data', (data) => {
            const response = data.toString().replace(/\0/g, '').trim();
            socket.destroy();
            resolve(response === 'PONG');
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Scan an uploaded buffer and return the status to persist.
 *
 * This is the seam that closes the dead-man switch. Every upload now resolves
 * to a TERMINAL status before the FileRecord is marked stored:
 *
 *   scanning configured + clean   → CLEAN
 *   scanning configured + hit     → INFECTED   (download blocked in every mode)
 *   scanning not configured       → SKIPPED    (downloadable; honest — nothing scanned it)
 *   scanner configured but erroring → depends on mode (see below)
 *
 * Nothing is left PENDING, because nothing in this system ever moves a file
 * OFF pending — there is no async scan worker. A status that only one process
 * can write and no process can advance is not a workflow state, it is a trap.
 *
 * On scanner ERROR the mode decides: `strict` keeps the file PENDING (and so
 * unreadable) because a deployment that asked for strict scanning should fail
 * closed; anything else records SKIPPED and logs, because failing open on an
 * unreachable optional scanner is what the operator asked for.
 */
export async function scanUploadedBuffer(
    buffer: Buffer,
): Promise<'CLEAN' | 'INFECTED' | 'SKIPPED' | 'PENDING'> {
    const mode = env.AV_SCAN_MODE;
    if (mode === 'disabled' || !env.CLAMAV_HOST) {
        // No scanner deployed. SKIPPED says so; PENDING would imply a scan is
        // coming, and none is.
        return 'SKIPPED';
    }

    const result = await scanBuffer(buffer);
    if (result.status === 'CLEAN') return 'CLEAN';
    if (result.status === 'INFECTED') {
        logger.warn('av-scan: upload rejected as infected', {
            component: 'av-scan',
            threat: result.threat,
            engine: result.engine,
        });
        return 'INFECTED';
    }

    logger.error('av-scan: scanner error on upload', {
        component: 'av-scan',
        engine: result.engine,
        mode,
    });
    return mode === 'strict' ? 'PENDING' : 'SKIPPED';
}
