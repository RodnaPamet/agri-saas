import { SkeletonDetailTabs } from '@/components/ui/skeleton';

/**
 * Practice detail loading skeleton — back link + heading + pills + 5 tabs + content cards.
 * Matches the tabbed detail page layout for seamless streaming.
 */
export default function PracticeDetailLoading() {
    return <SkeletonDetailTabs tabCount={5} />;
}
