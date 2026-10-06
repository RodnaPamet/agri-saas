'use client';

/**
 * Epic O-4 — Tenant creation form (org context).
 *
 * Two fields: name and slug. Both are POSTed to
 * `/api/org/{slug}/tenants` (Epic O-2 contract), and on success the
 * browser lands on the new tenant's dashboard.
 *
 * ── it used to have a THIRD field, and it was broken (P2.6) ──
 *
 * A "Starting framework" radio group offered ISO/IEC 27001, NIS2,
 * ISO 9001, ISO 28000 and ISO 39001 — a compliance-framework picker on a
 * farm product — and on anything but "Choose later" it pushed
 * `/t/<slug>/frameworks?install=<key>`, a route GRC teardown phase 2
 * deleted. So five of its six options navigated a brand-new tenant
 * straight into a 404 on their first screen. Nothing caught it: the
 * selection never reached the server, so no contract test saw it, and
 * `tests/guards/nav-routes-exist.test.ts` derives its population from the
 * nav REGISTRIES, not from `router.push` call sites.
 *
 * The slug is auto-derived from the name on the first keystroke and
 * stops auto-syncing once the user edits it manually — the same
 * UX pattern used in the standard onboarding flow.
 *
 * Validation mirrors the server schema (`CreateOrgTenantInput` in
 * `organization.schemas.ts`) so the user gets fast feedback without a
 * round-trip; the server remains the source of truth.
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getCsrfToken } from 'next-auth/react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Button, buttonVariants } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';

interface Props {
    orgSlug: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

interface FieldErrors {
    name?: string;
    slug?: string;
}

/**
 * Re-mint the NextAuth JWT cookie so the OWNER membership the server
 * just granted on the new tenant is reflected in the token BEFORE we
 * navigate into the tenant. Without this the Edge tenant-access gate —
 * which reads membership claims straight from the JWT with no DB hit —
 * would bounce the redirect to /no-tenant, because those claims are
 * otherwise frozen at sign-in.
 *
 * The app deliberately mounts no <SessionProvider> (session is resolved
 * server-side via `auth()`), so we can't use `useSession().update()`.
 * We POST the NextAuth session-update endpoint directly — exactly what
 * `update()` does internally — which re-runs the `jwt` callback with
 * `trigger: 'update'`; see `applyMembershipClaims` in `src/auth.ts`.
 * Best-effort — a failure here just means the user may need a manual
 * refresh, never a broken create.
 */
async function refreshSessionClaims(): Promise<void> {
    try {
        const csrfToken = await getCsrfToken();
        if (!csrfToken) return;
        await fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ csrfToken, data: {} }),
        });
    } catch {
        /* best-effort — navigation below still proceeds */
    }
}

function validate(
    { name, slug }: { name: string; slug: string },
    t: ReturnType<typeof useTranslations>,
): FieldErrors {
    const errors: FieldErrors = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
        errors.name = t('nameRequired');
    } else if (trimmedName.length > 120) {
        errors.name = t('nameTooLong');
    }
    const trimmedSlug = slug.trim();
    if (!trimmedSlug) {
        errors.slug = t('slugRequired');
    } else if (!SLUG_RE.test(trimmedSlug)) {
        errors.slug = t('slugInvalid');
    }
    return errors;
}

export function NewTenantForm({ orgSlug }: Props) {
    const router = useRouter();
    const t = useTranslations('org.newTenant');

    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [slugTouched, setSlugTouched] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [touched, setTouched] = useState<{ name: boolean; slug: boolean }>({
        name: false,
        slug: false,
    });

    const errors = useMemo(() => validate({ name, slug }, t), [name, slug, t]);
    const hasErrors = Boolean(errors.name || errors.slug);

    const onNameChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const next = e.target.value;
            setName(next);
            if (!slugTouched) {
                setSlug(slugify(next));
            }
        },
        [slugTouched],
    );

    const onSlugChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setSlug(e.target.value);
        setSlugTouched(true);
    }, []);

    const onSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            setTouched({ name: true, slug: true });
            if (hasErrors) return;

            setSubmitting(true);
            setSubmitError(null);
            try {
                const res = await fetch(`/api/org/${orgSlug}/tenants`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ name: name.trim(), slug: slug.trim() }),
                });
                if (!res.ok) {
                    let message = t('createFailed', { status: res.status });
                    try {
                        const body = (await res.json()) as { error?: { message?: string } };
                        if (body?.error?.message) message = body.error.message;
                    } catch {
                        /* response wasn't JSON; keep the generic message */
                    }
                    setSubmitError(message);
                    setSubmitting(false);
                    return;
                }
                const body = (await res.json()) as { tenant: { slug: string } };
                const newSlug = body.tenant.slug;
                // Pick up the just-granted OWNER membership in the JWT
                // before navigating into the new tenant (see helper above).
                await refreshSessionClaims();
                router.push(`/t/${newSlug}/dashboard`);
            } catch (err) {
                setSubmitError(
                    err instanceof Error
                        ? err.message
                        : 'Unexpected error while creating tenant.',
                );
                setSubmitting(false);
            }
        },
        [orgSlug, name, slug, hasErrors, router, t],
    );

    return (
        <div className="max-w-xl mx-auto space-y-section">
            <div>
                <Link
                    href={`/org/${orgSlug}/tenants`}
                    className="inline-flex items-center gap-1 text-sm text-content-muted hover:text-content-emphasis"
                    data-testid="org-new-tenant-back"
                >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    {t('backToTenants')}
                </Link>
                <Heading level={1} className="mt-3">
                    {t('createTitle')}
                </Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t('createDesc')}
                </p>
            </div>

            <form
                onSubmit={onSubmit}
                noValidate
                data-testid="org-new-tenant-form"
                className={cn(cardVariants(), 'space-y-default')}
            >
                <FormField
                    label={t('nameLabel')}
                    description={t('nameDesc')}
                    error={touched.name ? errors.name : undefined}
                    required
                >
                    <Input
                        name="name"
                        value={name}
                        onChange={onNameChange}
                        onBlur={() => setTouched((prev) => ({ ...prev, name: true }))}
                        autoComplete="off"
                        autoFocus
                        maxLength={120}
                        placeholder={t('namePlaceholder')}
                        data-testid="org-new-tenant-name"
                    />
                </FormField>

                <FormField
                    label={t('slugLabel')}
                    description={t('slugDesc')}
                    error={touched.slug ? errors.slug : undefined}
                    required
                >
                    <Input
                        name="slug"
                        value={slug}
                        onChange={onSlugChange}
                        onBlur={() => setTouched((prev) => ({ ...prev, slug: true }))}
                        autoComplete="off"
                        maxLength={64}
                        placeholder={t('slugPlaceholder')}
                        data-testid="org-new-tenant-slug"
                    />
                </FormField>

                {submitError && (
                    <p
                        className="text-sm text-content-error"
                        role="alert"
                        data-testid="org-new-tenant-error"
                    >
                        {submitError}
                    </p>
                )}

                <div className="flex items-center justify-end gap-tight pt-2">
                    <Link
                        href={`/org/${orgSlug}/tenants`}
                        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        data-testid="org-new-tenant-cancel"
                    >
                        {t('cancel')}
                    </Link>
                    <Button
                        type="submit"
                        variant="primary"
                        loading={submitting}
                        disabled={submitting || hasErrors}
                        data-testid="org-new-tenant-submit"
                        text={submitting ? t('creating') : t('createTenant')}
                    />
                </div>
            </form>
        </div>
    );
}
