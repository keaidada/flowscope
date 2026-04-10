import type { JSX } from 'react';
import { FileCode, Table2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLineage } from '../store';
import type { LineageViewMode } from '../types';
import { PANEL_STYLES } from '../constants';
import {
  GraphTooltip,
  GraphTooltipContent,
  GraphTooltipProvider,
  GraphTooltipTrigger,
  GraphTooltipArrow,
  GraphTooltipPortal,
} from './ui/graph-tooltip';

/**
 * Segmented control for switching between different lineage view modes.
 * Displays two options: Script and Table views.
 */
export function ViewModeSelector(): JSX.Element {
  const { t } = useTranslation();
  const { state, actions } = useLineage();
  const { viewMode } = state;
  const { setViewMode } = actions;

  const VIEW_MODES: Array<{
    value: LineageViewMode;
    label: string;
    description: string;
    icon: React.ElementType;
  }> = [
    {
      value: 'script',
      label: t('viewMode.script'),
      description: t('viewMode.scriptDesc'),
      icon: FileCode,
    },
    {
      value: 'table',
      label: t('viewMode.table'),
      description: t('viewMode.tableDesc'),
      icon: Table2,
    },
  ];

  return (
    <GraphTooltipProvider>
      <div
        className={PANEL_STYLES.selector}
        role="radiogroup"
        aria-label={t('viewMode.selectMode')}
        data-graph-panel
      >
        {VIEW_MODES.map((mode) => {
          const isActive = viewMode === mode.value;
          const Icon = mode.icon;

          return (
            <GraphTooltip key={mode.value} delayDuration={300}>
              <GraphTooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  aria-label={mode.label}
                  onClick={() => setViewMode(mode.value)}
                  className={`
                    inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-200
                    ${
                      isActive
                        ? 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                    }
                    focus-visible:outline-hidden
                  `}
                >
                  <Icon className="size-4" strokeWidth={isActive ? 2.5 : 1.5} />
                </button>
              </GraphTooltipTrigger>
              <GraphTooltipPortal>
                <GraphTooltipContent side="bottom">
                  <p>{mode.description}</p>
                  <GraphTooltipArrow />
                </GraphTooltipContent>
              </GraphTooltipPortal>
            </GraphTooltip>
          );
        })}
      </div>
    </GraphTooltipProvider>
  );
}
