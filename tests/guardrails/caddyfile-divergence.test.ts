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
 * ── SECOND WITHDRAWN CLAIM, 2026-09-10 ──
 *
 * The first revision of this file also said the live value "was NOT
 * verifiable from where the fix was written". It was verifiable:
 * `gcloud compute ssh agrent --zone europe-west1-b` works with the
 * configured account, and the comparison has now been made. Every
 * directive in `/opt/agrent/Caddyfile` matches the repo copy except
 * one — the ACME contact defaults, on the VM, to the operator's
 * PERSONAL mailbox.
 *
 * The repo keeps the ROLE address `admin@agrent.bg` anyway, and that
 * is a decision, not an oversight: **this repository is public**, the
 * personal address appears in no tracked file, and pasting it in to
 * make a comment "accurate" would publish an individual's email to
 * settle a cosmetic mismatch in a field that only routes Let's Encrypt
 * expiry notices. The reconciliation belongs on the VM.
 *
 * So this file checks four properties:
 *
 *   1. The current fact — the `caddy` service supplies no environment.
 *      Adding `env_file` or `environment` to it turns this RED, which
 *      is the point: the header below would then be out of date.
 *   2. The header names every `{$VAR}` placeholder it cannot satisfy,
 *      and does not re-assert either withdrawn claim.
 *   3. The header records the comparison and the direction of the fix
 *      (change the VM), rather than claiming the VM was unreachable.
 *   4. **Every address in `deploy/Caddyfile` is on the agrent.bg role
 *      domain.** This is the one that guards the person rather than
 *      the document: the tempting "fix" for the divergence is to copy
 *      the live value in, and that edit turns this RED.
 *
 * Mutation-proved (#842 review): adding `env_file:` to the caddy service
 * fails 1; deleting the ACME_EMAIL paragraph from the Caddyfile header
 * fails 2; restoring the withdrawn "sets ACME_EMAIL in the environment"
 * sentence fails 2.
 * Mutation-proved (third pass): restoring the "not reachable" wording
 * fails 3; replacing the role address with an off-domain one fails 4.
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

/**
 * The header with quoted material removed.
 *
 * A withdrawn claim survives in the header only inside quotation marks,
 * and quoting a sentence in order to withdraw it is the opposite of
 * asserting it. The negatives below therefore run against the UNQUOTED
 * text: they must fail on `the VM was not reachable` and pass on
 * `an earlier revision said "it was not reachable"; that is withdrawn`.
 */
const unquoted = (h: string) => h.replace(/"[^"]*"/g, ' ');

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
        // The needle has to be CODE-ONLY, and `35-187-80-26.sslip.io` stopped
        // being that in #2129: the header now lists the live file's five site
        // blocks by name, because "this file is one block of five" cannot be
        // said without naming them. A bare hostname therefore appears in the
        // prose on purpose.
        //
        // The site-block OPENING is code-only — a comment never ends in `{`
        // — so that is what the extractor is checked against.
        expect(h).not.toContain('app.agrent.bg {');
    });

    it('unquoted() removes quoted material and nothing else', () => {
        expect(unquoted('a "b" c')).not.toContain('b');
        expect(unquoted('a "b" c')).toContain('a');
        expect(unquoted('a "b" c')).toContain('c');
        // Multi-line, because the withdrawn claims in the header wrap.
        expect(unquoted('x "one\n# two" y')).not.toContain('two');
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

    it('the header records the live comparison instead of claiming the VM was out of reach', () => {
        const h = header(read(CADDYFILE));
        // The VM IS reachable — `gcloud compute ssh agrent --zone
        // europe-west1-b` — and the comparison has been made. The first
        // revision of this header asserted the opposite and used it as
        // the reason to assert nothing.
        expect(h).toMatch(/\/opt\/agrent\/Caddyfile/);
        expect(h).toMatch(/2026-09-10/);
        expect(h).toMatch(/compared/i);
        expect(unquoted(h)).not.toMatch(/not (?:reachable|verifiable)|unreachable/i);
        // Control: the withdrawal itself must still be on the page —
        // stripping quotes must not be a way to delete the correction.
        expect(h).toMatch(/not reachable/i);
        // The divergence is named, and so is the direction of its fix.
        expect(h).toMatch(/ACME_EMAIL/);
        expect(h).toMatch(/CHANGING THE VM|change the VM|VM-side/i);
        // And the missing drift check stays a findable piece of work
        // rather than a memory, since nothing detects the next one.
        expect(h).toMatch(/check-drift\.sh/);
        expect(h).toMatch(/apply\.sh/);
    });
});

describe('deploy/Caddyfile — the header says it is a FRAGMENT (#2129)', () => {
    // The previous header's central factual claim was that the two files
    // "differ in exactly ONE token: the ACME contact". Measured 2026-10-22,
    // that was false: the live file carries four more site blocks and two
    // Centrifugo websocket routes, because the VM serves a second product.
    //
    // That claim is what made `scp deploy/Caddyfile` look safe, and doing it
    // would take playerz.bg, app.playerz.bg and staging.playerz.bg offline.
    // Nothing in this repo detects Caddy drift — `apply.sh` copies only the
    // compose file — so the header is the only thing standing between a
    // reader and that action, and these cases are what keep it standing.

    it('states that this file is a subset of the live one', () => {
        const h = header(read(CADDYFILE));
        expect(h).toMatch(/FRAGMENT|subset/i);
        // Named, not gestured at: a reader has to be able to tell WHICH
        // blocks are missing without logging into the VM.
        expect(h).toMatch(/playerz/i);
    });

    it('warns that copying it over would take live sites down', () => {
        const h = header(read(CADDYFILE));
        expect(h).toMatch(/takes three live sites offline|offline/i);
        // The websocket routes are the part that is easy to miss, because
        // they are inside the playerz blocks rather than beside them.
        expect(h).toMatch(/websocket/i);
    });

    it('does NOT re-assert the withdrawn one-token claim', () => {
        // Same shape as the ACME_EMAIL withdrawal above: the correction has
        // to survive the next edit, and the way it dies is somebody restoring
        // the tidier sentence.
        const h = unquoted(header(read(CADDYFILE)));
        expect(h).not.toMatch(/differ in exactly one token/i);
    });

    it('this file still holds exactly ONE site block, as the header claims', () => {
        // If a second block is ever added here, "one block of five" becomes
        // wrong and the count in the header has to move with it. Asserted on
        // the CODE, not the prose: a site block opens at column 0 and ends
        // the line with `{`.
        const code = read(CADDYFILE)
            .split('\n')
            .filter((l) => !l.trimStart().startsWith('#'));
        // First character must NOT be whitespace: a site block opens at
        // column 0, while `    header {` is a nested directive. The first
        // version of this pattern had `\s` inside the leading class and
        // counted that nested block as a second site.
        const blocks = code.filter((l) => /^[a-z0-9*][a-z0-9*.,\s-]*\{\s*$/.test(l));
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toContain('app.agrent.bg');
    });

    it('CONTROL: the block detector does not count the global block or prose', () => {
        // The global `{` block opens with a bare brace and must not be
        // counted, and a comment that happens to end in `{` must not either —
        // which is how the previous needle in this file went wrong.
        const detect = (lines: string[]) =>
            lines
                .filter((l) => !l.trimStart().startsWith('#'))
                .filter((l) => /^[a-z0-9*][a-z0-9*.,\s-]*\{\s*$/.test(l));
        expect(detect(['{'])).toHaveLength(0);
        expect(detect(['# app.agrent.bg {'])).toHaveLength(0);
        expect(detect(['    reverse_proxy app:3000'])).toHaveLength(0);
        // The case the first version of this detector got WRONG: a nested
        // directive block, indented. `header {`, `handle {`, `route {` and
        // `tls {` all take this shape, so counting them would make any real
        // site block look like several.
        expect(detect(['    header {'])).toHaveLength(0);
        expect(detect(['    handle /connection/websocket {'])).toHaveLength(0);
        expect(detect(['example.com, www.example.com {'])).toHaveLength(1);
    });
});

describe('deploy/Caddyfile — a PUBLIC repo records a ROLE address, never a personal one', () => {
    // Derived, not listed: any address added to this file tomorrow is
    // covered tomorrow.
    const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const addresses = (src: string) => src.match(EMAIL_RE) ?? [];

    it('finds at least one address — an extraction that matches nothing certifies nothing', () => {
        // Positive control for the two assertions below, both of which a
        // broken regex would satisfy in silence.
        const found = addresses(read(CADDYFILE));
        expect(found.length).toBeGreaterThan(0);
        expect(found).toContain('admin@agrent.bg');
    });

    it('every address in the file is on the agrent.bg role domain', () => {
        // The live VM defaults the ACME contact to the operator's
        // personal mailbox. The honest reconciliation is to change the
        // VM; the dishonest one is to paste that address in here so the
        // repo copy reads as "accurate" — publishing an individual's
        // email address, in a public repository, to settle a comment.
        // This is the assertion that makes that edit fail.
        const offenders = addresses(read(CADDYFILE)).filter(
            (addr) => !addr.toLowerCase().endsWith('@agrent.bg'),
        );
        expect(offenders).toEqual([]);
    });

    it('the ACME contact default is that role address', () => {
        expect(read(CADDYFILE)).toMatch(
            /email \{\$ACME_EMAIL:admin@agrent\.bg\}/,
        );
    });
});
