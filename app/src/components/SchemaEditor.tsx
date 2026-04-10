import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { SqlView } from '@pondpilot/flowscope-react';
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
}

export function SchemaEditor({
  open,
  onOpenChange,
  schemaSQL,
  onSave,
  isReadOnly = false,
}: SchemaEditorProps) {
  const { t } = useTranslation();
  const [editedSQL, setEditedSQL] = useState(schemaSQL);
  const theme = useThemeStore((state) => state.theme);
  const isDark = resolveTheme(theme) === 'dark';

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
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isReadOnly ? t('schemaEditor.viewTitle') : t('schemaEditor.editTitle')}</DialogTitle>
          <DialogDescription>
            {isReadOnly ? t('schemaEditor.viewDesc') : t('schemaEditor.editDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 border rounded-md overflow-hidden">
          <SqlView
            value={editedSQL}
            onChange={isReadOnly ? undefined : setEditedSQL}
            className="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
            editable={!isReadOnly}
            isDark={isDark}
          />
        </div>

        <DialogFooter>
          {isReadOnly ? (
            <Button onClick={handleClose}>{t('common.close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSave}>{t('schemaEditor.saveSchema')}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
