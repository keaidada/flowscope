/**
 * ModelingWorkspace — Dataphin-style 规范建模 (data modeling) workspace.
 *
 * Mirrors Dataphin's modeling studio UI using MOCK data:
 * - Top bar: project selector + module tree nav (规范建模)
 * - Left: module tree (维度逻辑表 / 事实逻辑表 / 原子指标 / 业务限定 / 派生指标 / 汇总逻辑表)
 * - Center: object list table (名称/编码/负责人/状态/更新时间)
 * - Right: object detail with field table editor
 * - 新建 wizard: 6-step (创建→表结构→计算逻辑→约束→调度→提交)
 *
 * NOTE: All data is MOCK (hardcoded below) to demonstrate the UI look.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, Plus, ChevronRight, Pencil, Copy, Trash2,
  RefreshCw, Save, Check, X, ArrowLeft, ArrowRight, GitMerge,
  Table2, Layers, FunctionSquare, Filter, Box, Database, List, Share2, Grid3x3, Network, Rocket,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ============================================================
// MOCK DATA
// ============================================================

interface MockField {
  name: string;
  desc: string;
  type: string;
  category: '主键' | '属性' | '分区' | '度量';
  dim: string;
  constraint: string;
}

interface MockModel {
  id?: string;
  code: string;
  name: string;
  owner: string;
  status: '未提交' | '已发布' | '草稿' | '开发中';
  updated: string;
  layer: string;
  fields: MockField[];
  granularity?: string;
  atomic?: string;
  qualifiers?: string[];
  source?: string;
}

type ModuleId = 'dim' | 'fact' | 'atomic' | 'qualifier' | 'derived' | 'summary';

const MOCK_MODULES: Array<{ id: ModuleId; name: string; icon: React.ElementType; color: string }> = [
  { id: 'dim', name: '维度逻辑表', icon: Table2, color: 'text-purple-500' },
  { id: 'fact', name: '事实逻辑表', icon: Database, color: 'text-blue-500' },
  { id: 'atomic', name: '原子指标', icon: FunctionSquare, color: 'text-sky-500' },
  { id: 'qualifier', name: '业务限定', icon: Filter, color: 'text-amber-500' },
  { id: 'derived', name: '派生指标', icon: Layers, color: 'text-emerald-500' },
  { id: 'summary', name: '汇总逻辑表', icon: Box, color: 'text-orange-500' },
];

const MOCK_DATA: Record<ModuleId, MockModel[]> = {
  dim: [
    {
      code: 'dim_user_df', name: '用户维度表', owner: '张伟', status: '已发布', updated: '2026-08-04 14:23', layer: 'DIM',
      fields: [
        { name: 'usr_id', desc: '用户ID', type: 'bigint', category: '主键', dim: '', constraint: '非空' },
        { name: 'usr_name', desc: '用户昵称', type: 'string', category: '属性', dim: '', constraint: '' },
        { name: 'usr_type', desc: '用户类型', type: 'bigint', category: '属性', dim: '', constraint: '' },
        { name: 'reg_date', desc: '注册日期', type: 'timestamp', category: '属性', dim: '', constraint: '' },
        { name: 'ds', desc: '分区字段', type: 'string', category: '分区', dim: '', constraint: '' },
      ],
    },
    {
      code: 'dim_video_df', name: '视频维度表', owner: '李娜', status: '已发布', updated: '2026-08-03 09:15', layer: 'DIM',
      fields: [
        { name: 'vid', desc: '视频ID', type: 'bigint', category: '主键', dim: '', constraint: '非空' },
        { name: 'video_ctgy', desc: '视频分类', type: 'string', category: '属性', dim: '视频分类', constraint: '' },
        { name: 'video_side', desc: '视频端', type: 'string', category: '属性', dim: '视频端', constraint: '' },
        { name: 'c_ctime', desc: '创建时间', type: 'timestamp', category: '属性', dim: '', constraint: '' },
      ],
    },
    {
      code: 'dim_channel_df', name: '频道维度表', owner: '王强', status: '开发中', updated: '2026-08-02 16:40', layer: 'DIM',
      fields: [
        { name: 'channel_id', desc: '频道ID', type: 'bigint', category: '主键', dim: '', constraint: '非空' },
        { name: 'channel_name', desc: '频道名称', type: 'string', category: '属性', dim: '', constraint: '' },
      ],
    },
  ],
  fact: [
    {
      code: 'fct_video_play_di', name: '视频播放事实表', owner: '张伟', status: '已发布', updated: '2026-08-04 15:02', layer: 'DWD',
      fields: [
        { name: 'vid', desc: '视频ID', type: 'bigint', category: '属性', dim: '视频', constraint: '' },
        { name: 'usr_id', desc: '用户ID', type: 'bigint', category: '属性', dim: '用户', constraint: '' },
        { name: 'play_duration', desc: '播放时长', type: 'bigint', category: '度量', dim: '', constraint: '' },
        { name: 'play_ts', desc: '播放时间', type: 'timestamp', category: '属性', dim: '', constraint: '' },
      ],
    },
    {
      code: 'fct_login_di', name: '登录事实表', owner: '李娜', status: '草稿', updated: '2026-08-01 11:30', layer: 'DWD',
      fields: [
        { name: 'usr_id', desc: '用户ID', type: 'bigint', category: '属性', dim: '用户', constraint: '' },
        { name: 'login_ts', desc: '登录时间', type: 'timestamp', category: '属性', dim: '', constraint: '' },
        { name: 'login_side', desc: '登录端', type: 'string', category: '属性', dim: '视频端', constraint: '' },
      ],
    },
  ],
  atomic: [
    { code: 'play_duration_total', name: '播放总时长', owner: '张伟', status: '已发布', updated: '2026-08-04 14:30', layer: '原子', granularity: 'sum(play_duration)', source: 'fct_video_play_di', fields: [] },
    { code: 'play_cnt_total', name: '播放次数', owner: '张伟', status: '已发布', updated: '2026-08-04 14:31', layer: '原子', granularity: 'count(distinct vid)', source: 'fct_video_play_di', fields: [] },
    { code: 'dau_cnt', name: '日活跃用户数', owner: '李娜', status: '开发中', updated: '2026-08-03 10:00', layer: '原子', granularity: 'count(distinct usr_id)', source: 'fct_login_di', fields: [] },
  ],
  qualifier: [
    { code: 'side_app', name: 'APP端', owner: '张伟', status: '已发布', updated: '2026-08-02 09:00', layer: '限定', granularity: "video_side = 'APP'", fields: [] },
    { code: 'side_h5', name: 'H5端', owner: '李娜', status: '已发布', updated: '2026-08-02 09:05', layer: '限定', granularity: "video_side IN ('端内','端外')", fields: [] },
    { code: 'ctgy_olympic', name: '奥运分类', owner: '王强', status: '草稿', updated: '2026-08-01 15:20', layer: '限定', granularity: "video_ctgy = 'OLYL'", fields: [] },
  ],
  derived: [
    { code: 'play_duration_app_daily', name: 'APP端日播放总时长', owner: '张伟', status: '已发布', updated: '2026-08-04 15:00', layer: '派生', atomic: 'play_duration_total', qualifiers: ['side_app'], granularity: '按日', fields: [] },
    { code: 'play_cnt_h5_daily', name: 'H5端日播放次数', owner: '张伟', status: '已发布', updated: '2026-08-04 15:01', layer: '派生', atomic: 'play_cnt_total', qualifiers: ['side_h5'], granularity: '按日', fields: [] },
    { code: 'dau_side_daily', name: '分端日活跃用户', owner: '李娜', status: '开发中', updated: '2026-08-03 11:00', layer: '派生', atomic: 'dau_cnt', qualifiers: ['side_app'], granularity: '按日', fields: [] },
  ],
  summary: [
    { code: 'dws_video_play_daily', name: '视频播放日汇总表', owner: '张伟', status: '已发布', updated: '2026-08-04 15:30', layer: 'DWS', granularity: '按日(视频维度)', fields: [
      { name: 'ds', desc: '分区字段', type: 'string', category: '分区', dim: '', constraint: '非空' },
      { name: 'vid', desc: '视频ID', type: 'bigint', category: '主键', dim: '视频', constraint: '非空' },
      { name: 'app_play_duration', desc: 'APP端播放总时长', type: 'bigint', category: '度量', dim: '', constraint: '' },
      { name: 'h5_play_duration', desc: 'H5端播放总时长', type: 'bigint', category: '度量', dim: '', constraint: '' },
    ] },
    { code: 'dws_user_active_daily', name: '用户活跃日汇总表', owner: '李娜', status: '开发中', updated: '2026-08-03 14:00', layer: 'DWS', granularity: '按日(用户维度)', fields: [
      { name: 'ds', desc: '分区字段', type: 'string', category: '分区', dim: '', constraint: '非空' },
      { name: 'usr_id', desc: '用户ID', type: 'bigint', category: '主键', dim: '用户', constraint: '非空' },
      { name: 'app_dau', desc: 'APP端活跃', type: 'bigint', category: '度量', dim: '', constraint: '' },
    ] },
  ],
};

const STATUS_STYLE: Record<string, string> = {
  '已发布': 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  '开发中': 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  '草稿': 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400',
  '未提交': 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const LAYER_STYLE: Record<string, string> = {
  DIM: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400',
  DWD: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  DWS: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  ADS: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
};

export function ModelingWorkspace({ projectId: _projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [project, setProject] = useState('cvm_algo_db');
  const [module, setModule] = useState<ModuleId>('dim');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<MockModel | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardName, setWizardName] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'graph' | 'matrix' | 'concept' | 'publish'>('list');
  const [statusFilter, setStatusFilter] = useState<string>('全部');

  // Mutable mock data: seeded once, then users can add/edit/delete/duplicate.
  const [data, setData] = useState<Record<ModuleId, MockModel[]>>(() => {
    let counter = 0;
    const seeded: Record<ModuleId, MockModel[]> = {} as Record<ModuleId, MockModel[]>;
    (Object.keys(MOCK_DATA) as ModuleId[]).forEach(k => {
      seeded[k] = MOCK_DATA[k].map(m => ({ ...m, id: m.id ?? `m_${++counter}` }));
    });
    return seeded;
  });

  const currentModule = MOCK_MODULES.find(m => m.id === module)!;
  const list = data[module].filter(m =>
    (!search.trim() || m.name.toLowerCase().includes(search.toLowerCase()) || m.code.toLowerCase().includes(search.toLowerCase())) &&
    (statusFilter === '全部' || m.status === statusFilter)
  );

  // ── CRUD operations (mock) ─────────────────────────────────
  const addModel = (m: MockModel) => {
    const withId = { ...m, id: `m_${Date.now()}`, updated: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') };
    setData(prev => ({ ...prev, [module]: [withId, ...prev[module]] }));
  };
  const deleteModel = (id: string) => {
    setData(prev => ({ ...prev, [module]: prev[module].filter(x => x.id !== id) }));
    setSelected(prev => (prev?.id === id ? null : prev));
  };
  const duplicateModel = (m: MockModel) => {
    const copy = { ...m, id: `m_${Date.now()}`, code: `${m.code}_copy`, name: `${m.name}(副本)`, status: '草稿' as const };
    setData(prev => ({ ...prev, [module]: [copy, ...prev[module]] }));
  };
  const updateModel = (m: MockModel) => {
    setData(prev => ({ ...prev, [module]: prev[module].map(x => (x.id === m.id ? { ...m, updated: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') } : x)) }));
    setSelected(m);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ===== Top bar ===== */}
      <div className="flex items-center gap-3 px-4 h-11 border-b bg-background shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/10">
            <GitMerge className="h-3.5 w-3.5 text-primary" />
          </div>
          <span className="font-semibold text-sm">{t('governance.modeling', '规范建模')}</span>
        </div>
        <div className="flex items-center gap-2 ml-4">
          {/* Project selector */}
          <div className="flex items-center gap-1 px-2 py-1 rounded border bg-muted/30 text-xs">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <select value={project} onChange={e => setProject(e.target.value)} className="bg-transparent focus:outline-none text-xs">
              <option value="cvm_algo_db">cvm_algo_db</option>
              <option value="cvm_rep_db">cvm_rep_db</option>
              <option value="cvm_std_db">cvm_std_db</option>
            </select>
          </div>
          <span className="text-xs text-muted-foreground">Basic模式</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {/* View toggle */}
          <div className="flex items-center rounded-md border bg-background p-0.5 mr-1">
            <button onClick={() => setViewMode('list')}
              className={cn('flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium', viewMode === 'list' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              <List className="h-3 w-3" />列表
            </button>
            <button onClick={() => setViewMode('graph')}
              className={cn('flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium', viewMode === 'graph' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              <Share2 className="h-3 w-3" />模型关系
            </button>
            <button onClick={() => setViewMode('matrix')}
              className={cn('flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium', viewMode === 'matrix' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              <Grid3x3 className="h-3 w-3" />总线矩阵
            </button>
            <button onClick={() => setViewMode('concept')}
              className={cn('flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium', viewMode === 'concept' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              <Network className="h-3 w-3" />概念模型
            </button>
            <button onClick={() => setViewMode('publish')}
              className={cn('flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium', viewMode === 'publish' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              <Rocket className="h-3 w-3" />发布管理
            </button>
          </div>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowWizard(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />{t('governance.create', '新建')}
          </Button>
        </div>
      </div>

      {/* ===== Model relationship graph (Dataphin 模型关系) ===== */}
      {viewMode === 'graph' ? (
        <ModelRelationshipGraph onSelect={setSelected} />
      ) : viewMode === 'matrix' ? (
        <BusMatrix />
      ) : viewMode === 'concept' ? (
        <ConceptModel onSelect={setSelected} />
      ) : viewMode === 'publish' ? (
        <PublishManager onSelect={setSelected} />
      ) : (
        <div className="flex flex-1 min-h-0">
        {/* Left: module tree */}
        <div className="w-56 border-r flex flex-col shrink-0 bg-muted/10">
          <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            规范建模
          </div>
          <div className="flex-1 overflow-auto px-1.5 space-y-0.5">
            {MOCK_MODULES.map(m => {
              const Icon = m.icon;
              const active = module === m.id;
              return (
                <button key={m.id} onClick={() => { setModule(m.id); setSelected(null); }}
                  className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors',
                    active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-accent/50')}>
                  <Icon className={cn('h-3.5 w-3.5', m.color)} />
                  <span className="flex-1">{m.name}</span>
                  <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">{data[m.id].length}</span>
                  <ChevronRight className={cn('h-3 w-3 transition-transform', active && 'rotate-90')} />
                </button>
              );
            })}
          </div>
        </div>

        {/* Center: object list */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="搜索名称/编码..." className="w-full pl-8 pr-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
            </div>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {['全部', '已发布', '开发中', '草稿'].map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={cn('px-2 py-1 rounded border transition-colors',
                    statusFilter === s ? 'bg-primary/10 text-primary border-primary/30' : 'bg-muted/30 hover:bg-accent')}>
                  {s}
                </button>
              ))}
            </div>
            <span className="ml-auto text-[11px] text-muted-foreground">{list.length} 个对象</span>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background border-b">
                <tr className="text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium">编码</th>
                  <th className="px-3 py-2 font-medium">所属分层</th>
                  <th className="px-3 py-2 font-medium">负责人</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">更新时间</th>
                  <th className="px-3 py-2 font-medium w-16">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map(m => (
                  <tr key={m.code} onClick={() => setSelected(m)}
                    className={cn('border-b cursor-pointer hover:bg-accent/40 transition-colors',
                      selected?.code === m.code && 'bg-accent/60')}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {(() => { const I = currentModule.icon; return <I className={cn('h-3.5 w-3.5 shrink-0', currentModule.color)} />; })()}
                        <span className="font-medium">{m.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{m.code}</td>
                    <td className="px-3 py-2">
                      <Badge className={cn('text-[10px] font-medium', LAYER_STYLE[m.layer] ?? 'bg-muted text-muted-foreground')}>{m.layer}</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{m.owner}</td>
                    <td className="px-3 py-2">
                      <Badge className={cn('text-[10px] font-medium', STATUS_STYLE[m.status])}>{m.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{m.updated}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-0.5">
                        <button onClick={(e) => { e.stopPropagation(); setSelected(m); }} className="p-1 rounded hover:bg-accent" title="编辑"><Pencil className="h-3 w-3" /></button>
                        <button onClick={(e) => { e.stopPropagation(); duplicateModel(m); }} className="p-1 rounded hover:bg-accent" title="复制"><Copy className="h-3 w-3" /></button>
                        <button onClick={(e) => { e.stopPropagation(); deleteModel(m.id!); }} className="p-1 rounded hover:bg-destructive/10 hover:text-destructive" title="删除"><Trash2 className="h-3 w-3" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: detail */}
        <div className="w-[30rem] border-l flex flex-col shrink-0 bg-muted/5">
          {selected ? (
            <ModelDetail model={selected} module={module} onUpdate={updateModel} onDelete={deleteModel} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
              <div className="text-center p-6">
                <Database className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
                <p>选择左侧对象查看详情</p>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {/* ===== 新建 Wizard ===== */}
      {showWizard && (
        <CreateWizard
          module={module}
          step={wizardStep}
          name={wizardName}
          onName={setWizardName}
          onStep={setWizardStep}
          onClose={() => { setShowWizard(false); setWizardStep(0); setWizardName(''); }}
          onSubmit={() => {
            // 新建 → 添加到当前模块列表，并选中它。
            if (wizardName.trim()) {
              addModel({
                id: '', code: `new_${Date.now()}`, name: wizardName, owner: '当前用户',
                status: '草稿', updated: '', layer: 'DWD', fields: [],
              });
            }
            setShowWizard(false); setWizardStep(0); setWizardName('');
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// Model Detail
// ============================================================

function ModelDetail({ model, module, onUpdate, onDelete }: {
  model: MockModel; module: ModuleId;
  onUpdate: (m: MockModel) => void;
  onDelete: (id: string) => void;
}) {
  const moduleMeta = MOCK_MODULES.find(m => m.id === module)!;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <moduleMeta.icon className={cn('h-4 w-4', moduleMeta.color)} />
          <input value={model.name} onChange={e => onUpdate({ ...model, name: e.target.value })}
            className="text-sm font-semibold bg-transparent border-b border-transparent hover:border-muted focus:border-primary focus:outline-none px-1 -mx-1"
            placeholder="模型名称" />
          <div className="ml-auto flex items-center gap-1">
            <select value={model.status} onChange={e => onUpdate({ ...model, status: e.target.value as MockModel['status'] })}
              className="text-[10px] px-1.5 py-0.5 rounded border bg-transparent focus:outline-none">
              {['草稿', '开发中', '已发布', '未提交'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={() => onDelete(model.id!)} className="p-1 rounded hover:bg-destructive/10 hover:text-destructive" title="删除">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="font-mono">{model.code}</span>
          <Badge className={cn('text-[10px] font-medium', LAYER_STYLE[model.layer] ?? 'bg-muted text-muted-foreground')}>{model.layer}</Badge>
          <span>负责人: {model.owner}</span>
          <span>更新: {model.updated || '-'}</span>
        </div>
        {model.granularity && (
          <div className="mt-1.5 flex items-center gap-1 text-[11px]">
            {model.atomic && <>
              <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400 font-mono">{model.atomic}</span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
            </>}
            {model.qualifiers?.map(q => (
              <span key={q} className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 font-mono">{q}</span>
            ))}
            {model.granularity && <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400">{model.granularity}</span>}
          </div>
        )}
      </div>

      {/* Field table editor (Dataphin style) */}
      <div className="flex-1 overflow-auto">
        <div className="flex items-center gap-1 px-3 py-1.5 border-b bg-muted/20 text-[10px] text-muted-foreground">
          <span>表结构</span>
          <span className="mx-1 text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">计算逻辑</span>
          <span className="mx-1 text-muted-foreground/40">|</span>
          <span className="text-muted-foreground">约束</span>
          <span className="ml-auto flex items-center gap-1"><RefreshCw className="h-3 w-3" /> 编辑</span>
        </div>

        {model.fields.length > 0 ? (
          <table className="w-full text-xs">
            <thead className="bg-muted/30 border-b">
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-1.5 font-medium w-8">#</th>
                <th className="px-3 py-1.5 font-medium">字段名称</th>
                <th className="px-3 py-1.5 font-medium">说明</th>
                <th className="px-3 py-1.5 font-medium">数据类型</th>
                <th className="px-3 py-1.5 font-medium">字段类别</th>
                <th className="px-3 py-1.5 font-medium">关联维度</th>
                <th className="px-3 py-1.5 font-medium">约束</th>
              </tr>
            </thead>
            <tbody>
              {model.fields.map((f, i) => (
                <tr key={f.name} className="border-b hover:bg-accent/30">
                  <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px]">{f.name}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{f.desc}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant="outline" className="text-[10px] font-mono">{f.type}</Badge>
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge className={cn('text-[10px] font-medium',
                      f.category === '主键' && 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
                      f.category === '度量' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
                      f.category === '分区' && 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400',
                      f.category === '属性' && 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400')}>{f.category}</Badge>
                  </td>
                  <td className="px-3 py-1.5">
                    {f.dim ? (
                      <span className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-400 text-[10px]">{f.dim}</span>
                    ) : <span className="text-muted-foreground/40">-</span>}
                  </td>
                  <td className="px-3 py-1.5 text-[10px] text-muted-foreground">{f.constraint || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-6 text-center text-[11px] text-muted-foreground">
            <div className="text-2xl mb-2 font-mono bg-muted/40 rounded p-3">{model.granularity}</div>
            <p className="mb-1">{moduleMeta.name}定义</p>
            {model.source && <p className="font-mono text-[10px]">来源: {model.source}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Create Wizard (6 steps)
// ============================================================

const WIZARD_STEPS = ['创建', '表结构', '计算逻辑', '约束', '调度&参数', '提交'];

function CreateWizard({
  module, step, name, onName, onStep, onClose, onSubmit,
}: {
  module: ModuleId;
  step: number;
  name: string;
  onName: (s: string) => void;
  onStep: (n: number) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const moduleMeta = MOCK_MODULES.find(m => m.id === module)!;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
      <div className="w-[64rem] max-h-[85vh] flex flex-col rounded-xl bg-background shadow-2xl border">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <moduleMeta.icon className={cn('h-4 w-4', moduleMeta.color)} />
            <span className="font-semibold text-sm">新建{moduleMeta.name}</span>
            <span className="text-xs text-muted-foreground">{name || '未命名'}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>

        {/* Step bar */}
        <div className="flex items-center px-6 py-3 border-b bg-muted/10 shrink-0">
          {WIZARD_STEPS.map((s, i) => (
            <div key={s} className="flex items-center">
              <div className={cn('flex items-center gap-1.5 text-xs',
                i === step ? 'text-primary font-semibold' : i < step ? 'text-emerald-600' : 'text-muted-foreground')}>
                <span className={cn('flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold',
                  i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-emerald-500 text-white' : 'bg-muted')}>
                  {i < step ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                {s}
              </div>
              {i < WIZARD_STEPS.length - 1 && <div className={cn('w-10 h-px mx-2', i < step ? 'bg-emerald-400' : 'bg-muted')} />}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto p-6">
          {step === 0 && <StepCreate module={module} name={name} onName={onName} />}
          {step === 1 && <StepFields />}
          {step === 2 && <StepLogic />}
          {step === 3 && <StepConstraint />}
          {step === 4 && <StepSchedule />}
          {step === 5 && <StepSubmit name={name} onClose={onClose} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t shrink-0">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs">取消</Button>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => onStep(Math.max(0, step - 1))} disabled={step === 0} className="text-xs">
              <ArrowLeft className="h-3.5 w-3.5 mr-1" />上一步
            </Button>
            {step < 5 ? (
              <Button size="sm" onClick={() => onStep(step + 1)} className="text-xs bg-primary text-primary-foreground">
                保存并下一步<ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            ) : (
              <Button size="sm" className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white" onClick={onSubmit}>
                <Save className="h-3.5 w-3.5 mr-1" />保存并提交
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Wizard steps

function StepCreate({ module, name, onName }: { module: ModuleId; name: string; onName: (s: string) => void }) {
  const moduleMeta = MOCK_MODULES.find(m => m.id === module)!;
  return (
    <div className="max-w-md mx-auto space-y-4">
      <h3 className="text-sm font-semibold">基本信息</h3>
      <div className="space-y-3">
        <FormRow label="业务对象/业务活动">
          <select className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring">
            <option>视频播放</option><option>用户登录</option><option>内容浏览</option>
          </select>
        </FormRow>
        <FormRow label="数据板块">
          <div className="px-2 py-1.5 text-xs rounded border bg-muted/30">cvm_algo_db</div>
        </FormRow>
        <FormRow label="主题域">
          <select className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring">
            <option>视频域</option><option>用户域</option><option>内容域</option>
          </select>
        </FormRow>
        <FormRow label="数据时效">
          <select className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring">
            <option>T+1 全量</option><option>T+1 增量</option><option>T+h 小时级</option>
          </select>
        </FormRow>
        <FormRow label={`${moduleMeta.name}名`}>
          <input value={name} onChange={e => onName(e.target.value)}
            className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={`请输入${moduleMeta.name}名称`} />
        </FormRow>
        <FormRow label="中文名称">
          <input className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" placeholder="请输入中文名称" />
        </FormRow>
        <FormRow label="描述信息">
          <textarea rows={3} className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" placeholder="描述" />
        </FormRow>
      </div>
    </div>
  );
}

function StepFields() {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">表结构</h3>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 text-xs"><Plus className="h-3 w-3 mr-1" />添加字段</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs">从表引入</Button>
        </div>
      </div>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium w-8">#</th>
              <th className="px-3 py-2 font-medium">字段名称</th>
              <th className="px-3 py-2 font-medium">说明</th>
              <th className="px-3 py-2 font-medium">数据类型</th>
              <th className="px-3 py-2 font-medium">字段类别</th>
              <th className="px-3 py-2 font-medium">关联维度</th>
            </tr>
          </thead>
          <tbody>
            {[
              { n: 'vid', d: '视频ID', t: 'bigint', c: '主键', dim: '' },
              { n: 'usr_id', d: '用户ID', t: 'bigint', c: '属性', dim: '用户' },
              { n: 'play_duration', d: '播放时长', t: 'bigint', c: '度量', dim: '' },
              { n: 'ds', d: '分区', t: 'string', c: '分区', dim: '' },
            ].map((f, i) => (
              <tr key={f.n} className="border-b">
                <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                <td className="px-3 py-2 font-mono">{f.n}</td>
                <td className="px-3 py-2 text-muted-foreground">{f.d}</td>
                <td className="px-3 py-2"><Badge variant="outline" className="text-[10px] font-mono">{f.t}</Badge></td>
                <td className="px-3 py-2">{f.c}</td>
                <td className="px-3 py-2">{f.dim ? <span className="text-purple-600 text-[10px] px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-950/40">{f.dim}</span> : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StepLogic() {
  const [expr, setExpr] = useState('SELECT\n  vid,\n  usr_id,\n  play_duration\nFROM fct_video_play_di');
  const [dragging, setDragging] = useState<string | null>(null);

  const SOURCE_FIELDS = [
    { name: 'vid', type: 'bigint', desc: '视频ID' },
    { name: 'usr_id', type: 'bigint', desc: '用户ID' },
    { name: 'play_duration', type: 'bigint', desc: '播放时长' },
    { name: 'play_ts', type: 'timestamp', desc: '播放时间' },
    { name: 'video_ctgy', type: 'string', desc: '视频分类' },
    { name: 'video_side', type: 'string', desc: '视频端' },
  ];

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const field = e.dataTransfer.getData('text/plain');
    if (!field) return;
    // Insert field at cursor position.
    const ta = e.currentTarget as HTMLTextAreaElement;
    const start = ta.selectionStart ?? expr.length;
    const end = ta.selectionEnd ?? expr.length;
    setExpr(expr.slice(0, start) + field + expr.slice(end));
    setDragging(null);
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h3 className="text-sm font-semibold mb-3">来源配置</h3>
        <div className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">主来源</Badge>
            <span className="font-medium">fct_video_play_di</span>
            <Badge variant="outline" className="text-[10px]">物理表</Badge>
          </div>
          <div className="text-[11px] text-muted-foreground font-mono">{'过滤条件: ds = ${bizdate}'}</div>
          <div className="text-[10px] text-muted-foreground">拖拽字段到右侧计算逻辑编辑器</div>
          <div className="flex flex-wrap gap-1">
            {SOURCE_FIELDS.map(f => (
              <div key={f.name}
                draggable
                onDragStart={e => { e.dataTransfer.setData('text/plain', f.name); setDragging(f.name); }}
                onDragEnd={() => setDragging(null)}
                className={cn('px-2 py-1 rounded border bg-blue-50/60 dark:bg-blue-950/40 border-blue-200/50 dark:border-blue-800/50 cursor-grab hover:border-blue-400 hover:shadow-sm transition-all',
                  dragging === f.name && 'opacity-40 border-blue-400')}>
                <div className="text-[10px] font-mono text-blue-700 dark:text-blue-400">{f.name}</div>
                <div className="text-[9px] text-muted-foreground">{f.type} · {f.desc}</div>
              </div>
            ))}
          </div>
          <Button size="sm" variant="outline" className="h-6 text-[11px]"><Plus className="h-3 w-3 mr-1" />添加来源对象</Button>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-3">计算逻辑 <span className="text-[10px] font-normal text-muted-foreground">（拖拽字段到编辑器）</span></h3>
        <div className="border rounded-lg p-3">
          <div className="flex flex-wrap gap-1 mb-2">
            {['sum', 'count', 'count_distinct', 'avg', 'max', 'min'].map(f => (
              <span key={f}
                draggable
                onDragStart={e => { e.dataTransfer.setData('text/plain', `${f}(`); setDragging(f); }}
                onDragEnd={() => setDragging(null)}
                className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400 text-[10px] font-mono cursor-grab hover:bg-purple-100">{f}(</span>
            ))}
          </div>
          <textarea rows={6}
            value={expr}
            onChange={e => setExpr(e.target.value)}
            onDrop={onDrop}
            onDragOver={e => e.preventDefault()}
            placeholder="SELECT ...  (拖拽字段/函数到此处)"
            className="w-full p-2 text-xs font-mono rounded border bg-muted/20 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center gap-2 mt-2">
            <Button size="sm" variant="outline" className="h-6 text-[11px]">同名字段快速映射</Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px]">语法校验</Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px]">预览SQL</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepConstraint() {
  return (
    <div className="max-w-lg space-y-3">
      <h3 className="text-sm font-semibold">约束规则</h3>
      {[
        { f: 'usr_id', c: '非空', s: '强规则' },
        { f: 'vid', c: '非空', s: '强规则' },
        { f: 'play_duration', c: '值域 > 0', s: '弱规则' },
      ].map(r => (
        <div key={r.f} className="flex items-center gap-3 p-3 border rounded-lg">
          <span className="font-mono text-xs w-28">{r.f}</span>
          <Badge variant="outline" className="text-[10px]">{r.c}</Badge>
          <div className="flex items-center gap-1 ml-auto text-xs">
            <span className={cn('px-2 py-0.5 rounded text-[10px]', r.s === '强规则' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400')}>{r.s}</span>
            <span className="text-muted-foreground text-[10px] ml-1">强度</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StepSchedule() {
  return (
    <div className="max-w-lg space-y-3">
      <h3 className="text-sm font-semibold">调度&参数配置</h3>
      <div className="space-y-3">
        <FormRow label="调度周期">
          <select className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring">
            <option>每日 02:00</option><option>每小时</option><option>每周一</option>
          </select>
        </FormRow>
        <FormRow label="数据延迟">
          <div className="px-2 py-1.5 text-xs rounded border bg-muted/30">T+1</div>
        </FormRow>
        <FormRow label="上游依赖">
          <div className="px-2 py-1.5 text-xs rounded border bg-muted/30 font-mono">fct_video_play_di → dim_video_df</div>
        </FormRow>
        <FormRow label="参数配置">
          <input className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" value={'${bizdate}'} readOnly />
        </FormRow>
      </div>
    </div>
  );
}

function StepSubmit({ name, onClose: _onClose }: { name: string; onClose: () => void }) {
  return (
    <div className="max-w-lg mx-auto space-y-4">
      <h3 className="text-sm font-semibold">提交检查</h3>
      <div className="border rounded-lg divide-y">
        {[
          { icon: '✓', text: '表结构校验通过', ok: true },
          { icon: '✓', text: '计算逻辑校验通过', ok: true },
          { icon: '✓', text: '调度依赖校验通过', ok: true },
          { icon: '✓', text: '血缘解析完成', ok: true },
        ].map(r => (
          <div key={r.text} className="flex items-center gap-2 px-3 py-2 text-xs">
            <span className={cn('w-4 h-4 flex items-center justify-center rounded-full text-[10px] text-white', r.ok ? 'bg-emerald-500' : 'bg-red-500')}>{r.icon}</span>
            <span className="text-muted-foreground">{r.text}</span>
          </div>
        ))}
      </div>
      <FormRow label="提交备注">
        <textarea rows={3} className="w-full px-2 py-1.5 text-xs rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" placeholder="请输入提交备注" />
      </FormRow>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>即将创建: </span>
        <Badge className="bg-primary/10 text-primary font-mono text-[11px]">{name || 'unnamed'}</Badge>
      </div>
    </div>
  );
}

// Form row helper
function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <label className="w-28 shrink-0 text-xs text-muted-foreground">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ============================================================
// Model Relationship Graph (Dataphin 模型关系视图)
// Shows 维度逻辑表 → 事实逻辑表 → 汇总逻辑表 relationships.
// ============================================================

const GRAPH_LAYERS = [
  { id: 'dim', label: '维度逻辑表', color: '#8b5cf6' },
  { id: 'fact', label: '事实逻辑表', color: '#3b82f6' },
  { id: 'summary', label: '汇总逻辑表', color: '#10b981' },
];

const GRAPH_MODELS: Record<string, { id: string; name: string; code: string; layer: string; desc: string; fields: string[] }> = {
  // DIM
  dim_user: { id: 'dim_user', name: '用户维度表', code: 'dim_user_df', layer: 'dim', desc: '用户属性', fields: ['usr_id', 'usr_name', 'usr_type'] },
  dim_video: { id: 'dim_video', name: '视频维度表', code: 'dim_video_df', layer: 'dim', desc: '视频属性', fields: ['vid', 'video_ctgy', 'video_side'] },
  dim_channel: { id: 'dim_channel', name: '频道维度表', code: 'dim_channel_df', layer: 'dim', desc: '频道属性', fields: ['channel_id', 'channel_name'] },
  // FACT
  fact_play: { id: 'fact_play', name: '视频播放事实表', code: 'fct_video_play_di', layer: 'fact', desc: '播放事件', fields: ['vid', 'usr_id', 'play_duration'] },
  fact_login: { id: 'fact_login', name: '登录事实表', code: 'fct_login_di', layer: 'fact', desc: '登录事件', fields: ['usr_id', 'login_ts', 'login_side'] },
  // SUMMARY
  sum_video: { id: 'sum_video', name: '视频播放日汇总表', code: 'dws_video_play_daily', layer: 'summary', desc: '按日·视频维度', fields: ['ds', 'vid', 'app_play_duration', 'h5_play_duration'] },
  sum_user: { id: 'sum_user', name: '用户活跃日汇总表', code: 'dws_user_active_daily', layer: 'summary', desc: '按日·用户维度', fields: ['ds', 'usr_id', 'app_dau'] },
};

const GRAPH_EDGES: Array<{ from: string; to: string; label: string }> = [
  { from: 'dim_video', to: 'fact_play', label: '关联维度' },
  { from: 'dim_user', to: 'fact_play', label: '关联维度' },
  { from: 'dim_user', to: 'fact_login', label: '关联维度' },
  { from: 'dim_channel', to: 'fact_play', label: '关联维度' },
  { from: 'fact_play', to: 'sum_video', label: '汇总' },
  { from: 'fact_login', to: 'sum_user', label: '汇总' },
  { from: 'dim_video', to: 'sum_video', label: '粒度' },
  { from: 'dim_user', to: 'sum_user', label: '粒度' },
];

function ModelRelationshipGraph({ onSelect }: { onSelect: (m: MockModel | null) => void }) {
  const layerColor = (l: string) => GRAPH_LAYERS.find(g => g.id === l)?.color ?? '#94a3b8';

  const nodes: Node[] = GRAPH_LAYERS.map((layer, li) => ({
    id: `label-${layer.id}`,
    type: 'default',
    position: { x: 20 + li * 320, y: 12 },
    data: {
      label: (
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <span className="w-2 h-2 rounded-sm" style={{ background: layer.color }} />
          {layer.label}
        </div>
      ),
    },
    style: { background: 'transparent', border: 'none', boxShadow: 'none' },
    draggable: false,
  }));

  GRAPH_LAYERS.forEach((layer, li) => {
    const models = Object.values(GRAPH_MODELS).filter(m => m.layer === layer.id);
    models.forEach((m, mi) => {
      nodes.push({
        id: m.id,
        position: { x: 20 + li * 320, y: 60 + mi * 150 },
        data: { label: <GraphNode model={m} color={layer.color} onClick={() => onSelect(toMockModel(m))} /> },
        style: { padding: 0, background: 'transparent', border: 'none', width: 240 },
      });
    });
  });

  const edges: Edge[] = GRAPH_EDGES.map((e, i) => {
    const color = layerColor(GRAPH_MODELS[e.from].layer);
    return {
      id: `e-${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      label: e.label,
      labelStyle: { fontSize: 9, fill: '#64748b' },
      labelBgStyle: { fill: 'rgba(255,255,255,0.8)' },
      style: { stroke: color, strokeWidth: 1.5 },
    };
  });

  return (
    <div className="flex-1 min-h-0">
      {/* Legend bar */}
      <div className="flex items-center gap-4 px-4 py-1.5 border-b bg-muted/20 shrink-0">
        {GRAPH_LAYERS.map(l => (
          <div key={l.id} className="flex items-center gap-1.5 text-xs">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: l.color }} />
            <span className="font-medium">{l.label}</span>
            <span className="text-muted-foreground tabular-nums">{Object.values(GRAPH_MODELS).filter(m => m.layer === l.id).length}</span>
          </div>
        ))}
        <span className="text-xs text-muted-foreground ml-auto">
          7 个模型 · {GRAPH_EDGES.length} 条关系
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          attributionPosition="bottom-left"
          minZoom={0.3}
          maxZoom={2}
          nodesDraggable={true}
          nodesConnectable={false}
        >
          <Background color="#e2e8f0" gap={24} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(n) => {
              const m = Object.values(GRAPH_MODELS).find(g => g.id === n.id);
              return m ? layerColor(m.layer) : '#94a3b8';
            }}
            maskColor="rgba(0,0,0,0.1)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}

// ============================================================
// Bus Matrix (Dataphin 总线矩阵): 维度 × 业务过程 矩阵
// ============================================================

const BUS_DIMS = ['用户', '视频', '频道', '视频分类', '视频端'];
const BUS_PROCESSES = ['视频播放', '视频发布', '用户登录', '内容浏览', '互动收藏'];

const BUS_MATRIX: Record<string, string[]> = {
  '视频播放': ['用户', '视频', '视频分类', '视频端'],
  '视频发布': ['用户', '视频', '频道'],
  '用户登录': ['用户', '视频端'],
  '内容浏览': ['用户', '视频', '频道'],
  '互动收藏': ['用户', '视频'],
};

function BusMatrix() {
  const [matrix, setMatrix] = useState<Record<string, string[]>>(() =>
    JSON.parse(JSON.stringify(BUS_MATRIX)));

  const toggle = (process: string, dim: string) => {
    setMatrix(prev => {
      const cur = prev[process] ?? [];
      const has = cur.includes(dim);
      const next = has ? cur.filter(d => d !== dim) : [...cur, dim];
      return { ...prev, [process]: next };
    });
  };

  const totalLinks = Object.values(matrix).reduce((s, arr) => s + arr.length, 0);

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4">
      {/* Legend */}
      <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">总线矩阵</span>
        <span>用于管理维度与业务过程的组合关系</span>
        <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">{totalLinks} 个关联组合</span>
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300" /> 已关联</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm border border-dashed border-muted-foreground/40" /> 未关联</span>
        </div>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/40">
              <th className="px-3 py-2 text-left font-medium w-32">业务过程 \ 维度</th>
              {BUS_DIMS.map(d => (
                <th key={d} className="px-3 py-2 text-center font-medium">{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {BUS_PROCESSES.map(p => (
              <tr key={p} className="border-t hover:bg-accent/30">
                <td className="px-3 py-2 font-medium">{p}</td>
                {BUS_DIMS.map(d => {
                  const linked = (matrix[p] ?? []).includes(d);
                  return (
                    <td key={d} className="px-2 py-2 text-center">
                      {linked ? (
                        <button onClick={() => toggle(p, d)} className="w-5 h-5 inline-flex items-center justify-center rounded bg-emerald-100 text-emerald-600 border border-emerald-300 hover:bg-emerald-200 transition-colors"
                          title={`取消 ${p} × ${d}`}>
                          <Check className="h-3 w-3" />
                        </button>
                      ) : (
                        <button onClick={() => toggle(p, d)} className="w-5 h-5 inline-flex items-center justify-center rounded border border-dashed border-muted-foreground/30 text-muted-foreground/40 hover:border-emerald-300 hover:text-emerald-500 transition-colors"
                          title={`关联 ${p} × ${d}`}>
                          <Plus className="h-3 w-3" />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Selected combination hint */}
      <div className="mt-3 text-[11px] text-muted-foreground">
        点击「+」将维度关联到业务过程；点击绿色勾选可取消关联。已关联组合将用于派生指标的统计粒度。
      </div>
    </div>
  );
}

// ============================================================
// Concept Model (概念模型): 业务对象/业务活动 → 生成逻辑表
// ============================================================

interface ConceptEntity {
  id: string;
  name: string;
  nameCn: string;
  type: '业务对象' | '业务活动';
  domain: string;
  generated: Array<{ code: string; name: string; type: string }>;
}

const CONCEPT_ENTITIES: ConceptEntity[] = [
  {
    id: 'ent_user', name: 'USER', nameCn: '用户', type: '业务对象', domain: '用户域',
    generated: [{ code: 'dim_user_df', name: '用户维度表', type: '维度逻辑表' }],
  },
  {
    id: 'ent_video', name: 'VIDEO', nameCn: '视频', type: '业务对象', domain: '视频域',
    generated: [{ code: 'dim_video_df', name: '视频维度表', type: '维度逻辑表' }, { code: 'dim_channel_df', name: '频道维度表', type: '维度逻辑表' }],
  },
  {
    id: 'act_play', name: 'VIDEO_PLAY', nameCn: '视频播放', type: '业务活动', domain: '视频域',
    generated: [{ code: 'fct_video_play_di', name: '视频播放事实表', type: '事实逻辑表' }, { code: 'dws_video_play_daily', name: '视频播放日汇总表', type: '汇总逻辑表' }],
  },
  {
    id: 'act_login', name: 'USER_LOGIN', nameCn: '用户登录', type: '业务活动', domain: '用户域',
    generated: [{ code: 'fct_login_di', name: '登录事实表', type: '事实逻辑表' }, { code: 'dws_user_active_daily', name: '用户活跃日汇总表', type: '汇总逻辑表' }],
  },
];

function ConceptModel({ onSelect }: { onSelect: (m: MockModel | null) => void }) {
  const [entities, setEntities] = useState<ConceptEntity[]>(() => JSON.parse(JSON.stringify(CONCEPT_ENTITIES)));
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'业务对象' | '业务活动'>('业务对象');
  const [selectedGen, setSelectedGen] = useState<string | null>(null);

  const addEntity = () => {
    if (!newName.trim()) return;
    setEntities(prev => [...prev, {
      id: `ent_${Date.now()}`, name: newName.toUpperCase().replace(/\s+/g, '_'),
      nameCn: newName, type: newType, domain: '待定域', generated: [],
    }]);
    setNewName(''); setShowNew(false);
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Network className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">概念模型</span>
        <span className="text-xs text-muted-foreground">业务对象 / 业务活动 → 自动生成逻辑表</span>
        <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{entities.length} 个业务实体</span>
        <Button size="sm" variant="outline" className="h-6 ml-auto text-[11px]" onClick={() => setShowNew(!showNew)}>
          <Plus className="h-3 w-3 mr-1" />新建业务实体
        </Button>
      </div>

      {/* New entity inline form */}
      {showNew && (
        <div className="flex items-center gap-2 mb-3 p-2 border rounded-lg bg-accent/20">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="实体中文名，如：订单"
            className="flex-1 px-2 py-1 text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring" />
          <select value={newType} onChange={e => setNewType(e.target.value as '业务对象' | '业务活动')}
            className="px-2 py-1 text-xs rounded border bg-background focus:outline-none">
            <option value="业务对象">业务对象</option>
            <option value="业务活动">业务活动</option>
          </select>
          <Button size="sm" className="h-7 text-xs" onClick={addEntity} disabled={!newName.trim()}>确定</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowNew(false)}>取消</Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {entities.map(e => (
          <div key={e.id} className="border rounded-lg overflow-hidden bg-card">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: `${e.type === '业务对象' ? '#8b5cf6' : '#3b82f6'}33` }}>
              <span className="w-2 h-2 rounded-full" style={{ background: e.type === '业务对象' ? '#8b5cf6' : '#3b82f6' }} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{e.nameCn}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{e.name}</span>
                </div>
                <div className="text-[10px] text-muted-foreground">{e.type} · {e.domain}</div>
              </div>
              <Badge className={cn('ml-auto text-[10px]', e.type === '业务对象' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400')}>{e.type}</Badge>
            </div>
            <div className="p-3 space-y-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">已生成逻辑表 ({e.generated.length})</div>
              {e.generated.map(g => (
                <button key={g.code} onClick={() => { setSelectedGen(g.code); onSelect(toMockModelByCode(g.code)); }}
                  className={cn('w-full flex items-center gap-2 px-3 py-2 rounded border hover:border-primary/40 hover:bg-accent/30 transition-colors text-left',
                    selectedGen === g.code && 'border-primary/60 bg-accent/40')}>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <div className="flex-1">
                    <div className="text-xs font-medium">{g.name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">{g.code}</div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{g.type}</Badge>
                </button>
              ))}
              <Button size="sm" variant="ghost" className="h-6 w-full text-[11px] text-muted-foreground"
                onClick={() => {
                  const code = `new_${e.name.toLowerCase()}_${e.generated.length + 1}`;
                  const type = e.type === '业务对象' ? '维度逻辑表' : '事实逻辑表';
                  setEntities(prev => prev.map(x => x.id === e.id
                    ? { ...x, generated: [...x.generated, { code, name: `${e.nameCn}${type}`, type }] }
                    : x));
                }}>
                <Plus className="h-3 w-3 mr-1" />添加逻辑表
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function toMockModelByCode(code: string): MockModel {
  const m = Object.values(GRAPH_MODELS).find(g => g.code === code);
  return m ? toMockModel(m) : { code, name: code, owner: '张伟', status: '已发布', updated: '2026-08-04', layer: 'DWD', fields: [] };
}

// ============================================================
// Publish Manager (发布管理): 草稿 → 已发布 → 已上线 + 版本
// ============================================================

interface PublishItem {
  code: string;
  name: string;
  version: string;
  status: '草稿' | '待发布' | '已发布' | '已上线' | '开发中';
  owner: string;
  updated: string;
  history: Array<{ version: string; time: string; operator: string; note: string }>;
}

const PUBLISH_ITEMS: PublishItem[] = [
  {
    code: 'dim_user_df', name: '用户维度表', version: 'v2.1.0', status: '已上线', owner: '张伟', updated: '2026-08-04 14:23',
    history: [
      { version: 'v2.1.0', time: '2026-08-04 14:23', operator: '张伟', note: '新增 usr_type 字段' },
      { version: 'v2.0.0', time: '2026-08-01 09:00', operator: '李娜', note: '字段标准调整' },
      { version: 'v1.0.0', time: '2026-07-20 10:00', operator: '王强', note: '首次发布' },
    ],
  },
  {
    code: 'fct_video_play_di', name: '视频播放事实表', version: 'v1.3.0', status: '已发布', owner: '张伟', updated: '2026-08-04 15:02',
    history: [
      { version: 'v1.3.0', time: '2026-08-04 15:02', operator: '张伟', note: '增加播放时长度量' },
      { version: 'v1.2.0', time: '2026-07-28 11:00', operator: '李娜', note: '关联视频维度' },
    ],
  },
  {
    code: 'dim_channel_df', name: '频道维度表', version: 'v0.9.0', status: '开发中', owner: '王强', updated: '2026-08-02 16:40',
    history: [
      { version: 'v0.9.0', time: '2026-08-02 16:40', operator: '王强', note: '草稿' },
    ],
  },
  {
    code: 'dws_user_active_daily', name: '用户活跃日汇总表', version: 'v1.1.0', status: '待发布', owner: '李娜', updated: '2026-08-03 14:00',
    history: [
      { version: 'v1.1.0', time: '2026-08-03 14:00', operator: '李娜', note: '提交审核' },
    ],
  },
];

function bumpVersion(v: string): string {
  // v1.2.0 → v1.3.0
  const parts = v.replace(/^v/, '').split('.').map(Number);
  if (parts.length >= 2 && !isNaN(parts[1])) {
    parts[1] += 1;
    return `v${parts.join('.')}`;
  }
  return `${v}.1`;
}

function PublishManager({ onSelect: _onSelect }: { onSelect: (m: MockModel | null) => void }) {
  const [items, setItems] = useState<PublishItem[]>(() => JSON.parse(JSON.stringify(PUBLISH_ITEMS)));
  const [selected, setSelected] = useState<string | null>(null);
  const item = items.find(i => i.code === selected);

  // State transition: 草稿 → 待发布 → 已发布 → 已上线
  const advance = (code: string) => {
    setItems(prev => prev.map(i => {
      if (i.code !== code) return i;
      const next: Record<PublishItem['status'], PublishItem['status']> = { '草稿': '待发布', '待发布': '已发布', '已发布': '已上线', '已上线': '已上线', '开发中': '待发布' };
      const newStatus = next[i.status] ?? i.status;
      const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
      const ver = i.status === '已发布' ? bumpVersion(i.version) : i.version;
      return { ...i, status: newStatus, version: ver, updated: now };
    }));
  };

  const countBy = (s: string) => items.filter(i => i.status === s).length;

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Rocket className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">发布管理</span>
        <span className="text-xs text-muted-foreground">模型生命周期：草稿 → 待发布 → 已发布 → 已上线</span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {['草稿', '待发布', '已发布', '已上线'].map(s => (
            <span key={s} className="flex items-center gap-1">
              <span className={cn('w-2.5 h-2.5 rounded-full',
                s === '已上线' && 'bg-emerald-500', s === '已发布' && 'bg-blue-500',
                s === '待发布' && 'bg-amber-500', s === '草稿' && 'bg-gray-400')} />
              {s} <span className="text-muted-foreground tabular-nums">{countBy(s)}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">名称</th>
              <th className="px-3 py-2 font-medium">编码</th>
              <th className="px-3 py-2 font-medium">当前版本</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">负责人</th>
              <th className="px-3 py-2 font-medium">更新时间</th>
              <th className="px-3 py-2 font-medium w-40">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map(i => (
              <tr key={i.code} onClick={() => setSelected(i.code)}
                className={cn('border-t cursor-pointer hover:bg-accent/30', selected === i.code && 'bg-accent/50')}>
                <td className="px-3 py-2 font-medium">{i.name}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{i.code}</td>
                <td className="px-3 py-2 font-mono text-[11px]">{i.version}</td>
                <td className="px-3 py-2">
                  <Badge className={cn('text-[10px] font-medium',
                    i.status === '已上线' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
                    i.status === '已发布' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
                    i.status === '待发布' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
                    i.status === '草稿' && 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400')}>{i.status}</Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{i.owner}</td>
                <td className="px-3 py-2 text-muted-foreground">{i.updated}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={e => { e.stopPropagation(); setSelected(i.code); }}>编辑</Button>
                    {i.status === '草稿' && <Button size="sm" className="h-6 text-[10px] px-2" onClick={e => { e.stopPropagation(); advance(i.code); }}>提交发布</Button>}
                    {i.status === '待发布' && <Button size="sm" className="h-6 text-[10px] px-2 bg-blue-600 hover:bg-blue-700 text-white" onClick={e => { e.stopPropagation(); advance(i.code); }}>发布</Button>}
                    {i.status === '已发布' && <Button size="sm" className="h-6 text-[10px] px-2 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={e => { e.stopPropagation(); advance(i.code); }}>上线</Button>}
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={e => { e.stopPropagation(); setSelected(i.code); }}>版本</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Version history */}
      {item && (
        <div className="mt-4 border rounded-lg p-4 bg-card">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-semibold">{item.name}</span>
            <Badge className="text-[10px] bg-primary/10 text-primary font-mono">{item.version}</Badge>
            <span className="text-xs text-muted-foreground">版本历史</span>
          </div>
          <div className="space-y-0">
            {item.history.map((h, i) => (
              <div key={h.version} className="flex gap-3 pb-3">
                <div className="flex flex-col items-center">
                  <span className={cn('w-3 h-3 rounded-full border-2 mt-1', i === 0 ? 'bg-emerald-500 border-emerald-500' : 'bg-background border-muted-foreground/40')} />
                  {i < item.history.length - 1 && <span className="w-px flex-1 bg-muted" />}
                </div>
                <div className="flex-1 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium">{h.version}</span>
                    <span className="text-[10px] text-muted-foreground">{h.time}</span>
                    <span className="text-[10px] text-muted-foreground">by {h.operator}</span>
                    {i === 0 && <Badge className="text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">当前</Badge>}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{h.note}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function toMockModel(m: typeof GRAPH_MODELS[string]): MockModel {  const layerMap: Record<string, string> = { dim: 'DIM', fact: 'DWD', summary: 'DWS' };
  return {
    code: m.code,
    name: m.name,
    owner: '张伟',
    status: '已发布',
    updated: '2026-08-04 15:30',
    layer: layerMap[m.layer] ?? 'DWS',
    granularity: m.desc,
    fields: m.fields.map((f, i) => ({
      name: f,
      desc: f,
      type: i === 0 ? 'bigint' : i === 1 ? 'string' : 'bigint',
      category: i === 0 ? '主键' : '属性',
      dim: '',
      constraint: '',
    })),
  };
}

function GraphNode({ model, color, onClick }: { model: { name: string; code: string; desc: string; fields: string[] }; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full text-left rounded-lg border bg-card shadow-sm hover:shadow-md transition-shadow overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b" style={{ borderColor: `${color}33` }}>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: color }} />
          <span className="text-xs font-semibold truncate">{model.name}</span>
        </div>
        <div className="text-[9px] font-mono text-muted-foreground mt-0.5">{model.code}</div>
      </div>
      {/* Fields */}
      <div className="px-3 py-1.5 space-y-0.5">
        {model.fields.map(f => (
          <div key={f} className="flex items-center justify-between text-[9px]">
            <span className="font-mono text-muted-foreground">{f}</span>
            <span className="text-muted-foreground/50">·</span>
          </div>
        ))}
        <div className="text-[9px] text-muted-foreground/70 pt-0.5">{model.desc}</div>
      </div>
    </button>
  );
}
