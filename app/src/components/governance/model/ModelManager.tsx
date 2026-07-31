/**
 * ModelManager — full-height split layout: list + detail with all fields.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Search, Box, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { governanceApi, type ModelEntry } from '@/lib/governance-api';

const LAYER_COLORS: Record<string, string> = {
  ODS: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400',
  DWD: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
  DWS: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400',
  ADS: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400',
  DIM: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
  unknown: 'bg-muted text-muted-foreground',
};

export function ModelManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [layerFilter, setLayerFilter] = useState('');
  const [selected, setSelected] = useState<ModelEntry | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ project_id: projectId });
      if (layerFilter) params.set('layer', layerFilter);
      if (search) params.set('q', search);
      const res = await governanceApi.listModels(params.toString());
      setModels(res);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [projectId, layerFilter, search]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (!selected && models.length > 0) setSelected(models[0]); }, [models, selected]);

  const handleAutoDiscover = async () => {
    if (!projectId) return;
    try { await governanceApi.autoDiscover(projectId); await refresh(); } catch {}
  };

  if (!projectId) return <Center>{t('governance.selectProject')}</Center>;

  return (
    <div className="flex h-full">
      {/* Sidebar: list */}
      <div className="w-72 border-r flex flex-col shrink-0">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('governance.searchModels')}
            className="flex-1 bg-transparent text-xs outline-none min-w-0" />
          <Button variant="ghost" size="sm" onClick={handleAutoDiscover} disabled={loading} className="h-6 px-2 text-xs shrink-0">
            <Sparkles className="h-3 w-3 mr-1" />{t('governance.autoDiscover')}
          </Button>
        </div>
        <div className="flex gap-1 px-2 py-1.5 border-b overflow-x-auto">
          {['', 'ODS', 'DWD', 'DWS', 'ADS', 'DIM'].map(l => (
            <button key={l} onClick={() => setLayerFilter(l)}
              className={cn('px-2 py-0.5 rounded text-[11px] whitespace-nowrap',
                layerFilter === l ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-muted')}>
              {l || 'All'}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto">
          {models.map(m => (
            <button key={m.id} onClick={() => setSelected(m)}
              className={cn('w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 border-b transition-colors',
                selected?.id === m.id && 'bg-accent')}>
              <Box className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs font-medium truncate flex-1">{m.table_name}</span>
              <span className={cn('px-1 py-0.5 rounded text-[9px] font-bold shrink-0', LAYER_COLORS[m.model_layer] || LAYER_COLORS.unknown)}>
                {m.model_layer || '?'}
              </span>
            </button>
          ))}
          {!loading && models.length === 0 && (
            <div className="text-center py-8 text-xs text-muted-foreground px-3">{t('governance.noModels')}</div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-auto min-w-0">
        {selected ? <ModelDetail model={selected} projectId={projectId} onUpdate={refresh} /> : <Center>{t('governance.selectModel')}</Center>}
      </div>
    </div>
  );
}

function ModelDetail({ model, projectId, onUpdate }: { model: ModelEntry; projectId: string; onUpdate: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    layer: model.model_layer, domain: model.business_domain,
    owner: model.owner, desc: model.description, lifecycle: model.lifecycle,
  });

  const save = async () => {
    try {
      await governanceApi.updateModel(projectId, model.table_name, {
        layer: form.layer, domain: form.domain, owner: form.owner,
        description: form.desc, lifecycle: form.lifecycle,
      });
      setEditing(false); onUpdate();
    } catch {}
  };

  return (
    <div className="p-5 space-y-4">
      {/* Title row */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold font-mono truncate">{model.table_name}</h2>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-bold', LAYER_COLORS[model.model_layer] || LAYER_COLORS.unknown)}>{model.model_layer || 'unknown'}</span>
            {model.model_type && <span className="text-xs text-muted-foreground">{model.model_type}</span>}
            <span className={cn('px-1.5 py-0.5 rounded text-[10px]',
              model.lifecycle === 'active' ? 'bg-green-500/10 text-green-600' : model.lifecycle === 'deprecated' ? 'bg-red-500/10 text-red-600' : 'bg-muted text-muted-foreground')}>
              {model.lifecycle}
            </span>
          </div>
        </div>
        <Button variant={editing ? 'default' : 'outline'} size="sm" onClick={editing ? save : () => setEditing(true)} className="shrink-0 rounded-md h-7 text-xs">
          {editing ? t('governance.save') : t('common.edit', 'Edit')}
        </Button>
      </div>

      {/* Fields grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <Field label={t('governance.layer')} value={model.model_layer} editing={editing} editVal={form.layer}
          onEdit={v => setForm({ ...form, layer: v })} options={['ODS', 'DWD', 'DWS', 'ADS', 'DIM', 'unknown']} />
        <Field label={t('governance.type')} value={model.model_type} />
        <Field label={t('governance.domain')} value={model.business_domain} editing={editing} editVal={form.domain}
          onEdit={v => setForm({ ...form, domain: v })} />
        <Field label={t('governance.owner')} value={model.owner} editing={editing} editVal={form.owner}
          onEdit={v => setForm({ ...form, owner: v })} />
        <Field label={t('governance.lifecycle')} value={model.lifecycle} editing={editing} editVal={form.lifecycle}
          onEdit={v => setForm({ ...form, lifecycle: v })} options={['draft', 'active', 'deprecated', 'archived']} />
        <Field label={t('governance.source')} value={model.source} />
        {model.contract_id && <Field label="Contract ID" value={model.contract_id} mono />}
      </div>

      {/* Description */}
      <div>
        <label className="text-xs text-muted-foreground">{t('governance.description')}</label>
        {editing ? (
          <textarea value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })}
            className="w-full mt-1 p-2 border rounded text-sm resize-none" rows={2} />
        ) : (
          <p className="text-sm mt-1">{model.description || '-'}</p>
        )}
      </div>

      {/* Tags */}
      {model.tags.length > 0 && (
        <div>
          <label className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="h-3 w-3" />Tags</label>
          <div className="flex gap-1 mt-1 flex-wrap">
            {model.tags.map(tag => <span key={tag} className="px-2 py-0.5 bg-muted rounded text-xs">{tag}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, editing, editVal, onEdit, options, mono }: {
  label: string; value: string; editing?: boolean; editVal?: string; onEdit?: (v: string) => void;
  options?: string[]; mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label className="text-xs text-muted-foreground">{label}</label>
      {editing && onEdit ? (
        options ? (
          <select value={editVal} onChange={e => onEdit(e.target.value)} className="w-full mt-0.5 px-2 py-1 border rounded text-sm bg-background">
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input value={editVal} onChange={e => onEdit(e.target.value)} className="w-full mt-0.5 px-2 py-1 border rounded text-sm bg-background" />
        )
      ) : (
        <p className={cn('text-sm mt-0.5 font-medium truncate', mono && 'font-mono text-xs')}>{value || '-'}</p>
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{children}</div>;
}
