import { redirect } from 'next/navigation';

/**
 * Bare `/account` used to 404 — there was no index at all, so the only way in
 * was a deep link to one of the two sections. It now lands on the profile,
 * which is the section a person means when they say "my account".
 */
export default function AccountIndexPage() {
    redirect('/account/profile');
}
