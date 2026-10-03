'use client';

import { useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Mail, UserMinus, Shield, AlertTriangle, X } from 'lucide-react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns } from '@/components/ui/table';
import { TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { Heading } from '@/components/ui/typography';

interface MemberRow {
    membershipId: string;
    userId: string;
    role: 'ORG_ADMIN' | 'ORG_READER';
    joinedAt: string;
    user: {
        id: string;
        email: string;
        name: string | null;
    };
}

interface Props {
    orgSlug: string;
    currentUserId: string;
    rows: MemberRow[];
    invites: PendingInviteRow[];
}

export interface PendingInviteRow {
    id: string;
    email: string;
    role: 'ORG_ADMIN' | 'ORG_READER';
    expiresAt: string;
    createdAt: string;
    invitedBy: { id: string; name: string | null; email: string | null } | null;
}

const ROLE_VARIANT: Record<MemberRow['role'], 'error' | 'info'> = {
    ORG_ADMIN: 'error',
    ORG_READER: 'info',
};

const ROLE_LABEL_KEY: Record<MemberRow['role'], string> = {
    ORG_ADMIN: 'roleAdmin',
    ORG_READER: 'roleReader',
};

const ROLE_DESC_KEY: Record<MemberRow['role'], string> = {
    ORG_ADMIN: 'roleAdminDesc',
    ORG_READER: 'roleReaderDesc',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MembersTable({ orgSlug, currentUserId, rows, invites }: Props) {
    const { formatDate } = useDateFormat();
    const router = useRouter();
    const t = useTranslations('org.members');

    const [addOpen, setAddOpen] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);
    const [roleTarget, setRoleTarget] = useState<MemberRow | null>(null);

    const columns = useMemo(
        () =>
            createColumns<MemberRow>([
                {
                    id: 'user',
                    header: t('colMember'),
                    cell: ({ row }) => (
                        <div className="flex flex-col">
                            <span
                                className="text-sm font-medium text-content-emphasis"
                                data-testid={`org-member-name-${row.original.userId}`}
                            >
                                {row.original.user.name ?? row.original.user.email}
                            </span>
                            {row.original.user.name && (
                                <span className="text-xs text-content-muted">
                                    {row.original.user.email}
                                </span>
                            )}
                        </div>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'role',
                    header: t('colRole'),
                    cell: ({ row }) => (
                        <StatusBadge variant={ROLE_VARIANT[row.original.role]}>
                            {t(ROLE_LABEL_KEY[row.original.role])}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colRole') } },
                },
                {
                    id: 'joinedAt',
                    header: t('colJoined'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-subtle tabular-nums">
                            {formatDate(row.original.joinedAt)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colJoined') } },
                },
                {
                    id: 'actions',
                    header: '',
                    cell: ({ row }) => {
                        const isSelf = row.original.userId === currentUserId;
                        return (
                            <div className="flex justify-end gap-1.5">
                                <Tooltip
                                    content={
                                        isSelf
                                            ? t('tooltipCannotChangeOwnRole')
                                            : t('tooltipChangeRoleFor', {
                                                  email: row.original.user.email,
                                              })
                                    }
                                >
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        disabled={isSelf}
                                        onClick={() => setRoleTarget(row.original)}
                                        data-testid={`org-member-role-${row.original.userId}`}
                                    >
                                        <Shield className="size-3.5" aria-hidden="true" />
                                        {t('changeRole')}
                                    </Button>
                                </Tooltip>
                                <Tooltip
                                    content={
                                        isSelf
                                            ? t('tooltipCannotRemoveSelf')
                                            : t('tooltipRemove', {
                                                  email: row.original.user.email,
                                              })
                                    }
                                >
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="text-content-error"
                                        disabled={isSelf}
                                        onClick={() => setRemoveTarget(row.original)}
                                        data-testid={`org-member-remove-${row.original.userId}`}
                                    >
                                        <UserMinus
                                            className="size-3.5"
                                            aria-hidden="true"
                                        />
                                        {t('remove')}
                                    </Button>
                                </Tooltip>
                            </div>
                        );
                    },
                },
            ]),
        [currentUserId, t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="flex items-end justify-between gap-default flex-wrap">
                    <div>
                        <Heading level={1}>
                            {t('title')}
                        </Heading>
                        <p className="text-sm text-content-muted mt-1">
                            {t('membersSummary', { count: rows.length })}
                        </p>
                    </div>
                    <div className="flex gap-tight">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setInviteOpen(true)}
                            data-testid="org-members-invite-button"
                        >
                            <Mail className="size-4" aria-hidden="true" />
                            {t('inviteByEmail')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            onClick={() => setAddOpen(true)}
                            data-testid="org-members-add-button"
                        >
                            <Plus className="size-4" aria-hidden="true" />
                            {t('addMember')}
                        </Button>
                    </div>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable<MemberRow>
                    fillBody
                    mobileFallback="card"
                    data={rows}
                    columns={columns}
                    getRowId={(r) => r.membershipId}
                    resourceName={(plural) =>
                        plural ? t('resourcePlural') : t('resourceSingular')
                    }
                    emptyState={
                        <TableEmptyState
                            title={t('emptyTitle')}
                            description={t('emptyDesc')}
                            icon={<Shield className="size-10" />}
                            action={{
                                label: t('addMember'),
                                onClick: () => setAddOpen(true),
                                variant: 'primary',
                            }}
                        />
                    }
                    data-testid="org-members-table"
                />

                {invites.length > 0 && (
                    <PendingInvitesSection
                        orgSlug={orgSlug}
                        invites={invites}
                        onMutate={() => router.refresh()}
                    />
                )}
            </ListPageShell.Body>

            <AddMemberModal
                orgSlug={orgSlug}
                open={addOpen}
                onClose={() => setAddOpen(false)}
                onSuccess={useCallback(() => {
                    setAddOpen(false);
                    router.refresh();
                }, [router])}
            />

            <InviteMemberModal
                orgSlug={orgSlug}
                open={inviteOpen}
                onClose={() => setInviteOpen(false)}
                onSuccess={useCallback(() => {
                    setInviteOpen(false);
                    router.refresh();
                }, [router])}
            />

            <RemoveMemberModal
                orgSlug={orgSlug}
                target={removeTarget}
                onClose={() => setRemoveTarget(null)}
                onSuccess={useCallback(() => {
                    setRemoveTarget(null);
                    router.refresh();
                }, [router])}
            />

            <ChangeRoleModal
                orgSlug={orgSlug}
                target={roleTarget}
                onClose={() => setRoleTarget(null)}
                onSuccess={useCallback(() => {
                    setRoleTarget(null);
                    router.refresh();
                }, [router])}
            />
        </ListPageShell>
    );
}

// ── Add member ────────────────────────────────────────────────────────

interface AddMemberModalProps {
    orgSlug: string;
    open: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

function AddMemberModal({ orgSlug, open, onClose, onSuccess }: AddMemberModalProps) {
    const t = useTranslations('org.members');
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<MemberRow['role']>('ORG_READER');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = () => {
        setEmail('');
        setRole('ORG_READER');
        setError(null);
        setSubmitting(false);
    };

    const close = () => {
        reset();
        onClose();
    };

    const onSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = email.trim().toLowerCase();
        if (!EMAIL_RE.test(trimmed)) {
            setError(t('invalidEmail'));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`/api/org/${orgSlug}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ userEmail: trimmed, role }),
            });
            if (!res.ok) {
                let message = t('addFailed', { status: res.status });
                try {
                    const body = (await res.json()) as { error?: { message?: string } };
                    if (body?.error?.message) message = body.error.message;
                } catch {
                    /* not JSON */
                }
                setError(message);
                setSubmitting(false);
                return;
            }
            reset();
            onSuccess();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Unexpected error adding member.',
            );
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal={open} setShowModal={(o) => (o ? null : close())}>
            <Modal.Header title={t('addModalTitle')} />
            <Modal.Body>
                <form
                    id="org-add-member-form"
                    onSubmit={onSubmit}
                    noValidate
                    className="space-y-default"
                    data-testid="org-add-member-form"
                >
                    <FormField
                        label={t('emailLabel')}
                        description={t('addEmailDesc')}
                        required
                    >
                        <Input
                            name="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            autoComplete="off"
                            autoFocus
                            placeholder={t('emailPlaceholder')}
                            data-testid="org-add-member-email"
                        />
                    </FormField>

                    <fieldset className="space-y-tight" data-testid="org-add-member-role-group">
                        <legend className="text-sm font-medium text-content-emphasis">
                            {t('roleLegend')}
                        </legend>
                        {(['ORG_READER', 'ORG_ADMIN'] as const).map((opt) => {
                            const id = `org-add-member-role-${opt}`;
                            const checked = role === opt;
                            return (
                                <label
                                    key={opt}
                                    htmlFor={id}
                                    className={`flex items-start gap-compact rounded-lg border p-3 cursor-pointer transition-colors ${
                                        checked
                                            ? 'border-border-emphasis bg-bg-subtle'
                                            : 'border-border-subtle hover:bg-bg-muted'
                                    }`}
                                >
                                    <input
                                        id={id}
                                        type="radio"
                                        name="role"
                                        value={opt}
                                        checked={checked}
                                        onChange={() => setRole(opt)}
                                        className="mt-0.5"
                                        data-testid={id}
                                    />
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-content-emphasis">
                                            {t(ROLE_LABEL_KEY[opt])}
                                        </p>
                                        <p className="text-xs text-content-muted">
                                            {t(ROLE_DESC_KEY[opt])}
                                        </p>
                                    </div>
                                </label>
                            );
                        })}
                    </fieldset>

                    {error && (
                        <p
                            className="text-sm text-content-error"
                            role="alert"
                            data-testid="org-add-member-error"
                        >
                            {error}
                        </p>
                    )}
                </form>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={close}
                        data-testid="org-add-member-cancel"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        form="org-add-member-form"
                        variant="primary"
                        loading={submitting}
                        disabled={submitting}
                        data-testid="org-add-member-submit"
                        text={submitting ? t('adding') : t('addMember')}
                    />
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}

// ── Remove member ─────────────────────────────────────────────────────

interface RemoveMemberModalProps {
    orgSlug: string;
    target: MemberRow | null;
    onClose: () => void;
    onSuccess: () => void;
}

function RemoveMemberModal({
    orgSlug,
    target,
    onClose,
    onSuccess,
}: RemoveMemberModalProps) {
    const t = useTranslations('org.members');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const open = target !== null;

    const close = () => {
        setError(null);
        setSubmitting(false);
        onClose();
    };

    const onConfirm = async () => {
        if (!target) return;
        setSubmitting(true);
        setError(null);
        try {
            const url = `/api/org/${orgSlug}/members?userId=${encodeURIComponent(target.userId)}`;
            const res = await fetch(url, {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!res.ok) {
                let message = t('removeFailed', { status: res.status });
                try {
                    const body = (await res.json()) as { error?: { message?: string } };
                    if (body?.error?.message) message = body.error.message;
                } catch {
                    /* not JSON */
                }
                setError(message);
                setSubmitting(false);
                return;
            }
            onSuccess();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Unexpected error removing member.',
            );
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal={open} setShowModal={(o) => (o ? null : close())}>
            <Modal.Header title={t('removeModalTitle')} />
            <Modal.Body>
                <div
                    className="space-y-compact text-sm"
                    data-testid="org-remove-member-body"
                >
                    {target && (
                        <>
                            <p className="text-content-default">
                                {t.rich('removeConfirm', {
                                    name: target.user.name ?? target.user.email,
                                    b: (chunks) => (
                                        <span className="font-medium text-content-emphasis">
                                            {chunks}
                                        </span>
                                    ),
                                })}
                            </p>
                            {target.role === 'ORG_ADMIN' && (
                                <div
                                    className="flex gap-tight rounded-lg border border-border-warning bg-bg-warning/30 p-3 text-content-warning"
                                    role="alert"
                                >
                                    <AlertTriangle
                                        className="size-4 mt-0.5 flex-shrink-0"
                                        aria-hidden="true"
                                    />
                                    <p>{t('removeAdminWarning')}</p>
                                </div>
                            )}
                            {error && (
                                <p
                                    className="text-content-error"
                                    role="alert"
                                    data-testid="org-remove-member-error"
                                >
                                    {error}
                                </p>
                            )}
                        </>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={close}
                        data-testid="org-remove-member-cancel"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        loading={submitting}
                        disabled={submitting}
                        onClick={onConfirm}
                        data-testid="org-remove-member-confirm"
                        text={submitting ? t('removing') : t('remove')}
                    />
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}

// ── Change role ──────────────────────────────────────────────────────

interface ChangeRoleModalProps {
    orgSlug: string;
    target: MemberRow | null;
    onClose: () => void;
    onSuccess: () => void;
}

function ChangeRoleModal({
    orgSlug,
    target,
    onClose,
    onSuccess,
}: ChangeRoleModalProps) {
    const t = useTranslations('org.members');
    // Cache the chosen role independently of the target prop so the
    // radio's controlled state survives re-renders while the modal
    // is open. Defaults to "the OTHER role" so the obvious action
    // is also the one the user came here to do.
    const [chosen, setChosen] = useState<MemberRow['role'] | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const open = target !== null;

    // When a new target opens, default the radio to the opposite role
    // (the typical operator intent: open this dialog to flip).
    if (target && chosen === null) {
        setChosen(target.role === 'ORG_ADMIN' ? 'ORG_READER' : 'ORG_ADMIN');
    }

    const close = () => {
        setError(null);
        setSubmitting(false);
        setChosen(null);
        onClose();
    };

    const onConfirm = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!target || !chosen) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`/api/org/${orgSlug}/members`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ userId: target.userId, role: chosen }),
            });
            if (!res.ok) {
                let message = t('changeRoleFailed', { status: res.status });
                try {
                    const body = (await res.json()) as { error?: { message?: string } };
                    if (body?.error?.message) message = body.error.message;
                } catch {
                    /* not JSON */
                }
                setError(message);
                setSubmitting(false);
                return;
            }
            onSuccess();
            // Reset cached chosen role so the next open recomputes
            // the default.
            setChosen(null);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Unexpected error changing role.',
            );
            setSubmitting(false);
        }
    };

    const isPromotion = target?.role === 'ORG_READER' && chosen === 'ORG_ADMIN';
    const isDemotion = target?.role === 'ORG_ADMIN' && chosen === 'ORG_READER';
    const isNoOp = target !== null && chosen !== null && target.role === chosen;

    return (
        <Modal showModal={open} setShowModal={(o) => (o ? null : close())}>
            <Modal.Header title={t('changeRoleModalTitle')} />
            <Modal.Body>
                <form
                    id="org-change-role-form"
                    onSubmit={onConfirm}
                    noValidate
                    className="space-y-default"
                    data-testid="org-change-role-form"
                >
                    {target && (
                        <p className="text-sm text-content-default">
                            {t.rich('changeRoleFor', {
                                name: target.user.name ?? target.user.email,
                                b: (chunks) => (
                                    <span className="font-medium text-content-emphasis">
                                        {chunks}
                                    </span>
                                ),
                            })}
                        </p>
                    )}

                    <fieldset className="space-y-tight">
                        <legend className="text-sm font-medium text-content-emphasis">
                            {t('newRoleLegend')}
                        </legend>
                        {(['ORG_ADMIN', 'ORG_READER'] as const).map((opt) => {
                            const id = `org-change-role-${opt}`;
                            const checked = chosen === opt;
                            return (
                                <label
                                    key={opt}
                                    htmlFor={id}
                                    className={`flex items-start gap-compact rounded-lg border p-3 cursor-pointer transition-colors ${
                                        checked
                                            ? 'border-border-emphasis bg-bg-subtle'
                                            : 'border-border-subtle hover:bg-bg-muted'
                                    }`}
                                >
                                    <input
                                        id={id}
                                        type="radio"
                                        name="role"
                                        value={opt}
                                        checked={checked}
                                        onChange={() => setChosen(opt)}
                                        className="mt-0.5"
                                        data-testid={id}
                                    />
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-content-emphasis">
                                            {t(ROLE_LABEL_KEY[opt])}
                                        </p>
                                        <p className="text-xs text-content-muted">
                                            {t(ROLE_DESC_KEY[opt])}
                                        </p>
                                    </div>
                                </label>
                            );
                        })}
                    </fieldset>

                    {/*
                      Provisioning side-effect callouts — make the
                      cross-tenant fan-out / fan-in effects of the
                      role change visible BEFORE the user commits.
                      The atomic role-change usecase does the full
                      provisioning in one transaction; the operator
                      should know that's what's about to happen.
                    */}
                    {isPromotion && (
                        <div
                            className="flex gap-tight rounded-lg border border-border-info bg-bg-info/30 p-3 text-content-info text-xs"
                            role="status"
                            data-testid="org-change-role-promotion-callout"
                        >
                            <Shield className="size-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                            <p>{t('promotionCallout')}</p>
                        </div>
                    )}
                    {isDemotion && (
                        <div
                            className="flex gap-tight rounded-lg border border-border-warning bg-bg-warning/30 p-3 text-content-warning text-xs"
                            role="status"
                            data-testid="org-change-role-demotion-callout"
                        >
                            <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                            <p>{t('demotionCallout')}</p>
                        </div>
                    )}

                    {error && (
                        <p
                            className="text-sm text-content-error"
                            role="alert"
                            data-testid="org-change-role-error"
                        >
                            {error}
                        </p>
                    )}
                </form>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={close}
                        data-testid="org-change-role-cancel"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="submit"
                        form="org-change-role-form"
                        variant="primary"
                        loading={submitting}
                        disabled={submitting || isNoOp || chosen === null}
                        data-testid="org-change-role-submit"
                        text={submitting ? t('saving') : t('saveRole')}
                    />
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}

// ── Invite member (Epic D) ────────────────────────────────────────────

interface InviteMemberModalProps {
    orgSlug: string;
    open: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

function InviteMemberModal({ orgSlug, open, onClose, onSuccess }: InviteMemberModalProps) {
    const t = useTranslations('org.members');
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<MemberRow['role']>('ORG_READER');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
    const [emailSent, setEmailSent] = useState(false);
    const [issuedEmail, setIssuedEmail] = useState('');

    const reset = () => {
        setEmail('');
        setRole('ORG_READER');
        setError(null);
        setSubmitting(false);
        setIssuedUrl(null);
        setEmailSent(false);
        setIssuedEmail('');
    };

    const close = () => {
        reset();
        onClose();
    };

    const onSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = email.trim().toLowerCase();
        if (!EMAIL_RE.test(trimmed)) {
            setError(t('invalidEmail'));
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`/api/org/${orgSlug}/invites`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ email: trimmed, role }),
            });
            if (!res.ok) {
                let message = t('inviteFailed', { status: res.status });
                try {
                    const body = (await res.json()) as { error?: { message?: string } };
                    if (body?.error?.message) message = body.error.message;
                } catch {
                    /* not JSON */
                }
                setError(message);
                setSubmitting(false);
                return;
            }
            const body = (await res.json()) as {
                url?: string;
                emailSent?: boolean;
                invite?: { email?: string };
            };
            // The recipient is emailed the acceptance link directly
            // (emailSent). The URL is still surfaced as a copy-paste
            // fallback — useful if email delivery is unconfigured or the
            // admin wants to share it out-of-band too.
            const origin =
                typeof window !== 'undefined' ? window.location.origin : '';
            setIssuedUrl(body.url ? origin + body.url : null);
            setEmailSent(body.emailSent === true);
            setIssuedEmail(body.invite?.email ?? trimmed);
            setSubmitting(false);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Unexpected error creating invite.',
            );
            setSubmitting(false);
        }
    };

    const issued = issuedUrl !== null;

    return (
        <Modal showModal={open} setShowModal={(o) => (o ? null : close())}>
            <Modal.Header
                title={
                    issued
                        ? emailSent
                            ? t('invitationSentTitle')
                            : t('inviteCreatedTitle')
                        : t('inviteByEmail')
                }
            />
            <Modal.Body>
                {issued ? (
                    <div className="space-y-compact text-sm" data-testid="org-invite-issued">
                        {emailSent ? (
                            <p className="text-content-default" data-testid="org-invite-emailed">
                                {t.rich('invitationEmailed', {
                                    email: issuedEmail,
                                    b: (chunks) => (
                                        <span className="font-medium text-content-emphasis">
                                            {chunks}
                                        </span>
                                    ),
                                })}
                            </p>
                        ) : (
                            <p className="text-content-default">
                                {t.rich('inviteCreatedNoEmail', {
                                    email: issuedEmail,
                                    b: (chunks) => (
                                        <span className="font-medium text-content-emphasis">
                                            {chunks}
                                        </span>
                                    ),
                                })}
                            </p>
                        )}
                        <p className="text-xs text-content-muted">
                            {emailSent ? t('copyLinkAlso') : t('copyLinkBelow')}
                        </p>
                        <div className="rounded-lg border border-border-subtle bg-bg-subtle p-3 break-all font-mono text-xs">
                            {issuedUrl}
                        </div>
                        <p className="text-xs text-content-muted">
                            {t('inviteTip')}
                        </p>
                    </div>
                ) : (
                    <form
                        id="org-invite-member-form"
                        onSubmit={onSubmit}
                        noValidate
                        className="space-y-default"
                        data-testid="org-invite-member-form"
                    >
                        <FormField
                            label={t('emailLabel')}
                            description={t('inviteEmailDesc')}
                            required
                        >
                            <Input
                                name="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                autoComplete="off"
                                autoFocus
                                placeholder={t('emailPlaceholder')}
                                data-testid="org-invite-member-email"
                            />
                        </FormField>

                        <fieldset className="space-y-tight" data-testid="org-invite-member-role-group">
                            <legend className="text-sm font-medium text-content-emphasis">
                                {t('roleLegend')}
                            </legend>
                            {(['ORG_READER', 'ORG_ADMIN'] as const).map((opt) => {
                                const id = `org-invite-member-role-${opt}`;
                                const checked = role === opt;
                                return (
                                    <label
                                        key={opt}
                                        htmlFor={id}
                                        className={`flex items-start gap-compact rounded-lg border p-3 cursor-pointer transition-colors ${
                                            checked
                                                ? 'border-border-emphasis bg-bg-subtle'
                                                : 'border-border-subtle hover:bg-bg-muted'
                                        }`}
                                    >
                                        <input
                                            id={id}
                                            type="radio"
                                            name="role"
                                            value={opt}
                                            checked={checked}
                                            onChange={() => setRole(opt)}
                                            className="mt-0.5"
                                            data-testid={id}
                                        />
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-content-emphasis">
                                                {t(ROLE_LABEL_KEY[opt])}
                                            </p>
                                            <p className="text-xs text-content-muted">
                                                {opt === 'ORG_ADMIN'
                                                    ? t('roleAdminDescAccept')
                                                    : t('roleReaderDesc')}
                                            </p>
                                        </div>
                                    </label>
                                );
                            })}
                        </fieldset>

                        {error && (
                            <p
                                className="text-sm text-content-error"
                                role="alert"
                                data-testid="org-invite-member-error"
                            >
                                {error}
                            </p>
                        )}
                    </form>
                )}
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    {issued ? (
                        <Button
                            type="button"
                            variant="primary"
                            onClick={() => {
                                onSuccess();
                            }}
                            data-testid="org-invite-issued-done"
                            text={t('doneBtn')}
                        />
                    ) : (
                        <>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={close}
                                data-testid="org-invite-member-cancel"
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                type="submit"
                                form="org-invite-member-form"
                                variant="primary"
                                loading={submitting}
                                disabled={submitting}
                                data-testid="org-invite-member-submit"
                                text={submitting ? t('creating') : t('sendInvite')}
                            />
                        </>
                    )}
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}

// ── Pending invites section ───────────────────────────────────────────

interface PendingInvitesSectionProps {
    orgSlug: string;
    invites: PendingInviteRow[];
    onMutate: () => void;
}

function PendingInvitesSection({ orgSlug, invites, onMutate }: PendingInvitesSectionProps) {
    const { formatDate } = useDateFormat();
    const t = useTranslations('org.members');
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const revoke = useCallback(
        async (inviteId: string) => {
            setRevokingId(inviteId);
            setError(null);
            try {
                const res = await fetch(
                    `/api/org/${orgSlug}/invites/${inviteId}`,
                    { method: 'DELETE', credentials: 'same-origin' },
                );
                if (!res.ok) {
                    let message = t('revokeFailed', { status: res.status });
                    try {
                        const body = (await res.json()) as {
                            error?: { message?: string };
                        };
                        if (body?.error?.message) message = body.error.message;
                    } catch {
                        /* not JSON */
                    }
                    setError(message);
                    setRevokingId(null);
                    return;
                }
                onMutate();
            } catch (err) {
                setError(
                    err instanceof Error
                        ? err.message
                        : 'Unexpected error revoking invite.',
                );
                setRevokingId(null);
            }
        },
        [orgSlug, onMutate],
    );

    const inviteColumns = useMemo(
        () =>
            createColumns<PendingInviteRow>([
                {
                    id: 'email',
                    header: t('colEmail'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {row.original.email}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'title' } },
                },
                {
                    id: 'role',
                    header: t('colRole'),
                    cell: ({ row }) => (
                        <StatusBadge variant={ROLE_VARIANT[row.original.role]}>
                            {t(ROLE_LABEL_KEY[row.original.role])}
                        </StatusBadge>
                    ),
                    meta: { mobileCard: { slot: 'status', label: t('colRole') } },
                },
                {
                    id: 'invitedBy',
                    header: t('colInvitedBy'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-muted">
                            {row.original.invitedBy?.name ??
                                row.original.invitedBy?.email ??
                                '—'}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colInvitedBy') } },
                },
                {
                    id: 'expiresAt',
                    header: t('colExpires'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-subtle tabular-nums">
                            {formatDate(row.original.expiresAt)}
                        </span>
                    ),
                    meta: { mobileCard: { slot: 'meta', label: t('colExpires') } },
                },
                {
                    id: 'actions',
                    header: '',
                    cell: ({ row }) => (
                        <div className="flex justify-end">
                            <Tooltip content={t('tooltipRevokeInvite', { email: row.original.email })}>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="text-content-error"
                                    disabled={revokingId === row.original.id}
                                    onClick={() => revoke(row.original.id)}
                                    data-testid={`org-invite-revoke-${row.original.id}`}
                                >
                                    <X className="size-3.5" aria-hidden="true" />
                                    {revokingId === row.original.id ? t('revoking') : t('revoke')}
                                </Button>
                            </Tooltip>
                        </div>
                    ),
                },
            ]),
        [revokingId, revoke, t],
    );

    return (
        <div className="mt-8" data-testid="org-pending-invites-section">
            <Heading level={2} className="mb-2">
                {t('pendingInvitations')}
                <span className="ml-2 text-sm font-normal text-content-muted">
                    ({invites.length})
                </span>
            </Heading>
            {error && (
                <p
                    className="text-sm text-content-error mb-2"
                    role="alert"
                    data-testid="org-pending-invites-error"
                >
                    {error}
                </p>
            )}
            <DataTable<PendingInviteRow>
                mobileFallback="card"
                data={invites}
                columns={inviteColumns}
                getRowId={(r) => r.id}
                resourceName={(plural) =>
                    plural ? t('inviteResourcePlural') : t('inviteResourceSingular')
                }
                data-testid="org-pending-invites-table"
            />
        </div>
    );
}
