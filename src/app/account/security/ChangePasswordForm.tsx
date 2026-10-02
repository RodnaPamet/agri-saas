'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';

export function ChangePasswordForm() {
    const t = useTranslations('account.changePassword');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');

        if (!currentPassword || !newPassword || !confirmPassword) {
            setError(t('errFillAll'));
            return;
        }
        if (newPassword !== confirmPassword) {
            setError(t('errMismatch'));
            return;
        }
        if (newPassword.length < 8) {
            setError(t('errTooShort'));
            return;
        }
        if (newPassword === currentPassword) {
            setError(t('errSameAsCurrent'));
            return;
        }

        setLoading(true);
        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword }),
            });
            if (res.ok) {
                setSuccess(true);
                setTimeout(() => {
                    // A FULL navigation, deliberately: the session just changed, so the
                    // client's cached session state must be discarded rather than
                    // carried into a soft `router.push`. `new URL(...)` keeps that
                    // behaviour exactly and satisfies
                    // `@next/next/no-location-assign-relative-destination`, which
                    // objects to the bare relative string, not to the reload.
                    window.location.href = new URL('/login?passwordChanged=1', window.location.origin).href;
                }, 1500);
                return;
            }
            const data = await res.json().catch(() => ({}));
            setError(typeof data?.error === 'string' ? data.error : 'Could not change your password.');
        } catch {
            setError('Could not change your password.');
        }
        setLoading(false);
    };

    return (
        <Card className="animate-fadeIn">
            <Heading level={2} className="mb-6">
                {t('title')}
            </Heading>

            {success ? (
                <InlineNotice variant="success" className="mb-4" icon={null}>
                    {t('successNotice')}
                </InlineNotice>
            ) : (
                <>
                    {error && (
                        <InlineNotice variant="error" className="mb-4" icon={null}>
                            {error}
                        </InlineNotice>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-default">
                        <FormField label={t('currentLabel')} required>
                            <Input
                                type="password"
                                name="currentPassword"
                                autoComplete="current-password"
                                enterKeyHint="next"
                                value={currentPassword}
                                onChange={(e) => setCurrentPassword(e.target.value)}
                                required
                                placeholder={t('currentPlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('newLabel')} required>
                            <Input
                                type="password"
                                name="newPassword"
                                autoComplete="new-password"
                                enterKeyHint="next"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                required
                                placeholder={t('newPlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('confirmLabel')} required>
                            <Input
                                type="password"
                                name="confirmPassword"
                                autoComplete="new-password"
                                enterKeyHint="done"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                placeholder={t('confirmPlaceholder')}
                            />
                        </FormField>
                        <Button type="submit" variant="primary" size="sm" className="w-full" disabled={loading}>
                            {loading ? t('submitting') : t('submit')}
                        </Button>
                    </form>
                </>
            )}
        </Card>
    );
}
