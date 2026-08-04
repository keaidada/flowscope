/**
 * SemanticYamlDialog — dbt Semantic Layer YAML generation dialog.
 *
 * Same layout/style as DbtConvertDialog:
 * - Header with icon badge + title + stats badge
 * - Action bar: 重新生成 / 复制全部
 * - Two views (toggle): YAML (monospace) / 可视化表格
 * - 应用 button to save to DB
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, Copy, Loader2, RotateCcw, FileJson, Table2, FileCode2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { generateSemanticYaml, saveDbtYaml } from '@/lib/file-storage';

interface SemanticYamlDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  filePath: string;
  onSaved: (yaml: string) => void;
}

interface ParsedMeasure {
  name: string;
  agg: string;
  expr: string;
  source: string;
  time_dim: string;
  full_sql: string;
}

interface ParsedDim {
  name: string;
  type: string;
  expr: string;
  source: string;
}

interface ParsedEntity {
  name: string;
  type: string;
  expr: string;
}

interface ParsedMetric {
  name: string;
  label: string;
  type: string;
  filter: string;
  measure: string;
  measure_filter: string;
  alias: string;
  agg_time_dimension: string;
}

interface ParsedSemantic {
  measures: ParsedMeasure[];
  dimensions: ParsedDim[];
  entities: ParsedEntity[];
  metrics: ParsedMetric[];
}

/** Minimal YAML block parser for our generated semantic_models structure. */
function parseSemanticYaml(yaml: string): ParsedSemantic {
  const result: ParsedSemantic = { measures: [], dimensions: [], entities: [], metrics: [] };
  if (!yaml) return result;

  const lines = yaml.split('\n');
  // Current section we're inside: '', 'measures', 'dimensions', 'entities', 'metrics'.
  let section = '';
  let currentMeasure: Partial<ParsedMeasure> | null = null;
  let currentDim: Partial<ParsedDim> | null = null;
  let currentEntity: Partial<ParsedEntity> | null = null;
  let currentMetric: Partial<ParsedMetric> | null = null;
  // Track nesting inside a metric's type_params.measure block.
  let inMetricMeasure = false;

  const flushMeasure = () => {
    if (currentMeasure?.name) {
      result.measures.push({
        name: currentMeasure.name,
        agg: currentMeasure.agg ?? '',
        expr: currentMeasure.expr ?? '',
        source: currentMeasure.source ?? '',
        time_dim: currentMeasure.time_dim ?? '',
        full_sql: currentMeasure.full_sql ?? '',
      });
    }
    currentMeasure = null;
  };
  const flushDim = () => {
    if (currentDim?.name) {
      result.dimensions.push({
        name: currentDim.name,
        type: currentDim.type ?? '',
        expr: currentDim.expr ?? '',
        source: currentDim.source ?? '',
      });
    }
    currentDim = null;
  };
  const flushEntity = () => {
    if (currentEntity?.name) {
      result.entities.push({
        name: currentEntity.name,
        type: currentEntity.type ?? '',
        expr: currentEntity.expr ?? '',
      });
    }
    currentEntity = null;
  };
  const flushMetric = () => {
    if (currentMetric?.name) {
      result.metrics.push({
        name: currentMetric.name,
        label: currentMetric.label ?? '',
        type: currentMetric.type ?? '',
        filter: currentMetric.filter ?? '',
        measure: currentMetric.measure ?? '',
        measure_filter: currentMetric.measure_filter ?? '',
        alias: currentMetric.alias ?? '',
        agg_time_dimension: currentMetric.agg_time_dimension ?? '',
      });
    }
    currentMetric = null;
  };
  const flushAll = () => { flushMeasure(); flushDim(); flushEntity(); flushMetric(); inMetricMeasure = false; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // Skip blank lines — they are purely cosmetic between blocks.
    if (!trimmed) continue;

    // Section headers at 4-space indent: "    measures:", "    dimensions:"
    if (/^ {4}[a-z_]+:$/.test(line)) {
      const sec = trimmed.replace(':', '');
      if (sec === 'measures' || sec === 'dimensions' || sec === 'entities') {
        section = sec;
        flushAll();
        continue;
      }
    }
    // Top-level (no indent): "metrics:" or a new top-level block.
    if (indent === 0) {
      if (trimmed === 'metrics:') {
        section = 'metrics';
        flushAll();
      } else {
        section = '';
        flushAll();
      }
      continue;
    }

    if (section === 'measures' && indent === 6 && trimmed.startsWith('- name:')) {
      flushMeasure();
      currentMeasure = { name: trimmed.replace('- name:', '').trim() };
      continue;
    }
    if (section === 'dimensions' && indent === 6 && trimmed.startsWith('- name:')) {
      flushDim();
      currentDim = { name: trimmed.replace('- name:', '').trim() };
      continue;
    }
    if (section === 'entities' && indent === 6 && trimmed.startsWith('- name:')) {
      flushEntity();
      currentEntity = { name: trimmed.replace('- name:', '').trim() };
      continue;
    }
    if (section === 'metrics' && indent === 2 && trimmed.startsWith('- name:')) {
      flushMetric();
      inMetricMeasure = false;
      currentMetric = { name: trimmed.replace('- name:', '').trim() };
      continue;
    }

    if (currentMeasure && indent > 6) {
      if (trimmed.startsWith('agg:')) currentMeasure.agg = trimmed.replace('agg:', '').trim();
      else if (trimmed.startsWith('expr:')) currentMeasure.expr = trimmed.replace('expr:', '').trim();
      else if (trimmed.startsWith('source_table:')) currentMeasure.source = trimmed.replace('source_table:', '').trim();
      else if (trimmed.startsWith('agg_time_dimension:')) currentMeasure.time_dim = trimmed.replace('agg_time_dimension:', '').trim();
      else if (trimmed.startsWith('description:') && trimmed.includes('Source:')) {
        const m = trimmed.match(/Source:\s*(.+?)(?:'|$)/);
        if (m) currentMeasure.source = m[1].trim();
      }
      else if (trimmed.startsWith('full_sql: |')) {
        // Collect deeper-indented lines following as the SQL body.
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const bl = lines[j];
          if (!bl.trim()) continue;
          const bindent = bl.length - bl.trimStart().length;
          if (bindent <= 8) break; // back to sibling measure key
          body.push(bl.trim());
        }
        currentMeasure.full_sql = body.join('\n');
        i += body.length; // skip consumed lines
      }
    }
    if (currentDim && indent > 6) {
      if (trimmed.startsWith('type:')) currentDim.type = trimmed.replace('type:', '').trim();
      else if (trimmed.startsWith('expr:')) currentDim.expr = trimmed.replace('expr:', '').trim();
      else if (trimmed.startsWith('description:') && trimmed.includes('Source:')) {
        const m = trimmed.match(/Source:\s*(.+?)(?:'|$)/);
        if (m) currentDim.source = m[1].trim();
      }
    }
    if (currentEntity && indent > 6) {
      if (trimmed.startsWith('type:')) currentEntity.type = trimmed.replace('type:', '').trim();
      else if (trimmed.startsWith('expr:')) currentEntity.expr = trimmed.replace('expr:', '').trim();
    }
    if (currentMetric) {
      // Metric keys at indent 4: name/description/label/type/filter
      if (indent === 4 && trimmed.startsWith('label:')) currentMetric.label = trimmed.replace('label:', '').trim().replace(/'/g, '');
      else if (indent === 4 && trimmed.startsWith('type:')) currentMetric.type = trimmed.replace('type:', '').trim();
      else if (indent === 4 && trimmed.startsWith('filter:')) currentMetric.filter = trimmed.replace('filter:', '').trim().replace(/'/g, '');
      // type_params block starts at indent 4, measure at indent 6
      else if (trimmed === 'measure:' && indent === 6) {
        inMetricMeasure = true;
      }
      // measure keys at indent 8
      else if (inMetricMeasure && indent === 8) {
        if (trimmed.startsWith('name:')) currentMetric.measure = trimmed.replace('name:', '').trim();
        else if (trimmed.startsWith('filter:')) currentMetric.measure_filter = trimmed.replace('filter:', '').trim().replace(/'/g, '');
        else if (trimmed.startsWith('alias:')) currentMetric.alias = trimmed.replace('alias:', '').trim();
      }
      // agg_time_dimension at indent 6 (sibling of measure under type_params)
      else if (indent === 6 && trimmed.startsWith('agg_time_dimension:')) {
        currentMetric.agg_time_dimension = trimmed.replace('agg_time_dimension:', '').trim();
        inMetricMeasure = false;
      }
    }
  }
  flushMeasure(); flushDim(); flushEntity(); flushMetric();
  return result;
}

export function SemanticYamlDialog({
  open, onClose, projectId, filePath, onSaved,
}: SemanticYamlDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [yaml, setYaml] = useState('');
  const [stats, setStats] = useState({ dimension_count: 0, measure_count: 0, source_count: 0, model_name: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'yaml' | 'table'>('yaml');

  const parsed = useMemo(() => parseSemanticYaml(yaml), [yaml]);

  const runGenerate = useCallback(() => {
    if (!open) return;
    setLoading(true);
    setSaved(false);
    setError('');
    generateSemanticYaml(projectId, filePath)
      .then(result => {
        setYaml(result.yaml);
        setStats({
          dimension_count: result.dimension_count,
          measure_count: result.measure_count,
          source_count: result.source_count,
          model_name: result.model_name,
        });
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('YAML generation failed:', msg);
        setError(msg);
        setYaml('');
      })
      .finally(() => setLoading(false));
  }, [open, projectId, filePath]);

  useEffect(() => { runGenerate(); }, [runGenerate]);

  const handleApply = useCallback(async () => {
    setSaving(true);
    try {
      await saveDbtYaml(projectId, filePath, yaml);
      onSaved(yaml);
      setSaved(true);
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      setSaving(false);
    }
  }, [projectId, filePath, yaml, onSaved]);

  const handleCopyAll = useCallback(async () => {
    await navigator.clipboard.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [yaml]);

  const lineCount = yaml ? yaml.split('\n').length : 0;

  return (
    <Dialog open={open} onOpenChange={() => { if (!saving) onClose(); }}>
      <DialogContent size="full">
        <DialogHeader className="px-3 pt-3 pb-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center justify-center w-6 h-6 rounded-md bg-purple-500/10">
              <FileJson className="h-3.5 w-3.5 text-purple-500" />
            </div>
            <DialogTitle>{t('editor.generateYaml', '生成 Semantic YAML')}</DialogTitle>
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
              {view === 'yaml' ? `${lineCount} 行` : `${parsed.measures.length} measures · ${parsed.dimensions.length} dims · ${parsed.metrics.length} metrics`}
              {stats.measure_count > 0 && view === 'yaml' && ` · ${stats.measure_count} measures · ${stats.dimension_count} dims · ${stats.source_count} sources`}
            </span>
          </div>
          <DialogDescription className="leading-tight">
            {filePath}
          </DialogDescription>
        </DialogHeader>

        {/* Action bar */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0 bg-muted/20">
          <div className="flex items-center gap-1.5">
            {/* View toggle */}
            <div className="flex items-center rounded-md border bg-background p-0.5 mr-1">
              <button
                onClick={() => setView('yaml')}
                className={cn(
                  'flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium transition-colors',
                  view === 'yaml' ? 'bg-purple-500/10 text-purple-600' : 'text-muted-foreground hover:text-foreground'
                )}
                title={t('editor.yamlView', 'YAML 视图')}
              >
                <FileCode2 className="h-3 w-3" />{t('editor.viewYaml', 'YAML')}
              </button>
              <button
                onClick={() => setView('table')}
                className={cn(
                  'flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium transition-colors',
                  view === 'table' ? 'bg-purple-500/10 text-purple-600' : 'text-muted-foreground hover:text-foreground'
                )}
                title={t('editor.tableView', '可视化表格')}
              >
                <Table2 className="h-3 w-3" />{t('editor.viewTable', '表格')}
              </button>
            </div>
            <Button size="sm" className="h-7 gap-1 bg-purple-500 hover:bg-purple-600 text-white text-[11px] px-2.5" onClick={runGenerate} disabled={loading}>
              <RotateCcw className="h-3 w-3" />{loading ? t('editor.generating', '生成中...') : t('editor.reGenerate', '重新生成')}
            </Button>
            {yaml && (
              <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px] px-2" onClick={handleCopyAll}>
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                {copied ? t('editor.copied', '已复制') : t('editor.copyAll', '复制全部')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> {t('editor.saved', '已保存')}</span>}
            {yaml && !error && (
              <Button
                size="sm"
                className="h-7 gap-1 bg-purple-500 hover:bg-purple-600 text-white text-[11px] px-3"
                onClick={handleApply}
                disabled={!yaml.trim() || saving}
              >
                {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : saved ? <Check className="h-3 w-3 mr-1" /> : null}
                {saved ? t('editor.saved', '已保存') : t('editor.apply', '应用')}
              </Button>
            )}
          </div>
        </div>

        {/* Content panel */}
        <div className="flex-1 min-h-0 overflow-auto bg-purple-50/20 dark:bg-purple-950/10">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm h-full">
              <Loader2 className="h-5 w-5 mr-2 animate-spin" /> {t('editor.generating', '生成中...')}
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive">
              <p className="font-medium mb-1">生成失败</p>
              <pre className="whitespace-pre-wrap text-xs">{error}</pre>
            </div>
          ) : view === 'yaml' ? (
            <div className="p-3">
              <pre className="text-xs font-mono whitespace-pre leading-[1.5]">{yaml}</pre>
            </div>
          ) : (
            <TableView parsed={parsed} t={t} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Table view: measures / dimensions / entities rendered as structured tables. */
function TableView({ parsed, t }: { parsed: ParsedSemantic; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="p-3 space-y-4">
      {/* Measures */}
      <section>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">
          {t('editor.measures', '指标')} ({parsed.measures.length})
        </h4>
        {parsed.measures.length === 0 ? (
          <div className="text-xs text-muted-foreground p-2 border border-dashed rounded">{t('editor.emptyMeasures', '无指标')}</div>
        ) : (
          <div className="overflow-x-auto border rounded-lg bg-card">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colName', '名称')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colAgg', '聚合')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colExpr', '表达式')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colSource', '来源表')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colTime', '时间维度')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colFullSql', '完整 SQL')}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.measures.map(m => (
                  <tr key={m.name} className="border-t align-top">
                    <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">{m.name}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 text-[10px] font-medium">{m.agg}</span>
                    </td>
                    <td className="px-2.5 py-1.5 font-mono break-all max-w-[280px]">{m.expr}</td>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap">{m.source}</td>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap">{m.time_dim}</td>
                    <td className="px-2.5 py-1.5">
                      {m.full_sql ? (
                        <pre className="text-[10px] font-mono bg-muted rounded p-1.5 whitespace-pre-wrap break-all max-h-28 overflow-auto">{m.full_sql}</pre>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Dimensions */}
      <section>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">
          {t('editor.dimensions', '维度')} ({parsed.dimensions.length})
        </h4>
        {parsed.dimensions.length === 0 ? (
          <div className="text-xs text-muted-foreground p-2 border border-dashed rounded">{t('editor.emptyDimensions', '无维度')}</div>
        ) : (
          <div className="overflow-x-auto border rounded-lg bg-card">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colName', '名称')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colType', '类型')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colExpr', '表达式')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colSource', '来源表')}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.dimensions.map(d => (
                  <tr key={d.name} className="border-t align-top">
                    <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">{d.name}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      <span className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-medium',
                        d.type === 'time'
                          ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                      )}>{d.type}</span>
                    </td>
                    <td className="px-2.5 py-1.5 font-mono break-all max-w-[280px]">{d.expr}</td>
                    <td className="px-2.5 py-1.5 font-mono whitespace-nowrap">{d.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Entities */}
      {parsed.entities.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">
            {t('editor.entities', '实体')} ({parsed.entities.length})
          </h4>
          <div className="overflow-x-auto border rounded-lg bg-card">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colName', '名称')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colType', '类型')}</th>
                  <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colExpr', '表达式')}</th>
                </tr>
              </thead>
              <tbody>
                {parsed.entities.map(e => (
                  <tr key={e.name} className="border-t">
                    <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">{e.name}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">{e.type}</td>
                    <td className="px-2.5 py-1.5 font-mono break-all max-w-[280px]">{e.expr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Metrics */}
      {parsed.metrics.length > 0 && (
        <MetricsTable parsed={parsed} t={t} />
      )}
    </div>
  );
}

/** Metrics table: name / label / type / filter / measure / full SQL. */
function MetricsTable({ parsed, t }: { parsed: ParsedSemantic; t: ReturnType<typeof useTranslation>['t'] }) {
  const sqlByMeasure = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of parsed.measures) {
      if (m.full_sql) map.set(m.name, m.full_sql);
    }
    return map;
  }, [parsed.measures]);

  return (
    <section>
      <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">
        {t('editor.metrics', '指标定义')} ({parsed.metrics.length})
      </h4>
      <div className="overflow-x-auto border rounded-lg bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colName', '名称')}</th>
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colType', '类型')}</th>
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colSource', '来源表')}</th>
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colTime', '时间维度')}</th>
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">{t('editor.colFullSql', '完整 SQL')}</th>
            </tr>
          </thead>
          <tbody>
            {parsed.metrics.map(m => {
              const fullSql = sqlByMeasure.get(m.measure) ?? '';
              return (
                <tr key={m.name} className="border-t align-top">
                  <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">
                    {m.name}
                    {m.label && m.label !== m.name && (
                      <span className="ml-1 text-[10px] text-muted-foreground">({m.label})</span>
                    )}
                    {m.filter && (
                      <div className="text-[10px] text-amber-600 dark:text-amber-400 font-normal">filter: {m.filter}</div>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5 whitespace-nowrap">
                    <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 text-[10px] font-medium">{m.type}</span>
                  </td>
                  <td className="px-2.5 py-1.5 whitespace-nowrap">
                    <span className="font-mono">{m.measure}</span>
                    {m.alias && m.alias !== m.measure && (
                      <div className="text-[10px] text-muted-foreground">alias: {m.alias}</div>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5 font-mono whitespace-nowrap">{m.agg_time_dimension}</td>
                  <td className="px-2.5 py-1.5">
                    {fullSql ? (
                      <pre className="text-[10px] font-mono bg-muted rounded p-1.5 whitespace-pre-wrap break-all max-h-28 overflow-auto">{fullSql}</pre>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

