'use client';
import { useDateFormat } from '@/lib/i18n/use-date-format';
import { useMemo } from 'react';
import { Activity, CreditCard, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { DataTable, createColumns } from '@/components/ui/table';

/**
 * Renders a list of recent billing events with icons and human-readable labels.
 * Receives pre-formatted events from the server component.
 */

const EVENT_CONFIG: Record<string, { label: string; icon: typeof Activity; color: string }> = {
    'checkout.session.completed': { label: 'Checkout completed', icon: CreditCard, color: 'text-content-success' },
    'customer.subscription.created': { label: 'Subscription created', icon: CheckCircle, color: 'text-[var(--brand-default)]' },
    'customer.subscription.updated': { label: 'Subscription updated', icon: Activity, color: 'text-content-info' },
    'customer.subscription.deleted': { label: 'Subscription canceled', icon: XCircle, color: 'text-content-error' },
    'invoice.payment_failed': { label: 'Payment failed', icon: AlertTriangle, color: 'text-content-error' },
    'invoice.payment_succeeded': { label: 'Payment succeeded', icon: CheckCircle, color: 'text-content-success' },
};

interface BillingEvent {
    id: string;
    type: string;
    stripeEventId: string;
    createdAt: string;
}

export function BillingEventLog({ events }: { events: BillingEvent[] }) {
    const { formatDateTime } = useDateFormat();
    const columns = useMemo(() => createColumns<BillingEvent>([
        {
            id: 'event',
            header: 'Event',
            accessorKey: 'type',
            cell: ({ row }) => {
                const config = EVENT_CONFIG[row.original.type] || {
                    label: row.original.type,
                    icon: Activity,
                    color: 'text-content-muted',
                };
                const Icon = config.icon;
                return (
                    <div className="flex items-center gap-tight">
                        <Icon className={`w-4 h-4 ${config.color}`} />
                        <span className="text-sm text-content-emphasis">{config.label}</span>
                    </div>
                );
            },
        },
        {
            id: 'time',
            header: 'Time',
            accessorKey: 'createdAt',
            cell: ({ getValue }) => (
                <span className="text-content-muted whitespace-nowrap">
                    {formatDateTime(getValue() as string)}
                </span>
            ),
        },
        {
            id: 'stripeId',
            header: 'Stripe ID',
            accessorKey: 'stripeEventId',
            cell: ({ getValue }) => (
                <span className="text-content-subtle font-mono">
                    {(getValue() as string).slice(0, 20)}…
                </span>
            ),
        },
    ]), [formatDateTime]);

    return (
        <DataTable
            data={events}
            columns={columns}
            getRowId={(e) => e.id}
            emptyState="No billing events yet."
            resourceName={(p) => p ? 'events' : 'event'}
            data-testid="billing-event-log"
        />
    );
}
