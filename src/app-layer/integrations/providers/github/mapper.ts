/**
 * GitHub Field Mapper
 *
 * Concrete BaseFieldMapper for mapping between inflect-compliance
 * local objects and GitHub branch protection rule structures.
 *
 * Demonstrates the bidirectional mapping pattern:
 *   - Local practice fields → GitHub protection rule fields
 *   - GitHub protection rule fields → local practice fields
 *
 * @module integrations/providers/github-mapper
 */
import { BaseFieldMapper, type FieldMappings, type FieldMapperOptions } from '../../base-mapper';

// ─── Status Mappings ─────────────────────────────────────────────────

const LOCAL_TO_REMOTE_STATUS: Record<string, string> = {
    IMPLEMENTED: 'enabled',
    NOT_STARTED: 'disabled',
    IN_PROGRESS: 'partial',
};

const REMOTE_TO_LOCAL_STATUS: Record<string, string> = {
    enabled: 'IMPLEMENTED',
    disabled: 'NOT_STARTED',
    partial: 'IN_PROGRESS',
};

// ─── Mapper Implementation ───────────────────────────────────────────

export class GitHubBranchProtectionMapper extends BaseFieldMapper {
    /**
     * Field mapping: local inflect-compliance field → GitHub API field path.
     */
    protected readonly fieldMappings: FieldMappings = {
        // Local field                → GitHub protection rule field
        protectionEnabled:             'enabled',
        requiredReviewCount:           'required_pull_request_reviews.required_approving_review_count',
        dismissStaleReviews:           'required_pull_request_reviews.dismiss_stale_reviews',
        requireCodeOwnerReviews:       'required_pull_request_reviews.require_code_owner_reviews',
        requireStatusChecks:           'required_status_checks.strict',
        statusCheckContexts:           'required_status_checks.contexts',
        enforceAdmins:                 'enforce_admins.enabled',
        allowForcePushes:              'allow_force_pushes.enabled',
        allowDeletions:                'allow_deletions.enabled',
        requireLinearHistory:          'required_linear_history.enabled',
        status:                        'status',
    };

    constructor(options?: FieldMapperOptions) {
        super(options);
    }

    // ── Transform Hooks ──

    protected transformToRemote(field: string, value: unknown): unknown {
        if (field === 'status') {
            return LOCAL_TO_REMOTE_STATUS[value as string] ?? value;
        }
        return value;
    }

    protected transformToLocal(field: string, value: unknown): unknown {
        if (field === 'status') {
            return REMOTE_TO_LOCAL_STATUS[value as string] ?? value;
        }
        return value;
    }
}
