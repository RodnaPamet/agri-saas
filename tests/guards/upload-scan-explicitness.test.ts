/**
 * No upload path stores a file without saying what the scanner found.
 *
 * ── The regression this exists for ──────────────────────────────────
 *
 * `FileRepository.markStored` took `scanStatus` with a `= 'SKIPPED'`
 * default. It reads as a harmless fallback. It is not: `isDownloadAllowed`
 * returns TRUE for `'SKIPPED'` in every `AV_SCAN_MODE`, so an omitted
 * argument marked a file simultaneously **unscanned and downloadable**.
 *
 * Two upload paths took that default — the evidence ZIP import (100 MB of
 * arbitrary files, every one of them extracted and kept) and the spatial
 * import. Neither diff mentioned scanning, because neither diff contained
 * the word. One of them carried a docblock stating the opposite: that
 * ClamAV scanned asynchronously and the status was PENDING. There is no
 * async scan worker.
 *
 * ── Why DERIVED rather than a list of known routes ──────────────────
 *
 * A curated list of upload endpoints is exactly what failed here: the two
 * unscanned paths were not on anyone's list of "the upload routes",
 * because they are *importers* that happen to store a file. This scans for
 * the CALL, wherever it lives, so a sixth ingest path is covered the day
 * it is written rather than the day someone remembers it.
 *
 * The type system already rejects an omitted argument. This guard is for
 * the other direction: someone hitting that type error and "fixing" it by
 * restoring the default, which would silently re-open every call site at
 * once.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const FILE_REPO = path.join(SRC, 'app-layer/repositories/FileRepository.ts');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            walk(full, out);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** `markStored(...)` call sites under `src/`, with their argument text. */
function markStoredCalls(): Array<{ file: string; args: string }> {
    const found: Array<{ file: string; args: string }> = [];
    for (const file of walk(SRC)) {
        if (file === FILE_REPO) continue;
        const src = fs.readFileSync(file, 'utf-8');
        // Arguments up to the closing paren of the call. Upload call sites
        // are one-liners; a multi-line call would simply not match, which
        // the self-check below turns into a failure rather than a pass.
        const re = /markStored\(([^)]*)\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
            found.push({ file: path.relative(ROOT, file), args: m[1] });
        }
    }
    return found;
}

describe('every stored upload states its scan outcome', () => {
    const calls = markStoredCalls();

    it('finds the call sites at all (guard is not vacuously passing)', () => {
        // A rename, a move, or a switch to multi-line calls would leave the
        // assertions below iterating an empty array and passing forever.
        expect(calls.length).toBeGreaterThanOrEqual(5);
    });

    it.each(calls)('$file passes a scanStatus argument', ({ args }) => {
        // db, ctx, id, scanStatus — four arguments. Three means the caller
        // is leaning on a default that must not exist.
        const parts = args.split(',').map((a) => a.trim()).filter(Boolean);
        expect(parts.length).toBeGreaterThanOrEqual(4);
    });

    it('markStored declares scanStatus WITHOUT a default', () => {
        const src = fs.readFileSync(FILE_REPO, 'utf-8');
        const sig = src.slice(src.indexOf('static async markStored'));
        const params = sig.slice(0, sig.indexOf(')'));
        expect(params).toContain('scanStatus');
        // Any `= <something>` on that parameter re-opens every call site at
        // once, which is precisely how this shipped the first time.
        expect(params).not.toMatch(/scanStatus[^,)]*=/);
    });

    it("EXECUTES the download gate: 'SKIPPED' is allowed, which is why silence is unsafe", () => {
        // The premise of this whole guard, run rather than assumed — and run
        // rather than grepped, because the claim is about what the gate
        // DOES. If a skipped file were blocked from download, an omitted
        // argument would be merely wrong instead of dangerous, and this file
        // would be arguing for a rule that does not need to exist.
        const { isDownloadAllowed } = require('@/lib/storage/av-scan');
        expect(isDownloadAllowed('SKIPPED')).toBe(true);
        expect(isDownloadAllowed('INFECTED')).toBe(false);
    });
});
