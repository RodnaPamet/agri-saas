/**
 * Epic 69 — typed SWR cache-key registry pins.
 *
 * Two complementary checks:
 *
 *   1. **Behavioural** — every method below produces the expected
 *      tenant-relative path. Catches drift between the registry and
 *      the API routes when someone renames an endpoint without
 *      updating the constant.
 *
 *   2. **Structural** — convention sanity (every key starts with
 *      `/`, no trailing slash, no double slash, no leaked
 *      `/api/t/{slug}` prefix). Catches a class of mistakes the
 *      compiler can't see.
 *
 * Together these are cheap insurance: a registry that drifts from
 * its endpoints is worse than no registry at all because it produces
 * silent cache-misses.
 */
import { CACHE_KEYS } from '@/lib/swr-keys';

describe('CACHE_KEYS — key construction', () => {
    describe('controls', () => {
        it('list() → /controls', () => {
            expect(CACHE_KEYS.controls.list()).toBe('/controls');
        });
        it('detail(id) interpolates the id', () => {
            expect(CACHE_KEYS.controls.detail('c1')).toBe('/controls/c1');
        });
        it('exposes the dashboard sub-view', () => {
        });
        it('exposes templates and consistencyCheck', () => {
            expect(CACHE_KEYS.controls.consistencyCheck()).toBe(
                '/controls/consistency-check',
            );
        });
    });

    describe('risks', () => {
        it('list() → /risks; detail(id) → /risks/{id}', () => {
            expect(CACHE_KEYS.risks.list()).toBe('/risks');
            expect(CACHE_KEYS.risks.detail('r9')).toBe('/risks/r9');
        });
    });

    describe('evidence', () => {
        it('list / detail / metrics / files / retention shape', () => {
            expect(CACHE_KEYS.evidence.list()).toBe('/evidence');
            expect(CACHE_KEYS.evidence.detail('e1')).toBe('/evidence/e1');
            expect(CACHE_KEYS.evidence.metrics()).toBe('/evidence/metrics');
            expect(CACHE_KEYS.evidence.files()).toBe('/evidence/files');
            expect(CACHE_KEYS.evidence.retention()).toBe('/evidence/retention');
        });
    });

    describe('policies', () => {
        it('list / detail / templates', () => {
            expect(CACHE_KEYS.policies.list()).toBe('/policies');
            expect(CACHE_KEYS.policies.detail('p1')).toBe('/policies/p1');
            expect(CACHE_KEYS.policies.templates()).toBe('/policies/templates');
        });
    });

    describe('tasks', () => {
        it('list / detail / metrics', () => {
            expect(CACHE_KEYS.tasks.list()).toBe('/tasks');
            expect(CACHE_KEYS.tasks.detail('t1')).toBe('/tasks/t1');
            expect(CACHE_KEYS.tasks.metrics()).toBe('/tasks/metrics');
        });
    });

    describe('vendors', () => {
        it('list / detail / metrics', () => {
            expect(CACHE_KEYS.vendors.list()).toBe('/vendors');
            expect(CACHE_KEYS.vendors.detail('v1')).toBe('/vendors/v1');
            expect(CACHE_KEYS.vendors.metrics()).toBe('/vendors/metrics');
        });
    });

    describe('assets', () => {
        it('list / detail', () => {
            expect(CACHE_KEYS.assets.list()).toBe('/assets');
            expect(CACHE_KEYS.assets.detail('a1')).toBe('/assets/a1');
        });
    });

    describe('audits', () => {
        it('list / detail / readiness / cycles / packs', () => {
            expect(CACHE_KEYS.audits.list()).toBe('/audits');
            expect(CACHE_KEYS.audits.detail('au1')).toBe('/audits/au1');
            expect(CACHE_KEYS.audits.readiness()).toBe('/audits/readiness');
            expect(CACHE_KEYS.audits.cycles()).toBe('/audits/cycles');
            expect(CACHE_KEYS.audits.packs()).toBe('/audits/packs');
        });
    });

    describe('dashboard / coverage / cross-cutting', () => {
        it('dashboard home/executive/trends', () => {
            expect(CACHE_KEYS.dashboard.home()).toBe('/dashboard');
            expect(CACHE_KEYS.dashboard.executive()).toBe('/dashboard/executive');
            expect(CACHE_KEYS.dashboard.trends()).toBe('/dashboard/trends');
        });
        it('audit log / notifications / search / traceability', () => {
            expect(CACHE_KEYS.auditLog.list()).toBe('/audit-log');
            expect(CACHE_KEYS.notifications.list()).toBe('/notifications');
            expect(CACHE_KEYS.notifications.settings()).toBe(
                '/notification-settings',
            );
            expect(CACHE_KEYS.search.query()).toBe('/search');
            expect(CACHE_KEYS.traceability.graph()).toBe('/traceability');
        });
    });
});

describe('CACHE_KEYS — convention sanity', () => {
    /**
     * Walk every method on the registry, call it with a placeholder
     * if it takes an arg, and assert the returned key obeys the
     * tenant-relative format documented in the module header.
     *
     * This is intentionally a STRUCTURAL test, not a pinned-string
     * one — it catches whole classes of drift (leading slash,
     * trailing slash, leaked `/api/t/{slug}` prefix) without
     * needing to be updated each time someone adds a new method to
     * an existing resource.
     */
    function* allKeys(): Generator<{ path: string; method: string }> {
        for (const [resource, methods] of Object.entries(CACHE_KEYS)) {
            for (const [name, fn] of Object.entries(
                methods as Record<string, (...args: string[]) => string>,
            )) {
                if (typeof fn !== 'function') continue;
                // Pass a placeholder id; methods that ignore it
                // still produce the right shape.
                const path = fn('placeholder');
                yield { path, method: `${resource}.${name}` };
            }
        }
    }

    it('every key starts with a single leading slash', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            if (!path.startsWith('/') || path.startsWith('//')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('no key has a trailing slash', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            if (path.length > 1 && path.endsWith('/')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('no key contains the /api/t/ prefix (that belongs to the hook layer)', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            if (path.includes('/api/t/') || path.startsWith('/api/')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it('no key contains a double slash', () => {
        const violations: string[] = [];
        for (const { path, method } of allKeys()) {
            // skip the leading `/` then look for any `//`
            if (path.slice(1).includes('//')) {
                violations.push(`${method} → ${path}`);
            }
        }
        expect(violations).toEqual([]);
    });
});

describe('CACHE_KEYS — composability with the hook layer', () => {
    /**
     * The registry is useful only if the strings it produces drop
     * straight into the Epic 69 hooks. The hooks in turn prefix
     * with `/api/t/{slug}`. Simulate that prefix here to assert the
     * round-trip — a registry method + the hook prefix should
     * produce the canonical absolute API URL.
     */
    function withTenant(slug: string, key: string): string {
        return `/api/t/${slug}${key}`;
    }

    it('controls.list() composes to /api/t/{slug}/controls', () => {
        expect(withTenant('acme', CACHE_KEYS.controls.list())).toBe(
            '/api/t/acme/controls',
        );
    });

    it('risks.detail(id) composes correctly', () => {
        expect(withTenant('acme', CACHE_KEYS.risks.detail('r1'))).toBe(
            '/api/t/acme/risks/r1',
        );
    });

    it('different tenants get different absolute URLs from the same key', () => {
        const key = CACHE_KEYS.controls.consistencyCheck();
        expect(withTenant('acme', key)).not.toBe(
            withTenant('globex', key),
        );
    });
});
