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

/** The version of the consent text this build renders. */
const CONSENT_TEXT_VERSION = 'v1';

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

export function PublicProfileClient() {
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

    const recordConsent = async () => {
        const ok = await send('/farm-brand/consent', { textVersion: CONSENT_TEXT_VERSION });
        if (ok) {
            setSuccess(t('saved'));
            setConsentChecked(false);
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
            ? shareKit(draft.handle, draft.displayName ?? draft.handle)
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

            {/* ── consent ── */}
            <section className={cn(cardVariants(), 'flex flex-col gap-default')}>
                <Heading level={2}>{t('consentHeading')}</Heading>
                <p className="text-content-muted">{t('consentIntro')}</p>
                {/* `whitespace-pre-line`, because the text has paragraphs and
                    a consent record should describe what was actually on
                    screen — collapsing it would change what was agreed to. */}
                <p className="whitespace-pre-line">{t('consentBody')}</p>
                {draft?.consentedAt ? (
                    <InlineNotice variant="info">
                        {t('consentRecorded', {
                            date: formatDate(draft.consentedAt),
                        })}
                    </InlineNotice>
                ) : (
                    <div className="flex flex-col gap-tight">
                        <label className="flex items-center gap-tight">
                            <Checkbox
                                checked={consentChecked}
                                onCheckedChange={(v) => setConsentChecked(v === true)}
                            />
                            <span>{t('consentAgree')}</span>
                        </label>
                        <div>
                            <Button
                                onClick={recordConsent}
                                disabled={busy || !consentChecked}
                            >
                                {t('consentRecord')}
                            </Button>
                        </div>
                    </div>
                )}
            </section>

            {/* ── publish ── */}
            <section className={cn(cardVariants(), 'flex flex-col gap-default')}>
                <Heading level={2}>{t('publishHeading')}</Heading>
                <p className="text-content-muted">
                    {draft?.published && draft.publishedAt
                        ? t('publishedAt', {
                              date: formatDate(draft.publishedAt),
                          })
                        : t('notPublished')}
                </p>
                <div>
                    <Button
                        onClick={() => setPublished(!draft?.published)}
                        disabled={busy}
                        variant={draft?.published ? 'secondary' : 'primary'}
                    >
                        {draft?.published ? t('unpublish') : t('publish')}
                    </Button>
                </div>

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
                    </div>
                )}
            </section>
        </div>
    );
}
