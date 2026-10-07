'use client';

/**
 * The six-step farm registration wizard (P3.8).
 *
 * ── the steps, and which endpoint each one is ──
 *
 *   1 account   POST /api/auth/register/start    creates an UNVERIFIED user
 *   2 code      POST /api/auth/register/verify   proves the address, then signs in
 *   3 type      —                                «Стопанство с ЕИК» or физическо лице
 *   4 eik       POST /api/public/eik-check       live check, prefills the name
 *   5 name      POST /api/me/farms               creates the farm
 *   6 done      —                                «Стопанството Ви е онлайн»
 *
 * Step 4 is skipped entirely on the физическо лице path, so that branch is
 * five steps. The counter shows the steps THIS person will walk rather than a
 * fixed six, because "step 5 of 6" followed by the end is worse than honest
 * arithmetic.
 *
 * ── three things the API contracts force, which are easy to get wrong ──
 *
 * **The ЕИК check is a POST, not a GET.** Every value typed here may be an
 * ЕГН — that is why `looksLikeEgn` exists — and a query string is logged by
 * iOS CFNetwork, browser history and `Referer`. P3.10 added the POST form for
 * exactly this caller. A GET would put a personal identity number in the URL
 * bar of the farmer typing it.
 *
 * **`identityVerification` is `pending_review` whenever an ЕИК was supplied —
 * unconditionally.** It is not the claim's real status: a collision with
 * another farm's verified claim is invisible at creation, because the partial
 * unique index only covers VERIFIED rows, so a colliding claim lands PENDING
 * like any other. So step 6 must never say or imply the ЕИК was ACCEPTED. It
 * says it was submitted, which is the whole of what is known.
 *
 * **The slug comes from the response.** It carries a uniqueness suffix and is
 * not the name transliterated verbatim, so deriving it client-side would
 * produce a URL that 404s.
 *
 * ── and one the wizard adds ──
 *
 * A valid-looking ЕГН stops the step dead rather than warning and allowing.
 * The person has typed a personal identity number into a company-number box;
 * letting them continue would file it as the farm's ЕИК, where it would reach
 * the ДНЕВНИК PDF and the БАБХ register export.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { signIn } from 'next-auth/react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { TurnstileWidget } from '@/components/auth/TurnstileWidget';

type Step = 'account' | 'code' | 'type' | 'eik' | 'name' | 'done';
type FarmKind = 'company' | 'individual';

/** What `POST /api/public/eik-check` says about what has been typed so far. */
type EikVerdict =
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'valid'; registryName: string | null }
    | { state: 'invalid' }
    | { state: 'egn' };

/** `identityVerification` from `POST /api/me/farms`. */
type IdentityResult = 'pending_review' | 'not_requested' | 'deferred';

export interface FarmWizardProps {
    /** A signed-in visitor is adding a farm; registration is behind them. */
    startAtFarmType: boolean;
}

export function FarmWizard({ startAtFarmType }: FarmWizardProps) {
    const t = useTranslations('farmWizard');
    const locale = useLocale();
    const router = useRouter();

    const [step, setStep] = useState<Step>(startAtFarmType ? 'type' : 'account');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Step 1
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [turnstileSitekey, setTurnstileSitekey] = useState<string | null>(null);
    const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
    const [turnstileReset, setTurnstileReset] = useState(0);

    // Step 2
    const [code, setCode] = useState('');

    // Steps 3–5
    const [kind, setKind] = useState<FarmKind | null>(null);
    const [eik, setEik] = useState('');
    const [verdict, setVerdict] = useState<EikVerdict>({ state: 'idle' });
    const [farmName, setFarmName] = useState('');

    // Step 6
    const [identity, setIdentity] = useState<IdentityResult>('not_requested');
    const [farmSlug, setFarmSlug] = useState('');

    /**
     * The steps THIS person walks. The физическо лице path has no ЕИК step,
     * so a fixed "of 6" would promise one that never arrives.
     */
    const walk: Step[] = startAtFarmType
        ? kind === 'individual'
            ? ['type', 'name', 'done']
            : ['type', 'eik', 'name', 'done']
        : kind === 'individual'
          ? ['account', 'code', 'type', 'name', 'done']
          : ['account', 'code', 'type', 'eik', 'name', 'done'];
    const position = walk.indexOf(step) + 1;

    // The sitekey, so the widget renders only where screening is configured.
    useEffect(() => {
        let cancelled = false;
        fetch('/api/auth/ui-config')
            .then((r) => (r.ok ? r.json() : null))
            .then((cfg) => {
                if (!cancelled && typeof cfg?.turnstileSitekey === 'string') {
                    setTurnstileSitekey(cfg.turnstileSitekey);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * The live ЕИК check, debounced.
     *
     * 400ms rather than per-keystroke: the endpoint is rate-limited and
     * unauthenticated, and a check on every digit of a 13-digit number would
     * spend thirteen requests to answer one question.
     */
    const checkSeq = useRef(0);
    useEffect(() => {
        const trimmed = eik.trim();
        if (step !== 'eik' || trimmed.length < 9) {
            setVerdict({ state: 'idle' });
            return;
        }
        const seq = ++checkSeq.current;
        setVerdict({ state: 'checking' });
        const timer = setTimeout(async () => {
            try {
                const res = await fetch('/api/public/eik-check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ eik: trimmed }),
                });
                const data = await res.json().catch(() => null);
                // A stale response must not overwrite a newer verdict: the
                // person keeps typing while a request is in flight.
                if (seq !== checkSeq.current) return;
                if (!res.ok || !data) {
                    setVerdict({ state: 'invalid' });
                    return;
                }
                if (data.looksLikeEgn) setVerdict({ state: 'egn' });
                else if (data.valid) {
                    setVerdict({ state: 'valid', registryName: data.registryName ?? null });
                    // Prefill, but never overwrite a name the person has
                    // already edited — the register's spelling is a
                    // suggestion, not a correction.
                    //
                    // The FUNCTIONAL form, not a read of `farmName`: it sees
                    // the value at apply time rather than the one captured
                    // when this effect ran, so a name typed while the check
                    // was in flight is not clobbered by the response. It
                    // also keeps `farmName` out of the dependency list
                    // honestly, instead of suppressing the lint rule that
                    // would have demanded it.
                    const suggested = data.registryName;
                    if (suggested) setFarmName((prev) => (prev ? prev : suggested));
                } else setVerdict({ state: 'invalid' });
            } catch {
                if (seq === checkSeq.current) setVerdict({ state: 'invalid' });
            }
        }, 400);
        return () => clearTimeout(timer);
    }, [eik, step]);

    const fail = useCallback(
        (msg: string) => {
            setError(msg);
            setBusy(false);
            if (turnstileSitekey) {
                // A Turnstile token is single-use, so a retry needs a fresh
                // challenge whatever the failure was.
                setTurnstileToken(null);
                setTurnstileReset((n) => n + 1);
            }
        },
        [turnstileSitekey],
    );

    async function submitAccount() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/register/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    password,
                    name,
                    ...(turnstileToken ? { turnstileToken } : {}),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                // The server answers an identical 200 for a new, a mid-signup
                // and an existing address — so a non-200 here is about the
                // REQUEST (a weak password, a breached one, a refused
                // challenge), never about whether the address is taken.
                fail(data?.error ? t('failed') : t('failed'));
                return;
            }
            setStep('code');
        } catch {
            fail(t('failed'));
        } finally {
            setBusy(false);
        }
    }

    async function submitCode() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/register/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, code: code.trim() }),
            });
            if (!res.ok) {
                // Wrong, expired and too-many-attempts are one answer by
                // design — the next action is the same for all three.
                fail(t('codeWrong'));
                return;
            }
            // Sign in with what they just proved. The address is verified at
            // this point, which is strictly more than a login establishes.
            const signin = await signIn('credentials', {
                email,
                password,
                redirect: false,
            });
            if (signin?.error) {
                fail(t('failed'));
                return;
            }
            setStep('type');
        } catch {
            fail(t('failed'));
        } finally {
            setBusy(false);
        }
    }

    async function submitFarm() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/me/farms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: farmName.trim(),
                    // Omitted entirely on the физическо лице path — the
                    // contract treats absence as «Земеделски стопанин».
                    ...(kind === 'company' && eik.trim() ? { eik: eik.trim() } : {}),
                }),
            });
            if (!res.ok) {
                fail(t('failed'));
                return;
            }
            const data = await res.json();
            // From the response, never derived: the slug carries a uniqueness
            // suffix, so a client-side guess would 404.
            setFarmSlug(data?.farm?.slug ?? '');
            setIdentity((data?.identityVerification as IdentityResult) ?? 'not_requested');
            setStep('done');
        } catch {
            fail(t('failed'));
        } finally {
            setBusy(false);
        }
    }

    /** The provisional identity line on step 6. Never implies acceptance. */
    function identityLine(): string {
        if (identity === 'pending_review') return t('doneIdentityPending');
        if (identity === 'deferred') return t('doneIdentityDeferred');
        return t('doneIdentityNone');
    }

    const canSubmitEik = verdict.state === 'valid';

    /**
     * Title and primary action per step, hoisted out of the branches.
     *
     * Not a tidiness refactor — two design guards required it, and both were
     * right. `single H1 per page` and `primary action budget` counted six
     * level-one headings and five primary buttons in this file. Only one of
     * each ever RENDERS, but neither a reader nor a static a11y check can see
     * that, and "only one is reachable at runtime" is exactly the argument
     * that stops being true the first time somebody renders two steps side by
     * side on a wide screen.
     *
     * So the chrome renders ONE h1 and ONE primary button, and the step
     * supplies what they say and do.
     */
    const chrome: Record<Step, { title: string; primary?: { label: string; onClick: () => void; disabled?: boolean } }> = {
        account: {
            title: t('accountTitle'),
            primary: {
                label: busy ? t('working') : t('accountSubmit'),
                onClick: submitAccount,
                disabled: busy || !email || !password || !name,
            },
        },
        code: {
            title: t('codeTitle'),
            primary: {
                label: busy ? t('working') : t('next'),
                onClick: submitCode,
                disabled: busy || code.length !== 6,
            },
        },
        // No primary: the two farm-kind choices ARE the actions, and promoting
        // one of them would be the wizard choosing for the farmer.
        type: { title: t('typeTitle') },
        eik: {
            title: t('eikTitle'),
            primary: {
                label: t('eikYesMine'),
                onClick: () => setStep('name'),
                disabled: !canSubmitEik,
            },
        },
        name: {
            title: t('farmNameTitle'),
            primary: {
                label: busy ? t('working') : t('finish'),
                onClick: submitFarm,
                disabled: busy || !farmName.trim(),
            },
        },
        done: {
            title: t('doneTitle'),
            primary: {
                label: t('doneOpen'),
                onClick: () => router.push(`/t/${farmSlug}`),
                disabled: !farmSlug,
            },
        },
    };
    const current = chrome[step];

    return (
        <main className="mx-auto w-full max-w-md px-4 py-8">
            <Card className="p-6 space-y-default">
                <p className="text-sm text-muted" aria-live="polite">
                    {t('stepOf', { current: position, total: walk.length })}
                </p>

                {error && <InlineNotice variant="error">{error}</InlineNotice>}

                <Heading level={1}>{current.title}</Heading>

                {step === 'account' && (
                    <>
                        <p className="text-sm text-muted">{t('accountHelp')}</p>
                        <div>
                            <label htmlFor="w-name" className="input-label">{t('name')}</label>
                            <input id="w-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
                        </div>
                        <div>
                            <label htmlFor="w-email" className="input-label">{t('email')}</label>
                            <input id="w-email" className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('emailPlaceholder')} />
                        </div>
                        <div>
                            <label htmlFor="w-password" className="input-label">{t('password')}</label>
                            <input id="w-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} />
                            <p className="text-xs text-muted mt-1">{t('passwordHelp')}</p>
                        </div>
                        <TurnstileWidget
                            sitekey={turnstileSitekey}
                            onToken={setTurnstileToken}
                            resetSignal={turnstileReset}
                            language={locale}
                        />
                    </>
                )}

                {step === 'code' && (
                    <>
                        <p className="text-sm text-muted">{t('codeHelp', { email })}</p>
                        <div>
                            <label htmlFor="w-code" className="input-label">{t('codeLabel')}</label>
                            <input id="w-code" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))} />
                        </div>
                        <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={submitAccount}>
                            {t('codeResend')}
                        </Button>
                    </>
                )}

                {step === 'type' && (
                    <>
                        <Button variant="secondary" size="sm" className="w-full" onClick={() => { setKind('company'); setStep('eik'); }}>
                            {t('typeCompany')}
                        </Button>
                        <p className="text-xs text-muted">{t('typeCompanyHelp')}</p>
                        <Button variant="secondary" size="sm" className="w-full" onClick={() => { setKind('individual'); setStep('name'); }}>
                            {t('typeIndividual')}
                        </Button>
                        <p className="text-xs text-muted">{t('typeIndividualHelp')}</p>
                    </>
                )}

                {step === 'eik' && (
                    <>
                        <div>
                            <label htmlFor="w-eik" className="input-label">{t('eikLabel')}</label>
                            <input id="w-eik" className="input" inputMode="numeric" maxLength={13} value={eik} onChange={(e) => setEik(e.target.value.replace(/[^0-9]/g, ''))} placeholder={t('eikPlaceholder')} />
                        </div>
                        <div aria-live="polite">
                            {verdict.state === 'checking' && <p className="text-sm text-muted">{t('eikChecking')}</p>}
                            {verdict.state === 'egn' && <InlineNotice variant="error">{t('eikLooksLikeEgn')}</InlineNotice>}
                            {verdict.state === 'invalid' && <InlineNotice variant="warning">{t('eikInvalid')}</InlineNotice>}
                            {verdict.state === 'valid' && (
                                <InlineNotice variant="success">
                                    {verdict.registryName
                                        ? t('eikValidNamed', { name: verdict.registryName })
                                        : t('eikValidUnnamed')}
                                </InlineNotice>
                            )}
                        </div>
                        <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep('type')}>
                            {t('back')}
                        </Button>
                    </>
                )}

                {step === 'name' && (
                    <>
                        <div>
                            <label htmlFor="w-farm-name" className="input-label">{t('farmNameLabel')}</label>
                            <input id="w-farm-name" className="input" value={farmName} onChange={(e) => setFarmName(e.target.value)} />
                            <p className="text-xs text-muted mt-1">{t('farmNameHelp')}</p>
                        </div>
                        <Button variant="ghost" size="sm" className="w-full" disabled={busy} onClick={() => setStep(kind === 'company' ? 'eik' : 'type')}>
                            {t('back')}
                        </Button>
                    </>
                )}

                {step === 'done' && (
                    <>
                        {/* The identity line is SEPARATE from the headline on
                            purpose. «Стопанството Ви е онлайн» is true of the
                            farm; next to a just-submitted ЕИК it would read as
                            "your number was accepted", which is not known and
                            may be false. */}
                        <p className="text-sm text-muted">{identityLine()}</p>
                    </>
                )}
                {current.primary && (
                    <Button
                        variant="primary"
                        size="sm"
                        className="w-full"
                        disabled={current.primary.disabled}
                        onClick={current.primary.onClick}
                    >
                        {current.primary.label}
                    </Button>
                )}
            </Card>
        </main>
    );
}
