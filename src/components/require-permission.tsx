'use client';

import { usePermissions } from '@/lib/tenant-context-provider';
import type { PermissionSet } from '@/lib/permissions';

type Resource = keyof PermissionSet;

type RequirePermissionProps<R extends Resource> = {
    resource: R;
    action: keyof PermissionSet[R];
    children: React.ReactNode;
    fallback?: React.ReactNode;
};

/**
 * A generic helper component to conditionally render UI based on the user's granular permissions.
 * It strictly types the `resource` and `action` against the `PermissionSet` to prevent typos.
 *
 * Usage:
 * <RequirePermission resource="practices" action="edit" fallback={<span>Read Only</span>}>
 *   <EditButton />
 * </RequirePermission>
 */
export function RequirePermission<R extends Resource>({
    resource,
    action,
    children,
    fallback = null,
}: RequirePermissionProps<R>) {
    const permissions = usePermissions();
    
    // permissions[resource][action] is guaranteed to be a boolean due to PermissionSet typing
    const hasPermission = permissions[resource][action] as boolean;

    if (hasPermission) {
        return <>{children}</>;
    }

    return <>{fallback}</>;
}
