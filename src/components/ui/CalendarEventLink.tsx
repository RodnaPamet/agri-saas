'use client';

/**
 * Click-through for a calendar event, internal or external.
 *
 * Every calendar source until now was a tenant fact whose `href` was a
 * tenant-relative route, so both render sites used `next/link` directly.
 * The agriculture catalogue breaks that assumption: an `AgriEvent` links to
 * an organiser's own site, and `next/link` cannot take an absolute external
 * URL — it would try to client-route to it.
 *
 * Rather than branch at both call sites (the month grid and the side
 * panel), the choice lives here once. Internal hrefs keep client-side
 * navigation; external ones get a plain anchor opened in a new tab.
 *
 * `rel="noopener noreferrer"` is not optional and must not be "simplified"
 * away: without `noopener` the opened page can reach back through
 * `window.opener`, and an e2e asserts its presence.
 */

import Link from 'next/link';
import * as React from 'react';

interface CalendarEventLinkProps {
    href: string;
    /** True when `href` points off-site — see CalendarEvent.external. */
    external?: boolean;
    className?: string;
    title?: string;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
    children: React.ReactNode;
}

export function CalendarEventLink({
    href,
    external,
    className,
    title,
    onClick,
    children,
}: CalendarEventLinkProps) {
    if (external) {
        return (
            <a
                href={href}
                title={title}
                className={className}
                onClick={onClick}
                target="_blank"
                rel="noopener noreferrer"
            >
                {children}
            </a>
        );
    }

    return (
        <Link href={href} title={title} className={className} onClick={onClick}>
            {children}
        </Link>
    );
}
