/**
 * Structural ratchet — Redis BullMQ-safe eviction policy.
 *
 * REGRESSION CLASS
 * ----------------
 * Every Docker Compose `redis` service originally ran with
 *
 *     redis-server … --maxmemory <N> --maxmemory-policy allkeys-lru
 *
 * `allkeys-lru` EVICTS keys under memory pressure. BullMQ stores job
 * records in Redis — under an eviction policy those records can be
 * silently dropped, losing queued work. The only BullMQ-safe policy
 * is `noeviction` (Redis rejects writes with an OOM error instead,
 * which surfaces loudly rather than corrupting the queue).
 *
 * The ElastiCache path was already correct — the terraform parameter
 * group pins `maxmemory-policy = noeviction` (guarded by
 * the AWS stack, removed in #808). The Compose path was not: an
 * operator running the production-like Compose stack on bare metal
 * silently ran an unsafe queue.
 *
 * The fix set `--maxmemory-policy noeviction` on every Compose redis
 * service. This guardrail fails CI if a "tune the compose files" PR
 * reverts any of them to an eviction policy.
 *
 * EXEMPTION
 * ---------
 * `docker-compose.test.yml` sets NO `maxmemory` / `maxmemory-policy`
 * at all — the test Redis is ephemeral, uncapped, and inherits
 * Redis's own default (`noeviction`). It is asserted below to carry
 * no eviction policy, which holds vacuously.
 *
 * The runtime side (`verifyRedisEvictionPolicy` in `src/lib/redis.ts`,
 * wired from `src/instrumentation.ts`) is covered by
 * `tests/unit/redis-eviction-policy.test.ts`; its wiring is asserted
 * at the end of this file.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** Redis `maxmemory-policy` values that evict keys — all BullMQ-unsafe. */
const EVICTION_POLICIES = [
    'allkeys-lru',
    'allkeys-lfu',
    'allkeys-random',
    'volatile-lru',
    'volatile-lfu',
    'volatile-random',
    'volatile-ttl',
];

/**
 * Extract a top-level compose service block — the `  <service>:` line
 * up to the next sibling service / top-level key.
 */
function extractServiceBlock(src: string, service: string): string {
    const lines = src.split('\n');
    const start = lines.findIndex((l) =>
        new RegExp(`^ {2}${service}:\\s*$`).test(l),
    );
    if (start === -1) return '';
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join('\n');
}

/**
 * The `redis-server …` command line from a service block — scanned
 * in isolation so an explanatory COMMENT that names a policy (e.g.
 * "NOT allkeys-lru") never trips the eviction-token check.
 */
function redisCommandLine(block: string): string {
    return block.split('\n').find((l) => l.includes('redis-server')) ?? '';
}

/** Every Compose file whose `redis` service runs BullMQ-bearing Redis. */
const COMPOSE_WITH_REDIS = [
    'docker-compose.yml', // local dev — also runs the app + BullMQ
    'docker-compose.prod.yml',
    'docker-compose.staging.yml',
    'deploy/docker-compose.prod.yml',
];

describe('Redis eviction-policy ratchet — Compose redis is BullMQ-safe', () => {
    it.each(COMPOSE_WITH_REDIS)(
        '%s — redis runs --maxmemory-policy noeviction',
        (file) => {
            const block = extractServiceBlock(read(file), 'redis');
            expect(block).not.toBe('');
            expect(redisCommandLine(block)).toMatch(/--maxmemory-policy\s+noeviction/);
        },
    );

    it.each(COMPOSE_WITH_REDIS)(
        '%s — redis does NOT use any key-evicting policy',
        (file) => {
            const cmd = redisCommandLine(extractServiceBlock(read(file), 'redis'));
            for (const policy of EVICTION_POLICIES) {
                expect(cmd).not.toContain(policy);
            }
        },
    );

    it('docker-compose.test.yml — test redis carries no eviction policy (exempt, vacuous)', () => {
        const block = extractServiceBlock(read('docker-compose.test.yml'), 'redis-test');
        expect(block).not.toBe('');
        const cmd = redisCommandLine(block);
        for (const policy of EVICTION_POLICIES) {
            expect(cmd).not.toContain(policy);
        }
    });
});

describe('Redis eviction-policy ratchet — runtime check is wired', () => {
    it('src/lib/redis.ts exports verifyRedisEvictionPolicy', () => {
        expect(read('src/lib/redis.ts')).toMatch(
            /export async function verifyRedisEvictionPolicy/,
        );
    });

    it('src/instrumentation.ts calls verifyRedisEvictionPolicy at startup', () => {
        expect(read('src/instrumentation.ts')).toMatch(/verifyRedisEvictionPolicy\(/);
    });
});
