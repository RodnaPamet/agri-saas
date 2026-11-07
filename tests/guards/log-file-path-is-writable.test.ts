/**
 * If the compose declares a log FILE, the image must make its directory
 * writable by the runtime user — #2682.
 *
 * ## What happened
 *
 * #2687 added `LOG_FILE_PATH=/var/log/agrent/app.jsonl` to the compose file and
 * mounted the named volume `applogs` there, so a log copy would outlive the
 * container Watchtower prunes on every publish. It never wrote a byte.
 *
 * A Docker named volume is created **root-owned**, and it seeds its ownership
 * from the image's directory ONLY if that directory exists at first mount.
 * `/var/log/agrent` did not exist in the image, so the volume stayed
 * `root:root` 755 while the app runs as uid 1001. Measured on the VM: the
 * directory empty after 50 minutes of a healthy app, `app.jsonl` absent, and
 * the logger's own fallback in `docker logs`:
 *
 *     [logger] LOG_FILE_PATH is set but unusable; continuing on stdout only:
 *     EACCES: permission denied, open '/var/log/agrent/app.jsonl'
 *
 * The fallback is correct — it degrades to stdout rather than failing the
 * process. What it cost is the signal: **the only evidence the fix was inert
 * lived in the ephemeral log the fix exists to replace.** Nothing else could
 * have said so, because an absent file is indistinguishable from a quiet one.
 *
 * ## Why a guard and not just the Dockerfile line
 *
 * The two halves sit in different files, maintained for different reasons, and
 * neither reads the other. A future change to `LOG_FILE_PATH` — a different
 * directory, a second log, a worker-only path — reintroduces this with no
 * error at build time and no error at runtime, which is precisely how it got
 * here. The guard joins them.
 *
 * It asserts a PAIRING, not a path: whatever directory the compose chooses, the
 * image must create and chown it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT } from '../helpers/collect-files';

const COMPOSE = path.join(REPO_ROOT, 'deploy', 'docker-compose.vm.yml');
const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');

/** Every `LOG_FILE_PATH: <value>` the compose sets, deduped. */
function logFilePaths(compose: string): string[] {
    const out = new Set<string>();
    for (const m of compose.matchAll(/^\s*LOG_FILE_PATH:\s*(\S+)\s*$/gm)) {
        out.add(m[1].replace(/^["']|["']$/g, ''));
    }
    return [...out];
}

/** Does the Dockerfile create AND chown `dir` to the runtime user? */
function imagePreparesDir(dockerfile: string, dir: string): { mkdir: boolean; chown: boolean } {
    // Line continuations joined, so a `mkdir -p a b \` + `chown … a b` pair
    // reads as one statement — which is how the uploads precedent is written.
    const joined = dockerfile.replace(/\\\r?\n\s*/g, ' ');
    // Then split on `&&`, which is load-bearing rather than tidy. A greedy
    // `[^\n]*` across the joined line let the CHOWN's mention of the directory
    // satisfy the MKDIR pattern, so removing the directory from `mkdir -p`
    // failed no test — measured, and the same class as any matcher that spans
    // a boundary it was not meant to cross.
    const segments = joined.split('&&');
    const has = (verb: RegExp) =>
        segments.some(
            (seg) => verb.test(seg) && new RegExp(`\\s${dir}(\\s|$)`).test(seg),
        );
    return {
        mkdir: has(/\bmkdir\s+-p\b/),
        chown: has(/\bchown\s+nextjs:nodejs\b/),
    };
}

describe('a declared LOG_FILE_PATH is writable by the runtime user', () => {
    const compose = fs.readFileSync(COMPOSE, 'utf8');
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    const paths = logFilePaths(compose);

    it('[log-file-path-writable] prints the denominator', () => {
        // A floor: if the extraction stopped matching, every assertion below
        // would range over nothing and pass for free.
        expect(paths.length).toBeGreaterThanOrEqual(1);
        console.log(
            `[log-file-path-writable] ${paths.length} LOG_FILE_PATH value(s) in the compose: ${paths.join(', ')}`,
        );
    });

    it('the image creates and chowns every log directory the compose names', () => {
        const broken = paths
            .map((p) => ({ dir: path.posix.dirname(p), ...imagePreparesDir(dockerfile, path.posix.dirname(p)) }))
            .filter((r) => !r.mkdir || !r.chown);
        expect(broken).toEqual([]);
    });

    it('the compose actually MOUNTS something at that directory', () => {
        // Without a mount the file is inside the container and dies with it,
        // which is the whole defect #2682 describes. A chowned directory with
        // no volume would satisfy the assertion above and deliver nothing.
        for (const p of paths) {
            const dir = path.posix.dirname(p);
            expect(compose).toMatch(new RegExp(`:${dir}(\\s|$)`, 'm'));
        }
    });

    /**
     * The detector's own proof. The real files are compliant now, so without
     * this the assertions above would pass whether or not the matcher can see
     * anything — and this guard exists precisely because an inert mechanism
     * looked identical to a working one.
     */
    it('detects an image that mounts a log dir it never chowns', () => {
        const dir = '/var/log/agrent';
        const good = 'RUN mkdir -p /data/uploads /var/log/agrent && \\\n    chown nextjs:nodejs /data/uploads /var/log/agrent';
        const noChown = 'RUN mkdir -p /data/uploads /var/log/agrent';
        const neither = 'RUN mkdir -p /data/uploads && chown nextjs:nodejs /data/uploads';

        expect(imagePreparesDir(good, dir)).toEqual({ mkdir: true, chown: true });
        expect(imagePreparesDir(noChown, dir)).toEqual({ mkdir: true, chown: false });
        expect(imagePreparesDir(neither, dir)).toEqual({ mkdir: false, chown: false });
        // THE case that slipped: the dir is chowned but NOT created. A matcher
        // whose wildcard crosses `&&` reads the chown's mention as the mkdir's
        // and reports both true.
        const chownOnly = 'RUN mkdir -p /data/uploads && chown nextjs:nodejs /data/uploads /var/log/agrent';
        expect(imagePreparesDir(chownOnly, dir)).toEqual({ mkdir: false, chown: true });
        // and the extractor must find a real value rather than matching anything
        expect(logFilePaths('      LOG_FILE_PATH: /var/log/agrent/app.jsonl')).toEqual([
            '/var/log/agrent/app.jsonl',
        ]);
        expect(logFilePaths('# LOG_FILE_PATH is set elsewhere')).toEqual([]);
    });
});
