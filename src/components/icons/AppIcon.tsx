/**
 * AppIcon — renders a lucide icon by semantic name.
 *
 * Usage:
 *   <AppIcon name="dashboard" />
 *   <AppIcon name="practices" size={24} className="text-[var(--brand-default)]" />
 *   <AppIcon name="warning" aria-label="Warning" />
 */
import { ICON_MAP, ICON_DEFAULT_SIZE, type AppIconName } from './iconMap';

export interface AppIconProps {
    /** Semantic icon name from the icon map. */
    name: AppIconName;
    /** Size in px (default: ICON_DEFAULT_SIZE = 18). */
    size?: number;
    /** Additional CSS classes. */
    className?: string;
    /** If set, icon becomes accessible with this label; otherwise aria-hidden. */
    'aria-label'?: string;
}

export function AppIcon({
    name,
    size = ICON_DEFAULT_SIZE,
    className,
    'aria-label': ariaLabel,
}: AppIconProps) {
    const Icon = ICON_MAP[name];
    const isDecorative = !ariaLabel;
    return (
        <Icon
            className={className}
            size={size}
            aria-hidden={isDecorative ? true : undefined}
            aria-label={ariaLabel}
            role={isDecorative ? undefined : 'img'}
            focusable="false"
        />
    );
}

/** Re-export types and map for convenience. */
export { ICON_MAP, ICON_DEFAULT_SIZE, type AppIconName } from './iconMap';
