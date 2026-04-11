import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LineageActions } from '@pondpilot/flowscope-react';
import {
  GraphErrorBoundary,
  GraphView,
  MatrixView,
  SchemaView,
  useLineage,
} from '@pondpilot/flowscope-react';
import type { AnalyzeResult, SchemaTable } from '@pondpilot/flowscope-core';
import { ArrowRight, ChevronDown, ChevronRight, Database, Loader2, Settings, Table2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useGlobalShortcuts } from '@/hooks';
import type { GlobalShortcut } from '@/hooks';
import { getShortcutDisplay } from '@/lib/shortcuts';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePersistedLineageState } from '@/hooks/usePersistedLineageState';
import { usePersistedMatrixState } from '@/hooks/usePersistedMatrixState';
import { usePersistedSchemaState } from '@/hooks/usePersistedSchemaState';
import { isValidTab, useNavigation } from '@/lib/navigation-context';
import { useViewStateStore, getNamespaceFilterStateWithDefaults } from '@/lib/view-state-store';
import { useProject } from '@/lib/project-store';
import { schemaMetadataToSQL, resolvedSchemaToSQL } from '@/lib/schema-parser';
import { loadSchemaFiles } from '@/lib/schema-storage';
import { HierarchyView, type HierarchyViewRef } from './HierarchyView';
import { StatsPopover } from './StatsPopover';
import { NamespaceFilterBar } from './NamespaceFilterBar';
import { SchemaAwareIssuesPanel } from './SchemaAwareIssuesPanel';
import { SchemaEditor } from './SchemaEditor';

interface AnalysisViewProps {
  graphContainerRef?: React.RefObject<HTMLDivElement | null>;
  isAnalyzing?: boolean;
}

/**
 * Extract physical tables and their data flow relationships from lineage results.
 * This builds a simplified schema showing only table-to-table connections,
 * derived from the blood lineage analysis (not from column-level schema inference).
 */
/**
 * @param filterSourceName - If provided, only include statements from this source file.
 *                           Pass undefined/null to include all statements (global schema).
 */
function extractSchemaFromResult(result: AnalyzeResult, filterSourceName?: string | null): SchemaTable[] {
  // Collect all physical table nodes and their edges from (filtered) statements
  const tableMap = new Map<string, { catalog?: string; schema?: string; name: string }>();
  const flowEdges: { source: string; target: string }[] = [];

  // Filter statements by sourceName when in "current file" mode
  const statements = filterSourceName
    ? result.statements.filter((s) => s.sourceName === filterSourceName)
    : result.statements;

  // Build a set of temporary table names from resolvedSchema.
  // Temporary tables (CREATE TEMPORARY TABLE) should NOT appear as physical tables
  // in the schema list — they are intermediate/staging tables within the script.
  const temporaryTableNames = new Set<string>();
  if (result.resolvedSchema?.tables) {
    for (const rst of result.resolvedSchema.tables) {
      if (rst.temporary) {
        // Add all possible name forms: unqualified, schema-qualified, fully-qualified
        temporaryTableNames.add(rst.name);
        if (rst.schema) {
          temporaryTableNames.add(`${rst.schema}.${rst.name}`);
        }
        if (rst.catalog && rst.schema) {
          temporaryTableNames.add(`${rst.catalog}.${rst.schema}.${rst.name}`);
        }
      }
    }
  }

  // Helper: check if a node is a real physical table (not a CTE, alias, subquery, or temp table).
  // Strategy (in order of reliability):
  //   1. Must be table or view type
  //   2. Must NOT be a temporary table (checked against resolvedSchema)
  //   3. resolutionSource is set (imported/implied/unknown) → physical table for sure
  //      (CTE, derived tables, and aliases never have resolutionSource set by the engine)
  //   4. qualifiedName contains '.' → has schema/catalog prefix → physical table
  //   5. Otherwise → likely an alias or intermediate reference → skip
  // This correctly handles "USE database;" scenarios where the engine prepends the default
  // schema to the canonical name (e.g. "my_table" → "db.my_table" in qualifiedName).
  const isPhysicalTable = (node: { type: string; qualifiedName?: string; label: string; resolutionSource?: string }) => {
    if (node.type !== 'table' && node.type !== 'view') return false;
    // Exclude temporary tables — they are intermediate/staging, not real physical tables
    const qName = node.qualifiedName || node.label;
    if (temporaryTableNames.has(qName) || temporaryTableNames.has(node.label)) return false;
    // Physical tables always get a resolutionSource from the analyzer
    if (node.resolutionSource) return true;
    // Fallback: check for schema-qualified name
    return qName.includes('.');
  };

  for (const stmt of statements) {
    // Index nodes by id for lookup
    const nodeById = new Map<string, typeof stmt.nodes[0]>();
    for (const node of stmt.nodes) {
      nodeById.set(node.id, node);
    }

    // Collect only physical tables (schema-qualified names)
    for (const node of stmt.nodes) {
      if (isPhysicalTable(node)) {
        const qName = node.qualifiedName || node.label;
        if (!tableMap.has(qName)) {
          const parts = qName.split('.');
          if (parts.length >= 3) {
            // catalog.schema.table
            tableMap.set(qName, { catalog: parts[0], schema: parts[1], name: parts.slice(2).join('.') });
          } else if (parts.length === 2) {
            tableMap.set(qName, { schema: parts[0], name: parts[1] });
          } else {
            tableMap.set(qName, { name: qName });
          }
        }
      }
    }

    // Collect data flow edges between physical tables
    for (const edge of stmt.edges) {
      if (edge.type === 'ownership') continue;
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!fromNode || !toNode) continue;

      if (isPhysicalTable(fromNode) && isPhysicalTable(toNode)) {
        const sourceQName = fromNode.qualifiedName || fromNode.label;
        const targetQName = toNode.qualifiedName || toNode.label;
        flowEdges.push({ source: sourceQName, target: targetQName });
      }
    }

    // Trace indirect flows: physical table → intermediate → physical table
    // This handles paths through CTEs, aliases, subqueries, AND temporary tables.
    // Temporary tables are treated as intermediate nodes (like CTEs) — the BFS
    // traverses through them to find the real physical tables at the endpoints.
    const physicalNodes = stmt.nodes.filter(isPhysicalTable);
    const physicalIds = new Set(physicalNodes.map(n => n.id));

    // Build adjacency for BFS from physical source to physical target.
    // Include reverse ownership edges (column → owner table) so BFS can
    // traverse: source_table → CTE → target_column → target_table.
    // Without reverse ownership, the BFS cannot reach the INSERT target table
    // because data flows through columns that are owned by the target table
    // via ownership edges (table → column), but we need column → table direction.
    const adj = new Map<string, string[]>();
    for (const edge of stmt.edges) {
      if (edge.type === 'ownership') {
        // Reverse: column → owner table (so BFS can reach target table from its columns)
        if (!adj.has(edge.to)) adj.set(edge.to, []);
        adj.get(edge.to)!.push(edge.from);
      } else {
        if (!adj.has(edge.from)) adj.set(edge.from, []);
        adj.get(edge.from)!.push(edge.to);
      }
    }

    // For each physical source, BFS to find reachable physical targets
    for (const src of physicalNodes) {
      const visited = new Set<string>();
      const queue = [src.id];
      visited.add(src.id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of adj.get(current) || []) {
          if (visited.has(next)) continue;
          visited.add(next);
          if (physicalIds.has(next)) {
            // Found a physical target — record edge
            const targetNode = nodeById.get(next)!;
            const sourceQName = src.qualifiedName || src.label;
            const targetQName = targetNode.qualifiedName || targetNode.label;
            if (sourceQName !== targetQName) {
              flowEdges.push({ source: sourceQName, target: targetQName });
            }
          } else {
            // Intermediate node (CTE, alias, temp table) — continue traversal
            queue.push(next);
          }
        }
      }
    }
  }

  // Use global lineage for cross-statement flows.
  // This is essential for scripts like B10_INFO_CID.HQL where data flows through
  // temporary tables across statements:
  //   stmt1: CREATE TEMP TABLE a AS (SELECT ... FROM his_db.xxx)
  //   stmt7: INSERT OVERWRITE TABLE sum_db.xxx SELECT ... FROM target_tmp_1
  // Without global lineage, the per-statement BFS cannot connect physical source
  // tables (in stmt1-6) to the physical target table (in stmt7) since they are
  // separated by temporary table intermediaries in different statements.
  //
  // In "current file" mode, we filter global nodes to only those that belong to
  // the filtered statements (via statementRefs).
  if (result.globalLineage?.nodes) {
    // In current-file mode, build a set of statement indices we care about
    const relevantStatementIndices = filterSourceName
      ? new Set(statements.map(s => s.statementIndex))
      : null; // null = all statements (global mode)

    // Helper: check if a global node is relevant (belongs to filtered statements)
    const isRelevantGlobalNode = (node: { statementRefs?: Array<{ statementIndex: number }> }) => {
      if (!relevantStatementIndices) return true; // global mode — all are relevant
      return node.statementRefs?.some(ref => relevantStatementIndices.has(ref.statementIndex)) ?? false;
    };

    // Helper: build qualified name from global node's canonicalName
    // Global nodes use `label` for display but `canonicalName` for structure.
    // We need to match against tableMap which uses qualified names like "his_db.med_cover_extend_hour".
    const getGlobalNodeQName = (node: { label: string; canonicalName?: { catalog?: string; schema?: string; name: string } }): string => {
      const cn = node.canonicalName;
      if (cn) {
        const parts = [cn.catalog, cn.schema, cn.name].filter(Boolean);
        if (parts.length > 1) return parts.join('.');
      }
      return node.label;
    };

    for (const node of result.globalLineage.nodes) {
      if (!isRelevantGlobalNode(node)) continue;
      const cn = node.canonicalName;
      const qName = getGlobalNodeQName(node);
      // Physical tables: have resolutionSource, or have a schema in canonicalName
      // CTE/column nodes and temporary tables are excluded
      const isPhysical = node.type !== 'cte' && node.type !== 'column' &&
        !temporaryTableNames.has(qName) &&
        !temporaryTableNames.has(node.label) &&
        !temporaryTableNames.has(cn?.name || '') &&
        (node.resolutionSource || cn?.schema);
      if (isPhysical) {
        if (!tableMap.has(qName)) {
          tableMap.set(qName, {
            catalog: cn?.catalog,
            schema: cn?.schema,
            name: cn?.name || node.label,
          });
        }
      }
    }

    // Build adjacency for global lineage BFS (to traverse through temp tables)
    const globalNodeById = new Map<string, typeof result.globalLineage.nodes[0]>();
    for (const node of result.globalLineage.nodes) {
      globalNodeById.set(node.id, node);
    }
    const globalAdj = new Map<string, string[]>();
    for (const edge of result.globalLineage.edges || []) {
      if (!globalAdj.has(edge.from)) globalAdj.set(edge.from, []);
      globalAdj.get(edge.from)!.push(edge.to);
    }

    // Identify physical global nodes by matching their qName against tableMap
    const physicalGlobalNodeIds = new Set<string>();
    const globalNodeQNames = new Map<string, string>(); // nodeId -> qName
    for (const node of result.globalLineage.nodes) {
      const qName = getGlobalNodeQName(node);
      globalNodeQNames.set(node.id, qName);
      if (tableMap.has(qName)) {
        physicalGlobalNodeIds.add(node.id);
      }
    }

    // BFS through global lineage to find indirect flows (physical → temp → ... → physical)
    // This also handles direct edges (distance-1 BFS)
    for (const srcNode of result.globalLineage.nodes) {
      if (!physicalGlobalNodeIds.has(srcNode.id)) continue;
      const srcQName = globalNodeQNames.get(srcNode.id)!;
      const visited = new Set<string>();
      const queue = [srcNode.id];
      visited.add(srcNode.id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of globalAdj.get(current) || []) {
          if (visited.has(next)) continue;
          visited.add(next);
          if (physicalGlobalNodeIds.has(next)) {
            const targetQName = globalNodeQNames.get(next)!;
            if (srcQName !== targetQName) {
              flowEdges.push({ source: srcQName, target: targetQName });
            }
          } else {
            // Intermediate node (temp table, CTE) — continue traversal
            queue.push(next);
          }
        }
      }
    }
  }

  // Build SchemaTable[] with FK refs representing data flow
  // First, deduplicate tableMap: the same physical table may have been registered under
  // different keys (e.g. "med_cover_vec_hour" from one statement and "his_db.med_cover_vec_hour"
  // from another). We merge them by preferring the longer (more qualified) key.
  const canonicalKeyMap = new Map<string, string>(); // short/unqualified → longest key
  for (const qName of tableMap.keys()) {
    const info = tableMap.get(qName)!;
    // Build canonical identity: schema.name (or just name if no schema)
    const identity = info.schema ? `${info.schema}.${info.name}` : info.name;
    const existing = canonicalKeyMap.get(identity);
    if (!existing || qName.length > existing.length) {
      canonicalKeyMap.set(identity, qName);
    }
  }
  // Build set of keys to keep (the longest/most-qualified form of each table)
  const keysToKeep = new Set(canonicalKeyMap.values());
  // Build a mapping from any key to the canonical key (for edge remapping)
  const keyToCanonical = new Map<string, string>();
  for (const qName of tableMap.keys()) {
    const info = tableMap.get(qName)!;
    const identity = info.schema ? `${info.schema}.${info.name}` : info.name;
    keyToCanonical.set(qName, canonicalKeyMap.get(identity)!);
  }

  // Deduplicate edges using canonical keys
  const edgeSet = new Set(flowEdges.map(e => {
    const src = keyToCanonical.get(e.source) || e.source;
    const tgt = keyToCanonical.get(e.target) || e.target;
    return `${src}→${tgt}`;
  }));
  const edgesByTarget = new Map<string, string[]>();
  for (const key of edgeSet) {
    const [source, target] = key.split('→');
    if (!edgesByTarget.has(target)) edgesByTarget.set(target, []);
    edgesByTarget.get(target)!.push(source);
  }

  // Build a lookup from resolvedSchema for DDL column info.
  // Maps qualified table name (e.g. "his_db.ai_chk_idtfy") → column definitions
  const resolvedColumnsMap = new Map<string, Array<{ name: string; dataType?: string; isPrimaryKey?: boolean }>>();
  if (result.resolvedSchema?.tables) {
    for (const rst of result.resolvedSchema.tables) {
      // Build all possible name forms for matching
      const names: string[] = [rst.name];
      if (rst.schema) names.push(`${rst.schema}.${rst.name}`);
      if (rst.catalog && rst.schema) names.push(`${rst.catalog}.${rst.schema}.${rst.name}`);
      for (const n of names) {
        resolvedColumnsMap.set(n.toLowerCase(), rst.columns.map(c => ({
          name: c.name,
          dataType: c.dataType,
          isPrimaryKey: c.isPrimaryKey,
        })));
      }
    }
  }

  const tables: SchemaTable[] = [];
  for (const [qName, info] of tableMap) {
    if (!keysToKeep.has(qName)) continue; // skip duplicate shorter-named entries
    // Build columns as FK refs to represent incoming data flow
    const sources = edgesByTarget.get(qName) || [];
    const flowColumns = sources.map(sourceName => ({
      name: `← ${sourceName}`,
      dataType: undefined as string | undefined,
      isPrimaryKey: false,
      foreignKey: { table: sourceName, column: 'flow' },
    }));

    // Look up DDL columns from resolvedSchema
    const ddlColumns = resolvedColumnsMap.get(qName.toLowerCase()) || [];

    tables.push({
      catalog: info.catalog,
      schema: info.schema,
      name: info.name,
      columns: [...flowColumns, ...ddlColumns],
    });
  }

  return tables;
}

// ============================================================================
// Schema List View (for "current file" mode)
// ============================================================================

interface SchemaListViewProps {
  schema: SchemaTable[];
}

function SchemaListView({ schema }: SchemaListViewProps) {
  const { t } = useTranslation();
  const [expandedTables, setExpandedTables] = useState<Set<string>>(() => new Set());

  const toggleTable = useCallback((tableName: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) {
        next.delete(tableName);
      } else {
        next.add(tableName);
      }
      return next;
    });
  }, []);

  // Separate tables into target tables and source tables, mark data flow status
  const { targetTables, sourceTables } = useMemo(() => {
    const targets: { fullName: string; table: SchemaTable; sources: string[]; ddlColumns: Array<{ name: string; dataType?: string; isPrimaryKey?: boolean }> }[] = [];
    const referencedSourceNames = new Set<string>();

    for (const table of schema) {
      const fullName = [table.catalog, table.schema, table.name].filter(Boolean).join('.');
      const incomingSources = (table.columns || [])
        .filter((col) => col.name.startsWith('← '))
        .map((col) => col.name.replace('← ', ''));
      const ddlColumns = (table.columns || [])
        .filter((col) => !col.name.startsWith('← '));

      if (incomingSources.length > 0) {
        targets.push({ fullName, table, sources: incomingSources, ddlColumns });
        for (const src of incomingSources) {
          referencedSourceNames.add(src);
        }
      }
    }

    // Source tables: all non-target tables, with data flow indicator
    const sources: { fullName: string; table: SchemaTable; hasDataFlow: boolean; ddlColumns: Array<{ name: string; dataType?: string; isPrimaryKey?: boolean }> }[] = [];
    for (const table of schema) {
      const fullName = [table.catalog, table.schema, table.name].filter(Boolean).join('.');
      const isTarget = targets.some((t) => t.fullName === fullName);
      if (!isTarget) {
        const ddlColumns = (table.columns || []).filter((col) => !col.name.startsWith('← '));
        sources.push({ fullName, table, hasDataFlow: referencedSourceNames.has(fullName), ddlColumns });
      }
    }

    return { targetTables: targets, sourceTables: sources };
  }, [schema]);

  if (schema.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>{t('schemaView.noSchemaData')}</p>
      </div>
    );
  }

  const renderSchemaPrefix = (table: SchemaTable) => {
    const prefix = [table.catalog, table.schema].filter(Boolean).join('.');
    if (!prefix) return null;
    return (
      <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
        {prefix}
      </span>
    );
  };

  return (
    <div className="h-full overflow-auto">
      {/* Target tables section */}
      {targetTables.length > 0 && (
        <div>
          <div className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 border-b">
            {t('schemaView.targetTable')}
          </div>
          <div className="divide-y divide-border">
            {targetTables.map(({ fullName, table, sources, ddlColumns }) => {
              const isExpanded = expandedTables.has(fullName);
              return (
                <div key={fullName}>
                  <button
                    onClick={() => toggleTable(fullName)}
                    className="flex items-center gap-2 w-full px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                  >
                    <span className="text-muted-foreground shrink-0">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </span>
                    <Database className="h-4 w-4 text-orange-500 shrink-0" />
                    <span className="font-semibold text-sm truncate">{table.name}</span>
                    {renderSchemaPrefix(table)}
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">
                      {t('schemaView.sourceCount', { count: sources.length })}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="pb-2 pl-14 pr-4">
                      <div className="text-xs text-muted-foreground mb-1.5 font-medium">
                        {t('schemaView.dataFlowSources')}
                      </div>
                      <div className="space-y-1">
                        {sources.map((srcName, idx) => (
                          <div
                            key={`${srcName}-${idx}`}
                            className="flex items-center gap-2 text-sm text-foreground/80"
                          >
                            <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span className="truncate">{srcName}</span>
                          </div>
                        ))}
                      </div>
                      {ddlColumns.length > 0 && (
                        <div className="mt-3">
                          <div className="text-xs text-muted-foreground mb-1.5 font-medium">
                            {t('hierarchyView.columnsLabel', { count: ddlColumns.length })}
                          </div>
                          <div className="space-y-0.5">
                            {ddlColumns.map((col, idx) => (
                              <div key={`${col.name}-${idx}`} className="flex items-center gap-2 text-xs text-foreground/70">
                                <span className="w-1.5 h-1.5 rounded-full bg-primary/50 shrink-0" />
                                <span className="truncate font-mono">{col.name}</span>
                                {col.dataType && <span className="text-muted-foreground shrink-0">{col.dataType}</span>}
                                {col.isPrimaryKey && <span className="text-amber-500 text-[10px] shrink-0">PK</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Source tables section */}
      {sourceTables.length > 0 && (
        <div>
          <div className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 border-b">
            {t('schemaView.sourceTable')}
            <span className="ml-1.5 font-normal normal-case">({sourceTables.length})</span>
          </div>
          <div className="divide-y divide-border">
            {sourceTables.map(({ fullName, table, hasDataFlow, ddlColumns }) => {
              const isExpanded = expandedTables.has(fullName);
              const hasColumns = ddlColumns.length > 0;
              return (
                <div key={fullName}>
                  <div
                    className={cn("flex items-center gap-2 px-4 py-2.5", hasColumns && "cursor-pointer hover:bg-muted/50")}
                    onClick={hasColumns ? () => toggleTable(fullName) : undefined}
                  >
                    {hasColumns ? (
                      <span className="text-muted-foreground shrink-0">
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </span>
                    ) : (
                      <span className="inline-block w-4 shrink-0" />
                    )}
                    <Table2 className="h-4 w-4 text-primary shrink-0" />
                    <span className="font-medium text-sm truncate">{table.name}</span>
                    {renderSchemaPrefix(table)}
                    <span className="ml-auto shrink-0">
                      {hasDataFlow ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                          {t('schemaView.hasDataFlow')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                          {t('schemaView.noDataFlow')}
                        </span>
                      )}
                    </span>
                  </div>
                  {isExpanded && ddlColumns.length > 0 && (
                    <div className="pb-2 pl-14 pr-4">
                      <div className="text-xs text-muted-foreground mb-1.5 font-medium">
                        {t('hierarchyView.columnsLabel', { count: ddlColumns.length })}
                      </div>
                      <div className="space-y-0.5">
                        {ddlColumns.map((col, idx) => (
                          <div key={`${col.name}-${idx}`} className="flex items-center gap-2 text-xs text-foreground/70">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary/50 shrink-0" />
                            <span className="truncate font-mono">{col.name}</span>
                            {col.dataType && <span className="text-muted-foreground shrink-0">{col.dataType}</span>}
                            {col.isPrimaryKey && <span className="text-amber-500 text-[10px] shrink-0">PK</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Main analysis view component showing lineage graph, schema, and details.
 */
export function AnalysisView({
  graphContainerRef: externalGraphRef,
  isAnalyzing = false,
}: AnalysisViewProps) {
  const { t } = useTranslation();
  const { state, actions } = useLineage();
  const { result } = state;
  const internalGraphRef = useRef<HTMLDivElement>(null);
  const graphContainerRef = externalGraphRef || internalGraphRef;
  const hierarchyViewRef = useRef<HierarchyViewRef>(null);

  // Helper to focus search inputs with development-mode warnings
  const focusSearchInput = useCallback((selector: string, fallbackName: string) => {
    const element = document.querySelector(selector) as HTMLInputElement;
    if (element) {
      element.focus();
    } else if (import.meta.env.DEV) {
      console.warn(`Focus target "${fallbackName}" not found with selector: ${selector}`);
    }
  }, []);

  // Use refs to avoid stale closures and prevent unnecessary shortcut re-memoization
  const actionsRef = useRef<LineageActions>(actions);
  const stateRef = useRef(state);
  useEffect(() => {
    actionsRef.current = actions;
    stateRef.current = state;
  }, [actions, state]);
  const { currentProject, updateSchemaSQL, activeProjectId, isBackendMode, backendSchema } =
    useProject();
  const [schemaEditorOpen, setSchemaEditorOpen] = useState(false);
  const [matchedDDL, setMatchedDDL] = useState<string>('');
  const [schemaLoading, setSchemaLoading] = useState(false);
  const { activeTab, setActiveTab, navigationTarget, clearNavigationTarget } = useNavigation();
  const [lineageFocusNodeId, setLineageFocusNodeId] = useState<string | undefined>(undefined);
  const [fitViewTrigger, setFitViewTrigger] = useState(0);
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => new Set([activeTab]));

  // When Schema editor opens, extract matched DDL from schema files for physical tables in analysis
  useEffect(() => {
    if (!schemaEditorOpen || isBackendMode || !activeProjectId || !result) {
      return;
    }
    setSchemaLoading(true);
    setMatchedDDL('');

    // Collect physical table names from analysis result
    const tableNames = new Set<string>();
    for (const stmt of result.statements) {
      for (const node of stmt.nodes) {
        if (node.type === 'table' || node.type === 'view') {
          const qName = node.qualifiedName || node.label;
          tableNames.add(qName.toLowerCase());
          // Also add short name for matching
          const parts = qName.split('.');
          if (parts.length > 1) {
            tableNames.add(parts[parts.length - 1].toLowerCase());
          }
        }
      }
    }

    if (tableNames.size === 0) {
      setMatchedDDL(resolvedSchemaToSQL(result?.resolvedSchema));
      setSchemaLoading(false);
      return;
    }

    // Load schema files from IndexedDB and extract matching CREATE TABLE blocks
    loadSchemaFiles(activeProjectId).then(files => {
      if (files.length === 0) {
        setMatchedDDL(resolvedSchemaToSQL(result?.resolvedSchema));
        setSchemaLoading(false);
        return;
      }

      const matchedBlocks: string[] = [];
      const allContent = files.map(f => f.content).join('\n\n');

      // Split by CREATE TABLE statements — regex to find each CREATE TABLE ... ; block
      // Matches: CREATE [EXTERNAL] TABLE [IF NOT EXISTS] `name`(...); including Hive DDL
      const createTableRegex = /CREATE\s+(?:EXTERNAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([^\s(`"]+)[`"]?\s*\(/gi;
      let match;

      while ((match = createTableRegex.exec(allContent)) !== null) {
        const tableName = match[1].replace(/`/g, '').toLowerCase();
        const shortName = tableName.split('.').pop() || tableName;

        // Check if this table is referenced in the analysis
        if (tableNames.has(tableName) || tableNames.has(shortName)) {
          // Extract the full CREATE TABLE block: from "CREATE" to the next ";" or next "CREATE"
          const blockStart = match.index;
          // Find the end: look for the matching semicolon (handling nested parens)
          let depth = 0;
          let blockEnd = blockStart;
          let foundOpenParen = false;
          for (let i = blockStart; i < allContent.length; i++) {
            const ch = allContent[i];
            if (ch === '(') { depth++; foundOpenParen = true; }
            else if (ch === ')') { depth--; }
            else if (ch === ';' && foundOpenParen && depth <= 0) {
              blockEnd = i + 1;
              break;
            }
            // Also stop at next CREATE TABLE if no semicolon found
            if (i > blockStart + 10 && foundOpenParen && depth <= 0 && allContent.substring(i, i + 6).toUpperCase() === 'CREATE') {
              blockEnd = i;
              break;
            }
            blockEnd = i + 1;
          }

          const block = allContent.substring(blockStart, blockEnd).trim().replace(/;+$/, '');
          if (block.length > 0) {
            matchedBlocks.push(block);
          }
        }
      }

      if (matchedBlocks.length > 0) {
        setMatchedDDL(
          `-- 匹配到 ${matchedBlocks.length} 个物理表的 DDL 定义\n\n` +
          matchedBlocks.join(';\n\n') + ';'
        );
      } else {
        setMatchedDDL(resolvedSchemaToSQL(result?.resolvedSchema));
      }
      setSchemaLoading(false);
    });
  }, [schemaEditorOpen, isBackendMode, activeProjectId, result]);

  // Persisted state hooks for each view
  const matrixState = usePersistedMatrixState(activeProjectId);
  const lineageState = usePersistedLineageState(activeProjectId);
  const schemaState = usePersistedSchemaState(activeProjectId);

  // Refs for shortcut handlers to access latest values without re-memoization
  const activeTabRef = useRef(activeTab);
  const matrixStateRef = useRef(matrixState);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    matrixStateRef.current = matrixState;
  }, [matrixState]);

  // Handle navigation target for GraphView - select and focus node/statement when navigating to lineage tab
  useEffect(() => {
    if (activeTab === 'lineage' && navigationTarget) {
      if (navigationTarget.tableId) {
        // Navigate to specific table node
        actionsRef.current.selectNode(navigationTarget.tableId);
        setLineageFocusNodeId(navigationTarget.tableId);
      } else if (navigationTarget.fitView) {
        // Trigger fitView to show all nodes (e.g., from Issues panel)
        setFitViewTrigger((prev) => prev + 1);
      }
      clearNavigationTarget();
    }
  }, [activeTab, navigationTarget, clearNavigationTarget]);

  // Handle navigation target for SchemaView - select table when navigating to schema tab
  useEffect(() => {
    if (activeTab === 'schema' && navigationTarget?.tableName) {
      schemaState.setSelectedTableName(navigationTarget.tableName);
      clearNavigationTarget();
    }
  }, [activeTab, navigationTarget, clearNavigationTarget, schemaState]);

  const handleLineageFocusApplied = useCallback(() => {
    setLineageFocusNodeId(undefined);
  }, []);

  // Schema scope: 'current' = current file only, 'global' = all files
  const [schemaScope, setSchemaScope] = useState<'current' | 'global'>('current');

  // Get active file path for filtering
  const activeFilePath = currentProject?.files.find(
    (f) => f.id === currentProject.activeFileId
  )?.path;

  const currentFileSchema = useMemo(() => {
    if (!result || !activeFilePath) return [];
    return extractSchemaFromResult(result, activeFilePath);
  }, [result, activeFilePath]);

  const globalSchema = useMemo(() => {
    if (!result) return [];
    return extractSchemaFromResult(result);
  }, [result]);

  // Read namespace filter state from view state store
  const storedNamespaceFilter = useViewStateStore((state) =>
    activeProjectId ? state.viewStates[activeProjectId]?.namespaceFilter : undefined
  );
  const namespaceFilter = useMemo(
    () => getNamespaceFilterStateWithDefaults(storedNamespaceFilter),
    [storedNamespaceFilter]
  );

  // Extract unique schemas and databases from globalLineage nodes
  const { availableSchemas, availableDatabases } = useMemo(() => {
    if (!result?.globalLineage?.nodes) {
      return { availableSchemas: [], availableDatabases: [] };
    }

    const schemas = new Set<string>();
    const databases = new Set<string>();

    for (const node of result.globalLineage.nodes) {
      // Skip column nodes - their canonicalName structure differs:
      // columns have qualified_name like "schema.table.column" which
      // parse_canonical_name incorrectly interprets as "catalog.schema.table"
      if (node.type === 'column') continue;

      const { schema, catalog } = node.canonicalName || {};
      if (schema) schemas.add(schema);
      if (catalog) databases.add(catalog);
    }

    return {
      availableSchemas: Array.from(schemas).sort(),
      availableDatabases: Array.from(databases).sort(),
    };
  }, [result]);

  const handleSaveSchema = useCallback(
    (schemaSQL: string) => {
      if (activeProjectId) {
        updateSchemaSQL(activeProjectId, schemaSQL);
        // Analysis will be re-triggered automatically via useEffect in parent
      }
    },
    [activeProjectId, updateSchemaSQL]
  );

  const handleTabChange = useCallback(
    (value: string) => {
      if (isValidTab(value)) {
        setActiveTab(value);
      }
    },
    [setActiveTab]
  );

  // Ensure the active tab is always mounted (handles both user clicks and external changes)
  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev.has(activeTab)) return prev;
      return new Set([...prev, activeTab]);
    });
  }, [activeTab]);

  // Ref for shortcuts to use handleTabChange without re-memoization
  const handleTabChangeRef = useRef(handleTabChange);
  useEffect(() => {
    handleTabChangeRef.current = handleTabChange;
  }, [handleTabChange]);

  const summary = result?.summary;
  const hasIssues = summary
    ? summary.issueCount.errors > 0 || summary.issueCount.warnings > 0
    : false;

  // Tab switching and schema editor shortcuts
  // Uses refs for frequently-changing values to avoid re-memoization on every state change
  const tabShortcuts = useMemo<GlobalShortcut[]>(
    () => [
      { key: '1', handler: () => handleTabChangeRef.current('lineage') },
      { key: '2', handler: () => handleTabChangeRef.current('hierarchy') },
      { key: '3', handler: () => handleTabChangeRef.current('matrix') },
      { key: '4', handler: () => handleTabChangeRef.current('schema') },
      {
        key: '5',
        handler: () => {
          if (hasIssues) handleTabChangeRef.current('issues');
        },
      },
      // Schema editor shortcut (disabled in serve mode)
      {
        key: 'k',
        cmdOrCtrl: true,
        shift: true,
        handler: () => {
          if (!isBackendMode) {
            setSchemaEditorOpen(true);
          }
        },
      },
      // Lineage view shortcuts (only active when on lineage tab)
      {
        key: 'v',
        handler: () => {
          if (activeTabRef.current === 'lineage') {
            const newMode = stateRef.current.viewMode === 'table' ? 'script' : 'table';
            actionsRef.current.setViewMode(newMode);
          }
        },
      },
      {
        key: 'c',
        handler: () => {
          if (activeTabRef.current === 'lineage') {
            actionsRef.current.toggleColumnEdges();
          }
        },
      },
      {
        key: 'e',
        handler: () => {
          if (activeTabRef.current === 'lineage') {
            actionsRef.current.setAllNodesCollapsed(false); // Expand all
          }
        },
      },
      {
        key: 'e',
        shift: true,
        handler: () => {
          if (activeTabRef.current === 'lineage') {
            actionsRef.current.setAllNodesCollapsed(true); // Collapse all
          }
        },
      },
      {
        key: 't',
        handler: () => {
          if (activeTabRef.current === 'lineage') {
            actionsRef.current.toggleShowScriptTables();
          }
        },
      },
      {
        key: 'l',
        handler: () => {
          if (activeTabRef.current === 'lineage') {
            const newLayout = stateRef.current.layoutAlgorithm === 'dagre' ? 'elk' : 'dagre';
            actionsRef.current.setLayoutAlgorithm(newLayout);
          }
        },
      },
      {
        key: '/',
        handler: () => {
          // Focus the search input in the current view
          if (activeTabRef.current === 'lineage') {
            focusSearchInput('[data-graph-search-input]', 'lineage search');
          } else if (activeTabRef.current === 'hierarchy') {
            // Use ref for hierarchy view (app layer, full control)
            hierarchyViewRef.current?.focusSearch();
          } else if (activeTabRef.current === 'matrix') {
            focusSearchInput('[data-matrix-search-input]', 'matrix search');
          }
        },
      },
      // Matrix view shortcuts
      {
        key: 'h',
        handler: () => {
          if (activeTabRef.current === 'matrix') {
            const ms = matrixStateRef.current;
            const currentHeatmap = ms.controlledState.heatmapMode ?? false;
            ms.onStateChange({ heatmapMode: !currentHeatmap });
          }
        },
      },
      {
        key: 'x',
        handler: () => {
          if (activeTabRef.current === 'matrix') {
            const ms = matrixStateRef.current;
            const currentXRay = ms.controlledState.xRayMode ?? false;
            ms.onStateChange({ xRayMode: !currentXRay });
          }
        },
      },
    ],
    [hasIssues, focusSearchInput, isBackendMode]
  );

  useGlobalShortcuts(tabShortcuts);

  // Redirect from issues tab if there are no issues
  // This effect must be before any early returns to satisfy Rules of Hooks
  useEffect(() => {
    if (!hasIssues && activeTab === 'issues') {
      handleTabChangeRef.current('lineage');
    }
  }, [hasIssues, activeTab]);

  if (!result || !summary) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/5">
        <div className="p-6 text-center">
          {isAnalyzing ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin mx-auto mb-3 opacity-70" />
              <h3 className="font-semibold mb-2">Analyzing SQL</h3>
              <p className="text-sm max-w-xs mx-auto">
                Building lineage, schema, and issue details for the current analysis run.
              </p>
            </>
          ) : (
            <>
              <h3 className="font-semibold mb-2">No Analysis Results</h3>
              <p className="text-sm max-w-xs mx-auto">
                Run analysis on your SQL script to see lineage and schema details here.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex-1 flex flex-col min-h-0"
      >
        <div className="px-4 py-2 border-b flex items-center justify-between bg-muted/10 h-[44px] shrink-0">
          <TabsList>
            <TabsTrigger value="lineage">{t('analysis.lineage')}</TabsTrigger>
            <TabsTrigger value="hierarchy">{t('analysis.hierarchy')}</TabsTrigger>
            <TabsTrigger value="matrix">{t('analysis.matrix')}</TabsTrigger>
            <TabsTrigger value="schema">{t('analysis.schema')}</TabsTrigger>
            {hasIssues && (
              <TabsTrigger value="issues" className="text-warning-light dark:text-warning-dark">
                {t('analysis.issuesCount', { count: summary.issueCount.errors + summary.issueCount.warnings })}
              </TabsTrigger>
            )}
          </TabsList>

          {/* Stats Popover and Actions */}
          <div className="flex items-center gap-2">
            <StatsPopover
              tableCount={summary.tableCount}
              columnCount={summary.columnCount}
              joinCount={summary.joinCount}
              complexityScore={summary.complexityScore}
            />
            {/* Hide Schema editor button in serve mode - schema comes from CLI */}
            {!isBackendMode && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSchemaEditorOpen(true)}
                      className="h-7 text-xs"
                    >
                      <Settings className="h-3 w-3 mr-1" />
                      {t('analysis.schema')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="flex items-center gap-2">
                      {t('analysis.editSchema')}
                      <kbd className="px-1.5 py-0.5 text-xs bg-muted rounded border font-mono">
                        {getShortcutDisplay('edit-schema')}
                      </kbd>
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        {/* Namespace filter bar - only shown when schemas/databases are available */}
        {activeProjectId && (availableSchemas.length > 0 || availableDatabases.length > 0) && (
          <NamespaceFilterBar
            projectId={activeProjectId}
            availableSchemas={availableSchemas}
            availableDatabases={availableDatabases}
          />
        )}

        <div className="flex-1 overflow-hidden relative">
          {/* forceMount keeps components mounted when switching tabs to preserve state */}
          <TabsContent
            value="lineage"
            forceMount
            className="h-full mt-0 p-0 absolute inset-0 data-[state=inactive]:hidden"
          >
            <GraphErrorBoundary>
              <GraphView
                graphContainerRef={graphContainerRef}
                className="h-full w-full"
                focusNodeId={lineageFocusNodeId}
                onFocusApplied={handleLineageFocusApplied}
                controlledSearchTerm={lineageState.searchTerm}
                onSearchTermChange={lineageState.onSearchTermChange}
                initialViewport={lineageState.initialViewport}
                onViewportChange={lineageState.onViewportChange}
                fitViewTrigger={fitViewTrigger}
                namespaceFilter={namespaceFilter}
              />
            </GraphErrorBoundary>
          </TabsContent>

          <TabsContent
            value="hierarchy"
            forceMount
            className="h-full mt-0 p-0 absolute inset-0 data-[state=inactive]:hidden"
          >
            {mountedTabs.has('hierarchy') && (
              <GraphErrorBoundary>
                <HierarchyView
                  ref={hierarchyViewRef}
                  className="h-full"
                  projectId={activeProjectId}
                />
              </GraphErrorBoundary>
            )}
          </TabsContent>

          <TabsContent
            value="matrix"
            forceMount
            className="h-full mt-0 p-0 absolute inset-0 data-[state=inactive]:hidden"
          >
            {mountedTabs.has('matrix') && (
              <MatrixView
                className="h-full"
                controlledState={matrixState.controlledState}
                onStateChange={matrixState.onStateChange}
              />
            )}
          </TabsContent>

          <TabsContent
            value="schema"
            forceMount
            className="h-full mt-0 p-0 absolute inset-0 data-[state=inactive]:hidden"
          >
            {mountedTabs.has('schema') && (
              <div className="flex flex-col h-full">
                {/* Schema scope toggle */}
                <div className="flex items-center gap-1 px-3 py-1.5 border-b bg-muted/5 shrink-0">
                  <div className="inline-flex items-center rounded-md bg-muted p-0.5 text-xs">
                    <button
                      onClick={() => setSchemaScope('current')}
                      className={cn(
                        'px-2.5 py-1 rounded-sm transition-colors',
                        schemaScope === 'current'
                          ? 'bg-background text-foreground shadow-sm font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t('analysis.schemaCurrentFile')}
                      {currentFileSchema.length > 0 && (
                        <span className="ml-1 text-muted-foreground">({currentFileSchema.length})</span>
                      )}
                    </button>
                    <button
                      onClick={() => setSchemaScope('global')}
                      className={cn(
                        'px-2.5 py-1 rounded-sm transition-colors',
                        schemaScope === 'global'
                          ? 'bg-background text-foreground shadow-sm font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t('analysis.schemaGlobal')}
                      {globalSchema.length > 0 && (
                        <span className="ml-1 text-muted-foreground">({globalSchema.length})</span>
                      )}
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  {schemaScope === 'current' ? (
                    <SchemaListView schema={currentFileSchema} />
                  ) : (
                    <SchemaView
                      schema={globalSchema}
                      selectedTableName={schemaState.selectedTableName}
                      onClearSelection={schemaState.clearSelection}
                    />
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          {hasIssues && activeProjectId && (
            <TabsContent
              value="issues"
              forceMount
              className="h-full mt-0 overflow-auto p-0 absolute inset-0 data-[state=inactive]:hidden"
            >
              {mountedTabs.has('issues') && (
                <SchemaAwareIssuesPanel
                  projectId={activeProjectId}
                  onOpenSchemaEditor={() => setSchemaEditorOpen(true)}
                />
              )}
            </TabsContent>
          )}
        </div>
      </Tabs>

      {/* Schema Editor Modal */}
      {currentProject && (
        <SchemaEditor
          open={schemaEditorOpen}
          onOpenChange={setSchemaEditorOpen}
          schemaSQL={isBackendMode
            ? schemaMetadataToSQL(backendSchema)
            : matchedDDL}
          dialect={currentProject.dialect}
          onSave={handleSaveSchema}
          isReadOnly
          loading={!isBackendMode && schemaLoading}
        />
      )}
    </div>
  );
}
