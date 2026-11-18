/**
 * #3191 — `compose_repo_inputs` is what decides which repo files `apply.sh`
 * ships and `check-drift.sh` hashes beyond the compose file itself.
 *
 * Both scripts named `deploy/postgres/Dockerfile` by hand, so the
 * `zarnoborsa` build context and the `init-roles.sh` bind mount were neither
 * shipped nor hashed. The set is derived from the compose file now; these
 * cases EXECUTE the helper rather than reading its source.
 */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');
const LIB = join(REPO_ROOT, 'deploy/lib/compose-repo-inputs.sh');

/**
 * The driver is a FIXED script read from stdin (`bash -s`), and every path
 * reaches it as a positional argument — none is ever spliced into shell text.
 * It used `bash -c '<script>' _ <paths>`, which is equally safe but reads to a
 * scanner as a shell string built next to environment-derived paths (CodeQL
 * #454); `-s` keeps the same argv shape with no command string to construct.
 */
const DRIVER = 'set -euo pipefail; . "$1"; compose_repo_inputs "$2" "$3"\n';

function inputs(compose: string, root: string): { code: number; out: string[]; err: string } {
    const r = spawnSync('bash', ['-s', '--', LIB, compose, root], {
        input: DRIVER,
        encoding: 'utf8',
    });
    return { code: r.status ?? 1, out: r.stdout.split('\n').filter(Boolean), err: r.stderr };
}

describe('compose_repo_inputs (#3191)', () => {
    it('derives every build context and ./deploy mount from the real compose file', () => {
        const r = inputs(join(REPO_ROOT, 'deploy/docker-compose.vm.yml'), REPO_ROOT);
        expect(r.code).toBe(0);
        // The two this issue is about, plus the one the scripts already knew.
        expect(r.out).toEqual(
            expect.arrayContaining([
                'deploy/postgres/Dockerfile',
                'deploy/zarnoborsa/Dockerfile',
                'deploy/init-roles.sh',
            ]),
        );
    });

    it('never ships the VM-provided Caddyfile, nor the image build context', () => {
        const r = inputs(join(REPO_ROOT, 'deploy/docker-compose.vm.yml'), REPO_ROOT);
        expect(r.out.some((p) => /Caddyfile/.test(p))).toBe(false);
        expect(r.out.every((p) => p.startsWith('deploy/'))).toBe(true);
    });

    describe('against a crafted compose file', () => {
        let root: string;
        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'compose-inputs-'));
            mkdirSync(join(root, 'deploy/newsvc'), { recursive: true });
            writeFileSync(join(root, 'deploy/newsvc/Dockerfile'), 'FROM scratch\n');
            writeFileSync(join(root, 'deploy/newsvc/entry.sh'), 'true\n');
            writeFileSync(join(root, 'deploy/seed.sh'), 'true\n');
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        const compose = (body: string) => {
            const f = join(root, 'deploy/docker-compose.vm.yml');
            writeFileSync(f, body);
            return f;
        };

        it('covers a NEW context the moment the compose file names it — every file in it', () => {
            const f = compose(
                'services:\n  newsvc:\n    build:\n      context: ./deploy/newsvc\n' +
                    '    volumes:\n      - ./deploy/seed.sh:/seed.sh:ro\n      - ./Caddyfile:/etc/caddy/Caddyfile:ro\n',
            );
            const r = inputs(f, root);
            expect(r.code).toBe(0);
            expect(r.out).toEqual([
                'deploy/newsvc/Dockerfile',
                'deploy/newsvc/entry.sh',
                'deploy/seed.sh',
            ]);
        });

        it('REFUSES (non-zero) when a named context is absent from the repo', () => {
            const f = compose('services:\n  x:\n    build:\n      context: ./deploy/missing\n');
            const r = inputs(f, root);
            expect(r.code).not.toBe(0);
            expect(r.err).toContain('deploy/missing');
        });

        it('REFUSES when a named bind-mount source is absent from the repo', () => {
            const f = compose('services:\n  x:\n    volumes:\n      - ./deploy/gone.sh:/gone.sh:ro\n');
            const r = inputs(f, root);
            expect(r.code).not.toBe(0);
            expect(r.err).toContain('deploy/gone.sh');
        });
    });

    it('both scripts source the helper rather than naming a context by hand', () => {
        for (const script of ['deploy/apply.sh', 'deploy/check-drift.sh']) {
            const src = readFileSync(join(REPO_ROOT, script), 'utf8');
            expect(src).toContain('lib/compose-repo-inputs.sh');
            expect(src).toContain('compose_repo_inputs "$LOCAL_COMPOSE"');
            expect(src).not.toMatch(/postgres\/Dockerfile"/);
        }
        // Control: the helper itself runs (bash present, file sourceable).
        expect(execFileSync('bash', ['-n', LIB]).toString()).toBe('');
    });
});
