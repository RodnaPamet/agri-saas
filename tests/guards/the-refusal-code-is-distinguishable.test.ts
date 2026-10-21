/**
 * The implicit-link refusal must reach the browser as a code that names it.
 *
 * `ImplicitAccountLinkRefused` sets `name` to `NEXT_AUTH_DISPATCH_NAME`, which
 * is deliberately NOT its class name. next-auth picks the redirect by
 * string-comparing `error.name` (`core/routes/callback.js`), so that string is
 * the whole mechanism: with it, the person is sent to
 * `?error=OAuthAccountNotLinked`; without it, to `?error=Callback` — the
 * generic bucket a transient OAuth failure also lands in, which is both
 * useless to a person and unbranchable for a native client deciding whether
 * to retry.
 *
 * A guard that only checked our own constant against our own string would
 * pass forever: it would mirror the runtime BY NAME and go stale the moment
 * next-auth renamed its error. So this reads next-auth's INSTALLED source and
 * asserts our string is the one it actually dispatches on, adjacent to the
 * redirect we want. A dependency bump that renames it fails here instead of
 * silently restoring the generic code.
 *
 * It follows that this guard is allowed to fail on an upgrade. That is the
 * point — the alternative is learning from a person who cannot sign in.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ImplicitAccountLinkRefused,
    NEXT_AUTH_DISPATCH_NAME,
} from '@/lib/auth/refuse-implicit-links';

/**
 * Located by walking up for `node_modules`, not by `require.resolve`: jest's
 * resolver honours next-auth's `exports` map, which publishes neither
 * `package.json` nor `core/routes/callback.js`. Walking also survives
 * hoisting and this repo's git worktrees.
 */
function findCallbackRoute(): string {
    const suffix = path.join('node_modules', 'next-auth', 'core', 'routes', 'callback.js');
    let dir = __dirname;
    for (;;) {
        const candidate = path.join(dir, suffix);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`next-auth callback route not found walking up from ${__dirname}`);
        }
        dir = parent;
    }
}

const CALLBACK_ROUTE = findCallbackRoute();

/** The user-facing code we need next-auth to redirect to. */
const WANTED_CODE = 'OAuthAccountNotLinked';

describe('the implicit-link refusal is distinguishable from a transient failure', () => {
    const source = fs.readFileSync(CALLBACK_ROUTE, 'utf8');

    it('control: next-auth callback route was found and read', () => {
        expect(source.length).toBeGreaterThan(1000);
        // If this stops matching, the dispatch was restructured and every
        // assertion below is answering about the wrong file.
        expect(source).toMatch(/error\.name\s*===/);
    });

    it('control: the generic bucket we are avoiding is really in there', () => {
        // Proves the file contains BOTH outcomes, so a match on the one we
        // want is a choice between them rather than the only thing present.
        expect(source).toContain('error?error=Callback');
    });

    it('next-auth dispatches on exactly the name we set', () => {
        expect(source).toContain(`error.name === "${NEXT_AUTH_DISPATCH_NAME}"`);
    });

    it('that dispatch is the one that redirects to the code we want', () => {
        const at = source.indexOf(`error.name === "${NEXT_AUTH_DISPATCH_NAME}"`);
        expect(at).toBeGreaterThan(-1);
        // The redirect sits inside the matched branch, within a few lines of
        // the comparison. Bounding the window keeps an unrelated later
        // occurrence of the code from satisfying this.
        const branch = source.slice(at, at + 300);
        expect(branch).toContain(`error?error=${WANTED_CODE}`);
    });

    it('the thrown error actually carries that name', () => {
        const thrown = new ImplicitAccountLinkRefused('google');
        expect(thrown.name).toBe(NEXT_AUTH_DISPATCH_NAME);
        // The class identity is what our own code and tests match on, and it
        // must survive the name being spoken for by next-auth.
        expect(thrown).toBeInstanceOf(ImplicitAccountLinkRefused);
        expect(thrown).toBeInstanceOf(Error);
    });

    it('the reason is still recoverable from the message', () => {
        // `name` can no longer carry it, so the message has to.
        expect(new ImplicitAccountLinkRefused('google').message).toMatch(
            /refusing to link an unseen google identity/i,
        );
    });
});
