/**
 * Email notification service barrel exports.
 */
export { enqueueEmail, buildDedupeKey, type EnqueueEmailInput } from './enqueue';
export { processOutbox, type ProcessOutboxOptions, type ProcessOutboxResult } from './processOutbox';
export {
    getTenantNotificationSettings,
    updateTenantNotificationSettings,
    isNotificationsEnabled,
    getOutboxStats,
    type TenantNotificationSettingsData,
    type OutboxStats,
} from './settings';
export {
    buildTaskAssignedEmail,
    buildEvidenceExpiringEmail,
    buildPolicyApprovalRequestedEmail,
    buildPolicyDecisionEmail,
    type EmailTemplateResult,
    type TaskAssignedPayload,
    type EvidenceExpiringPayload,
    type PolicyApprovalRequestedPayload,
    type PolicyDecisionPayload,
} from './templates';
export {
    buildDeadlineDigestEmail,
    buildEvidenceExpiryDigestEmail,
    type DeadlineDigestPayload,
    type EvidenceExpiryDigestPayload,
} from './digest-templates';
export {
    dispatchDigest,
    buildDigestDedupeKey,
    type DigestCategory,
    type DispatchDigestOptions,
    type DispatchDigestResult,
} from './digest-dispatcher';
