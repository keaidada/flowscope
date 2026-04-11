import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ComplexityDotsProps {
  score: number;
  className?: string;
}

export function ComplexityDots({ score, className }: ComplexityDotsProps) {
  const { t } = useTranslation();

  function getComplexityLabel(score: number): string {
    if (score <= 20) return t('analysis.complexitySimple');
    if (score <= 40) return t('analysis.complexityModerate');
    if (score <= 60) return t('analysis.complexityComplex');
    if (score <= 80) return t('analysis.complexityVeryComplex');
    return t('analysis.complexityHighlyComplex');
  }

  const dotValue = Math.min(5, Math.max(0.5, Math.ceil(score / 10) / 2));
  const fullDots = Math.floor(dotValue);
  const hasHalfDot = dotValue % 1 !== 0;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn('flex items-center gap-0.5 cursor-default', className)}>
            {Array.from({ length: 5 }).map((_, i) => {
              const isFull = i < fullDots;
              const isHalf = i === fullDots && hasHalfDot;

              return (
                <span
                  key={i}
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    isFull && 'bg-foreground',
                    isHalf &&
                      'bg-linear-to-r from-foreground from-50% to-muted-foreground/30 to-50%',
                    !isFull && !isHalf && 'bg-muted-foreground/30'
                  )}
                />
              );
            })}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="font-medium">{getComplexityLabel(score)}</p>
          <p className="text-xs text-muted-foreground">
            {t('analysis.complexityScore', { score })}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
