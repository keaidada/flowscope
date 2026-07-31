/**
 * VisualModelDesigner — React Flow canvas for model design.
 *
 * Features:
 * - Display models as nodes with column lists
 * - Generate DDL from model definitions
 * - Reverse-engineer SQL to models
 * - Model diff comparison
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Code2, GitCompareArrows, FileSearch, Wand2, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { governanceApi } from '@/lib/governance-api';

interface ColumnDef {
  name: string;
  data_type: string;
  primary_key: boolean;
  nullable: boolean;
  description: string;
}

interface ModelDef {
  table_name: string;
  columns: ColumnDef[];
  description: string;
}

export function VisualModelDesigner() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'ddl' | 'reverse' | 'diff'>('ddl');
  const [ddlModel, setDdlModel] = useState<ModelDef>({
    table_name: 'dws_example',
    columns: [
      { name: 'dt', data_type: 'DATE', primary_key: true, nullable: false, description: '' },
      { name: 'amount', data_type: 'DECIMAL(10,2)', primary_key: false, nullable: false, description: '' },
    ],
    description: '',
  });
  const [dialect, setDialect] = useState('postgresql');
  const [ddlOutput, setDdlOutput] = useState('');
  const [reverseInput, setReverseInput] = useState('');
  const [reverseOutput, setReverseOutput] = useState<ModelDef[]>([]);
  const [diffOld, setDiffOld] = useState('');
  const [diffNew, setDiffNew] = useState('');
  const [diffOutput, setDiffOutput] = useState<{ added: string[]; removed: string[]; modified: Array<{ column: string; old_type: string; new_type: string }> } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleGenDdl = useCallback(async () => {
    try {
      const res = await governanceApi['genDdl'](ddlModel, dialect);
      setDdlOutput(res.ddl);
    } catch (e) {
      setDdlOutput(`Error: ${e}`);
    }
  }, [ddlModel, dialect]);

  const handleReverse = useCallback(async () => {
    try {
      const res = await governanceApi['reverseEngineer'](reverseInput);
      setReverseOutput(res as unknown as ModelDef[]);
    } catch (e) {
      console.error('Reverse engineer failed:', e);
    }
  }, [reverseInput]);

  const handleDiff = useCallback(async () => {
    try {
      const oldModels = await governanceApi['reverseEngineer'](diffOld);
      const newModels = await governanceApi['reverseEngineer'](diffNew);
      if (oldModels.length > 0 && newModels.length > 0) {
        const res = await governanceApi['modelDiff'](oldModels[0], newModels[0]);
        setDiffOutput(res);
      }
    } catch (e) {
      console.error('Diff failed:', e);
    }
  }, [diffOld, diffNew]);

  const handleCopy = () => {
    navigator.clipboard.writeText(ddlOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Mode tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b">
        <ModeTab active={mode === 'ddl'} onClick={() => setMode('ddl')} icon={Code2} label={t('governance.genDdl', 'DDL 生成')} />
        <ModeTab active={mode === 'reverse'} onClick={() => setMode('reverse')} icon={FileSearch} label={t('governance.reverseEngineer', '逆向工程')} />
        <ModeTab active={mode === 'diff'} onClick={() => setMode('diff')} icon={GitCompareArrows} label={t('governance.modelDiff', '模型对比')} />
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* DDL Generation */}
        {mode === 'ddl' && (
          <div className="space-y-4 max-w-3xl">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Wand2 className="h-4 w-4" />
              {t('governance.ddlFromModel', '从模型定义生成 DDL')}
            </h3>

            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground">{t('governance.dialect', '方言')}:</label>
              <select value={dialect} onChange={(e) => setDialect(e.target.value)} className="px-2 py-1 border rounded text-sm">
                <option value="postgresql">PostgreSQL</option>
                <option value="mysql">MySQL</option>
                <option value="snowflake">Snowflake</option>
                <option value="bigquery">BigQuery</option>
                <option value="clickhouse">ClickHouse</option>
              </select>
            </div>

            {/* Model editor */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  value={ddlModel.table_name}
                  onChange={(e) => setDdlModel({ ...ddlModel, table_name: e.target.value })}
                  className="px-2 py-1 border rounded text-sm font-mono flex-1"
                  placeholder="table_name"
                />
                <input
                  value={ddlModel.description}
                  onChange={(e) => setDdlModel({ ...ddlModel, description: e.target.value })}
                  className="px-2 py-1 border rounded text-sm flex-1"
                  placeholder="描述"
                />
              </div>

              {/* Columns */}
              <div className="border rounded">
                <div className="grid grid-cols-[1fr_1fr_auto_auto_1fr_32px] gap-2 px-2 py-1 bg-muted/50 text-xs text-muted-foreground">
                  <span>{t('governance.sourceTables', '列名')}</span>
                  <span>{t('governance.type', '类型')}</span>
                  <span>PK</span>
                  <span>NOT NULL</span>
                  <span>{t('governance.description', '注释')}</span>
                  <span></span>
                </div>
                {ddlModel.columns.map((col, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_1fr_auto_auto_1fr_32px] gap-2 px-2 py-1 border-t items-center">
                    <input
                      value={col.name}
                      onChange={(e) => updateColumn(ddlModel, setDdlModel, idx, { name: e.target.value })}
                      className="px-1 py-0.5 border rounded text-xs font-mono"
                    />
                    <input
                      value={col.data_type}
                      onChange={(e) => updateColumn(ddlModel, setDdlModel, idx, { data_type: e.target.value })}
                      className="px-1 py-0.5 border rounded text-xs font-mono"
                    />
                    <input type="checkbox" checked={col.primary_key}
                      onChange={(e) => updateColumn(ddlModel, setDdlModel, idx, { primary_key: e.target.checked })} />
                    <input type="checkbox" checked={!col.nullable}
                      onChange={(e) => updateColumn(ddlModel, setDdlModel, idx, { nullable: !e.target.checked })} />
                    <input
                      value={col.description}
                      onChange={(e) => updateColumn(ddlModel, setDdlModel, idx, { description: e.target.value })}
                      className="px-1 py-0.5 border rounded text-xs"
                    />
                    <button
                      onClick={() => setDdlModel({ ...ddlModel, columns: ddlModel.columns.filter((_, i) => i !== idx) })}
                      className="text-red-500 text-xs hover:text-red-700"
                    >✕</button>
                  </div>
                ))}
                <button
                  onClick={() => setDdlModel({ ...ddlModel, columns: [...ddlModel.columns, { name: '', data_type: 'VARCHAR(255)', primary_key: false, nullable: true, description: '' }] })}
                  className="w-full px-2 py-1 text-xs text-primary hover:bg-accent border-t"
                >+ {t('governance.addColumn', '添加列')}</button>
              </div>
            </div>

            <Button onClick={handleGenDdl} size="sm">
              <Code2 className="h-4 w-4 mr-1" />
              {t('governance.generate', '生成 DDL')}
            </Button>

            {ddlOutput && (
              <div className="relative">
                <pre className="p-3 bg-muted rounded-lg text-xs font-mono overflow-auto max-h-64">{ddlOutput}</pre>
                <button onClick={handleCopy} className="absolute top-2 right-2 p-1 bg-background border rounded hover:bg-accent">
                  {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Reverse Engineer */}
        {mode === 'reverse' && (
          <div className="space-y-3 max-w-3xl">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FileSearch className="h-4 w-4" />
              {t('governance.reverseEngineer', '逆向工程 — 从 SQL 提取模型')}
            </h3>
            <textarea
              value={reverseInput}
              onChange={(e) => setReverseInput(e.target.value)}
              placeholder="-- 粘贴 CREATE TABLE SQL..."
              className="w-full p-3 border rounded text-xs font-mono h-48 resize-none"
            />
            <Button onClick={handleReverse} size="sm" disabled={!reverseInput.trim()}>
              {t('governance.parse', '解析')}
            </Button>
            {reverseOutput.length > 0 && (
              <div className="space-y-3">
                {reverseOutput.map((m, i) => (
                  <div key={i} className="border rounded-lg p-3">
                    <div className="text-sm font-semibold font-mono">{m.table_name}</div>
                    {m.description && <div className="text-xs text-muted-foreground">{m.description}</div>}
                    <table className="w-full mt-2 text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b">
                          <th className="text-left py-1">{t('governance.sourceTables', '列名')}</th>
                          <th className="text-left py-1">{t('governance.type', '类型')}</th>
                          <th className="text-left py-1">{t('governance.description', '约束')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.columns.map((c, j) => (
                          <tr key={j} className="border-b">
                            <td className="py-1 font-mono">{c.name}</td>
                            <td className="py-1 font-mono">{c.data_type}</td>
                            <td className="py-1">
                              {c.primary_key && <span className="text-orange-600">PK</span>}{' '}
                              {!c.nullable && <span className="text-red-600">NOT NULL</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Model Diff */}
        {mode === 'diff' && (
          <div className="space-y-3 max-w-3xl">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <GitCompareArrows className="h-4 w-4" />
              {t('governance.modelDiff', '模型对比 — 对比两个版本的 CREATE TABLE')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">{t('governance.oldVersion', '旧版本')}</label>
                <textarea
                  value={diffOld}
                  onChange={(e) => setDiffOld(e.target.value)}
                  placeholder="CREATE TABLE ..."
                  className="w-full mt-1 p-2 border rounded text-xs font-mono h-40 resize-none"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('governance.newVersion', '新版本')}</label>
                <textarea
                  value={diffNew}
                  onChange={(e) => setDiffNew(e.target.value)}
                  placeholder="CREATE TABLE ..."
                  className="w-full mt-1 p-2 border rounded text-xs font-mono h-40 resize-none"
                />
              </div>
            </div>
            <Button onClick={handleDiff} size="sm" disabled={!diffOld.trim() || !diffNew.trim()}>
              {t('governance.compare', '对比')}
            </Button>
            {diffOutput && (
              <div className="border rounded-lg p-3 space-y-2">
                {diffOutput.added.length > 0 && (
                  <div className="text-sm">
                    <span className="text-green-600 font-medium">+ {t('governance.added', '新增')}:</span>
                    <span className="ml-2 font-mono">{diffOutput.added.join(', ')}</span>
                  </div>
                )}
                {diffOutput.removed.length > 0 && (
                  <div className="text-sm">
                    <span className="text-red-600 font-medium">- {t('governance.removed', '删除')}:</span>
                    <span className="ml-2 font-mono">{diffOutput.removed.join(', ')}</span>
                  </div>
                )}
                {diffOutput.modified.length > 0 && (
                  <div className="text-sm space-y-1">
                    <span className="text-yellow-600 font-medium">~ {t('governance.modified', '修改')}:</span>
                    {diffOutput.modified.map((m, i) => (
                      <div key={i} className="ml-4 font-mono text-xs">
                        {m.column}: <span className="text-red-400 line-through">{m.old_type}</span> → <span className="text-green-600">{m.new_type}</span>
                      </div>
                    ))}
                  </div>
                )}
                {diffOutput.added.length === 0 && diffOutput.removed.length === 0 && diffOutput.modified.length === 0 && (
                  <div className="text-sm text-green-600">✓ {t('governance.noChanges', '无变化')}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function updateColumn(model: ModelDef, setter: (m: ModelDef) => void, idx: number, patch: Partial<ColumnDef>) {
  const columns = [...model.columns];
  columns[idx] = { ...columns[idx], ...patch };
  setter({ ...model, columns });
}

function ModeTab({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ElementType; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 transition-colors',
        active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
