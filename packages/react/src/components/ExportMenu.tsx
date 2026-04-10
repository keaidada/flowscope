import { useCallback, type JSX } from 'react';
import { toPng } from 'html-to-image';
import { useTranslation } from 'react-i18next';
import { Download, Image, FileJson, FileSpreadsheet, FileCode, FileText } from 'lucide-react';
import { useLineage } from '../store';
import { UI_CONSTANTS } from '../constants';
import {
  downloadXlsx,
  downloadJson,
  downloadMermaid,
  downloadHtml,
  downloadPng,
} from '../utils/exportUtils';
import {
  GraphTooltip,
  GraphTooltipContent,
  GraphTooltipProvider,
  GraphTooltipTrigger,
  GraphTooltipArrow,
  GraphTooltipPortal,
} from './ui/graph-tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from './ui/dropdown-menu';

export interface ExportMenuProps {
  graphRef: React.RefObject<HTMLDivElement>;
}

export function ExportMenu({ graphRef }: ExportMenuProps): JSX.Element {
  const { t } = useTranslation();
  const { state } = useLineage();
  const { result } = state;

  const handleDownloadPng = useCallback(async () => {
    if (graphRef.current === null) {
      return;
    }

    try {
      const dataUrl = await toPng(graphRef.current, { backgroundColor: '#fff' });
      await downloadPng(dataUrl);
    } catch (err) {
      console.error('Failed to export image:', err);
    }
  }, [graphRef]);

  const handleDownloadXlsx = useCallback(async () => {
    if (!result) return;
    try {
      await downloadXlsx(result);
    } catch (err) {
      console.error('Failed to export Excel:', err);
    }
  }, [result]);

  const handleDownloadJson = useCallback(async () => {
    if (!result) return;
    try {
      await downloadJson(result);
    } catch (err) {
      console.error('Failed to export JSON:', err);
    }
  }, [result]);

  const handleDownloadMermaid = useCallback(async () => {
    if (!result) return;
    try {
      await downloadMermaid(result);
    } catch (err) {
      console.error('Failed to export Mermaid:', err);
    }
  }, [result]);

  const handleDownloadHtml = useCallback(async () => {
    if (!result) return;
    try {
      await downloadHtml(result);
    } catch (err) {
      console.error('Failed to export HTML:', err);
    }
  }, [result]);

  return (
    <GraphTooltipProvider>
      <GraphTooltip delayDuration={UI_CONSTANTS.TOOLTIP_DELAY}>
        <DropdownMenu>
          <GraphTooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-500 transition-all duration-200 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-slate-100 focus-visible:outline-hidden"
                aria-label={t('exportMenu.exportLineage')}
              >
                <Download className="size-4" strokeWidth={1.5} />
              </button>
            </DropdownMenuTrigger>
          </GraphTooltipTrigger>
          <GraphTooltipPortal>
            <GraphTooltipContent side="bottom">
              <p>{t('exportMenu.exportLineage')}</p>
              <GraphTooltipArrow />
            </GraphTooltipContent>
          </GraphTooltipPortal>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>{t('exportMenu.dataFormats')}</DropdownMenuLabel>
            <DropdownMenuItem onClick={handleDownloadXlsx}>
              <FileSpreadsheet className="size-4 mr-2" />
              {t('exportMenu.excel')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDownloadJson}>
              <FileJson className="size-4 mr-2" />
              {t('exportMenu.json')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('exportMenu.visualFormats')}</DropdownMenuLabel>
            <DropdownMenuItem onClick={handleDownloadPng}>
              <Image className="size-4 mr-2" />
              {t('exportMenu.pngImage')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDownloadMermaid}>
              <FileCode className="size-4 mr-2" />
              {t('exportMenu.mermaid')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDownloadHtml}>
              <FileText className="size-4 mr-2" />
              {t('exportMenu.htmlReport')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </GraphTooltip>
    </GraphTooltipProvider>
  );
}
