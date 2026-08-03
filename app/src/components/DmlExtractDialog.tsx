/**
 * DmlExtractDialog — extract DML statements from SQL, display in a popup.
 *
 * No DB persistence — view + copy only.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { extractDml } from '@/lib/file-storage';

interface DmlExtractDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  filePath: string;
}

export function DmlExtractDialog({ open, onClose, projectId, filePath }: DmlExtractDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [statements, setStatements] = useState<string[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    extractDml(projectId, filePath)
      .then(result => setStatements(result.statements))
      .catch(e => {
        console.error('Extract DML failed:', e);
        setStatements([]);
      })
      .finally(() => setLoading(false));
  }, [open, projectId, filePath]);

  const copyOne = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  const copyAll = () => {
    navigator.clipboard.writeText(statements.join('\n;\n'));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-background border rounded-lg shadow-xl w-[80vw] max-w-5xl h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b shrink-0">
          <h2 className="text-sm font-semibold">📋 {t('editor.extractDml', 'DML 语句提取')}</h2>
          <div className="flex items-center gap-2">
            {statements.length > 0 && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={copyAll}>
                {copiedAll ? <Check className="h-3 w-3 mr-1 text-green-600" /> : <Copy className="h-3 w-3 mr-1" />}
                {t('editor.copyAll', '复制全部')}
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t('editor.extracting', '提取中...')}
            </div>
          ) : statements.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {t('editor.noDml', '未提取到 DML 语句')}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                {t('editor.foundDml', '提取到')} <b className="text-foreground">{statements.length}</b> {t('editor.dmlStatements', '条 DML 语句')}:
              </div>
              {statements.map((stmt, i) => (
                <div key={i} className="border rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase">
                      {t('editor.statement', '语句')} {i + 1}
                    </span>
                    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]" onClick={() => copyOne(stmt, i)}>
                      {copiedIdx === i ? <Check className="h-2.5 w-2.5 text-green-600" /> : <Copy className="h-2.5 w-2.5" />}
                    </Button>
                  </div>
                  <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-auto max-h-64">{stmt}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
