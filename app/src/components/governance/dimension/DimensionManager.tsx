/**
 * DimensionManager — dimension registry management.
 *
 * Features:
 * - Auto-discover dimension candidates from lineage
 * - Candidate → confirmed lifecycle (user clicks confirm)
 * - List dimensions with ref count, master table, attributes
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Check, X, Database, Search, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  governanceApi,
  type DimensionEntry,
} from '@/lib/governance-api';

export function DimensionManager({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [dimensions, setDimensions] = useState<DimensionEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [filter, setFilter] = useState<'all' | 'candidate' | 'confirmed'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const PAGE = 50;
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const r = await governanceApi.listDimensions(projectId, filter === 'all' ? undefined : filter, PAGE, page * PAGE);
      setDimensions(r.items);
      setTotal(r.total);
    } catch (e) {
      console.error('Dimension list failed:', e);
    } finally {
      setLoading(false);
    }
  }, [projectId, filter, page]);

  useEffect(() => { load(); }, [load]);

  // Reset page when filter changes
  useEffect(() => { setPage(0); }, [filter]);

  const handleDiscover = async () => {
    if (!projectId) return;
    setDiscovering(true);
    try {
      const r = await governanceApi.discoverDimensions(projectId);
      console.log(`Discovered ${r.discovered} dimensions`);
      await load();
    } catch (e) {
      console.error('Discover failed:', e);
    } finally {
      setDiscovering(false);
    }
  };

  const handleConfirm = async (dim: DimensionEntry) => {
    if (!projectId) return;
    try {
      await governanceApi.updateDimension(projectId, dim.id, { status: 'confirmed' });
      await load();
    } catch (e) { console.error('Confirm failed:', e); }
  };

  const handleDismiss = async (dim: DimensionEntry) => {
    if (!projectId) return;
    try {
      await governanceApi.updateDimension(projectId, dim.id, { status: 'dismissed' });
      await load();
    } catch (e) { console.error('Dismiss failed:', e); }
  };

  const filtered = search.trim()
    ? dimensions.filter(d =>
        d.dim_name.toLowerCase().includes(search.toLowerCase()) ||
        d.dim_column.toLowerCase().includes(search.toLowerCase()))
    : dimensions;

  const totalPages = Math.ceil(total / PAGE);
  const canPrev = page > 0;
  const canNext = (page + 1) * PAGE < total;

  if (!projectId) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">{t('governance.selectProject', '请先选择项目')}</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
        <div className="flex items-center gap-1">
          <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('all')} className="h-6 px-2 text-xs">
            全部
          </Button>
          <Button variant={filter === 'candidate' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('candidate')} className="h-6 px-2 text-xs">
            候选
          </Button>
          <Button variant={filter === 'confirmed' ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter('confirmed')} className="h-6 px-2 text-xs">
            已确认
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input type="text" placeholder="搜索维度..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-48 pl-7 pr-2 py-1 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <Button size="sm" onClick={handleDiscover} disabled={discovering} className="h-6 gap-1 text-xs px-2.5">
            {discovering ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {discovering ? '发现中...' : '自动发现'}
          </Button>
        </div>
      </div>

      {/* Dimension list */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            暂无维度数据，点击「自动发现」从血缘中提取维度候选
          </div>
        ) : (
          <div className="p-3 space-y-1">
            {filtered.map(d => (
              <div key={d.id} className="border rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/50 text-left"
                >
                  <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 text-sm font-medium truncate">{d.dim_name}</span>
                  <span className="text-[10px] text-muted-foreground font-mono">{d.dim_column}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary shrink-0">{d.ref_count}</span>
                  {d.status === 'candidate' && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">候选</span>
                  )}
                  {d.status === 'confirmed' && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">已确认</span>
                  )}
                </button>
                {expanded === d.id && (
                  <div className="px-3 pb-3 pl-9 space-y-2">
                    {/* Actions */}
                    {d.status === 'candidate' && (
                      <div className="flex gap-1.5">
                        <Button size="sm" className="h-6 gap-1 text-[11px] px-2 bg-green-600 hover:bg-green-700 text-white" onClick={() => handleConfirm(d)}>
                          <Check className="h-3 w-3" /> 确认维度
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 gap-1 text-[11px] px-2" onClick={() => handleDismiss(d)}>
                          <X className="h-3 w-3" /> 忽略
                        </Button>
                      </div>
                    )}
                    {/* Details */}
                    <div className="text-xs space-y-1">
                      <div className="flex items-start gap-2"><span className="text-muted-foreground w-14 shrink-0">原始列:</span><code className="font-mono">{d.dim_column}</code></div>
                      <div className="flex items-start gap-2"><span className="text-muted-foreground w-14 shrink-0">主维表:</span><code className="font-mono text-xs break-all">{d.master_table}</code></div>
                      <div className="flex items-start gap-2"><span className="text-muted-foreground w-14 shrink-0">引用数:</span><span>{d.ref_count} 张表引用</span></div>
                      {d.attributes.length > 0 && (
                        <div className="flex items-start gap-2"><span className="text-muted-foreground w-14 shrink-0">维度属性:</span>
                          <div className="flex flex-wrap gap-1">{d.attributes.slice(0, 10).map(a => <span key={a} className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 text-[10px] font-mono">{a}</span>)}</div>
                        </div>
                      )}
                      {d.ref_tables.length > 0 && (
                        <div className="flex items-start gap-2"><span className="text-muted-foreground w-14 shrink-0">引用表:</span>
                          <div className="flex flex-wrap gap-1">{d.ref_tables.slice(0, 8).map(t => <span key={t} className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 text-[10px] font-mono">{t}</span>)}{d.ref_tables.length > 8 && <span className="text-[10px] text-muted-foreground">+{d.ref_tables.length - 8}</span>}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE && (
        <div className="flex items-center justify-center gap-2 px-3 py-2 border-t shrink-0 text-xs text-muted-foreground">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={!canPrev} onClick={() => setPage(page - 1)}>上一页</Button>
          <span className="tabular-nums">第 {page + 1} / {totalPages} 页 · 共 {total} 个维度</span>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={!canNext} onClick={() => setPage(page + 1)}>下一页</Button>
        </div>
      )}
    </div>
  );
}
