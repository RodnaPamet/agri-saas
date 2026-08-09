/**
 * Cadence utility for computing next due dates based on practice frequency.
 */

type PracticeFrequency = 'AD_HOC' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';

/**
 * Compute the next due date based on frequency and a reference date.
 * AD_HOC returns null (no automatic scheduling).
 */
export function computeNextDueAt(frequency: PracticeFrequency | string | null | undefined, fromDate: Date = new Date()): Date | null {
    if (!frequency || frequency === 'AD_HOC') return null;

    const next = new Date(fromDate);

    switch (frequency) {
        case 'DAILY':
            next.setDate(next.getDate() + 1);
            break;
        case 'WEEKLY':
            next.setDate(next.getDate() + 7);
            break;
        case 'MONTHLY':
            next.setMonth(next.getMonth() + 1);
            break;
        case 'QUARTERLY':
            next.setMonth(next.getMonth() + 3);
            break;
        case 'ANNUALLY':
            next.setFullYear(next.getFullYear() + 1);
            break;
        default:
            return null;
    }

    return next;
}
