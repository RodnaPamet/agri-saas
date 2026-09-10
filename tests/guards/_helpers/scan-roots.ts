/**
 * Scan roots that prove they resolved to something.
 *
 * `git ls-files -z <missing-path>` returns EMPTY with EXIT 0. A guard that
 * scans a renamed directory therefore finds zero files, reports zero
 * violations, and goes green — an empty selection is a PASS.
 *
 * Reproduced on this repo 2026-09-10 under the realistic refactor (rename the
 * directory, then fix every OTHER referencing file until CI is green): the
 * legacy brand shipped in both locale catalogs with 8 suites / 73 tests
 * passing, including the brand scanner's own self-tests. Nothing said a root
 * had stopped being scanned.
 *
 * The asymmetry that makes it survive: a root like `src/app-layer` is a unique
 * token any mechanical rename catches. A root like `messages` is an ordinary
 * English word nobody blanket-seds, so the rename is done by hand guided by red
 * tests — and this file never goes red, so it is never visited.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface ScanResult {
    /** Repo-relative paths, sorted. */
    files: string[];
    /** How many files each root contributed — for error messages worth reading. */
    perRoot: Record<string, number>;
}

/**
 * List every tracked file under `roots`, and REFUSE to return a population
 * that cannot be what the caller meant.
 *
 * Throws when a root contributes zero files. That is the whole point: the
 * caller's next line is almost always `expect(offences).toEqual([])`, which is
 * satisfied by a population of nothing.
 */
export function resolveScanRoots(
    roots: readonly string[],
    opts: { minFiles?: number; allowEmptyRoots?: readonly string[] } = {},
): ScanResult {
    const { minFiles = 1, allowEmptyRoots = [] } = opts;
    if (roots.length === 0) throw new Error('resolveScanRoots: no roots given');

    const perRoot: Record<string, number> = {};
    const all = new Set<string>();
    const empty: string[] = [];

    for (const root of roots) {
        const rel = path.isAbsolute(root) ? path.relative(REPO_ROOT, root) : root;
        let out = '';
        try {
            out = execFileSync('git', ['ls-files', '-z', '--', rel], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            });
        } catch {
            out = '';
        }
        const files = out.split('\0').filter(Boolean);
        perRoot[rel] = files.length;
        files.forEach((f) => all.add(f));
        if (files.length === 0 && !allowEmptyRoots.includes(rel)) empty.push(rel);
    }

    if (empty.length > 0) {
        throw new Error(
            `resolveScanRoots: ${empty.length} scan root(s) matched NO tracked files: ${empty.join(', ')}.\n` +
                `This is almost certainly a rename, not an empty directory. Left alone, every assertion\n` +
                `over this population would pass while scanning nothing. Update the root list, or pass\n` +
                `allowEmptyRoots for a root that is genuinely optional.\n` +
                `Per-root counts: ${JSON.stringify(perRoot)}`,
        );
    }

    const files = [...all].sort();
    if (files.length < minFiles) {
        throw new Error(
            `resolveScanRoots: ${files.length} file(s) across ${roots.length} root(s), below the floor of ${minFiles}. ` +
                `Per-root counts: ${JSON.stringify(perRoot)}`,
        );
    }
    return { files, perRoot };
}

/** Read a scanned file. Separate from the listing so callers can be tested with a stub. */
export function readScanned(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}
