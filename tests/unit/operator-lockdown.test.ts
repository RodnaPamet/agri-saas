/**
 * MECHANISATOR operator lockdown — `isOperatorAllowedPath`.
 *
 * The pure allowlist the middleware wires to a redirect (pages) / 403 (APIs).
 * A machine-operator persona may reach ONLY their "My work" screen + the
 * field-operation completion flow, and only the task/field-op data APIs.
 */
import { isOperatorAllowedPath } from '@/lib/auth/guard';

const slug = 'acme';

describe('isOperatorAllowedPath — allowed surfaces', () => {
    it('allows the My work screen, field-operation completion, and the fields/locations pages', () => {
        expect(isOperatorAllowedPath('/t/acme/my-work', slug)).toBe(true);
        expect(isOperatorAllowedPath('/t/acme/field/task-1', slug)).toBe(true);
        expect(isOperatorAllowedPath('/t/acme/field/task-1/anything', slug)).toBe(true);
        expect(isOperatorAllowedPath('/t/acme/locations', slug)).toBe(true);
        expect(isOperatorAllowedPath('/t/acme/locations/loc-1', slug)).toBe(true);
    });

    it('allows the queue, field-op, task-status, locations, and agro-tile APIs', () => {
        expect(isOperatorAllowedPath('/api/t/acme/farm-tasks', slug)).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/farm-tasks?open=1', slug)).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/field-operations/t1', slug)).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/field-operations/t1/parcels/l1', slug)).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/tasks/t1/status', slug)).toBe(true);
        // The fields map: list, detail, parcels, basemap tiles, index overlays.
        expect(isOperatorAllowedPath('/api/t/acme/locations', slug)).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/locations/loc-1/parcels', slug)).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/locations/loc-1/basemap/1/2/3', slug)).toBe(true);
        expect(isOperatorAllowedPath('/api/t/acme/agro/ndvi-tiles', slug)).toBe(true);
    });
});

describe('isOperatorAllowedPath — blocked surfaces', () => {
    it('blocks every other tenant page (redirected to My work)', () => {
        for (const p of [
            '/t/acme/dashboard',
            '/t/acme/risks',
            '/t/acme/journal',
            '/t/acme/farm-tasks',
            '/t/acme/admin/members',
            '/t/acme/exchange',
        ]) {
            expect(isOperatorAllowedPath(p, slug)).toBe(false);
        }
    });

    it('blocks every other tenant API (403)', () => {
        for (const p of [
            '/api/t/acme/risks',
            '/api/t/acme/practices',
            '/api/t/acme/evidence',
            '/api/t/acme/admin/members',
            '/api/t/acme/dashboard/ag',
        ]) {
            expect(isOperatorAllowedPath(p, slug)).toBe(false);
        }
    });

    it('is not fooled by prefix spoofing', () => {
        // A path that merely STARTS with an allowed segment must not slip
        // through — the boundary is a `/`, end, or `?`.
        expect(isOperatorAllowedPath('/api/t/acme/farm-tasks-evil', slug)).toBe(false);
        expect(isOperatorAllowedPath('/api/t/acme/tasksomething', slug)).toBe(false);
        expect(isOperatorAllowedPath('/api/t/acme/locations-secret', slug)).toBe(false);
        expect(isOperatorAllowedPath('/t/acme/my-workshop', slug)).toBe(false);
        expect(isOperatorAllowedPath('/t/acme/fieldwork', slug)).toBe(false);
        expect(isOperatorAllowedPath('/t/acme/locationsX', slug)).toBe(false);
    });
});
