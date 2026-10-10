/**
 * Every service in agrent's VM stack caps its container log (#1507).
 *
 * Docker's default `json-file` driver NEVER rotates. On 2026-10-07 this VM's
 * 79 GB disk reached 100%: playerz-db PANICked on a checkpoint and agrent's
 * Redis failed its background saves with MISCONF until space was freed. Images
 * and build cache were the main cause; container logs are the other unbounded
 * thing on the same disk, and the one nothing was watching.
 *
 * ## Why a guard and not just the fix
 *
 * The fix is seven lines in one file and is already applied. What rots is the
 * NEXT service: adding one to the stack without a `logging:` key reintroduces
 * an unbounded log, silently, and the symptom arrives weeks later as a full
 * disk — which, per this repo's own experience, reads as a performance
 * regression rather than as a disk problem, because a full disk stops Next
 * writing `.next` and pages slow with no error anywhere.
 *
 * So the population is DERIVED from the compose file rather than listed: every
 * service it defines must be capped, and a new one fails this until it is.
 *
 * ## Why per-service and not the daemon
 *
 * `/etc/docker/daemon.json` would cap everything in one line, and it is the
 * wrong place: that file is shared with playerz.bg on the same VM, and changing
 * it needs a Docker daemon restart, which takes BOTH products down. This is
 * asserted below, because "just move it to the daemon config" is the obvious
 * simplification and it is the one that breaks a neighbour.
 *
 * ## What this guard does NOT prove
 *
 * That the running containers are capped. The option is read when a container
 * is CREATED, so an existing one keeps its unbounded log until the next
 * `docker compose up -d --force-recreate`. That is a short restart for db and
 * redis and a 502 window for app, so it is the owner's to schedule. A green
 * test here means the file is right, not that the VM is fixed — the difference
 * this repo has been caught by before (code-complete is not running).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

/**
 * agrent's stack, and ONLY agrent's.
 *
 * This repository also carries `docker-compose.prod.yml` and
 * `deploy/docker-compose.prod.yml`, which describe the inflect product — their
 * images are `ghcr.io/inflect-compliance/...` and their containers are named
 * `inflect-prod-*`. Capping those from here would be editing another product's
 * deployment from this repo's test suite. The discriminator below is the image
 * name, not the filename, because a filename is a convention and an image is a
 * fact.
 */
const COMPOSE_REL = 'deploy/docker-compose.vm.yml';

interface Compose {
    services?: Record<string, { image?: string; logging?: { driver?: string; options?: Record<string, string> } }>;
}

const raw = fs.readFileSync(path.join(ROOT, COMPOSE_REL), 'utf8');
const compose = yaml.load(raw) as Compose;
const services = compose.services ?? {};

describe('agrent container logs are capped (#1507)', () => {
    it('control: this is agrent’s stack, and the parse found services', () => {
        // Without this the per-service assertions below iterate an empty object,
        // which is agreement and worthless. And the image check is what stops
        // this guard silently migrating to another product's compose file if the
        // path is ever reused.
        const names = Object.keys(services);
        expect(names.length).toBeGreaterThanOrEqual(5);
        expect(JSON.stringify(services)).toContain('ghcr.io/rodnapamet/agri-saas');
        expect(JSON.stringify(services)).not.toContain('inflect-compliance');
    });

    it.each(Object.keys(services))('%s caps its log', (name) => {
        const svc = services[name];

        // Named rather than a bare truthy check, so the failure says which
        // service and what is missing instead of "expected true".
        expect({ service: name, hasLogging: svc.logging != null }).toEqual({
            service: name,
            hasLogging: true,
        });
        expect(svc.logging?.driver).toBe('json-file');

        const opts = svc.logging?.options ?? {};
        // Both halves are required and neither implies the other: a max-size
        // with no max-file rotates into unbounded ROTATED files, and a max-file
        // with no max-size never rotates at all because nothing triggers it.
        expect({ service: name, maxSize: opts['max-size'] != null }).toEqual({
            service: name,
            maxSize: true,
        });
        expect({ service: name, maxFile: opts['max-file'] != null }).toEqual({
            service: name,
            maxFile: true,
        });

        // A cap is only a cap if it is finite. Docker treats max-file 1 as "no
        // rotation", so the bound has to be at least 2 files.
        expect(Number(opts['max-file'])).toBeGreaterThanOrEqual(2);
        expect(opts['max-size']).toMatch(/^\d+[kmg]$/i);
    });

    it('the whole stack is bounded, and the bound is stated', () => {
        // The number an operator actually needs: not "is it capped" but "by how
        // much". A cap nobody has multiplied out is how a 100 MB-per-service
        // default gets called a fix on a 79 GB disk shared with another product.
        const bytes = (sz: string): number => {
            const m = /^(\d+)([kmg])$/i.exec(sz);
            if (!m) return Number.NaN;
            const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()]!;
            return Number(m[1]) * mult;
        };
        const total = Object.values(services).reduce((n, s) => {
            const o = s.logging?.options ?? {};
            return n + bytes(o['max-size'] ?? '0m') * Number(o['max-file'] ?? 0);
        }, 0);

        expect(Number.isFinite(total)).toBe(true);
        expect(total).toBeGreaterThan(0);
        // Under 2 GB on a disk that ran out at 79 GB. Deliberately a ceiling
        // and not an equality: adding a service should not fail this, only
        // adding an unreasonable amount of logging should.
        expect(total).toBeLessThan(2 * 1024 ** 3);
        // The bound IS the output. No `eslint-disable` here: `no-console` is not
        // enabled for tests, so the directive would be UNUSED — which is itself a
        // warning, and the lint ceiling counts suppressions deliberately so that
        // muting is never the cheapest fix.
        console.log(
            `[logs] agrent's bound across ${Object.keys(services).length} services: ` +
                `${(total / 1024 ** 2).toFixed(0)} MB`,
        );
    });

    it('the cap lives in the compose file, NOT in the shared daemon config', () => {
        // /etc/docker/daemon.json is shared with playerz.bg on the same VM and
        // changing it needs a daemon restart that takes both products down.
        // This asserts the repo never grows that file, because "move it to the
        // daemon" is the obvious simplification and the one that breaks a
        // neighbour.
        const candidates = ['deploy/daemon.json', 'deploy/docker-daemon.json', 'daemon.json'];
        for (const c of candidates) {
            expect({ file: c, exists: fs.existsSync(path.join(ROOT, c)) }).toEqual({
                file: c,
                exists: false,
            });
        }
        // And the reason is written where the change is, not only here.
        expect(raw).toMatch(/daemon\.json/);
        expect(raw).toMatch(/playerz/i);
    });
});
