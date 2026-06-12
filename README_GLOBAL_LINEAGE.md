# Global Lineage Merge Analysis - Summary

I've analyzed the FlowScope repository to understand how multiple `AnalyzeResult` objects are merged for a global lineage view. Here's what I found:

## 📋 Documents Created

Three comprehensive guides have been created in your repository:

1. **`GLOBAL_LINEAGE_MERGE_GUIDE.md`** - Deep technical reference
   - Complete type definitions
   - Full function implementations
   - Merge algorithm details
   - Best practices

2. **`MERGE_ARCHITECTURE.md`** - Visual diagrams and patterns
   - Data flow diagrams
   - Deduplication patterns
   - Cross-statement edge creation
   - Node ID strategies

3. **`QUICK_REFERENCE.md`** - Developer cheat sheet
   - Quick answers to common questions
   - Code snippets ready to use
   - Performance comparisons
   - Troubleshooting guide

## 🎯 Key Finding

**There is NO pre-built function to merge multiple `AnalyzeResult` objects**, but the architecture is sophisticated:

### Single-Pass Analysis (✅ RECOMMENDED)
```typescript
// Analyze all statements together
const allSQL = file1 + '\n\n' + file2 + '\n\n' + file3;
const result = await analyzer.analyze({ sql: allSQL, dialect: 'postgres' });
// Result has complete globalLineage with cross-file edges automatically
```

### Manual Merge (⚠️ Fallback)
```typescript
// If analyzing separately, merge like this:
const merged = mergeAnalyzeResults([result1, result2, result3]);
// Has deduplicated nodes but NO cross-file edges
```

## 🔑 Key Types

```typescript
// The main result structure
AnalyzeResult {
  statements: StatementLineage[];
  globalLineage: GlobalLineage;  // ← Built-in unified graph
  issues: Issue[];
  summary: Summary;
  resolvedSchema?: ResolvedSchemaMetadata;
}

// Unified graph across statements
GlobalLineage {
  nodes: GlobalNode[];   // Deduplicated tables/views/columns
  edges: GlobalEdge[];   // All data flows + cross-statement
}

// Node in global graph
GlobalNode {
  id: string;                    // Stable hash ID
  canonicalName: CanonicalName;  // For matching across files
  statementRefs: StatementRef[]; // Which statements use this
}

// Cross-statement relationships
GlobalEdge {
  from: string;
  to: string;
  type: 'cross_statement' | 'data_flow' | ...
  producer_statement?: StatementRef;   // Which statement produces
  consumer_statement?: StatementRef;   // Which statement consumes
}
```

## 🏗️ Architecture Layers

### Rust Layer (flowscope-core)
- **`global.rs:build_global_lineage_from()`** - Builds GlobalLineage from multiple StatementLineage
- **`cross_statement.rs:CrossStatementTracker`** - Tracks producer/consumer relationships
- **`cross_statement.rs:build_cross_statement_edges()`** - Creates edges between statements

### TypeScript Layer (React UI)
- **`graphBuilder.worker.ts:mergeStatements()`** - Merges StatementLineage for visualization
- **`graphBuilders.ts:buildFlowNodes()`** - Creates visual nodes using globalLineage
- **`lineageHelpers.ts`** - Helper functions for lineage manipulation

## 📊 Node Deduplication Strategy

| Node Type | Deduplicates By | Scope |
|-----------|-----------------|-------|
| Table/View | Canonical name | Across all statements |
| Column | Full path | Across all statements |
| CTE | Statement index | NOT deduplicated (statement-scoped) |

## 🔄 Cross-Statement Edge Pattern

```
Statement 0: CREATE TABLE staging.raw ...
Statement 1: SELECT * FROM staging.raw ...
             ▼
GlobalEdge {
  from: "table_staging_raw",
  to: "table_staging_raw",           ← Self-referencing
  type: "cross_statement",
  producer_statement: {statementIndex: 0},
  consumer_statement: {statementIndex: 1}
}
```

## 📁 Critical Files

```
Rust Implementation:
  crates/flowscope-core/src/analyzer/global.rs          (87-211 lines)
  crates/flowscope-core/src/analyzer/cross_statement.rs (40-291 lines)

TypeScript Types:
  packages/core/src/types.ts                           (AnalyzeResult, GlobalLineage)

UI Integration:
  packages/react/src/workers/graphBuilder.worker.ts    (mergeStatements at line 885)
  packages/react/src/utils/graphBuilders.ts
  packages/react/src/utils/lineageHelpers.ts
```

## 🚀 How to Use

### Option A: Analyze Together (Best)
```typescript
const sql = await readMultipleFiles();  // Concatenate
const result = await analyzer.analyze({ sql, dialect: 'postgres' });
// Done! result.globalLineage is complete with cross-file edges
```

### Option B: Merge After (Fallback)
```typescript
// Implement mergeAnalyzeResults() function (see QUICK_REFERENCE.md)
const results = await analyzeMultipleFiles();
const merged = mergeAnalyzeResults(results);
// Has deduplicated graph but manual cross-file edge tracking needed
```

## ⚠️ Important Limitations

When analyzing files separately:
- ✗ No automatic cross-file edges created
- ✓ Nodes ARE deduplicated by canonical name
- ✓ Can be merged for visualization
- ⚠️ Requires consistent schema across files

## 💡 Key Insights

1. **GlobalLineage is built on-the-fly** during analysis - not pre-computed
2. **Node IDs are stable hashes** based on canonical names
3. **Cross-statement edges are self-referencing** with metadata indicating direction
4. **StatementRefs array tracks all usages** of a global node
5. **The system is designed for single-pass analysis** of all statements together

## 🔍 What I Analyzed

✓ `packages/core/src/types.ts` - All TypeScript type definitions
✓ `crates/flowscope-core/src/analyzer/global.rs` - Global lineage building  
✓ `crates/flowscope-core/src/analyzer/cross_statement.rs` - Cross-statement tracking
✓ `packages/react/src/workers/graphBuilder.worker.ts` - UI merge function
✓ `packages/react/src/utils/lineageHelpers.ts` - Helper utilities

---

## Next Steps

1. Read **QUICK_REFERENCE.md** for immediate answers
2. Read **MERGE_ARCHITECTURE.md** for visual understanding
3. Read **GLOBAL_LINEAGE_MERGE_GUIDE.md** for deep dive

All three documents are in your repository root.
