# Global Lineage Merge Architecture - Visual Reference

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MULTIPLE SQL FILES                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  file1.sql                    file2.sql                    file3.sql         │
│  ┌──────────┐                 ┌──────────┐                 ┌──────────┐     │
│  │ STMT 0   │                 │ STMT 0   │                 │ STMT 0   │     │
│  │ SELECT..│                 │ CREATE..│                 │ INSERT..│     │
│  └──────────┘                 └──────────┘                 └──────────┘     │
│  ┌──────────┐                 ┌──────────┐                 ┌──────────┐     │
│  │ STMT 1   │                 │ STMT 1   │                 │ STMT 1   │     │
│  │ CREATE..│                 │ INSERT..│                 │ UPDATE..│     │
│  └──────────┘                 └──────────┘                 └──────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      RUST ANALYZER (flowscope-core)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  For each file:  analyze() → AnalyzeResult (single file)                   │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │ Per File Analysis:                                              │        │
│  ├─────────────────────────────────────────────────────────────────┤        │
│  │                                                                 │        │
│  │  Statement 0 → StatementLineage { nodes, edges, ... }          │        │
│  │  Statement 1 → StatementLineage { nodes, edges, ... }          │        │
│  │                                                                 │        │
│  │  CrossStatementTracker (within this file only):                │        │
│  │  ├─ produced_tables: { "table_x" → stmt_0, "table_y" → stmt_1 } │        │
│  │  └─ consumed_tables: { "table_x" → [stmt_1] }                 │        │
│  │                                                                 │        │
│  │  build_global_lineage_from(statements):                        │        │
│  │  ├─ Collect all nodes from all statements                      │        │
│  │  ├─ Deduplicate by canonical_name                              │        │
│  │  ├─ Create GlobalNode with statementRefs: [{stmt_0}, {stmt_1}] │        │
│  │  ├─ Remap local edge IDs to global IDs                         │        │
│  │  ├─ Add cross-statement edges from tracker                     │        │
│  │  └─ Result: GlobalLineage { nodes, edges }                     │        │
│  │                                                                 │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                               │
│  AnalyzeResult = {                                                           │
│    statements: [StatementLineage, StatementLineage],                         │
│    globalLineage: GlobalLineage,  ◄── BUILT IN!                             │
│    issues,                                                                   │
│    summary,                                                                  │
│    resolvedSchema                                                            │
│  }                                                                            │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  MULTIPLE AnalyzeResult OBJECTS                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  AnalyzeResult 1 (file1)    AnalyzeResult 2 (file2)    AnalyzeResult 3     │
│  ┌────────────────┐         ┌────────────────┐         ┌────────────┐      │
│  │ statements[2]  │         │ statements[2]  │         │statements[]       │
│  │ globalLineage  │         │ globalLineage  │         │globalLineage       │
│  │ issues, etc.   │         │ issues, etc.   │         │issues, etc.        │
│  └────────────────┘         └────────────────┘         └────────────┘      │
│                                                                               │
│  ⚠️  Each has its OWN GlobalLineage (only aware of internal statements)     │
│  ✓  No cross-file edges yet                                                 │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▼
                    ┌───────────────────────────────────┐
                    │  OPTION A: Analyze Together       │
                    │  ✅ (RECOMMENDED)                 │
                    ├───────────────────────────────────┤
                    │ Concatenate all SQL:              │
                    │ sql = file1 + file2 + file3       │
                    │                                   │
                    │ analyze(sql) →                    │
                    │ Single AnalyzeResult with:        │
                    │ ✓ All statements                  │
                    │ ✓ Complete GlobalLineage          │
                    │ ✓ Cross-file edges!               │
                    └───────────────────────────────────┘
                                   OR
                    ┌───────────────────────────────────┐
                    │  OPTION B: Merge Results          │
                    │  ⚠️  (manual work needed)          │
                    ├───────────────────────────────────┤
                    │ mergeAnalyzeResults([r1,r2,r3])   │
                    │                                   │
                    │ TypeScript merge function:        │
                    │ 1. Combine statements[]           │
                    │ 2. Deduplicate nodes by canonical │
                    │ 3. Merge GlobalNode.statementRefs │
                    │ 4. Deduplicate edges              │
                    │ 5. Merge issues & summary         │
                    │                                   │
                    │ Result: Single AnalyzeResult      │
                    │ ✓ Can visualize unified graph     │
                    │ ⚠️  No automatic cross-file edges  │
                    │    (would need manual tracking)   │
                    └───────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                  UNIFIED AnalyzeResult (for UI)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  {                                                                            │
│    statements: [stmt0, stmt1, stmt2, stmt3, ...],  ◄── All statements      │
│    globalLineage: {                                                          │
│      nodes: [                                                                │
│        GlobalNode {                                                          │
│          id: "table_xyz...",                                                 │
│          canonicalName: {schema: "public", name: "users"},                   │
│          statementRefs: [                                                    │
│            {statementIndex: 0, nodeId: "..."},                               │
│            {statementIndex: 2, nodeId: "..."},  ◄── Used in statements 0,2  │
│            {statementIndex: 3, nodeId: "..."}                               │
│          ]                                                                   │
│        },                                                                    │
│        ...                                                                   │
│      ],                                                                      │
│      edges: [                                                                │
│        { from: "t1", to: "t2", type: "data_flow", ... },                    │
│        { from: "t2", to: "t3", type: "data_flow", ... },                    │
│        {                                                                     │
│          from: "staging_raw",  to: "staging_raw",                           │
│          type: "cross_statement",  ◄── Self-referencing!                    │
│          producer_statement: {statementIndex: 0},                            │
│          consumer_statement: {statementIndex: 1}                             │
│        },                                                                    │
│        ...                                                                   │
│      ]                                                                       │
│    },                                                                        │
│    issues: [...],                                                            │
│    summary: {...}                                                            │
│  }                                                                            │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   VISUALIZATION (React UI)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  buildTableGraph(statements, globalLineage):                                 │
│  ├─ Build visual nodes from merged lineage                                   │
│  ├─ Build visual edges                                                       │
│  └─ Render: Tables, CTEs, columns, and their relationships                  │
│                                                                               │
│  buildScriptGraph(statements):                                               │
│  ├─ Group statements by sourceName (file)                                    │
│  ├─ Show script nodes (file-level)                                           │
│  └─ Show table/data flow between scripts                                     │
│                                                                               │
│  Result:                                                                     │
│  ✓ Unified visual representation                                             │
│  ✓ Cross-statement/cross-file relationships visible                         │
│  ✓ Can navigate between statements/files                                     │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## GlobalNode Structure - Deduplication Pattern

```
Input: Multiple StatementLineage objects with duplicate table references

Statement 0 nodes:
  Node { id: "tbl_abc123", label: "users", qualified_name: "public.users" }
  Node { id: "tbl_xyz789", label: "orders", qualified_name: "public.orders" }

Statement 1 nodes:
  Node { id: "tbl_abc123", label: "users", qualified_name: "public.users" }  ◄── DUPLICATE
  Node { id: "tbl_uvw456", label: "products", qualified_name: "public.products" }

Statement 2 nodes:
  Node { id: "tbl_abc123", label: "users", qualified_name: "public.users" }  ◄── DUPLICATE
  Node { id: "tbl_xyz789", label: "orders", qualified_name: "public.orders" }  ◄── DUPLICATE

                                    ▼

Deduplication Logic:
  for each statement's nodes:
    canonical_name = qualified_name or label
    global_id = hash(type, canonical_name)  ◄── SAME canonical = SAME global ID
    
    if global_id exists:
      add to existing GlobalNode.statementRefs
    else:
      create new GlobalNode with statementRefs

                                    ▼

Output: Single GlobalLineage

  GlobalNode {
    id: "table_xyz123...",           ◄── Stable hash-based ID
    canonical_name: {
      schema: "public",
      name: "users"
    },
    statementRefs: [
      { statementIndex: 0, nodeId: "tbl_abc123" },
      { statementIndex: 1, nodeId: "tbl_abc123" },
      { statementIndex: 2, nodeId: "tbl_abc123" }
    ]                                ◄── Shows it's used in 3 statements
  },

  GlobalNode {
    id: "table_abc456...",
    canonical_name: {
      schema: "public",
      name: "orders"
    },
    statementRefs: [
      { statementIndex: 0, nodeId: "tbl_xyz789" },
      { statementIndex: 2, nodeId: "tbl_xyz789" }
    ]
  },

  GlobalNode {
    id: "table_pqr789...",
    canonical_name: {
      schema: "public",
      name: "products"
    },
    statementRefs: [
      { statementIndex: 1, nodeId: "tbl_uvw456" }
    ]
  }
```

---

## Cross-Statement Edge Pattern

```
Scenario: ETL Pipeline

Statement 0:  CREATE TABLE staging.raw AS SELECT * FROM external.source
Statement 1:  CREATE TABLE staging.cleaned AS SELECT * FROM staging.raw WHERE ...
Statement 2:  CREATE TABLE mart.final AS SELECT * FROM staging.cleaned

                                    ▼

CrossStatementTracker tracks:

produced_tables:
  "external.source"    → 0  (no, it's consumed, not produced)
  "staging.raw"        → 0  (produced by stmt 0)
  "staging.cleaned"    → 1  (produced by stmt 1)
  "mart.final"         → 2  (produced by stmt 2)

consumed_tables:
  "external.source"    → [0]              (consumed by stmt 0)
  "staging.raw"        → [1]              (consumed by stmt 1)
  "staging.cleaned"    → [2]              (consumed by stmt 2)

                                    ▼

build_cross_statement_edges() creates:

For each (table, consumers) in consumed_tables:
  If producer exists AND consumer > producer:
    Create GlobalEdge {
      from: node_id(table),
      to: node_id(table),              ◄── SELF-REFERENCING
      type: "cross_statement",
      producer_statement: {statementIndex: producer},
      consumer_statement: {statementIndex: consumer}
    }

Result:

GlobalEdge {
  from: "table_staging_raw...",
  to:   "table_staging_raw...",        ◄── Same node!
  type: "cross_statement",
  producer_statement: {statementIndex: 0},
  consumer_statement: {statementIndex: 1}
}
│
├─ "Statement 0 PRODUCES this table"
├─ "Statement 1 CONSUMES this table"
└─ "Data flows from producer to consumer"

GlobalEdge {
  from: "table_staging_cleaned...",
  to:   "table_staging_cleaned...",
  type: "cross_statement",
  producer_statement: {statementIndex: 1},
  consumer_statement: {statementIndex: 2}
}
```

---

## Node ID Generation Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│ Node Type        │ ID Generation              │ Deduplication   │
├─────────────────────────────────────────────────────────────────┤
│ Table/View       │ hash("table", canonical)   │ By canonical    │
│ (persistent)     │ E.g., "table_abc123..."    │ name across all │
│                  │                            │ statements      │
├─────────────────────────────────────────────────────────────────┤
│ CTE              │ statement-scoped ID        │ NOT deduplicated│
│ (ephemeral)      │ E.g., "cte_stmt_0_xyz..."  │ Same CTE name   │
│                  │                            │ in different    │
│                  │                            │ statements =    │
│                  │                            │ different nodes │
├─────────────────────────────────────────────────────────────────┤
│ Column           │ hash("column", canonical)  │ By full column  │
│                  │ E.g., "column_abc456..."   │ path: schema.   │
│                  │                            │ table.column    │
├─────────────────────────────────────────────────────────────────┤
│ Output/Derived   │ Content-based hash         │ If identical    │
│                  │                            │ definition      │
├─────────────────────────────────────────────────────────────────┤
│ Self-join alias  │ hash(canonical + alias +   │ Alias-specific: │
│                  │ scope_id)                  │ Each alias      │
│                  │                            │ instance unique │
└─────────────────────────────────────────────────────────────────┘

Example Canonical Names:
  "public.users"                    ← Table (2-part)
  "warehouse.analytics.user_daily"  ← Table (3-part)
  "public.users.user_id"            ← Column (3-part)
  "public.users.profile.json.name"  ← Column in JSON (4+ parts)
```

---

## Key Differences: Single vs Multiple Files

```
┌──────────────────────────────────────┬──────────────────────────────────────┐
│   SINGLE FILE (All Stmts Together)   │   MULTIPLE FILES (Separate Analysis) │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ ✓ Cross-statement edges automatic    │ ✗ No automatic cross-file edges      │
│ ✓ Tables deduplicated automatically  │ ✓ Can be merged by canonical name    │
│ ✓ Single AnalyzeResult               │ ✗ Multiple AnalyzeResults            │
│ ✓ GlobalLineage complete             │ ⚠️  Requires merging logic           │
│ ✓ Statement indices sequential       │ ⚠️  Statement indices per file       │
│ ✓ No manual coordination             │ ✗ Requires manual merge function     │
│                                      │                                      │
│ Cost: O(1) - built in                │ Cost: O(n*m) - manual merge          │
│ where n = files, m = avg statements  │                                      │
│                                      │                                      │
│ ✅ RECOMMENDED APPROACH              │ ⚠️  Use only if necessary             │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

---

## Files Involved

| Component | File | Type | Key Function |
|-----------|------|------|--------------|
| Type Defs | `packages/core/src/types.ts` | TypeScript | `AnalyzeResult`, `GlobalLineage`, `GlobalNode` |
| Global Build | `crates/flowscope-core/src/analyzer/global.rs` | Rust | `build_global_lineage_from()` |
| Cross-Statement | `crates/flowscope-core/src/analyzer/cross_statement.rs` | Rust | `CrossStatementTracker`, `build_cross_statement_edges()` |
| Merge (UI) | `packages/react/src/workers/graphBuilder.worker.ts` | TypeScript | `mergeStatements()` |
| Helpers | `packages/react/src/utils/lineageHelpers.ts` | TypeScript | `getCreatedRelationNodeIds()`, etc. |
| Graph Build | `packages/react/src/utils/graphBuilders.ts` | TypeScript | `buildFlowNodes()` with globalLineage |
| Service | `packages/react/src/utils/graphBuilderWorkerService.ts` | TypeScript | Worker communication |

