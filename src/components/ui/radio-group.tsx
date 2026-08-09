"use client";

/**
 * Epic 55 — shared <RadioGroup> + <RadioGroupItem> primitives.
 *
 * Wraps `@radix-ui/react-radio-group` with semantic-token styling.
 * Drops the legacy Dub `border-primary` classes; tokens are brand-*
 * for the selected dot and border-default/-emphasis for the ring.
 *
 * Size variant aligns with Checkbox so mixed groups of radio + check
 * practices line up vertically in the same form.
 */

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

export const radioItemVariants = cva(
    [
        "aspect-square shrink-0 rounded-full border transition-colors",
        "bg-bg-default border-border-default",
        "hover:border-border-emphasis",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default",
        "data-[state=checked]:border-brand-emphasis data-[state=checked]:text-brand-emphasis",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[invalid]:border-border-error data-[invalid]:focus-visible:ring-border-error",
    ],
    {
        variants: {
            size: {
                sm: "h-4 w-4",
                md: "h-5 w-5",
                lg: "h-6 w-6",
            },
        },
        defaultVariants: { size: "md" },
    },
);

const RadioGroup = React.forwardRef<
    React.ElementRef<typeof RadioGroupPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
    <RadioGroupPrimitive.Root
        ref={ref}
        className={cn("grid gap-tight", className)}
        {...props}
    />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

export interface RadioGroupItemProps
    extends React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>,
        VariantProps<typeof radioItemVariants> {
    invalid?: boolean;
}

const indicatorSizeForRadio = {
    sm: "h-2 w-2",
    md: "h-2.5 w-2.5",
    lg: "h-3 w-3",
} as const;

const RadioGroupItem = React.forwardRef<
    React.ElementRef<typeof RadioGroupPrimitive.Item>,
    RadioGroupItemProps
>(({ className, size, invalid, ...props }, ref) => (
    <RadioGroupPrimitive.Item
        ref={ref}
        data-invalid={invalid ? "" : undefined}
        aria-invalid={invalid || undefined}
        className={cn(radioItemVariants({ size }), className)}
        {...props}
    >
        <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
            <span
                className={cn(
                    "rounded-full bg-brand-emphasis",
                    indicatorSizeForRadio[size ?? "md"],
                )}
            />
        </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };
