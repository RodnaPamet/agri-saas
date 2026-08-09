/**
 * CopyText — Epic 56 inline copyable value.
 *
 * Renders a technical value (tenant id, evidence SHA, share link,
 * webhook secret, etc.) as an inline element the user can click to copy.
 * A tiny copy icon appears next to the value so the affordance is
 * obvious without cluttering the layout.
 *
 *   <CopyText value={tenantId}>{tenantId}</CopyText>
 *   <CopyText value={sharedUrl} label="Copy share link" truncate>
 *     {sharedUrl}
 *   </CopyText>
 *
 * Masking sensitive values:
 *   Consumers practice what's rendered via `children`. Pass the masked
 *   preview as children and the full secret as `value` — CopyText
 *   copies `value` while only displaying `children`:
 *
 *     <CopyText value={secret} label="Copy enrollment secret">
 *       {mask(secret)}
 *     </CopyText>
 */

"use client";

import { cn } from "@/lib/cn";
import { Check, Copy } from "lucide-react";
import { type ReactNode, forwardRef } from "react";
import { useToast } from "./hooks/use-toast";
import { Tooltip } from "./tooltip";
import { useCopyToClipboard } from "./hooks";

export interface CopyTextProps {
    /** Value written to the clipboard. May differ from the displayed children. */
    value: string;
    /** What the user sees. Defaults to `value` when omitted. */
    children?: ReactNode;
    /** Tooltip + accessible label. Defaults to "Copy". */
    label?: string;
    /** Toast shown on success. Defaults to `{label} copied`. */
    successMessage?: string;
    /** Toast shown on error. */
    errorMessage?: string;
    /** Instrumentation hook. Called once per successful copy. */
    onCopy?: (value: string) => void;
    /** Disables interaction and visually mutes the value. */
    disabled?: boolean;
    /** Truncate overly long values with ellipsis (single line). */
    truncate?: boolean;
    /** Hide the trailing copy icon (value itself remains clickable). */
    hideIcon?: boolean;
    className?: string;
}

export const CopyText = forwardRef<HTMLButtonElement, CopyTextProps>(
    function CopyText(
        {
            value,
            children,
            label = "Copy",
            successMessage,
            errorMessage = "Copy failed",
            onCopy,
            disabled,
            truncate,
            hideIcon,
            className,
        },
        ref,
    ) {
        const { copy, copied } = useCopyToClipboard();
        const toast = useToast();

        const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            if (disabled) return;
            const ok = await copy(value);
            if (ok) {
                onCopy?.(value);
                toast.success(successMessage ?? `${label} copied`);
            } else {
                toast.error(errorMessage);
            }
        };

        const button = (
            <button
                ref={ref}
                type="button"
                aria-label={label}
                disabled={disabled}
                data-copied={copied ? "true" : undefined}
                onClick={handleClick}
                className={cn(
                    "group inline-flex items-center gap-1.5 rounded-md text-left font-mono text-xs",
                    "text-content-default transition-colors",
                    "hover:text-content-emphasis",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-content-default",
                    !disabled && "cursor-copy",
                    className,
                )}
            >
                <span
                    className={cn(
                        "inline-block align-middle",
                        truncate && "max-w-trunc-default truncate",
                    )}
                >
                    {children ?? value}
                </span>
                {!hideIcon && (
                    <span
                        className={cn(
                            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-muted",
                            "transition-colors group-hover:text-content-default",
                            copied && "text-content-success",
                        )}
                        aria-hidden="true"
                    >
                        {copied ? (
                            <Check className="h-3 w-3" />
                        ) : (
                            <Copy className="h-3 w-3" />
                        )}
                    </span>
                )}
            </button>
        );

        if (disabled) return button;
        return <Tooltip content={copied ? "Copied" : label} disableHoverableContent>{button}</Tooltip>;
    },
);
