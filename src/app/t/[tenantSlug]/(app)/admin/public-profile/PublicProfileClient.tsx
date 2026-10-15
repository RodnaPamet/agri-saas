'use client';

/**
 * The form behind `admin/public-profile` — P6.6 (#1884).
 *
 * Four endpoints, four sections, in the order a farmer completes them:
 * content, address, consent, publish. That order is not cosmetic — it is the
 * order the publication preconditions enforce, so a form laid out any other
 * way would let someone fill in the last box first and be refused for a
 * reason three sections above.
 *
 * ## Why the address is its own call
 *
 * Every other field can only fail on its own validity. The handle is a
 * reservation in a namespace shared with every tenant, so it is the one field
 * refusable because of somebody else — and the refusal carries alternatives.
 * `PUT /farm-brand/handle` answers `FARM_HANDLE_TAKEN` with
 * `details.suggestions`, derived from this farm's own oblast and name, and
 * those are rendered as buttons because retyping a suggestion is how a
 * farmer ends up with a typo of it.
 *
 * ## Why consent is a separate confirm
 *
 * It records that a person was shown a specific text and agreed. The content
 * form autosaves on Save; a consent recorded by the same action would be
 * claiming somebody read something they never opened. So the text is on
 * screen, the checkbox is explicit, and the version sent is the version
 * rendered.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/ui/form-field';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { QrCode } from '@/components/ui/qr-code';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cardVariants } from '@/components/ui/card';
import { shareKit } from '@/lib/public-profile/share-links';
import { cn } from '@/lib/cn';

/**
 * The version of the consent text this build renders.
 *
 * v1 -> v2 (2026-10-15, owner review): v2 adds a paragraph naming the PUBLIC
 * ADDRESS as itself public. v1 listed the five content fields and said the
 * link could be forwarded, but never said that the handle the owner chooses is
 * public, is the link, and ends up on printed material — which, since the A6
 * share card (#1910), the product itself prints.
 *
 * Bumping this is not bookkeeping. `setVisible` compares it with the recorded
 * `consentTextVersion` and RE-ASKS when they differ, so every farm that agreed
 * to v1 is shown v2 before its page can go public again. That is the whole
 * reason a version is stored next to the timestamp: "they agreed" is
 * unfalsifiable once the wording changes; "they agreed to v2" can be held
 * against the v2 text.
 */
const CONSENT_TEXT_VERSION = 'v2';

interface Draft {
    handle: string | null;
    displayName: string | null;
    tagline: string | null;
    about: string | null;
    oblast: string | null;
    crops: string[];
    published: boolean;
    publishedAt: string | null;
    consentedAt: string | null;
    consentTextVersion: string | null;
    indexable: boolean;
}

export function PublicProfileClient({ baseUrl }: { baseUrl: string }) {
    const t = useTranslations('admin.publicProfile');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    // The shared formatter, not an ad-hoc Intl call:
    // `date-display-consistency` forbids those in app code, and the
    // formatter is keyed on the locale the reader actually chose rather
    // than a hardcoded tag — my first version hardcoded `bg-BG`, so an
    // English reader would have seen a Bulgarian date.
    const { formatDate } = useDateFormat();

    const [draft, setDraft] = useState<Draft | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Form state is STRINGS because that is what an input holds — the same
    // reason `admin/farm-profile` keeps its numeric fields as text.
    const [displayName, setDisplayName] = useState('');
    const [tagline, setTagline] = useState('');
    const [about, setAbout] = useState('');
    const [oblast, setOblast] = useState('');
    const [crops, setCrops] = useState('');

    const [handleInput, setHandleInput] = useState('');
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [consentChecked, setConsentChecked] = useState(false);
    /**
     * True while the owner has asked for the page to go public and has not yet
     * agreed to the consent text. The switch reads as ON during this window —
     * it reflects what they asked for, with the confirmation shown underneath —
     * and snaps back if they cancel.
     */
    const [consentPending, setConsentPending] = useState(false);

    const hydrate = useCallback((d: Draft | null) => {
        setDraft(d);
        setDisplayName(d?.displayName ?? '');
        setTagline(d?.tagline ?? '');
        setAbout(d?.about ?? '');
        setOblast(d?.oblast ?? '');
        setCrops((d?.crops ?? []).join(', '));
        setHandleInput(d?.handle ?? '');
    }, []);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/farm-brand'));
            if (!res.ok) throw new Error();
            hydrate((await res.json()) as Draft | null);
        } catch {
            setError(t('loadFailed'));
        } finally {
            setLoading(false);
        }
        // `t` is referentially stable — next-intl memoises it — so naming it
        // satisfies the exhaustive-deps rule without re-running this effect
        // on every render, which would refetch the draft each time.
    }, [apiUrl, hydrate, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { load(); }, [load]);

    /**
     * One request helper, because all four endpoints fail the same way and a
     * coded refusal has to reach the right place: `FARM_HANDLE_TAKEN` needs
     * its suggestions rendered, everything else is a sentence.
     */
    const send = useCallback(
        async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
            setBusy(true);
            setError(null);
            setSuccess(null);
            try {
                const res = await fetch(apiUrl(path), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
                if (!res.ok) {
                    // The envelope is NESTED — `{ error: { code, message,
                    // requestId, details, params } }`, per `ErrorResponse` in
                    // the spec. A flat read of `data.code` compiles, returns
                    // undefined, and silently turns every coded refusal into
                    // the generic message: `FARM_HANDLE_TAKEN` would have lost
                    // its suggestions entirely. The rendered test caught it.
                    const err = (data.error ?? {}) as {
                        code?: string;
                        message?: string;
                        details?: { suggestions?: string[] };
                    };
                    if (err.code === 'FARM_HANDLE_TAKEN') {
                        setSuggestions(err.details?.suggestions ?? []);
                        setError(t('addressTaken'));
                        return null;
                    }
                    // A coded refusal carries a message the API wrote for a
                    // person; showing it beats a generic failure, and the
                    // codes this form can provoke are all actionable.
                    setError(err.message ?? t('saveFailed'));
                    return null;
                }
                return data;
            } catch {
                setError(t('saveFailed'));
                return null;
            } finally {
                setBusy(false);
            }
        },
        [apiUrl, t],
    );

    const saveContent = async () => {
        const ok = await send('/farm-brand', {
            displayName: displayName.trim() === '' ? null : displayName.trim(),
            tagline: tagline.trim() === '' ? null : tagline.trim(),
            about: about.trim() === '' ? null : about.trim(),
            oblast: oblast.trim() === '' ? null : oblast.trim(),
            crops: crops
                .split(',')
                .map((c) => c.trim())
                .filter((c) => c !== ''),
        });
        if (ok) {
            setSuccess(t('saved'));
            await load();
        }
    };

    const claimHandle = async (candidate?: string) => {
        setSuggestions([]);
        const value = (candidate ?? handleInput).trim();
        if (value === '') return;
        const ok = await send('/farm-brand/handle', { handle: value });
        if (ok) {
            // The STORED handle, not what was typed: the API normalises, and
            // echoing the input would leave an owner expecting an address
            // that does not exist.
            setHandleInput(String(ok.handle ?? value));
            setSuccess(t('addressNormalised', { url: `/f/${String(ok.handle ?? value)}` }));
            await load();
        }
    };

    const setPublished = async (next: boolean) => {
        const ok = await send('/farm-brand/publication', { published: next });
        if (ok) {
            setSuccess(t('saved'));
            await load();
        }
    };

    /**
     * Whether the recorded consent still covers the text THIS build renders.
     *
     * A timestamp alone is not enough. `consentTextVersion` exists so that
     * "they agreed" can be held against a specific wording, and a farm that
     * agreed to v1 has not agreed to v2 — so a changed text re-asks rather
     * than inheriting an older answer. That is the whole reason the version is
     * stored alongside the timestamp.
     */
    const consentIsCurrent =
        !!draft?.consentedAt && draft.consentTextVersion === CONSENT_TEXT_VERSION;

    /**
     * The visibility switch.
     *
     * OFF is immediate and never gated. A farm must always be able to take its
     * page down — the usecase makes the same choice, applying the publication
     * preconditions only to `published: true` — and asking somebody to agree
     * to something in order to STOP publishing would be absurd.
     *
     * ON asks first. The consent is raised BY this action rather than standing
     * as a separate step to have completed earlier, so the agreement is made
     * at the moment it has an effect.
     */
    const setVisible = async (next: boolean) => {
        if (!next) {
            setConsentPending(false);
            setConsentChecked(false);
            await setPublished(false);
            return;
        }
        if (consentIsCurrent) {
            await setPublished(true);
            return;
        }
        setConsentChecked(false);
        setConsentPending(true);
    };

    const cancelConsent = () => {
        setConsentPending(false);
        setConsentChecked(false);
    };

    /**
     * Record the consent, then publish — in that order, as two calls.
     *
     * Not one call, and not a field on the content save. Consent is a legal
     * artefact rather than editor state: the content form autosaves, and an
     * autosave that recorded consent would be claiming somebody read something
     * they never saw.
     *
     * The order matters on the failure path too. If the consent is recorded and
     * publication is then refused — no public name, say — the consent STANDS
     * and the page stays private. That is the safe direction: a recorded
     * agreement with nothing published is a true statement about what the owner
     * agreed to, where a published page with no record would not be.
     */
    const confirmConsentAndPublish = async () => {
        const consented = await send('/farm-brand/consent', {
            textVersion: CONSENT_TEXT_VERSION,
        });
        if (!consented) return;

        const published = await send('/farm-brand/publication', { published: true });
        setConsentChecked(false);
        if (published) {
            setConsentPending(false);
            setSuccess(t('saved'));
        }
        // Reload either way: the consent is recorded even when the publication
        // that followed it was refused, and the form must show that.
        await load();
    };

    const setIndexable = async (next: boolean) => {
        const ok = await send('/farm-brand', { indexable: next });
        if (ok) {
            setSuccess(t('saved'));
            await load();
        }
    };

    if (loading) {
        return (
            <div className="flex flex-col gap-tight">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbPublicProfile') },
                    ]}
                    className="mb-1"
                />
                <p className="text-content-muted">{t('loading')}</p>
            </div>
        );
    }

    const kit =
        draft?.published && draft.handle
            ? shareKit(draft.handle, draft.displayName ?? draft.handle, baseUrl)
            : null;

    return (
        <div className="flex flex-col gap-loose">
            <div className="flex flex-col gap-tight">
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                        { label: t('breadcrumbAdmin'), href: tenantHref('/admin') },
                        { label: t('breadcrumbPublicProfile') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('heading')}</Heading>
                <p className="text-content-muted">{t('intro')}</p>
            </div>

            {error && (
                <InlineNotice variant="error" onDismiss={() => setError(null)}>
                    {error}
                </InlineNotice>
            )}
            {success && (
                <InlineNotice variant="success" onDismiss={() => setSuccess(null)}>
                    {success}
                </InlineNotice>
            )}

            {/* ── content ── */}
            <section className={cn(cardVariants(), 'flex flex-col gap-default')}>
                <FormField label={t('displayNameLabel')} description={t('displayNameHelp')}>
                    <Input
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        maxLength={120}
                    />
                </FormField>
                <FormField label={t('taglineLabel')} description={t('taglineHelp')}>
                    <Input
                        value={tagline}
                        onChange={(e) => setTagline(e.target.value)}
                        maxLength={200}
                    />
                </FormField>
                <FormField label={t('aboutLabel')} description={t('aboutHelp')}>
                    <Textarea
                        value={about}
                        onChange={(e) => setAbout(e.target.value)}
                        maxLength={2000}
                        rows={6}
                    />
                </FormField>
                <FormField label={t('oblastLabel')}>
                    <Input
                        value={oblast}
                        onChange={(e) => setOblast(e.target.value)}
                        maxLength={80}
                    />
                </FormField>
                <FormField label={t('cropsLabel')} description={t('cropsHelp')}>
                    <Input value={crops} onChange={(e) => setCrops(e.target.value)} />
                </FormField>
                <div>
                    <Button onClick={saveContent} disabled={busy}>
                        {busy ? t('saving') : t('save')}
                    </Button>
                </div>
            </section>

            {/* ── address ── */}
            <section className={cn(cardVariants(), 'flex flex-col gap-default')}>
                <Heading level={2}>{t('addressHeading')}</Heading>
                <FormField label={t('addressLabel')} description={t('addressHelp')}>
                    <Input
                        value={handleInput}
                        onChange={(e) => setHandleInput(e.target.value)}
                        maxLength={200}
                    />
                </FormField>
                {suggestions.length > 0 && (
                    <div className="flex flex-col gap-tight">
                        <p className="text-content-muted">{t('addressSuggestions')}</p>
                        <div className="flex flex-wrap gap-tight">
                            {suggestions.map((s) => (
                                // Buttons, not text: retyping a suggestion is
                                // how an owner ends up with a typo of it.
                                <Button
                                    key={s}
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => claimHandle(s)}
                                >
                                    {s}
                                </Button>
                            ))}
                        </div>
                    </div>
                )}
                <div>
                    <Button onClick={() => claimHandle()} disabled={busy}>
                        {t('addressClaim')}
                    </Button>
                </div>
            </section>

            {/* ── visibility, and the consent it raises ── */}
            <section className={cn(cardVariants(), 'flex flex-col gap-default')}>
                <Heading level={2}>{t('visibilityHeading')}</Heading>
                <p className="text-content-muted">
                    {draft?.published && draft.publishedAt
                        ? t('publishedAt', {
                              date: formatDate(draft.publishedAt),
                          })
                        : t('notPublished')}
                </p>

                <label className="flex items-center justify-between gap-default">
                    <span className="flex flex-col">
                        <span>{t('visibilityLabel')}</span>
                        <span className="text-content-muted">{t('visibilityHelp')}</span>
                    </span>
                    {/* Reads ON while a consent is pending: the switch shows
                        what was ASKED FOR, and the confirmation below says what
                        is still needed. Cancelling returns it to off, and the
                        page is private throughout. */}
                    <Switch
                        checked={(draft?.published ?? false) || consentPending}
                        onCheckedChange={setVisible}
                        disabled={busy}
                    />
                </label>

                {/* The consent, raised BY turning visibility on rather than
                    standing as an earlier step — so the agreement is made at
                    the moment it has an effect. */}
                {consentPending && (
                    <div className="flex flex-col gap-default border-t border-border-subtle pt-default">
                        <Heading level={3}>{t('consentHeading')}</Heading>
                        {draft?.consentedAt && (
                            <InlineNotice variant="warning">{t('consentStale')}</InlineNotice>
                        )}
                        <p className="text-content-muted">{t('consentIntro')}</p>
                        {/* `whitespace-pre-line`, because the text has
                            paragraphs and a consent record should describe what
                            was actually on screen — collapsing it would change
                            what was agreed to. */}
                        <p className="whitespace-pre-line">{t('consentBody')}</p>
                        <label className="flex items-center gap-tight">
                            <Checkbox
                                checked={consentChecked}
                                onCheckedChange={(v) => setConsentChecked(v === true)}
                            />
                            <span>{t('consentAgree')}</span>
                        </label>
                        <div className="flex gap-tight">
                            <Button
                                onClick={confirmConsentAndPublish}
                                disabled={busy || !consentChecked}
                            >
                                {t('consentConfirm')}
                            </Button>
                            <Button onClick={cancelConsent} disabled={busy} variant="secondary">
                                {t('consentCancel')}
                            </Button>
                        </div>
                    </div>
                )}

                {consentIsCurrent && !consentPending && (
                    <InlineNotice variant="info">
                        {t('consentRecorded', {
                            date: formatDate(draft!.consentedAt!),
                        })}
                    </InlineNotice>
                )}

                <label className="flex items-center justify-between gap-default">
                    <span className="flex flex-col">
                        <span>{t('indexableLabel')}</span>
                        <span className="text-content-muted">{t('indexableHelp')}</span>
                    </span>
                    <Switch
                        checked={draft?.indexable ?? false}
                        onCheckedChange={setIndexable}
                        disabled={busy}
                    />
                </label>

                {kit && (
                    <div className="flex flex-col gap-tight">
                        <p>{kit.url}</p>
                        <QrCode value={kit.qrValue} size={128} />
                        {/* The A6 card — P6.7 (#1908).
                            Until this, the card shipped (#1910) with nothing in
                            the product linking to it.

                            NO disabled state, and that is deliberate. The route
                            refuses an unpublished farm with
                            `FARM_BRAND_NOT_PUBLISHED`, and this whole block is
                            already gated on `kit`, which is non-null only when
                            `published && handle` — the same conditions. So the
                            affordance's PRESENCE is the condition: it cannot be
                            offered in a state where it would 400. A disabled
                            button would have to restate a rule the layout
                            already enforces, and the two could drift.

                            A plain anchor, not a fetch-and-blob: the route
                            already sends `Content-Disposition: attachment` with
                            the farm's own Bulgarian name in RFC 5987
                            `filename*`, so the browser's own download path
                            preserves it. Reading the bytes in JS to re-offer
                            them would throw that away and add a failure mode. */}
                        <a
                            href={apiUrl('/farm-brand/share-card')}
                            download
                            className="underline underline-offset-2"
                        >
                            {t('downloadCard')}
                        </a>
                        <span className="text-content-muted">{t('downloadCardHint')}</span>
                    </div>
                )}
            </section>
        </div>
    );
}
