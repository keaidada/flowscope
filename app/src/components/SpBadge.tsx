import { cn } from '@/lib/utils';

interface SpBadgeProps {
  hasTransformedContent: boolean;
  className?: string;
}

export function SpBadge({ hasTransformedContent, className }: SpBadgeProps) {
  return (
    <span
      className={cn(
        'text-[9px] px-1 py-px rounded shrink-0 font-medium',
        hasTransformedContent
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
        className
      )}
    >
      SP
    </span>
  );
}
