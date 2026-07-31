/**
 * ModelManager — model list + stats + auto-discover + edit.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Search, Box } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { governanceApi, type ModelEntry, type ModelStats } from '@/lib/governance-api';

const LAYER_COLORS: Record<string, string> = {
  ODS: 'bg-orange-100 text-orange-700',
  DWD: 'bg-blue-100 text-blue-700',
  DWS: 'bg-green-100 text-green-700',
  ADS: 'bg-purple-100 text-purple-700',
  DIM: 'bg-gray-100 text-gray-700',
  unknown: 'bg-muted text-muted-foreground',
};

export function ModelManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [stats, setStats] = useState<ModelStats | null>(null);
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
      const res = await governanceApi['listModels'](params.toString());
      setModels(res);
      const s = await governanceApi['modelStats'](projectId);
      setStats(s);
    } catch (e) {
      console.error('Model list failed:', e);
    } finally {
      setLoading(false);
    }
  }, [projectId, layerFilter, search]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleAutoDiscover = async () => {
    if (!projectId) return;
    try {
      const result = await governanceApi['autoDiscover'](projectId);
      console.log('Auto-discover result:', result);
      await refresh();
    } catch (e) {
      console.error('Auto-discover failed:', e);
    }
  };

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  return (
    <div className="flex h-full">
      {/* Left: list + filters */}
      <div className="w-96 border-r flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          <div className="flex items-center gap-1 flex-1">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('governance.searchModels', '搜索模型...')}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleAutoDiscover} disabled={loading}>
            <Sparkles className="h-3.5 w-3.5 mr-1" />
            {t('governance.autoDiscover', '自动发现')}
          </Button>
        </div>

        {/* Layer filter */}
        <div className="flex gap-1 px-3 py-2 border-b">
          {['', 'ODS', 'DWD', 'DWS', 'ADS', 'DIM'].map((l) => (
            <button
              key={l}
              onClick={() => setLayerFilter(l)}
              className={cn(
                'px-2 py-0.5 rounded text-xs',
                layerFilter === l ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
              )}
            >
              {l || 'All'}
            </button>
          ))}
        </div>

        {/* Stats bar */}
        {stats && (
          <div className="flex gap-3 px-3 py-1.5 border-b bg-muted/20 text-xs text-muted-foreground">
            <span>{t('governance.total', '总计')}: <b className="text-foreground">{stats.total}</b></span>
            {Object.entries(stats.by_layer).slice(0, 4).map(([layer, count]) => (
              <span key={layer}>{layer}: <b className="text-foreground">{count}</b></span>
            ))}
          </div>
        )}

        {/* Model list */}
        <div className="flex-1 overflow-auto">
          {models.map((m) => {
            const colorClass = LAYER_COLORS[m.model_layer] || LAYER_COLORS.unknown;
            return (
              <button
                key={m.id}
                onClick={() => setSelected(m)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors border-b',
                  selected?.id === m.id && 'bg-accent'
                )}
              >
                <Box className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium truncate flex-1">{m.table_name}</span>
                <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', colorClass)}>
                  {m.model_layer}
                </span>
                {m.model_type && (
                  <span className="text-[10px] text-muted-foreground">{m.model_type}</span>
                )}
              </button>
            );
          })}
          {!loading && models.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {t('governance.noModels', '暂无模型，点击"自动发现"导入')}
            </div>
          )}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-auto p-4">
        {selected ? (
          <ModelDetail model={selected} projectId={projectId} onUpdate={refresh} />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('governance.selectModel', '选择左侧模型查看详情')}
          </div>
        )}
      </div>
    </div>
  );
}

function ModelDetail({ model, projectId, onUpdate }: { model: ModelEntry; projectId: string; onUpdate: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(model.owner);
  const [domain, setDomain] = useState(model.business_domain);
  const [desc, setDesc] = useState(model.description);
  const [layer, setLayer] = useState(model.model_layer);

  const handleSave = async () => {
    try {
      await governanceApi['updateModel'](projectId, model.table_name, {
        layer, domain, owner, description: desc,
      });
      setEditing(false);
      onUpdate();
    } catch (e) {
      console.error('Update failed:', e);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{model.table_name}</h2>
        <Button variant={editing ? 'default' : 'outline'} size="sm" onClick={editing ? handleSave : () => setEditing(true)}>
          {editing ? t('common.save', '保存') : t('common.edit', '编辑')}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <DetailField label={t('governance.layer', '层级')} value={model.model_layer} editing={editing} editValue={layer} onEdit={setLayer} options={['ODS', 'DWD', 'DWS', 'ADS', 'DIM', 'unknown']} />
        <DetailField label={t('governance.type', '类型')} value={model.model_type} />
        <DetailField label={t('governance.domain', '业务域')} value={model.business_domain} editing={editing} editValue={domain} onEdit={setDomain} />
        <DetailField label={t('governance.owner', '负责人')} value={model.owner} editing={editing} editValue={owner} onEdit={setOwner} />
        <DetailField label={t('governance.lifecycle', '生命周期')} value={model.lifecycle} />
        <DetailField label={t('governance.source', '来源')} value={model.source} />
      </div>

      <div>
        <label className="text-xs text-muted-foreground">{t('governance.description', '描述')}</label>
        {editing ? (
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} className="w-full mt-1 p-2 border rounded text-sm" rows={3} />
        ) : (
          <p className="text-sm mt-1">{model.description || '-'}</p>
        )}
      </div>
    </div>
  );
}

function DetailField({ label, value, editing, editValue, onEdit, options }: {
  label: string; value: string; editing?: boolean; editValue?: string; onEdit?: (v: string) => void;
  options?: string[];
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      {editing && onEdit !== undefined ? (
        options ? (
          <select value={editValue} onChange={(e) => onEdit(e.target.value)} className="w-full mt-1 px-2 py-1 border rounded text-sm">
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input value={editValue} onChange={(e) => onEdit(e.target.value)} className="w-full mt-1 px-2 py-1 border rounded text-sm" />
        )
      ) : (
        <p className="text-sm mt-1 font-medium">{value || '-'}</p>
      )}
    </div>
  );
}
