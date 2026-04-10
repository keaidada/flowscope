import { useState, useEffect } from 'react';
import { Database, GitBranch, Shield, Keyboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { STORAGE_KEYS } from '@/lib/constants';

interface WelcomeModalProps {
  onClose?: () => void;
}

export function WelcomeModal({ onClose }: WelcomeModalProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const hasSeenWelcome = localStorage.getItem(STORAGE_KEYS.WELCOME_SHOWN) === 'true';
    if (!hasSeenWelcome) {
      setOpen(true);
    }
  }, []);

  const handleClose = () => {
    localStorage.setItem(STORAGE_KEYS.WELCOME_SHOWN, 'true');
    setOpen(false);
    onClose?.();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">{t('welcome.title')}</DialogTitle>
          <DialogDescription>{t('welcome.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-start gap-3">
            <Database className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-sm">{t('welcome.sqlLineage')}</p>
              <p className="text-sm text-muted-foreground">{t('welcome.sqlLineageDesc')}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <GitBranch className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-sm">{t('welcome.multiFile')}</p>
              <p className="text-sm text-muted-foreground">{t('welcome.multiFileDesc')}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-sm">{t('welcome.privacyFirst')}</p>
              <p className="text-sm text-muted-foreground">{t('welcome.privacyFirstDesc')}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <Keyboard className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-sm">{t('welcome.keyboardDriven')}</p>
              <p className="text-sm text-muted-foreground">
                <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border">⌘P</kbd> projects,{' '}
                <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border">⌘O</kbd> files,{' '}
                <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border">⌘Enter</kbd> analyze
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose}>{t('welcome.getStarted')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
