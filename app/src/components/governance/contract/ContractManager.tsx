/**
 * ContractManager — list, view, edit, create ODCS contracts.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Plus, Save, Trash2, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { governanceApi, type ContractInfo } from '@/lib/governance-api';

interface ContractManagerProps {
  contracts: ContractInfo[];
  onRefresh: () => Promise<void>;
}

export function ContractManager({ contracts, onRefresh }: ContractManagerProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ valid: boolean; errors?: string[] } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');

  const loadContract = useCallback(async (name: string) => {
    try {
      const detail = await governanceApi.getContract(name);
      setContent(detail.content);
      setOriginalContent(detail.content);
      setValidation(null);
      setSelected(name);
    } catch (e) {
      console.error('Failed to load contract:', e);
    }
  }, []);

  useEffect(() => {
    if (!selected && contracts.length > 0) {
      loadContract(contracts[0].name);
    }
  }, [contracts, selected, loadContract]);

  const handleSave = async () => {
    if (!selected) return;
    try {
      await governanceApi.updateContract(selected, content);
      setOriginalContent(content);
      await onRefresh();
    } catch (e) {
      console.error('Failed to save contract:', e);
    }
  };

  const handleValidate = async () => {
    if (!selected) return;
    setValidating(true);
    try {
      // Save first so validation checks the latest content
      await governanceApi.updateContract(selected, content);
      const result = await governanceApi.validateContract(selected);
      setValidation(result);
      await onRefresh();
    } catch (e) {
      setValidation({ valid: false, errors: [String(e)] });
    } finally {
      setValidating(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(t('governance.confirmDelete', '确认删除契约？'))) return;
    try {
      await governanceApi.deleteContract(selected);
      setSelected(null);
      setContent('');
      await onRefresh();
    } catch (e) {
      console.error('Failed to delete:', e);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await governanceApi.createContract(newName, DEFAULT_NEW_CONTRACT);
      setShowNew(false);
      setNewName('');
      await onRefresh();
      await loadContract(newName);
    } catch (e) {
      console.error('Failed to create:', e);
    }
  };

  const dirty = content !== originalContent;

  return (
    <div className="flex h-full">
      {/* Contract list sidebar */}
      <div className="w-56 border-r bg-muted/20 overflow-auto">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-xs font-semibold text-muted-foreground">
            {t('governance.contracts', '契约管理')}
          </span>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {contracts.map((c) => (
          <button
            key={c.name}
            onClick={() => loadContract(c.name)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors',
              selected === c.name && 'bg-accent'
            )}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate flex-1">{c.name}</span>
            <span
              className={cn(
                'px-1 rounded text-[10px] font-medium',
                c.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'
              )}
            >
              {c.status}
            </span>
          </button>
        ))}
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-3 py-2 border-b">
              <span className="text-sm font-medium">{selected}</span>
              {dirty && <span className="text-xs text-yellow-600">●</span>}
              {validation && (
                <span className={cn('flex items-center gap-1 text-xs', validation.valid ? 'text-green-600' : 'text-red-600')}>
                  {validation.valid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                  {validation.valid ? t('governance.valid', '校验通过') : t('governance.invalid', '校验失败')}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={handleValidate} disabled={validating}>
                  {t('governance.validate', '校验')}
                </Button>
                <Button variant="default" size="sm" onClick={handleSave} disabled={!dirty}>
                  <Save className="h-3.5 w-3.5 mr-1" />
                  {t('governance.save', '保存')}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDelete} className="text-red-600">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Validation errors */}
            {validation && !validation.valid && validation.errors && (
              <div className="px-3 py-2 bg-red-50 border-b text-xs text-red-700">
                {validation.errors.map((e, i) => (
                  <div key={i}>• {e}</div>
                ))}
              </div>
            )}

            {/* YAML editor */}
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setValidation(null);
              }}
              className="flex-1 w-full p-3 font-mono text-xs bg-background resize-none outline-none"
              spellCheck={false}
            />
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('governance.selectContract', '选择一个契约或创建新契约')}
          </div>
        )}
      </div>

      {/* New contract dialog */}
      {showNew && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg p-4 shadow-lg w-80">
            <h3 className="text-sm font-semibold mb-3">
              {t('governance.newContract', '新建契约')}
            </h3>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="orders_pipeline"
              className="w-full px-3 py-2 border rounded text-sm mb-3"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowNew(false)}>
                {t('common.cancel', '取消')}
              </Button>
              <Button variant="default" size="sm" onClick={handleCreate} disabled={!newName.trim()}>
                {t('common.create', '创建')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DEFAULT_NEW_CONTRACT = `apiVersion: v3.1.0
kind: DataContract
id: new_contract
name: New Contract
version: 1.0.0
status: active

custom:
  flowscope:
    lineage_rules:
      - id: no_orphan_output
        severity: P2
    sql_rules:
      - id: no_select_star
        severity: P2
`;
