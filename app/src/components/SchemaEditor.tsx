import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SqlView } from '@pondpilot/flowscope-react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { useThemeStore, resolveTheme } from '@/lib/theme-store';
import type { Dialect } from '@/lib/project-store';

interface SchemaEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaSQL: string;
  dialect: Dialect;
  onSave: (schemaSQL: string) => void;
  isReadOnly?: boolean;
  loading?: boolean;
}

export function SchemaEditor({
  open,
  onOpenChange,
  schemaSQL,
  onSave,
  isReadOnly = false,
  loading = false,
}: SchemaEditorProps) {
  const { t } = useTranslation();
  const [editedSQL, setEditedSQL] = useState(schemaSQL);
  const theme = useThemeStore((state) => state.theme);
  const isDark = resolveTheme(theme) === 'dark';

  // Sync editedSQL when schemaSQL changes (e.g. async loading completes)
  useEffect(() => {
    setEditedSQL(schemaSQL);
  }, [schemaSQL]);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (newOpen) {
        setEditedSQL(schemaSQL);
      }
      onOpenChange(newOpen);
    },
    [schemaSQL, onOpenChange]
  );

  const handleSave = useCallback(() => {
    if (isReadOnly) return;
    onSave(editedSQL);
    onOpenChange(false);
  }, [editedSQL, onSave, onOpenChange, isReadOnly]);

  const handleClose = useCallback(() => {
    setEditedSQL(schemaSQL);
    onOpenChange(false);
  }, [schemaSQL, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {isReadOnly ? t('schemaEditor.viewTitle') : t('schemaEditor.editTitle')}
          </DialogTitle>
          <DialogDescription>
            {isReadOnly ? t('schemaEditor.viewDesc') : t('schemaEditor.editDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 border rounded-md overflow-hidden relative">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">{t('schemaEditor.loading')}</span>
            </div>
          ) : (
            <SqlView
              value={editedSQL}
              onChange={isReadOnly ? undefined : setEditedSQL}
              className="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
              editable={!isReadOnly}
              isDark={isDark}
            />
          )}
        </div>

        <DialogFooter>
          {isReadOnly ? (
            <Button onClick={handleClose}>{t('common.close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSave} disabled={loading}>
                {t('schemaEditor.saveSchema')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
