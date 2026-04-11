import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { setLanguage } from '@/i18n';

const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

export function LanguageToggle() {
  const { i18n, t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-2 px-2 w-full justify-start">
          <Languages className="h-4 w-4" />
          <span className="text-sm">{t('app.language')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={i18n.language}
          onValueChange={(value) => setLanguage(value)}
        >
          {languageOptions.map(({ value, label }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2">
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
