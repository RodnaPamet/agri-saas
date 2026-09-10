import * as fs from 'fs';
import * as path from 'path';

/**
 * `deploy/Caddyfile` is a repo file that is NOT deployed and NOT
 * drift-checked, and #842's review found its header explaining that
 * divergence with a claim that was false.
 *
 * The header said the VM "sets ACME_EMAIL in the environment, overriding
 * the default below", in a commit titled "Reconciled from the VM". But
 * the `caddy` service in `deploy/docker-compose.vm.yml` declares neither
 * `env_file` nor `environment` — unlike `app` and `worker`, which both
 * carry `env_file` — so nothing in this repo can put ACME_EMAIL into
 * that container. The excuse for the divergence was itself a divergence.
 *
 * The live value on the VM was NOT verifiable from where the fix was
 * written and is deliberately not asserted anywhere: this file checks
 * only what the repo can prove about itself. Two properties:
 *
 *   1. The current fact — the `caddy` service supplies no environment.
 *      Adding `env_file` or `environment` to it turns this RED, which
 *      is the point: the header below would then be out of date.
 *   2. The header names every `{$VAR}` placeholder it cannot satisfy,
 *      and does not re-assert the withdrawn claim.
 *
 * Mutation-proved (#842 review): adding `env_file:` to the caddy service
 * fails 1; deleting the ACME_EMAIL paragraph from the Caddyfile header
 * fails 2; restoring the withdrawn "sets ACME_EMAIL in the environment"
 * sentence fails 2.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const CADDYFILE = 'deploy/Caddyfile';
const COMPOSE = 'deploy/docker-compose.vm.yml';

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** A compose service's body, bounded at the next 2-space top-level key. */
function serviceBlock(compose: string, name: string): string {
    const start = compose.indexOf(`\n  ${name}:\n`);
    if (start === -1) return '';
    const rest = compose.slice(start + `\n  ${name}:\n`.length);
    const next = rest.search(/\n(?:  [A-Za-z_][A-Za-z0-9_-]*:|[A-Za-z_][A-Za-z0-9_-]*:)/);
    return next === -1 ? rest : rest.slice(0, next);
}

/** The leading `#` comment block of the Caddyfile. */
function header(caddyfile: string): string {
    const lines = caddyfile.split('\n');
    const end = lines.findIndex((l) => l.trim() !== '' && !l.startsWith('#'));
    return lines.slice(0, end === -1 ? lines.length : end).join('\n');
}

/** Every `{$NAME}` / `{$NAME:default}` placeholder, derived not listed. */
function placeholders(caddyfile: string): string[] {
    return [
        ...new Set(
            Array.from(
                caddyfile.matchAll(/\{\$([A-Z_][A-Z0-9_]*)(?::[^}]*)?\}/g),
                (m) => m[1],
            ),
        ),
    ];
}

describe('the section/service extractors this file depends on', () => {
    // An empty selection is a pass in every matcher that takes one, so
    // the extractors are proved before anything is asserted with them.
    it('serviceBlock finds the caddy service and stops at the next service', () => {
        const block = serviceBlock(read(COMPOSE), 'caddy');
        expect(block).not.toBe('');
        expect(block).toContain('image: caddy:2-alpine');
        expect(block).not.toContain('image: postgres');
        expect(block).not.toContain('watchtower');
    });

    it('header stops at the first non-comment line', () => {
        const h = header(read(CADDYFILE));
        expect(h.length).toBeGreaterThan(500);
        expect(h).not.toContain('reverse_proxy');
        expect(h).not.toContain('35-187-80-26.sslip.io');
    });

    it('placeholders extracts a non-empty set', () => {
        const found = placeholders(read(CADDYFILE));
        expect(found.length).toBeGreaterThan(0);
        expect(found).toContain('ACME_EMAIL');
    });
});

describe('deploy/Caddyfile — the divergence is stated, not excused', () => {
    it('the caddy service supplies NO environment, so every {$VAR} takes its default', () => {
        const block = serviceBlock(read(COMPOSE), 'caddy');
        expect(block).not.toBe('');
        // Control: the sibling services DO declare env_file, so a regex
        // that matched nothing anywhere would be caught here.
        expect(serviceBlock(read(COMPOSE), 'app')).toMatch(/^\s{4}env_file:/m);
        expect(serviceBlock(read(COMPOSE), 'worker')).toMatch(/^\s{4}env_file:/m);
        // The fact the header rests on.
        expect(block).not.toMatch(/^\s{4}env_file:/m);
        expect(block).not.toMatch(/^\s{4}environment:/m);
    });

    it('the header names every placeholder the repo cannot satisfy', () => {
        const h = header(read(CADDYFILE));
        const names = placeholders(read(CADDYFILE));
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(h).toContain(name);
        }
        // ...and says WHY, in the terms a reader can check for themselves.
        expect(h).toMatch(/env_file/);
        expect(h).toMatch(/environment/);
    });

    it('the header does not re-assert the withdrawn claim that the VM supplies ACME_EMAIL', () => {
        const h = header(read(CADDYFILE));
        // The exact sentence #842's review found false. It survives in
        // the header only inside a quoted, explicitly withdrawn form —
        // so the test looks for it as an unqualified assertion.
        const claim = /(?<!")it also sets ACME_EMAIL in the environment/i;
        expect(h).not.toMatch(claim);
        expect(h).toMatch(/withdrawn|not true|was false/i);
    });

    it('the header states what could NOT be verified rather than guessing a live value', () => {
        const h = header(read(CADDYFILE));
        expect(h).toMatch(/NOT VERIFIED|not verified|unverified|UNCONFIRMED/);
        expect(h).toMatch(/\/opt\/agrent\/Caddyfile/);
        // And flags the missing drift check by name, so closing it is a
        // findable piece of work rather than a memory.
        expect(h).toMatch(/check-drift\.sh/);
    });
});
