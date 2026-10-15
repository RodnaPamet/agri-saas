/**
 * Guard: no `logEvent` call interpolates a secret into its audit detail (#1784).
 *
 * ## What this replaces
 *
 * Two tests were NAMED as though they checked this and could not:
 *
 *   • `session-revocation-api.test.ts` — "audit events never contain session
 *     tokens or secrets"
 *   • `mfa-hardening.test.ts` — "audit details never contain secrets"
 *
 * Both tested a string typed into the test file against patterns chosen by the
 * same author:
 *
 *     const details = 'Admin admin-001 revoked sessions for user target-user-456…';
 *     for (const pattern of sensitivePatterns) expect(pattern.test(details)).toBe(false);
 *
 * Neither read anything the system produces, so both passed for ever and would
 * have passed just as happily if every audit writer started interpolating a
 * bearer token tomorrow. `a-control-that-cannot-express-failure` — capable of
 * running, incapable of failing on the thing its name claims. The name is the
 * worse half: a reader searching for coverage of that claim found them,
 * stopped, and was wrong.
 *
 * ## What this checks instead
 *
 * Every `logEvent(` call in `src/`, and every identifier it interpolates —
 * both `${…}` inside a template and `key: value` inside the call object. An
 * identifier whose LAST path segment names a secret fails the guard.
 *
 * The last segment is load-bearing. `entityId: apiKey.id` is the one match a
 * whole-expression rule produced across 220 calls, and an API key's ID is not
 * its secret — a rule that flagged it would have been switched off in a week.
 * `session.token` and `apiKeySecret` still fail, because their last segments
 * are what they are.
 *
 * ## What it cannot do
 *
 * Follow a value. `details: summarise(x)` hides whatever `summarise` puts
 * there, and `JSON.stringify(obj)` hides the whole object. This is a
 * name-level check on the call site, which is where a leak is written by
 * hand; it is not a taint analysis. The honest claim is "nobody interpolated
 * something called a token", and that is the mistake this family actually
 * makes.
 *
 * Driving real writers and scanning the rows they produce is the stronger
 * half of #1784's suggestion and is not here: `audit-middleware.test.ts` has
 * the harness, and the two or three highest-risk writers are worth doing that
 * way. Recorded on the issue rather than claimed.
 */
import { readFileSync } from 'node:fs';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/**
 * A name that should never be interpolated into an audit detail.
 *
 * Two arms on purpose: an exact-match set for words that are only ever a
 * secret (`token`, `apiKey`), and a substring set for words that are a secret
 * wherever they appear (`secret`, `password`). `tokenCount` passes the first
 * arm's exactness; `apiKeySecret` fails the second.
 */
const SECRET_NAME = /^(token|secret|password|bearer|credential|apikey|privatekey|passphrase|plaintext|rawkey)$|(secret|password|bearer|passphrase)/i;

/** The last segment of a property path — `apiKey.id` is judged as `id`. */
function lastSegment(expr: string): string {
    return expr.trim().split(/[.?![\]]/).filter(Boolean).pop() ?? '';
}

/** The balanced `(...)` following `start`. */
function callExtent(code: string, start: number): string {
    const open = code.indexOf('(', start);
    if (open === -1) return '';
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') {
            depth--;
            if (depth === 0) return code.slice(start, i + 1);
        }
    }
    return code.slice(start); // unbalanced — hand back everything
}

interface Finding {
    file: string;
    text: string;
}

function scan(): { calls: number; findings: Finding[]; files: number } {
    const files = collectSourceFiles({
        roots: ['src'],
        extensions: ['.ts', '.tsx'],
        floor: 500,
    });
    let calls = 0;
    const findings: Finding[] = [];
    for (const abs of files) {
        // Comments blanked: a docblock explaining that a token must NOT be
        // logged would otherwise read as a token being logged — the trap
        // #1774 is about, and the reason this guard was born blanking.
        const code = blankNonCode(readFileSync(abs, 'utf8'));
        if (!code.includes('logEvent')) continue;
        const rel = abs.slice(REPO_ROOT.length + 1);
        for (const m of code.matchAll(/logEvent\s*\(/g)) {
            calls++;
            const extent = callExtent(code, m.index);
            for (const i of extent.matchAll(/\$\{([^}]{1,80})\}/g)) {
                if (SECRET_NAME.test(lastSegment(i[1]))) {
                    findings.push({ file: rel, text: `\${${i[1].trim()}}` });
                }
            }
            for (const i of extent.matchAll(/(\w+)\s*:\s*([A-Za-z_$][\w.$]{0,60})/g)) {
                if (SECRET_NAME.test(lastSegment(i[1])) || SECRET_NAME.test(lastSegment(i[2]))) {
                    findings.push({ file: rel, text: `${i[1]}: ${i[2]}` });
                }
            }
        }
    }
    return { calls, findings, files: files.length };
}

describe('audit details carry no secrets (#1784)', () => {
    const { calls, findings, files } = scan();

    it('ranges over the real population — the denominator', () => {
        // This line is INVISIBLE IN CI and #1879 is why: jest's default
        // reporter drops console output entirely once a run has more than
        // one suite (measured — 1 suite prints, 2 suites print nothing,
        // `--verbose` restores it), and CI runs hundreds per shard. So the
        // print below serves someone running this guard by hand, and the
        // floor is what actually holds in CI. Noted rather than worked
        // around: 34 guards print a denominator this way and the fix is one
        // change to the jest invocation, not 34 workarounds.
        console.log(
            `[audit-details] ${files} src files, ${calls} logEvent calls scanned, ${findings.length} finding(s)`,
        );
        // 220 at the time of writing across 69 files. A floor well below it
        // separates "nothing is wrong" from "nothing was examined", which is
        // the failure the tests this replaces actually had.
        expect(calls).toBeGreaterThan(150);
    });

    it('the detector catches a real leak — the control it needs', () => {
        // All three shapes a hand-written leak takes. Without this the scan
        // could match nothing and the assertion below would pass for ever,
        // which is precisely the defect being fixed.
        const leak = `
            await logEvent(db, ctx, { action: 'X', entityType: 'Y', entityId: id,
                details: \`signed in with \${session.token}\`,
                detailsJson: { summary: 'ok', secret: apiKeySecret, password: pw } });
        `;
        const found: string[] = [];
        const extent = callExtent(leak, leak.indexOf('logEvent'));
        for (const i of extent.matchAll(/\$\{([^}]{1,80})\}/g)) {
            if (SECRET_NAME.test(lastSegment(i[1]))) found.push(i[1]);
        }
        for (const i of extent.matchAll(/(\w+)\s*:\s*([A-Za-z_$][\w.$]{0,60})/g)) {
            if (SECRET_NAME.test(lastSegment(i[1])) || SECRET_NAME.test(lastSegment(i[2]))) {
                found.push(`${i[1]}: ${i[2]}`);
            }
        }
        expect(found).toHaveLength(3);

        // And the other direction: an API key's ID is not its secret. This is
        // the one match a whole-expression rule produced over 220 real calls,
        // and flagging it would have got this guard switched off.
        expect(SECRET_NAME.test(lastSegment('apiKey.id'))).toBe(false);
        expect(SECRET_NAME.test(lastSegment('sessionVersion'))).toBe(false);
        expect(SECRET_NAME.test(lastSegment('session.token'))).toBe(true);
    });

    it('no call site interpolates a secret-named value', () => {
        expect(findings.map((f) => `  ${f.file}: ${f.text}`).join('\n')).toBe('');
    });
});
