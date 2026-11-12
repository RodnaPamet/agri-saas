/**
 * One matching sample per secret pattern — #2670 item 4.
 *
 * Under `tests/fixtures/secrets/` because `scripts/detect-secrets.sh`
 * auto-skips this directory, and it refused these inline: every value here
 * matches a live pattern, which is exactly what makes them useful. The
 * alternative — fourteen `pragma: allowlist secret` comments in the test — is
 * the same exemption spelled fourteen times, in the file whose subject is
 * exemptions that nobody rechecks.
 *
 * **Every value is INVENTED.** Each satisfies its pattern's shape and length
 * floor and nothing more; none was ever a credential anywhere. `AKIAIOSFODNN7EXAMPLE`
 * is AWS's own published documentation example.
 *
 * **Each signifier is BROKEN by a `·` and rejoined at runtime, so no literal
 * in this file matches a credential pattern.** That is not decoration and not
 * belt-and-braces about our own scanner: GitHub push protection reads the
 * BYTES of every commit in a push, cannot tell an invented Stripe key from a
 * live one, and blocked this branch on three of these lines. The repository is
 * public, so the offered remedy — "allow the secret" — is a human decision to
 * weaken a security control, never a step in landing a test fixture, and
 * rewriting the one line it flagged today only defers the block: its detector
 * set grows, and the next pattern added here would hit it again. Breaking all
 * of them is the fix that stays fixed.
 *
 * It costs the test nothing, which is the point. `scanEgress` reads the string
 * it is HANDED at runtime, so the gate is exercised by the rejoined value; a
 * byte scanner reads the file. The two look at different things, and only one
 * of them is the subject of this fixture. `prefix-release-is-sound` asserts
 * every sample still matches its own pattern, so a mis-assembled value fails
 * loudly rather than quietly testing a string that triggers nothing.
 *
 * Keyed by pattern NAME so `prefix-release-is-sound` can assert the set is
 * COMPLETE against `SECRET_PATTERNS`. A new pattern without a sample fails
 * there rather than being silently untested — which is the forcing function,
 * because the egress gate's soundness is a property of the pattern set rather
 * than of the gate.
 */

/** Rejoin a signifier broken for the byte scanners. See the docblock. */
const sig = (broken: string): string => broken.replace(/·/g, '');

export const EGRESS_SAMPLES: Record<string, string> = {
    'AWS Access Key ID': sig(' AKIA·IOSFODNN7EXAMPLE '),
    'AWS Secret Access Key (named assignment)': sig(
        'aws_secret_·access_key = "abcdefghijklmnopqrstuvwxyz012345678901"',
    ),
    'GitHub Token': sig(' ghp·_abcdefghijklmnopqrstuvwxyz0123456789 '),
    'Slack Bot/User Token': sig(' xox·b-1234567890-abcdefghij '),
    'Slack Webhook URL': sig(
        'https://hooks.slack·.com/services/T12345678/B12345678/abcdefghijklmnopqrstuvwx',
    ),
    'Anthropic API Key': sig(' sk-·ant-abcdefghijklmnopqrstuvwxyz0123456789012345 '),
    'OpenAI API Key': sig(' sk-·proj-abcdefghijklmnopqrstuvwxyz0123456789012345 '),
    'Google API Key': sig(' AIza·abcdefghijklmnopqrstuvwxyz012345678 '),
    'Stripe Live Secret Key': sig(' sk_·live_abcdefghijklmnopqrstuvwxyz '),
    'Stripe Restricted Key': sig(' rk_·live_abcdefghijklmnopqrstuvwxyz '),
    'JWT (in-source literal)': sig(
        '"eyJ·hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"',
    ),
    'PEM Private Key': sig('-----BEGIN RSA PRIVATE· KEY-----'),
    'NPM Token': sig(' npm·_abcdefghijklmnopqrstuvwxyz0123456789 '),
    'Hardcoded Password Assignment': sig('client_·secret = "abcdefghijklmnopqrstuvwxyz"'),
};

/** The two patterns whose value can sit on the line AFTER their name. */
export const SPLIT_ASSIGNMENT_SAMPLES: readonly string[] = [
    sig('client_·secret =\n"abcdefghijklmnopqrstuvwxyz"'),
    sig('aws_secret_·access_key =\n"abcdefghijklmnopqrstuvwxyz012345678901"'),
];
