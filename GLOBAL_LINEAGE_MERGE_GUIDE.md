# FlowScope: Merging Multiple AnalyzeResults for Global Lineage

## Executive Summary

The FlowScope project demonstrates a sophisticated architecture for analyzing SQL lineage across multiple statements and files. While there is **no single pre-built function that merges multiple `AnalyzeResult` objects**, the codebase contains several layered approaches to create a unified global lineage view:

1. **Single-Pass Analysis (Rust)**: All statements in one SQL file are analyzed together, producing a single `AnalyzeResult` with a built-in `globalLineage`
2. **Cross-Statement Tracking (Rust)**: The `CrossStatementTracker` links data flows between statements within that result
3. **Client-Side Merging (TypeScript)**: The `mergeStatements()` function combines multiple `StatementLineage` objects
4. **Global Lineage Assembly**: The `build_global_lineage_from()` function synthesizes a unified graph

---

## Part 1: TypeScript Type Definitions

### Core AnalyzeResult Structure

**File**: `packages/core/src/types.ts` (lines 383-425)

```typescript
export interface AnalyzeResult {
  statements: StatementLineage[];        // Per-statement results
  globalLineage: GlobalLineage;          // Unified cross-statement view
  issues: Issue[];                       // Errors/warnings
  summary: Summary;                      // Statistics
  resolvedSchema?: ResolvedSchemaMetadata;  // Effective schema used
}
```

### GlobalLineage Structure

**File**: `packages/core/src/types.ts` (lines 540-586)

```typescript
export interface GlobalLineage {
  nodes: GlobalNode[];
  edges: GlobalEdge[];
}

export interface GlobalNode {
  id: string;                              // Stable ID from canonical identifier
  type: NodeType;                         // 'table' | 'view' | 'cte' | 'output' | 'column'
  label: string;                          // Human-readable name
  canonicalName: CanonicalName;          // Fully qualified name for matching
  statementRefs: StatementRef[];         // Which statements use this node
  metadata?: Record<string, unknown>;
  resolutionSource?: ResolutionSource;   // 'imported' | 'implied' | 'unknown'
}

export interface GlobalEdge {
  id: string;
  from: string;                          // Source node ID
  to: string;                            // Target node ID
  type: EdgeType;                        // 'ownership' | 'data_flow' | 'derivation' | 'join_dependency' | 'cross_statement'
  producerStatement?: StatementRef;      // Which statement produced data
  consumerStatement?: StatementRef;      // Which statement consumed data
  metadata?: Record<string, unknown>;
}

export interface StatementRef {
  statementIndex: number;                // Zero-based index in original request
  nodeId?: string;                       // Local node ID in that statement
}

export interface CanonicalName {
  catalog?: string;
  schema?: string;
  name: string;
  column?: string;                       // For column nodes
}
```

### Per-Statement Lineage

**File**: `packages/core/src/types.ts` (lines 402-425)

```typescript
export interface StatementLineage {
  statementIndex: number;                // Position in SQL
  statementType: string;                 // 'SELECT', 'CREATE_TABLE', 'INSERT', etc.
  sourceName?: string;                   // File identifier for grouping
  nodes: Node[];                         // Local nodes
  edges: Edge[];                         // Local edges
  span?: Span;                           // Source location
  joinCount: number;
  complexityScore: number;
  resolvedSql?: string;                  // After template expansion
}

export interface Node {
  id: string;                            // Content-based hash
  type: NodeType;
  label: string;
  qualifiedName?: string;
  expression?: string;
  span?: Span;
  metadata?: Record<string, unknown>;
  resolutionSource?: ResolutionSource;
  filters?: FilterPredicate[];
  aggregation?: AggregationInfo;
}

export interface Edge {
  id: string;
  from: string;                          // Source node ID
  to: string;                            // Target node ID
  type: EdgeType;
  expression?: string;
  operation?: string;                    // 'JOIN', 'UNION', 'AGGREGATE', etc.
  joinType?: JoinType;
  joinCondition?: string;
  metadata?: Record<string, unknown>;
  approximate?: boolean;
}
```

---

## Part 2: Rust-Side Global Lineage Building

### Global Lineage Assembly Function

**File**: `crates/flowscope-core/src/analyzer/global.rs` (lines 87-211)

The `build_global_lineage_from()` method **constructs a `GlobalLineage` from multiple `StatementLineage` objects**:

```rust
fn build_global_lineage_from(
    &self,
    statements: &[crate::types::StatementLineage],
) -> GlobalLineage {
    let mut global_nodes: HashMap<Arc<str>, GlobalNode> = HashMap::new();
    let mut global_edges: Vec<GlobalEdge> = Vec::new();
    let mut local_to_global_id: HashMap<Arc<str>, Arc<str>> = HashMap::new();
    let mut seen_global_edges: HashSet<(Arc<str>, Arc<str>, &'static str)> = HashSet::new();

    // Collect and deduplicate nodes across all statements
    for lineage in statements {
        for node in &lineage.nodes {
            let canonical = node.qualified_name.clone().unwrap_or(node.label.clone());
            let global_id = self.global_node_id(node, &canonical);
            local_to_global_id.insert(node.id.clone(), global_id.clone());

            global_nodes
                .entry(global_id.clone())
                .and_modify(|existing| {
                    // Merge statement references for duplicate nodes
                    existing.statement_refs.push(StatementRef {
                        statement_index: lineage.statement_index,
                        node_id: Some(node.id.clone()),
                    });
                })
                .or_insert_with(|| GlobalNode {
                    id: global_id,
                    node_type: node.node_type,
                    label: node.label.clone(),
                    canonical_name: parse_canonical_name(&canonical),
                    statement_refs: vec![StatementRef {
                        statement_index: lineage.statement_index,
                        node_id: Some(node.id.clone()),
                    }],
                    metadata: None,
                    resolution_source: node.resolution_source,
                });
        }

        // Remap local edge node IDs to global equivalents
        for edge in &lineage.edges {
            let from = local_to_global_id.get(&edge.from).cloned()
                .unwrap_or_else(|| edge.from.clone());
            let to = local_to_global_id.get(&edge.to).cloned()
                .unwrap_or_else(|| edge.to.clone());

            if seen_global_edges.insert((
                from.clone(),
                to.clone(),
                Self::global_edge_kind(edge.edge_type),
            )) {
                global_edges.push(GlobalEdge {
                    id: edge.id.clone(),
                    from,
                    to,
                    edge_type: edge.edge_type,
                    producer_statement: Some(StatementRef {
                        statement_index: lineage.statement_index,
                        node_id: None,
                    }),
                    consumer_statement: None,
                    metadata: None,
                });
            }
        }
    }

    // Add cross-statement edges
    global_edges.extend(self.tracker.build_cross_statement_edges());

    // Remove orphaned edges (edges referencing non-existent nodes)
    let global_node_ids: HashSet<&Arc<str>> = nodes.iter().map(|n| &n.id).collect();
    global_edges.retain(|edge| {
        global_node_ids.contains(&edge.from) && global_node_ids.contains(&edge.to)
    });

    GlobalLineage {
        nodes: global_nodes.into_values().collect(),
        edges: global_edges,
    }
}
```

**Key Operations**:
1. **Node Deduplication**: Same canonical table across statements → single `GlobalNode` with multiple `statementRefs`
2. **ID Remapping**: Local node IDs → global IDs via `local_to_global_id` HashMap
3. **Edge Deduplication**: Same edge type between same global nodes → deduplicated (stored once)
4. **Cross-Statement Edge Integration**: Edges added from `CrossStatementTracker` (see Part 3)
5. **Orphan Cleanup**: Remove edges referencing missing nodes

---

## Part 3: Cross-Statement Edge Tracking

### CrossStatementTracker

**File**: `crates/flowscope-core/src/analyzer/cross_statement.rs` (lines 40-291)

The `CrossStatementTracker` manages producer-consumer relationships:

```rust
pub(crate) struct CrossStatementTracker {
    pub(crate) produced_tables: HashMap<String, usize>,      // table → producer statement
    pub(crate) produced_views: HashSet<String>,
    pub(crate) consumed_tables: HashMap<String, Vec<usize>>, // table → [consumer indices]
    pub(crate) all_relations: HashSet<String>,
    pub(crate) all_ctes: HashSet<String>,
}
```

**Building Cross-Statement Edges** (lines 231-290):

```rust
pub(crate) fn build_cross_statement_edges(&self) -> Vec<GlobalEdge> {
    let mut edges = Vec::new();

    for (table_name, consumers) in &self.consumed_tables {
        if let Some(&producer_idx) = self.produced_tables.get(table_name) {
            for &consumer_idx in consumers {
                if consumer_idx > producer_idx {  // Only forward edges
                    // Hash table + indices for unique edge ID
                    let mut hasher = DefaultHasher::new();
                    table_name.hash(&mut hasher);
                    producer_idx.hash(&mut hasher);
                    consumer_idx.hash(&mut hasher);
                    let edge_id = format!("cross_{:016x}", hasher.finish());
                    let node_id = self.relation_node_id(table_name);

                    edges.push(GlobalEdge {
                        id: edge_id.into(),
                        from: node_id.clone(),
                        to: node_id,              // Self-referencing edge!
                        edge_type: EdgeType::CrossStatement,
                        producer_statement: Some(StatementRef {
                            statement_index: producer_idx,
                            node_id: None,
                        }),
                        consumer_statement: Some(StatementRef {
                            statement_index: consumer_idx,
                            node_id: None,
                        }),
                        metadata: None,
                    });
                }
            }
        }
    }

    edges
}
```

**Example ETL Pattern** (test at line 554):
```
Statement 0: CREATE TABLE staging.raw FROM external.source
Statement 1: CREATE TABLE staging.cleaned FROM staging.raw
Statement 2: CREATE TABLE mart.final FROM staging.cleaned
```

Results in 2 cross-statement edges:
- `staging.raw`: statement 0 → statement 1
- `staging.cleaned`: statement 1 → statement 2

---

## Part 4: TypeScript-Side Statement Merging

### mergeStatements() Function

**File**: `packages/react/src/workers/graphBuilder.worker.ts` (lines 885-933)

Used when multiple `StatementLineage` objects need to be visualized as one statement:

```typescript
function mergeStatements(statements: StatementLineage[]): StatementLineage {
  if (statements.length === 1) {
    return normalizeStatement(statements[0]);
  }

  const mergedNodes = new Map<string, Node>();
  const mergedEdges = new Map<string, Edge>();

  statements.forEach((stmt) => {
    const sourceName = stmt.sourceName;
    stmt.nodes.forEach((node) => {
      const nodeWithSource = withSourceName(node, sourceName);
      const existing = mergedNodes.get(node.id);
      if (!existing) {
        mergedNodes.set(node.id, nodeWithSource);
        return;
      }

      // Merge filter predicates and metadata
      if (node.filters && node.filters.length > 0) {
        existing.filters = [...(existing.filters || []), ...node.filters];
      }
      if (!existing.metadata?.sourceName && nodeWithSource.metadata?.sourceName) {
        existing.metadata = {
          ...(existing.metadata || {}),
          sourceName: nodeWithSource.metadata.sourceName,
        };
      }
    });

    stmt.edges.forEach((edge) => {
      if (!mergedEdges.has(edge.id)) {
        mergedEdges.set(edge.id, edge);
      }
    });
  });

  const totalJoinCount = statements.reduce((sum, stmt) => sum + stmt.joinCount, 0);
  const maxComplexity =
    statements.length > 0 ? Math.max(...statements.map((stmt) => stmt.complexityScore)) : 1;

  return {
    statementIndex: 0,
    statementType: 'SELECT',
    nodes: Array.from(mergedNodes.values()),
    edges: Array.from(mergedEdges.values()),
    joinCount: totalJoinCount,
    complexityScore: maxComplexity,
  };
}
```

**Merge Strategy**:
- **Nodes**: Deduplicated by ID, filters concatenated, source metadata preserved
- **Edges**: Deduplicated by ID (first occurrence wins)
- **Metrics**: Join counts summed, complexity = max across statements

### Supporting Functions

**`withSourceName()`** (lines 858-868): Adds `sourceName` to node metadata

**`normalizeStatement()`** (lines 870-879): Ensures all nodes have source metadata

---

## Part 5: Result Building & Summary

### AnalyzeResult Construction

**File**: `crates/flowscope-core/src/analyzer/global.rs` (lines 13-43)

```rust
pub(super) fn build_result(&self) -> crate::AnalyzeResult {
    // Apply CTE filtering if requested
    let hide_ctes = self
        .request
        .options
        .as_ref()
        .and_then(|o| o.hide_ctes)
        .unwrap_or(false);

    let statements = if hide_ctes {
        let mut filtered = self.statement_lineages.clone();
        for lineage in &mut filtered {
            super::transform::filter_cte_nodes(lineage);
        }
        filtered
    } else {
        self.statement_lineages.clone()
    };

    let global_lineage = self.build_global_lineage_from(&statements);  // <- HERE
    let summary = self.build_summary(&global_lineage);
    let resolved_schema = self.build_resolved_schema();

    crate::AnalyzeResult {
        statements,
        global_lineage,
        issues: self.issues.clone(),
        summary,
        resolved_schema,
    }
}
```

---

## Part 6: How To Merge Multiple AnalyzeResults

### Scenario: Multiple Files

If you have multiple SQL files analyzed separately (each producing its own `AnalyzeResult`):

```typescript
const results: AnalyzeResult[] = [
  analyzeResult1,  // from file1.sql
  analyzeResult2,  // from file2.sql
  analyzeResult3,  // from file3.sql
];
```

**Client-Side Merging Approach**:

```typescript
import type { AnalyzeResult, StatementLineage, GlobalLineage, GlobalNode, GlobalEdge } from '@pondpilot/flowscope-core';

function mergeAnalyzeResults(results: AnalyzeResult[]): AnalyzeResult {
  if (results.length === 0) {
    throw new Error('Cannot merge empty results');
  }
  if (results.length === 1) {
    return results[0];
  }

  // 1. Combine all statements with file source tracking
  const allStatements: StatementLineage[] = [];
  let statementIndexOffset = 0;
  
  for (const result of results) {
    for (const stmt of result.statements) {
      allStatements.push({
        ...stmt,
        statementIndex: statementIndexOffset + stmt.statementIndex,
        sourceName: stmt.sourceName || `file_${results.indexOf(result)}`,
      });
    }
    statementIndexOffset += result.statements.length;
  }

  // 2. Merge global nodes by canonical name
  const globalNodeMap = new Map<string, GlobalNode>();
  
  for (const result of results) {
    for (const node of result.globalLineage.nodes) {
      const canonicalKey = [
        node.canonicalName.catalog,
        node.canonicalName.schema,
        node.canonicalName.name,
        node.canonicalName.column,
      ]
        .filter(Boolean)
        .join('.');
      
      if (!globalNodeMap.has(canonicalKey)) {
        globalNodeMap.set(canonicalKey, node);
      } else {
        // Merge statement references
        const existing = globalNodeMap.get(canonicalKey)!;
        for (const ref of node.statementRefs) {
          if (!existing.statementRefs.some(r => 
            r.statementIndex === ref.statementIndex + statementIndexOffset
          )) {
            existing.statementRefs.push({
              ...ref,
              statementIndex: ref.statementIndex + statementIndexOffset,
            });
          }
        }
      }
    }
  }

  // 3. Merge global edges
  const globalEdgeMap = new Map<string, GlobalEdge>();
  
  for (const result of results) {
    for (const edge of result.globalLineage.edges) {
      const edgeKey = `${edge.from}→${edge.to}:${edge.type}`;
      
      if (!globalEdgeMap.has(edgeKey)) {
        globalEdgeMap.set(edgeKey, edge);
      } else {
        // Edge already exists, could merge metadata if needed
      }
    }
  }

  // 4. Combine issues and summary
  const mergedIssues = results.flatMap(r => r.issues);
  const mergedSummary = {
    statementCount: allStatements.length,
    tableCount: Math.max(...results.map(r => r.summary.tableCount)),
    columnCount: Math.max(...results.map(r => r.summary.columnCount)),
    joinCount: results.reduce((sum, r) => sum + r.summary.joinCount, 0),
    complexityScore: Math.max(...results.map(r => r.summary.complexityScore)),
    issueCount: {
      errors: mergedIssues.filter(i => i.severity === 'error').length,
      warnings: mergedIssues.filter(i => i.severity === 'warning').length,
      infos: mergedIssues.filter(i => i.severity === 'info').length,
    },
    hasErrors: mergedIssues.some(i => i.severity === 'error'),
  };

  // 5. Merge resolved schemas
  const mergedTables = new Map<string, any>();
  for (const result of results) {
    if (result.resolvedSchema?.tables) {
      for (const table of result.resolvedSchema.tables) {
        const key = [table.catalog, table.schema, table.name].filter(Boolean).join('.');
        if (!mergedTables.has(key)) {
          mergedTables.set(key, table);
        }
      }
    }
  }

  return {
    statements: allStatements,
    globalLineage: {
      nodes: Array.from(globalNodeMap.values()),
      edges: Array.from(globalEdgeMap.values()),
    },
    issues: mergedIssues,
    summary: mergedSummary,
    resolvedSchema: mergedTables.size > 0 
      ? { tables: Array.from(mergedTables.values()) }
      : undefined,
  };
}
```

---

## Part 7: Usage Patterns in React

### How GlobalLineage Is Used

**File**: `packages/react/src/utils/graphBuilders.ts` (lines 285-310)

```typescript
interface BuildFlowNodesOptions {
  globalLineage?: GlobalLineage;
  // ... other options
}

function buildFlowNodes(...options: BuildFlowNodesOptions) {
  if (globalLineage?.nodes) {
    for (const gn of globalLineage.nodes) {
      // Use global node info for cross-statement references
      // E.g., showing all statements that reference a table
    }
  }
  // ... continue with local statement analysis
}
```

### Multiple Statements in Single View

**File**: `packages/react/src/workers/graphBuilder.worker.ts` (lines 1176-1209)

```typescript
if (request.type === 'build-table-graph') {
  const statement = request.statement
    ? normalizeStatement(request.statement)
    : request.statements
      ? mergeStatements(request.statements)  // <- Merge multiple statements
      : null;
  
  if (!statement) {
    throw new Error('No statements provided');
  }
  
  nodes = buildFlowNodes(
    statement,
    request.selectedNodeId,
    request.searchTerm,
    collapsedNodeIds,
    expandedTableIds,
    request.resolvedSchema,
    request.defaultCollapsed,
    request.globalLineage  // <- Pass global context
  );
}
```

---

## Part 8: Key Functions Reference

### Rust Functions

| Function | File | Purpose |
|----------|------|---------|
| `build_global_lineage_from()` | `global.rs:87-211` | Assemble `GlobalLineage` from multiple `StatementLineage` |
| `build_cross_statement_edges()` | `cross_statement.rs:231-290` | Create edges between producer/consumer statements |
| `record_produced()` | `cross_statement.rs:109-117` | Track table production |
| `record_consumed()` | `cross_statement.rs:128-138` | Track table consumption |
| `relation_identity()` | `cross_statement.rs:176-186` | Get node ID and type for a relation |

### TypeScript Functions

| Function | File | Purpose |
|----------|------|---------|
| `mergeStatements()` | `graphBuilder.worker.ts:885-933` | Combine multiple `StatementLineage` for visualization |
| `buildFlowNodes()` | `graphBuilders.ts` | Create visual nodes from lineage |
| `buildFlowEdges()` | `graphBuilders.ts` | Create visual edges from lineage |
| `groupStatementsByScript()` | `graphBuilder.worker.ts:964-975` | Group statements by source file |
| `buildDirectScriptGraph()` | `graphBuilder.worker.ts:1087-1129` | Create script-level dependencies |

---

## Part 9: Node ID Generation

### Canonical Name Parsing

**File**: `crates/flowscope-core/src/analyzer/helpers.rs`

```rust
pub fn parse_canonical_name(canonical: &str) -> CanonicalName {
    // Splits "catalog.schema.table.column" format
    // Returns structured CanonicalName for deduplication
}

pub fn generate_node_id(prefix: &str, canonical: &str) -> Arc<str> {
    // Creates stable ID from hash of prefix + canonical name
    // E.g., "table_a1b2c3d4e5f6..." for deterministic, content-based IDs
}
```

### Node ID Stability

- **Tables/Views**: Based on canonical name (same table = same ID across files)
- **CTEs**: Scoped to statement (same name in different statements = different IDs)
- **Columns**: Based on qualified name (schema.table.column)
- **Self-Joins**: Instances differentiated by alias + scope

---

## Part 10: Best Practices for Multi-File Lineage

### ✅ Recommended Approach

1. **Single Analysis Pass** (if possible):
   ```typescript
   // Analyze all files together at once
   const multiFileSQL = file1.content + '\n\n' + file2.content + '\n\n' + file3.content;
   const result = await analyzer.analyze({
     sql: multiFileSQL,
     dialect: 'postgres',
   });
   // Single AnalyzeResult with built-in global lineage and cross-statement tracking
   ```

2. **If Files Must Be Analyzed Separately**:
   - Store `AnalyzeResult` for each file with `sourceName`
   - Use `mergeAnalyzeResults()` helper (code provided above)
   - Manually track producer/consumer relationships between files

### ⚠️ Limitations

- **Cross-File Deduplication**: Must match by canonical name (requires consistent schema)
- **External Tables**: Tables not defined in any analyzed file won't create cross-file edges
- **CTE Scoping**: CTEs are statement-scoped, so same-named CTEs in different files are distinct
- **Schema Inference**: Implied schema only applies within analyzed SQL, not across files

---

## Summary

**Merging Strategy in FlowScope**:

1. ✓ **Within Single Analysis**: Rust automatically creates `GlobalLineage` via `build_global_lineage_from()` + `CrossStatementTracker`
2. ✓ **Multiple Statements (UI)**: TypeScript `mergeStatements()` combines `StatementLineage` for visualization
3. ✓ **Multiple Files (Manual)**: Use provided merge helper to combine `AnalyzeResult` objects
4. ✓ **Cross-Statement Edges**: Self-referencing `GlobalEdge` with `producer_statement` and `consumer_statement` metadata
5. ✓ **Node Deduplication**: By canonical name; includes `StatementRef` array tracking all usages

**Key Types**:
- `GlobalLineage`: Unified graph across statements
- `GlobalNode`: Canonical representation with statement references  
- `GlobalEdge`: Cross-statement data flows
- `StatementRef`: Tracks which statement uses which node

