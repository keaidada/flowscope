import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface StatsPopoverProps {
  tableCount: number;
  columnCount: number;
  joinCount: number;
  complexityScore: number;
  className?: string;
}

function ComplexityDotsInline({ score }: { score: number }) {
  const dotValue = Math.min(5, Math.max(0.5, Math.ceil(score / 10) / 2));
  const fullDots = Math.floor(dotValue);
  const hasHalfDot = dotValue % 1 !== 0;

  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => {
        const isFull = i < fullDots;
        const isHalf = i === fullDots && hasHalfDot;

        return (
          <span
            key={i}
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              isFull && 'bg-foreground',
              isHalf && 'bg-linear-to-r from-foreground from-50% to-muted-foreground/30 to-50%',
              !isFull && !isHalf && 'bg-muted-foreground/30'
            )}
          />
        );
      })}
    </div>
  );
}

export function StatsPopover({
  tableCount,
  columnCount,
  joinCount,
  complexityScore,
  className,
}: StatsPopoverProps) {
  const { t } = useTranslation();

  function getComplexityLabel(score: number): string {
    if (score <= 33) return t('analysis.complexityLow');
    if (score <= 66) return t('analysis.complexityMed');
    return t('analysis.complexityHigh');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-full',
            'bg-muted/30 hover:bg-muted/50 transition-colors duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            className
          )}
        >
          <ComplexityDotsInline score={complexityScore} />
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          {t('analysis.analysisSummary')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <div className="px-2 py-1.5 space-y-1">
          <StatRow label={t('analysis.tables')} value={tableCount} />
          <StatRow label={t('analysis.columns')} value={columnCount} />
          <StatRow label={t('analysis.joins')} value={joinCount} />
        </div>

        <DropdownMenuSeparator />

        <div className="px-2 py-1.5">
          <StatRow label={t('analysis.complexity')} value={getComplexityLabel(complexityScore)} />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  );
}
