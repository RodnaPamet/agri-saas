/**
 * `framework:import` CLI integration test.
 *
 * Spawns the CLI as a subprocess (the way operators / CI invoke it),
 * asserts the exit code + stdout/stderr contract:
 *
 *   • exit 0 on a valid dry-run
 *   • exit 0 + DB writes on a valid apply (real DB)
 *   • exit 2 when --input is missing
 *   • exit 3 on a malformed YAML file (CatalogParseError)
 *   • exit 3 on schema-invalid content (CatalogValidationError)
 *
 * Skipped when DB is unavailable.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, getTestDatabaseUrl } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEMO_YAML = path.join(REPO_ROOT, 'prisma/catalogs/iso27001-2022-demo.yaml');

interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

// Call the resolved `tsx` binary directly instead of `npx tsx`. `npx`
// adds a binary-resolution layer (cache/registry lookup) that, under
// full-suite parallel load, can add seconds of cold-start on top of
// tsx's own TS compile — a real flake contributor. The direct bin
// skips that layer.
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

function runCli(args: string[]): RunResult {
    const databaseUrl = getTestDatabaseUrl();
    const result = spawnSync(
        TSX_BIN,
        ['scripts/framework-import.ts', ...args],
        {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                DATABASE_URL: databaseUrl,
                DIRECT_DATABASE_URL: databaseUrl,
                SKIP_ENV_VALIDATION: '1',
            },
            // 120s: cold tsx compile + Prisma import + the DB work, with
            // generous slack for CPU starvation when the full suite runs.
            timeout: 120000,
        },
    );
    return {
        code: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

// `runCli` shells out to the `tsx` binary; cold `tsx` startup +
// Prisma import easily eats the default Jest timeout under parallel
// load. The per-test budget must exceed the 120s subprocess timeout
// so Jest doesn't kill the test before the spawn's own backstop fires.
jest.setTimeout(150_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('framework:import CLI — integration', () => {
    let prisma: PrismaClient;
    let tmpDir: string;

    beforeAll(() => {
        prisma = prismaTestClient();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-import-cli-'));
    });

    afterAll(async () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        await prisma.$disconnect();
    });

    it('--help exits 0 with usage text', () => {
        const r = runCli(['--help']);
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/framework:import/);
        expect(r.stdout).toMatch(/--input/);
        expect(r.stdout).toMatch(/Exit codes/);
    });

    it('exits 2 when --input is missing', () => {
        const r = runCli([]);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/--input <path> is required/);
    });

    it('--dry-run on a valid YAML exits 0 + emits a JSON summary, no DB writes', async () => {
        const beforeFw = await prisma.framework.findFirst({
            where: { key: 'ISO27001_DEMO' },
        });
        const baselineCreatedAt = beforeFw?.createdAt;

        const r = runCli(['--input', DEMO_YAML, '--dry-run']);
        expect(r.code).toBe(0);
        const parsed = JSON.parse(r.stdout) as {
            ok: boolean;
            mode: string;
            framework: string;
            requirements: number;
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.mode).toBe('dry-run');
        expect(parsed.framework).toBe('ISO27001_DEMO');
        expect(parsed.requirements).toBe(4);

        // No new framework row was inserted.
        const afterFw = await prisma.framework.findFirst({
            where: { key: 'ISO27001_DEMO' },
        });
        if (beforeFw) {
            expect(afterFw?.createdAt).toEqual(baselineCreatedAt);
        } else {
            expect(afterFw).toBeNull();
        }
    });

    it('apply on a valid YAML exits 0 + writes Framework + Requirements + Pack', async () => {
        const r = runCli(['--input', DEMO_YAML]);
        expect(r.code).toBe(0);
        const parsed = JSON.parse(r.stdout) as {
            ok: boolean;
            mode: string;
            framework: { key: string };
            requirements: { upserted: number };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.mode).toBe('apply');
        expect(parsed.framework.key).toBe('ISO27001_DEMO');
        expect(parsed.requirements.upserted).toBe(4);

        // Idempotency check: re-run, framework not re-created.
        // The control-template half of the catalogue went with the
        // compliance uproot — the applier now reports a constant
        // `templates: { created: 0, existing: 0 }` and seeds the
        // framework, its requirements and the pack only. Idempotency is
        // asserted on the framework + pack instead.
        const r2 = runCli(['--input', DEMO_YAML]);
        expect(r2.code).toBe(0);
        const parsed2 = JSON.parse(r2.stdout) as {
            framework: { created: boolean };
            requirements: { upserted: number };
            pack?: { created: boolean };
        };
        expect(parsed2.framework.created).toBe(false);
        expect(parsed2.requirements.upserted).toBe(4);
        if (parsed2.pack) expect(parsed2.pack.created).toBe(false);
    });

    it('exits 3 (parse error) on malformed YAML', () => {
        const bad = path.join(tmpDir, 'bad.yaml');
        fs.writeFileSync(bad, `framework:\n  key: X\n  unbalanced: [\n`, 'utf8');
        const r = runCli(['--input', bad, '--dry-run']);
        expect(r.code).toBe(3);
        expect(r.stderr).toMatch(/Catalog parse error/);
    });

    it('exits 3 (validation error) on schema-invalid content', () => {
        const bad = path.join(tmpDir, 'invalid.yaml');
        fs.writeFileSync(
            bad,
            `framework:\n  name: Missing key\nrequirements: []\n`,
            'utf8',
        );
        const r = runCli(['--input', bad, '--dry-run']);
        expect(r.code).toBe(3);
        expect(r.stderr).toMatch(/Catalog validation failed/);
        expect(r.stderr).toMatch(/framework\.key/);
    });

    it('exits 3 on cross-validation failure (template references unknown requirement)', () => {
        const bad = path.join(tmpDir, 'crossval.yaml');
        fs.writeFileSync(
            bad,
            `framework: { key: X, name: X }
requirements:
  - { code: A.1, title: T }
templates:
  - code: T1
    title: Template
    category: C
    requirementCodes: [A.999]
`,
            'utf8',
        );
        const r = runCli(['--input', bad, '--dry-run']);
        expect(r.code).toBe(3);
        expect(r.stderr).toMatch(/A\.999/);
    });

    it('rejects unknown flags with exit 2', () => {
        const r = runCli(['--bogus-flag']);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/Unknown flag/);
    });
});
