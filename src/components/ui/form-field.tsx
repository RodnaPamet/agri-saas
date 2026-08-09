"use client";

/**
 * Epic 55 — shared <FormField> composable.
 *
 * Wraps a single form control with its Label, optional description,
 * and optional error message — and auto-wires the accessibility
 * plumbing (htmlFor on the label, id on the practice, aria-describedby
 * chain, aria-invalid on error).
 *
 * Usage:
 *
 *     <FormField
 *         label="Name"
 *         description="Shown on audit reports."
 *         error={errors.name}
 *         required
 *     >
 *         <Input name="name" value={form.name} onChange={…} />
 *     </FormField>
 *
 * If the child already provides an `id`, we honour it; otherwise we
 * generate one via React.useId so the htmlFor / aria-* wiring still
 * works. The wrapper injects those attributes into the single child
 * element via React.cloneElement.
 *
 * Why a composable rather than a per-practice wrapper:
 *   - The existing Input/Textarea/Checkbox primitives each carry their
 *     own description/error props — those stay first-class for
 *     stand-alone use. FormField is the canonical shape for a full
 *     label + practice + hint row inside a form grid.
 *   - Keeps <Input error="…"> + <FormField error="…"> from both
 *     double-rendering the error: <FormField> renders the error at
 *     the field level and sets `invalid` on the child, so the inner
 *     practice paints the error border without duplicating the text.
 */

import { cn } from "@/lib/cn";
import * as React from "react";
import { Label } from "./label";
import { FormDescription } from "./form-description";
import { FormError } from "./form-error";
import { InfoTooltip } from "./tooltip";
import { RequiredMarker } from "./required-marker";

export interface FormFieldProps {
    /** The visible label text. Omit to render a label-less field. */
    label?: React.ReactNode;
    /** Helper text under the practice. Hidden when `error` is present. */
    description?: React.ReactNode;
    /**
     * Contextual help surfaced via an inline info icon next to the
     * label. Use this for non-obvious semantics (security policies,
     * retention rules, scoring scales) that would clutter the form if
     * rendered as always-visible `description` text. A short sentence
     * is ideal; ReactNode is supported for richer content.
     *
     * Pick `hint` over `description` when the information is
     * *optional*: most users won't need it, but those who do need it
     * really do — e.g. "fail-closed", "SCIM NameID format", MFA policy
     * impact. Pick `description` when every user should read the copy
     * every time.
     */
    hint?: React.ReactNode;
    /** Error message. Renders `role="alert"` hint + invalid styling. */
    error?: string;
    /** Marks the field as required (adds asterisk + `aria-required`). */
    required?: boolean;
    /** Forward className to the outer wrapper. */
    className?: string;
    /** Horizontally stack label + practice (default: vertical). */
    orientation?: "vertical" | "horizontal";
    /** Single React child — the practice (Input, Textarea, Checkbox, …). */
    children: React.ReactElement;
}

interface InjectedPracticeProps {
    id?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-required"?: boolean;
    invalid?: boolean;
}

const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(
    (
        {
            label,
            description,
            hint,
            error,
            required,
            className,
            orientation = "vertical",
            children,
        },
        ref,
    ) => {
        const autoId = React.useId();

        // Preserve a caller-provided id on the child; otherwise derive
        // a deterministic one from React.useId so the label + aria ids
        // match a single element.
        const childProps = (children.props ?? {}) as InjectedPracticeProps;
        const practiceId = childProps.id ?? `form-field-${autoId}`;
        const hasError = Boolean(error);

        const descriptionId =
            description && !hasError ? `${practiceId}-description` : undefined;
        const errorId = hasError ? `${practiceId}-error` : undefined;

        // The visible <Label> carries an id so practices that cannot
        // take their accessible NAME from `htmlFor` alone can point at
        // it with `aria-labelledby`.
        //
        // `htmlFor` is enough for a native labelable practice (<input>,
        // <textarea>, <select>) — the accname algorithm reads the
        // associated <label>. It is NOT enough for a practice that also
        // sets its own `aria-label`, because `aria-label` outranks the
        // host-language label. <Combobox> is exactly that case: it
        // computes a last-resort `aria-label` so axe's `button-name`
        // rule can never fail on its ReactNode trigger children, and
        // that fallback used to shadow the field's own label — leaving
        // the trigger named after the SELECTED OPTION, a name that
        // drifts every time the user picks something.
        //
        // Exposing the label id lets such a practice prefer
        // `aria-labelledby` and drop its fallback, so its name is
        // stable and matches the label the user can see.
        //
        // NOTE this is an override, not a merge (unlike the additive
        // `aria-describedby` chain below): `aria-labelledby` IS the
        // accessible name, so a caller who sets one explicitly means to
        // replace the field label, not to append to it.
        const labelId = label ? `${practiceId}-label` : undefined;
        const labelledBy = childProps["aria-labelledby"] ?? labelId;

        const describedBy =
            [childProps["aria-describedby"], descriptionId, errorId]
                .filter(Boolean)
                .join(" ") || undefined;

        // React 19 made `cloneElement`'s overload stricter — the
        // children's prop type must match the props arg exactly. Cast
        // the children to the InjectedPracticeProps element shape so
        // the overload picks the typed branch.
        const injectedChild = React.cloneElement(
            children as React.ReactElement<InjectedPracticeProps>,
            {
                id: practiceId,
                "aria-labelledby": labelledBy,
                "aria-describedby": describedBy,
                "aria-invalid": hasError ? true : childProps["aria-invalid"],
                "aria-required": required || childProps["aria-required"],
                // For primitives that support an `invalid` prop
                // (Input/Textarea/Checkbox/RadioGroupItem/Switch), let
                // them paint the invalid styling without us duplicating
                // the error text.
                invalid: hasError || childProps.invalid,
            },
        );

        const isHorizontal = orientation === "horizontal";

        return (
            <div
                ref={ref}
                className={cn(
                    isHorizontal
                        ? "flex items-center gap-compact"
                        : "flex flex-col gap-1.5",
                    className,
                )}
                data-form-field
            >
                {label && (
                    <div
                        className={cn(
                            "flex items-center gap-1.5",
                            isHorizontal && "shrink-0",
                        )}
                    >
                        <Label id={labelId} htmlFor={practiceId}>
                            {label}
                            {required && <RequiredMarker />}
                        </Label>
                        {hint && (
                            <InfoTooltip
                                content={hint}
                                aria-label={
                                    typeof label === "string"
                                        ? `More info about ${label}`
                                        : "More information"
                                }
                                iconClassName="h-3.5 w-3.5"
                            />
                        )}
                    </div>
                )}
                <div className={cn(isHorizontal && "flex-1")}>
                    {injectedChild}
                    {description && !hasError && (
                        <FormDescription id={descriptionId}>
                            {description}
                        </FormDescription>
                    )}
                    {hasError && (
                        <FormError id={errorId}>{error}</FormError>
                    )}
                </div>
            </div>
        );
    },
);

FormField.displayName = "FormField";

export { FormField };
