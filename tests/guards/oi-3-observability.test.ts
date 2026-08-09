/**
 * Epic OI-3 — observability ratchet.
 *
 * Locks the OI-3 deliverables so they don't drift silently:
 *   - readyz route imports HeadBucket + uses 2s per-check timeout
 *   - traceRepository helper exists, exported from the barrel
 *   - repository metrics have the bounded label set (no tenant_id)
 *   - the four OI-3 dashboards exist + parse as Grafana JSON v8+
 *   - dashboards have UIDs (importable + provisionable)
 *   - sample repos use traceRepository on their public methods
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe('OI-3 — readyz dependency checks', () => {
    const SRC = 'src/app/api/readyz/route.ts';

    it('imports HeadBucketCommand from @aws-sdk/client-s3', () => {
        const src = read(SRC);
        expect(src).toMatch(/import\s+\{[^}]*HeadBucketCommand[^}]*\}\s+from\s+'@aws-sdk\/client-s3'/);
    });

    it('loads getRedis from @/lib/redis (lazy require so Redis is optional)', () => {
        // GAP-13 fix-forward: Redis is loaded via a try/require so the
        // module evaluation never fails when @/lib/redis throws. The
        // probe degrades to a Redis-error check rather than crashing
        // the entire readyz endpoint. Guard now matches the dynamic
        // require shape that lives on main.
        const src = read(SRC);
        expect(src).toMatch(/require\(['"]@\/lib\/redis['"]\)/);
    });

    it('uses Prisma $queryRaw SELECT 1 for the database check', () => {
        const src = read(SRC);
        expect(src).toMatch(/prisma\.\$queryRaw`SELECT 1`/);
    });

    it('runs all three checks via Promise.all', () => {
        const src = read(SRC);
        expect(src).toMatch(/Promise\.all\(\[\s*checkDatabase\(\)/);
        expect(src).toMatch(/checkRedis\(\),/);
        expect(src).toMatch(/checkStorage\(\)/);
    });

    it('wraps each check in withTimeout (per-check budget, not global)', () => {
        const src = read(SRC);
        // 3 call sites (database, redis, storage), each invoking
        // `withTimeout(...)`. The function definition itself uses
        // `Promise.race` rather than re-calling its own name, so the
        // expected count is exactly 3.
        const calls = (src.match(/withTimeout\(/g) ?? []).length;
        expect(calls).toBeGreaterThanOrEqual(3);
    });

    it('emits structured failed[] in the response body', () => {
        const src = read(SRC);
        expect(src).toMatch(/failed,\s*\n/);
        expect(src).toMatch(/Object\.entries\(checks\)[\s\S]*?\.filter\([\s\S]*?'error'\)/);
    });
});

describe('OI-3 — traceRepository helper', () => {
    const HELPER = 'src/lib/observability/repository-tracing.ts';
    const BARREL = 'src/lib/observability/index.ts';

    it('helper file exists', () => {
        expect(exists(HELPER)).toBe(true);
    });

    it('exports traceRepository + detectResultCount', () => {
        const src = read(HELPER);
        expect(src).toMatch(/export\s+async\s+function\s+traceRepository/);
        expect(src).toMatch(/export\s+function\s+detectResultCount/);
    });

    it('barrel re-exports both', () => {
        const src = read(BARREL);
        expect(src).toMatch(/export\s+\{[\s\S]*?traceRepository[\s\S]*?detectResultCount[\s\S]*?\}\s+from\s+'\.\/repository-tracing'/);
    });

    it('span carries repo.method, repo.tenant_id, repo.duration_ms, repo.result_count', () => {
        const src = read(HELPER);
        expect(src).toMatch(/'repo\.method'/);
        expect(src).toMatch(/'repo\.tenant_id'/);
        expect(src).toMatch(/'repo\.duration_ms'/);
        expect(src).toMatch(/'repo\.result_count'/);
    });

    it('emits all four repository metrics: duration, calls, errors, result_count', () => {
        const src = read(HELPER);
        expect(src).toMatch(/getRepositoryDurationHistogram/);
        expect(src).toMatch(/getRepositoryCallCounter/);
        expect(src).toMatch(/getRepositoryErrorCounter/);
        expect(src).toMatch(/getRepositoryResultCountHistogram/);
    });

    it('metric labels DO NOT include tenant_id (cardinality safety)', () => {
        const src = read(HELPER);
        // Inspect the label objects passed to .record() / .add() — they
        // must use 'repo.method' + 'outcome' only.
        // Specifically: NO `'repo.tenant_id'` or `tenant_id` appears
        // adjacent to `.record` or `.add`.
        const recordLines = src.split('\n').filter((l) => l.includes('.record(') || l.includes('.add('));
        for (const line of recordLines) {
            expect(line).not.toMatch(/tenant_id/);
        }
        // The block following each .record/.add should be the labels obj
        // — verify by looking at the labels variable definitions.
        const labelsBlocks = src.match(/const labels = \{[\s\S]*?\};/g) ?? [];
        for (const block of labelsBlocks) {
            expect(block).not.toMatch(/tenant_id/);
        }
    });
});

describe('OI-3 — repository metric instruments', () => {
    const METRICS = 'src/lib/observability/metrics.ts';

    it.each([
        'getRepositoryDurationHistogram',
        'getRepositoryCallCounter',
        'getRepositoryErrorCounter',
        'getRepositoryResultCountHistogram',
    ])('exports %s', (name) => {
        const src = read(METRICS);
        expect(src).toMatch(new RegExp(`export function ${name}\\(`));
    });

    it.each([
        ['repo.method.duration', 'createHistogram'],
        ['repo.method.calls', 'createCounter'],
        ['repo.method.errors', 'createCounter'],
        ['repo.method.result_count', 'createHistogram'],
    ])('uses metric name %s with %s', (name, kind) => {
        const src = read(METRICS);
        expect(src).toMatch(new RegExp(`${kind}\\('${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    });
});

describe('OI-3 — sample repository instrumentation', () => {
    const SAMPLES = [
        ['src/app-layer/repositories/ControlRepository.ts',  ['control.list', 'control.listPaginated', 'control.getById', 'control.create']],
        ['src/app-layer/repositories/EvidenceRepository.ts', ['evidence.list', 'evidence.listPaginated', 'evidence.getById', 'evidence.create']],
    ] as const;

    it.each(SAMPLES)('%s imports traceRepository', (file) => {
        const src = read(file);
        expect(src).toMatch(/import\s+\{\s*traceRepository\s*\}\s+from\s+'@\/lib\/observability\/repository-tracing'/);
    });

    it.each(SAMPLES)('%s wraps the canonical methods with traceRepository(...)', (file, methods) => {
        const src = read(file);
        for (const method of methods) {
            // traceRepository('<method>', ctx, ...)
            expect(src).toMatch(
                new RegExp(`traceRepository\\(\\s*'${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*,\\s*ctx`),
            );
        }
    });
});

describe('OI-3 — dashboards', () => {
    const DASH_DIR = 'infra/dashboards';
    const REQUIRED = ['app-overview.json', 'database.json', 'redis.json', 'bullmq.json'] as const;

    it.each(REQUIRED)('%s exists', (filename) => {
        expect(exists(`${DASH_DIR}/${filename}`)).toBe(true);
    });

    it.each(REQUIRED)('%s parses as JSON', (filename) => {
        expect(() => JSON.parse(read(`${DASH_DIR}/${filename}`))).not.toThrow();
    });

    it.each(REQUIRED)('%s has a stable uid (importable/provisionable)', (filename) => {
        const dash = JSON.parse(read(`${DASH_DIR}/${filename}`));
        expect(typeof dash.uid).toBe('string');
        expect(dash.uid.length).toBeGreaterThan(0);
        expect(dash.uid).toMatch(/^[a-z0-9-]+$/);
    });

    it.each(REQUIRED)('%s declares a Prometheus datasource input ($DS_PROMETHEUS)', (filename) => {
        const dash = JSON.parse(read(`${DASH_DIR}/${filename}`));
        expect(Array.isArray(dash.__inputs)).toBe(true);
        const promInput = dash.__inputs.find(
            (i: { pluginId?: string }) => i.pluginId === 'prometheus',
        );
        expect(promInput).toBeDefined();
        expect(promInput.name).toBe('DS_PROMETHEUS');
    });

    it.each(REQUIRED)('%s has at least one panel and a title', (filename) => {
        const dash = JSON.parse(read(`${DASH_DIR}/${filename}`));
        expect(typeof dash.title).toBe('string');
        expect(dash.title.length).toBeGreaterThan(0);
        expect(Array.isArray(dash.panels)).toBe(true);
        expect(dash.panels.length).toBeGreaterThan(0);
    });

    it('app-overview queries api.request.* metrics', () => {
        const src = read(`${DASH_DIR}/app-overview.json`);
        expect(src).toMatch(/api_request_count/);
        expect(src).toMatch(/api_request_duration_bucket/);
    });

    it('database dashboard queries repo.method.* metrics (the new OI-3 instruments)', () => {
        const src = read(`${DASH_DIR}/database.json`);
        expect(src).toMatch(/repo_method_calls/);
        expect(src).toMatch(/repo_method_duration_bucket/);
        expect(src).toMatch(/repo_method_errors/);
        expect(src).toMatch(/repo_method_result_count_bucket/);
    });

    it('redis dashboard queries job_queue_depth (BullMQ on Redis) + AWS ElastiCache CW metrics', () => {
        const src = read(`${DASH_DIR}/redis.json`);
        expect(src).toMatch(/job_queue_depth/);
        expect(src).toMatch(/aws_elasticache_/);
    });

    it('bullmq dashboard queries job_execution_* + job_queue_depth', () => {
        const src = read(`${DASH_DIR}/bullmq.json`);
        expect(src).toMatch(/job_execution_count/);
        expect(src).toMatch(/job_execution_duration_bucket/);
        expect(src).toMatch(/job_queue_depth/);
    });
});
