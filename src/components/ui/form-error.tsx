"use client";

/**
 * Epic 55 — shared <FormError> primitive.
 *
 * Error message that sits below a form control — one canonical shape
 * (`text-xs text-content-error mt-1.5`, `role="alert"`, `aria-live="polite"`)
 * so validation announcements behave consistently across the app.
 *
 * Usage:
 *   - Automatic, via `<FormField error="Required">`.
 *   - Standalone, for pages that assemble their own practice layouts
 *     but still want the canonical rhythm + a11y.
 *
 * Renders nothing when `children` is empty so callers can pass
 * conditional errors without `&&` guards at every site.
 */

import { cn } from "@/lib/cn";
import * as React from "react";

export interface FormErrorProps
    extends React.HTMLAttributes<HTMLParagraphElement> {
    /**
     * When explicitly `false` the error is not rendered regardless of
     * children — useful for state-driven visibility without unmount.
     */
    visible?: boolean;
}

const FormError = React.forwardRef<HTMLParagraphElement, FormErrorProps>(
    ({ className, children, visible = true, ...props }, ref) => {
        if (!visible) return null;
        const hasContent =
            children !== undefined &&
            children !== null &&
            children !== false &&
            children !== "";
        if (!hasContent) return null;

        return (
            <p
                ref={ref}
                role="alert"
                aria-live="polite"
                data-form-error
                className={cn(
                    "mt-1.5 text-xs text-content-error",
                    className,
                )}
                {...props}
            >
                {children}
            </p>
        );
    },
);

FormError.displayName = "FormError";

export { FormError };
