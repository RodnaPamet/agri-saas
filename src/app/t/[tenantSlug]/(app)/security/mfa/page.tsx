'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useDateFormat } from '@/lib/i18n/use-date-format';
import { Card, cardVariants } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/cn';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { ShieldCheck, QrCode, Copy, CheckCircle, XCircle, Trash2, AlertTriangle, X } from 'lucide-react';
import { useToast } from '@/components/ui/hooks/use-toast';
import { useCopyToClipboard } from '@/components/ui/hooks';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Heading } from '@/components/ui/typography';

interface MfaStatus {
    isEnrolled: boolean;
    isVerified: boolean;
    enrolledAt: string | null;
    verifiedAt: string | null;
    tenantMfaPolicy: string;
    mfaRequired: boolean;
}

interface EnrollmentResult {
    otpauthUrl: string;
    secret: string;
    enrollmentId: string;
}

type Step = 'status' | 'enrolling' | 'verifying';

export default function UserMfaPage() {
    const { formatDate } = useDateFormat();
    const t = useTranslations('mfa');
    const te = useTranslations('mfa.enroll');
    const apiUrl = useTenantApiUrl();
    const [status, setStatus] = useState<MfaStatus | null>(null);
    const [step, setStep] = useState<Step>('status');
    const [enrollment, setEnrollment] = useState<EnrollmentResult | null>(null);
    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
    const { copy, copied } = useCopyToClipboard({ timeout: 2500 });
    const toast = useToast();

    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/security/mfa/enroll'));
            if (res.ok) {
                setStatus(await res.json());
            }
        } catch {
            setError(te('loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchStatus(); }, [fetchStatus]);

    const startEnroll = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/enroll/start'), { method: 'POST' });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to start enrollment');
            }
            const data = await res.json();
            setEnrollment(data);
            setStep('enrolling');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Enrollment failed');
        } finally {
            setSubmitting(false);
        }
    };

    const verifyCode = async () => {
        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            setError(t('invalidCode'));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/enroll/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const data = await res.json();
            if (data.success) {
                setSuccess(te('enrolledSuccess'));
                setStep('status');
                setEnrollment(null);
                setCode('');
                await fetchStatus();
            } else {
                setError(data.error || te('invalidCodeRetry'));
            }
        } catch {
            setError('Verification failed');
        } finally {
            setSubmitting(false);
        }
    };

    const removeMfa = () => setShowRemoveConfirm(true);

    const performRemoveMfa = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/enroll'), { method: 'DELETE' });
            if (res.ok) {
                setSuccess(te('mfaRemoved'));
                await fetchStatus();
                setTimeout(() => setSuccess(null), 3000);
            }
        } catch {
            setError('Failed to remove MFA');
        } finally {
            setSubmitting(false);
        }
    };

    const copySecret = async () => {
        if (!enrollment) return;
        const ok = await copy(enrollment.secret);
        if (ok) {
            toast.success(te('setupKeyCopied'));
        } else {
            toast.error(te('copyFailed'));
        }
    };

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <Heading level={2} className="flex items-center gap-tight">
                    <ShieldCheck className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('loadingTitle')}
                </Heading>
                <Card>
                    <div className="animate-pulse space-y-default">
                        <div className="h-4 bg-bg-elevated rounded w-1/3" />
                        <div className="h-20 bg-bg-elevated rounded w-full" />
                    </div>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn max-w-2xl">
            <Heading level={1} className="flex items-center gap-tight">
                <ShieldCheck className="w-6 h-6 text-[var(--brand-default)]" />
                {t('title')}
            </Heading>

            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-error bg-bg-error flex items-center gap-tight')}>
                    <XCircle className="w-4 h-4 text-content-error shrink-0" />
                    <span className="text-sm text-content-error">{error}</span>
                    <button onClick={() => setError(null)} className="ml-auto text-xs text-content-muted hover:text-content-emphasis">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            {success && (
                <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-success bg-bg-success flex items-center gap-tight')}>
                    <CheckCircle className="w-4 h-4 text-content-success shrink-0" />
                    <span className="text-sm text-content-success">{success}</span>
                </div>
            )}

            {/* Status Card */}
            {step === 'status' && status && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div className="flex items-center justify-between">
                        <div>
                            <Heading level={2}>{te('statusTitle')}</Heading>
                            <p className="text-sm text-content-muted mt-1">
                                {te('tenantPolicy')} <span className="font-medium text-content-default">{status.tenantMfaPolicy}</span>
                            </p>
                        </div>
                        <div>
                            {/* Roadmap-2 PR-7 — canonical StatusBadge
                                replaces the hand-rolled enrolment
                                pill. CheckCircle stays inline as
                                an icon-prefix because the badge
                                doesn't own iconography; future PR
                                may extend StatusBadge to take an
                                `icon` slot. */}
                            {status.isVerified ? (
                                <StatusBadge variant="success">
                                    <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" />
                                    {te('enrolled')}
                                </StatusBadge>
                            ) : (
                                <StatusBadge variant="neutral">
                                    {te('notEnrolled')}
                                </StatusBadge>
                            )}
                        </div>
                    </div>

                    {status.isVerified && status.verifiedAt && (
                        <p className="text-xs text-content-subtle">
                            {te('enrolledSince', { date: formatDate(status.verifiedAt) })}
                        </p>
                    )}

                    {status.mfaRequired && !status.isVerified && (
                        <div className="p-3 rounded-lg border border-border-warning bg-bg-warning flex items-start gap-tight">
                            <AlertTriangle className="w-4 h-4 text-content-warning mt-0.5 shrink-0" />
                            <p className="text-sm text-content-warning">
                                {te('orgRequires')}
                            </p>
                        </div>
                    )}

                    <div className="flex gap-tight pt-2">
                        {!status.isVerified && (
                            <Button
                                variant="primary"
                                onClick={startEnroll}
                                disabled={submitting}
                                id="mfa-enroll-btn"
                                icon={<QrCode className="w-4 h-4" />}
                            >
                                {submitting ? te('starting') : t('setUpMfa')}
                            </Button>
                        )}
                        {status.isVerified && status.tenantMfaPolicy !== 'REQUIRED' && (
                            <Button
                                variant="destructive-outline"
                                onClick={removeMfa}
                                disabled={submitting}
                                id="mfa-remove-btn"
                                icon={<Trash2 className="w-4 h-4" />}
                            >
                                {t('removeMfa')}
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {/* Enrollment Step: Show Secret + QR */}
            {step === 'enrolling' && enrollment && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <div>
                        <Heading level={2} className="mb-1">{te('setupTitle')}</Heading>
                        <p className="text-sm text-content-muted">
                            {te('setupStep1')}
                        </p>
                        <p className="text-sm text-content-muted">
                            {te('setupStep2')}
                        </p>
                    </div>

                    {/* QR Code placeholder — render the otpauth URI */}
                    <div className="flex flex-col items-center gap-default py-4">
                        <div className="bg-white p-4 rounded-lg">
                            {/* Simple QR fallback: render as a monospace URI block */}
                            <div className="w-full sm:w-48 h-48 flex items-center justify-center">
                                <QrCode className="w-full sm:w-32 h-32 text-content-emphasis" />
                            </div>
                        </div>
                        <p className="text-xs text-content-subtle">
                            {te('cannotScan')}
                        </p>
                    </div>

                    {/* Setup Key */}
                    <div className="p-4 rounded-lg border border-border-default bg-bg-default/50">
                        <label className="text-xs text-content-muted block mb-1">{te('setupKey')}</label>
                        <div className="flex items-center gap-tight">
                            <code className="text-sm font-mono text-[var(--brand-muted)] tracking-wider break-all flex-1">
                                {enrollment.secret}
                            </code>
                            <Button
                                variant="secondary"
                                size="xs"
                                className="shrink-0"
                                onClick={copySecret}
                                icon={copied ? <CheckCircle className="w-3.5 h-3.5 text-content-success" /> : <Copy className="w-3.5 h-3.5" />}
                            >
                                {copied ? te('copied') : te('copy')}
                            </Button>
                        </div>
                    </div>

                    {/* Verification */}
                    <div>
                        <Heading level={3} className="mb-2">
                            {te('setupStep3')}
                        </Heading>
                        <div className="flex gap-tight">
                            <input
                                type="text"
                                inputMode="numeric"
                                maxLength={6}
                                placeholder="000000"
                                value={code}
                                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                className="input text-center text-lg font-mono tracking-[0.3em] w-full sm:w-40"
                                id="mfa-code-input"
                                autoFocus
                            />
                            <Button
                                variant="primary"
                                onClick={verifyCode}
                                disabled={submitting || code.length !== 6}
                                id="mfa-verify-btn"
                            >
                                {submitting ? t('verifying') : te('verifyEnable')}
                            </Button>
                        </div>
                    </div>

                    <button
                        onClick={() => { setStep('status'); setEnrollment(null); setCode(''); }}
                        className="text-xs text-content-subtle hover:text-content-default transition"
                    >
                        {te('cancelEnrollment')}
                    </button>
                </div>
            )}
            <ConfirmDialog
                showModal={showRemoveConfirm}
                setShowModal={setShowRemoveConfirm}
                tone="danger"
                title={te('removeConfirmTitle')}
                description={te('removeConfirmDesc')}
                confirmLabel={t('removeMfa')}
                onConfirm={performRemoveMfa}
            />
        </div>
    );
}
