# Quick Reference: Merging Multiple AnalyzeResults

## TL;DR

**Q: How do I combine multiple AnalyzeResult objects into one global lineage view?**

**A:** There are two approaches:

### Option 1: Analyze Together (✅ RECOMMENDED)
```typescript
// Concatenate all SQL and analyze once
const allSQL = file1.content + '\n\n' + file2.content + '\n\n' + file3.content;
const result = await analyzer.analyze({ sql: allSQL, dialect: 'postgres' });

// Single AnalyzeResult with complete GlobalLineage + cross-file edges
// Cost: O(n) where n = total statements
```

### Option 2: Merge After (⚠️ Manual)
```typescript
// Analyze each file separately, then merge
const results = await Promise.all([
  analyzer.analyze({ sql: file1.content, ... }),
  analyzer.analyze({ sql: file2.content, ... }),
  analyzer.analyze({ sql: file3.content, ... }),
]);

const merged = mergeAnalyzeResults(results);
// Cost: O(n*m) where n = files, m = avg statements per file
// ⚠️ No automatic cross-file edges
```

---

## Key Types

```typescript
// The result of analyzing SQL
export interface AnalyzeResult {
  statements: StatementLineage[];     // Per-statement results
  globalLineage: GlobalLineage;       // ← Unified cross-statement graph
  issues: Issue[];
  summary: Summary;
  resolvedSchema?: ResolvedSchemaMetadata;
}

// The unified graph spanning all statements
export interface GlobalLineage {
  nodes: GlobalNode[];   // Deduplicated tables/views/columns
  edges: GlobalEdge[];   // All data flows (including cross-statement)
}

// A node in the global graph
export interface GlobalNode {
  id: string;                    // Stable hash-based ID
  canonicalName: CanonicalName;  // {catalog?, schema?, name, column?}
  statementRefs: StatementRef[]; // ← Which statements use this node
}

// References which statement uses which node
export interface StatementRef {
  statementIndex: number;  // 0-based position in statements[]
  nodeId?: string;         // Local node ID within that statement
}

// Cross-statement edges (self-referencing)
export interface GlobalEdge {
  from: string;                         // Node ID
  to: string;                           // Same node ID
  type: 'cross_statement' | 'data_flow' | ...
  producer_statement?: StatementRef;    // Which statement produces
  consumer_statement?: StatementRef;    // Which statement consumes
}
```

---

## Merge Function (TypeScript)

**If you must merge separate AnalyzeResults:**

```typescript
function mergeAnalyzeResults(results: AnalyzeResult[]): AnalyzeResult {
  if (results.length === 0) throw new Error('No results');
  if (results.length === 1) return results[0];

  // 1. Combine all statements
  const allStatements: StatementLineage[] = [];
  let offset = 0;
  for (const result of results) {
    for (const stmt of result.statements) {
      allStatements.push({
        ...stmt,
        statementIndex: offset + stmt.statementIndex,
        sourceName: stmt.sourceName || `file_${results.indexOf(result)}`,
      });
    }
    offset += result.statements.length;
  }

  // 2. Deduplicate global nodes by canonical name
  const globalNodeMap = new Map<string, GlobalNode>();
  for (const result of results) {
    for (const node of result.globalLineage.nodes) {
      const key = [
        node.canonicalName.catalog,
        node.canonicalName.schema,
        node.canonicalName.name,
        node.canonicalName.column,
      ].filter(Boolean).join('.');

      if (!globalNodeMap.has(key)) {
        globalNodeMap.set(key, node);
      } else {
        // Merge statement references
        globalNodeMap.get(key)!.statementRefs.push(...node.statementRefs);
      }
    }
  }

  // 3. Deduplicate global edges
  const globalEdgeMap = new Map<string, GlobalEdge>();
  for (const result of results) {
    for (const edge of result.globalLineage.edges) {
      const key = `${edge.from}→${edge.to}:${edge.type}`;
      if (!globalEdgeMap.has(key)) {
        globalEdgeMap.set(key, edge);
      }
    }
  }

  // 4. Merge issues and summary
  const allIssues = results.flatMap(r => r.issues);
  return {
    statements: allStatements,
    globalLineage: {
      nodes: Array.from(globalNodeMap.values()),
      edges: Array.from(globalEdgeMap.values()),
    },
    issues: allIssues,
    summary: {
      statementCount: allStatements.length,
      tableCount: Math.max(...results.map(r => r.summary.tableCount)),
      columnCount: Math.max(...results.map(r => r.summary.columnCount)),
      joinCount: results.reduce((sum, r) => sum + r.summary.joinCount, 0),
      complexityScore: Math.max(...results.map(r => r.summary.complexityScore)),
      issueCount: {
        errors: allIssues.filter(i => i.severity === 'error').length,
        warnings: allIssues.filter(i => i.severity === 'warning').length,
        infos: allIssues.filter(i => i.severity === 'info').length,
      },
      hasErrors: allIssues.some(i => i.severity === 'error'),
    },
    resolvedSchema: undefined, // Optionally merge if needed
  };
}
```

---

## How Global Lineage Is Built (Rust)

**File**: `crates/flowscope-core/src/analyzer/global.rs`

```rust
fn build_global_lineage_from(
    &self,
    statements: &[StatementLineage],
) -> GlobalLineage {
    // 1. Deduplicate nodes by canonical name
    let mut global_nodes = HashMap::new();
    for stmt in statements {
        for node in &stmt.nodes {
            let canonical = node.qualified_name.as_ref()
                .unwrap_or(&node.label);
            let global_id = hash("table", canonical); // ← Stable hash
            
            global_nodes.entry(global_id)
                .and_modify(|existing: &mut GlobalNode| {
                    // Merge statement references
                    existing.statementRefs.push(StatementRef {
                        statementIndex: stmt.statementIndex,
                        nodeId: Some(node.id.clone()),
                    });
                })
                .or_insert_with(|| GlobalNode {
                    id: global_id,
                    canonicalName: parse_canonical_name(canonical),
                    statementRefs: vec![StatementRef {
                        statementIndex: stmt.statementIndex,
                        nodeId: Some(node.id.clone()),
                    }],
                    // ... other fields
                });
        }
    }

    // 2. Remap edge IDs from local to global
    let mut global_edges = Vec::new();
    let mut local_to_global = HashMap::new();
    // Build mapping and remap edges...

    // 3. Add cross-statement edges
    global_edges.extend(self.tracker.build_cross_statement_edges());

    // 4. Remove orphaned edges
    let valid_ids: HashSet<_> = global_nodes.keys().collect();
    global_edges.retain(|e| {
        valid_ids.contains(&e.from) && valid_ids.contains(&e.to)
    });

    GlobalLineage {
        nodes: global_nodes.into_values().collect(),
        edges: global_edges,
    }
}
```

**Key Steps**:
1. ✓ Iterate all statements' nodes
2. ✓ Use canonical name to create stable ID (same table = same ID)
3. ✓ On duplicate ID: add to existing node's `statementRefs`
4. ✓ Remap all edges to use global IDs
5. ✓ Add cross-statement producer/consumer edges
6. ✓ Clean up orphaned edges

---

## Cross-Statement Edges

**How tables flow between statements:**

```
Statement 0: CREATE TABLE staging.raw AS SELECT * FROM external.source
Statement 1: CREATE TABLE staging.cleaned AS SELECT * FROM staging.raw
Statement 2: CREATE TABLE mart.final AS SELECT * FROM staging.cleaned

         ▼

CrossStatementTracker tracks:
  produced: {staging.raw: 0, staging.cleaned: 1, mart.final: 2}
  consumed: {external.source: [0], staging.raw: [1], staging.cleaned: [2]}

         ▼

GlobalEdge {
  from: "table_staging_raw...",
  to:   "table_staging_raw...",       ← Self-referencing!
  type: "cross_statement",
  producer_statement: {statementIndex: 0},
  consumer_statement: {statementIndex: 1}
}

GlobalEdge {
  from: "table_staging_cleaned...",
  to:   "table_staging_cleaned...",
  type: "cross_statement",
  producer_statement: {statementIndex: 1},
  consumer_statement: {statementIndex: 2}
}
```

**Key insight**: Cross-statement edges are self-referencing. The direction is indicated by `producer_statement` and `consumer_statement` metadata.

---

## Node Deduplication Rules

| Node Type | Deduplicates By | Key ID | Example |
|-----------|-----------------|--------|---------|
| Table | Canonical name | `hash(type="table", "public.users")` | All references to `public.users` → same GlobalNode |
| View | Canonical name | `hash(type="view", "public.users_v")` | All `public.users_v` references → same GlobalNode |
| Column | Full path | `hash(type="column", "public.users.user_id")` | Same column across statements → same GlobalNode |
| CTE | Statement-scoped | Encoded in local ID | CTEs NOT deduplicated (same name in different stmts = different nodes) |

---

## API Reference

### Rust Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `build_global_lineage_from()` | `global.rs:87` | Assemble GlobalLineage from statements |
| `build_cross_statement_edges()` | `cross_statement.rs:231` | Create producer→consumer edges |
| `record_produced()` | `cross_statement.rs:109` | Track table production |
| `record_consumed()` | `cross_statement.rs:128` | Track table consumption |

### TypeScript Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `mergeStatements()` | `graphBuilder.worker.ts:885` | Combine multiple StatementLineage for UI |
| `mergeAnalyzeResults()` | *provided above* | Combine multiple AnalyzeResult (not in codebase) |
| `buildFlowNodes()` | `graphBuilders.ts` | Create visual nodes from lineage |
| `buildFlowEdges()` | `graphBuilders.ts` | Create visual edges from lineage |

---

## Files to Know

```
crates/flowscope-core/src/analyzer/
├── global.rs                    ← GlobalLineage building
├── cross_statement.rs           ← CrossStatementTracker
└── helpers.rs                   ← Node ID generation

packages/core/src/
└── types.ts                     ← All TypeScript types

packages/react/src/
├── workers/graphBuilder.worker.ts    ← mergeStatements()
├── utils/graphBuilders.ts            ← buildFlowNodes/Edges
├── utils/lineageHelpers.ts           ← Helper functions
└── utils/graphBuilderWorkerService.ts ← Worker lifecycle
```

---

## Common Scenarios

### Scenario 1: Analyze Multiple Files Together
```typescript
// ✅ BEST: Single analysis pass
const sql = await Promise.all([
  fs.readFile('file1.sql', 'utf8'),
  fs.readFile('file2.sql', 'utf8'),
  fs.readFile('file3.sql', 'utf8'),
]).then(files => files.join('\n\n'));

const result = await analyzer.analyze({
  sql,
  dialect: 'postgres',
});

// result.globalLineage has everything
// Cross-file edges automatically created
```

### Scenario 2: Merge Separate Results
```typescript
// ⚠️ FALLBACK: Separate analyses + merge
const results = await Promise.all([
  analyzer.analyze({ sql: file1Content, ... }),
  analyzer.analyze({ sql: file2Content, ... }),
  analyzer.analyze({ sql: file3Content, ... }),
]);

const merged = mergeAnalyzeResults(results);
// Can visualize, but no automatic cross-file edges
```

### Scenario 3: Query GlobalLineage in React
```typescript
// In a React component using globalLineage
const allTables = result.globalLineage.nodes
  .filter(n => n.type === 'table');

for (const table of allTables) {
  console.log(`Table: ${table.label}`);
  console.log(`  Used in statements:`, table.statementRefs);
}

// Find which tables are produced/consumed
const crossStatementEdges = result.globalLineage.edges
  .filter(e => e.type === 'cross_statement');

for (const edge of crossStatementEdges) {
  console.log(
    `Statement ${edge.producer_statement?.statementIndex} ` +
    `→ ${edge.consumer_statement?.statementIndex}`
  );
}
```

---

## Performance Considerations

| Approach | Time | Memory | Correctness |
|----------|------|--------|-------------|
| Analyze together | O(n) | O(n) | ✓ Perfect |
| Merge after | O(n*m) | O(n*m) | ⚠️ Partial* |

*Partial = nodes deduplicated but no cross-file edges

---

## Troubleshooting

**Q: I merged results but don't see cross-file edges**
A: Cross-file edges aren't created automatically when merging. Only edges within each file are preserved. To get cross-file edges, analyze all files together.

**Q: Node IDs don't match between files**
A: Node IDs are content-based hashes. If the same table appears in two files but with different qualifications (e.g., `users` vs `public.users`), they'll get different IDs. Use `canonicalName` to match, not `id`.

**Q: My merged GlobalLineage has duplicate nodes**
A: Check the merge function - it should deduplicate by `canonicalName`, not `id`. If seeing duplicates, ensure the canonical names are identical across files.

**Q: Statement indices are out of order after merging**
A: After merging, renumber `statementIndex` to be sequential across all files (0, 1, 2, ... n). The merge function provided does this.

---

## Key Takeaways

1. **GlobalLineage is built automatically** when you analyze SQL with multiple statements
2. **Node deduplication** happens by canonical name (qualified table/column name)
3. **Cross-statement edges** track producer→consumer relationships automatically within one analysis
4. **No cross-file edges** are created when analyzing files separately
5. **Merge manually** if you analyze separately, but understand the limitations
6. **Use `statementRefs`** to see which statements use each global node

