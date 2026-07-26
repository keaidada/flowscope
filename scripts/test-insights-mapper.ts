// 验证脚本：测试 data-mapper.ts 的数据映射逻辑
// 使用方法：npx tsx scripts/test-insights-mapper.ts
import type { AnalyzeResult } from '@pondpilot/flowscope-core';

import {
  convertToInsightsGraph,
  isInsightsResult,
} from '../app/src/components/insights/data-mapper';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${msg}`);
}

// 构造测试数据：两个脚本，三张表，存在跨脚本依赖
// 脚本 A: 写入 users，读取 accounts
// 脚本 B: 读取 users，写入 orders
function buildTestCase(): AnalyzeResult {
  return {
    statements: [
      {
        statementIndex: 0,
        statementType: 'INSERT',
        sourceName: 'etl/scriptA.sql',
        nodes: [
          { id: 'n1', type: 'table', label: 'users', qualifiedName: 'public.users' },
          { id: 'n2', type: 'table', label: 'accounts', qualifiedName: 'public.accounts' },
        ],
        edges: [],
        joinCount: 0,
        complexityScore: 1,
      },
      {
        statementIndex: 1,
        statementType: 'SELECT',
        sourceName: 'etl/scriptB.sql',
        nodes: [
          { id: 'n3', type: 'table', label: 'users', qualifiedName: 'public.users' },
          { id: 'n4', type: 'table', label: 'orders', qualifiedName: 'public.orders' },
        ],
        edges: [],
        joinCount: 0,
        complexityScore: 1,
      },
    ],
    globalLineage: {
      nodes: [
        {
          id: 'table_users',
          type: 'table',
          label: 'users',
          canonicalName: { schema: 'public', name: 'users' },
          statementRefs: [{ statementIndex: 0 }, { statementIndex: 1 }],
        },
        {
          id: 'table_accounts',
          type: 'table',
          label: 'accounts',
          canonicalName: { schema: 'public', name: 'accounts' },
          statementRefs: [{ statementIndex: 0 }],
        },
        {
          id: 'table_orders',
          type: 'table',
          label: 'orders',
          canonicalName: { schema: 'public', name: 'orders' },
          statementRefs: [{ statementIndex: 1 }],
        },
      ],
      edges: [
        // accounts → users (data flow)
        { id: 'e1', from: 'table_accounts', to: 'table_users', type: 'data_flow' },
        // users → orders (data flow, cross-script)
        { id: 'e2', from: 'table_users', to: 'table_orders', type: 'data_flow' },
      ],
    },
    issues: [],
    summary: {
      statementCount: 2,
      tableCount: 3,
      columnCount: 0,
      joinCount: 0,
      complexityScore: 1,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
  };
}

function testBasicConversion(): void {
  console.log('\n--- testBasicConversion ---');
  const original = buildTestCase();
  const { result, stats } = convertToInsightsGraph(original);

  // 应该有 2 个脚本节点
  assert(stats.scriptCount === 2, `脚本数应为 2，实际 ${stats.scriptCount}`);

  // 应该有 3 张唯一表
  assert(stats.uniqueTableCount === 3, `唯一表数应为 3，实际 ${stats.uniqueTableCount}`);

  // users 被两个脚本引用，所以表实例数 = 2+1+1 = 4
  // scriptA: users, accounts = 2
  // scriptB: users, orders = 2
  assert(stats.tableInstanceCount === 4, `表实例数应为 4，实际 ${stats.tableInstanceCount}`);

  // ownership 边 = 4（每个表实例一条）
  assert(stats.ownershipEdgeCount === 4, `ownership 边数应为 4，实际 ${stats.ownershipEdgeCount}`);

  // 跨脚本 data_flow 边：
  // accounts(在A) → users(在A,B)：A→A（跳过），A→B = 1
  // users(在A,B) → orders(在B)：A→B = 1, B→B（跳过）
  // 合计 2 条
  assert(
    stats.dataFlowEdgeCount === 2,
    `跨脚本 data_flow 边数应为 2，实际 ${stats.dataFlowEdgeCount}`
  );

  // 节点在 statement.nodes 中（不在 globalLineage 中，避免 OOM）
  assert(
    result.statements[0].nodes.length === 6,
    `合成 statement 的 nodes 数应为 6，实际 ${result.statements[0].nodes.length}`
  );

  // 检查脚本节点类型为 'table'
  const scriptNodes = result.statements[0].nodes.filter((n) => n.type === 'table');
  assert(scriptNodes.length === 2, `脚本节点（type=table）应为 2，实际 ${scriptNodes.length}`);

  // 检查表实例节点类型为 'column'
  const tableNodes = result.statements[0].nodes.filter((n) => n.type === 'column');
  assert(tableNodes.length === 4, `表实例节点（type=column）应为 4，实际 ${tableNodes.length}`);

  // GraphView 守卫需要至少一条 statement
  assert(result.statements.length === 1, `statements 长度应为 1，实际 ${result.statements.length}`);
  assert(
    result.summary.statementCount === 1,
    `summary.statementCount 应为 1，实际 ${result.summary.statementCount}`
  );
  // globalLineage 应为空（避免 worker postMessage 时 structured clone 重复复制导致 OOM）
  assert(
    result.globalLineage.nodes.length === 0,
    `globalLineage.nodes 应为空（避免 OOM），实际 ${result.globalLineage.nodes.length}`
  );
  assert(
    result.globalLineage.edges.length === 0,
    `globalLineage.edges 应为空（避免 OOM），实际 ${result.globalLineage.edges.length}`
  );
  // resolvedSchema 不应被复制（可能巨大）
  assert(
    result.resolvedSchema === undefined,
    `resolvedSchema 应为 undefined，实际 ${result.resolvedSchema}`
  );

  console.log('统计信息:', JSON.stringify(stats, null, 2));
}

function testIsInsightsResult(): void {
  console.log('\n--- testIsInsightsResult ---');
  const original = buildTestCase();
  const { result: converted } = convertToInsightsGraph(original);

  assert(isInsightsResult(original) === false, '原始 result 不应被识别为 insights result');
  assert(isInsightsResult(converted) === true, '转换后的 result 应被识别为 insights result');
  assert(isInsightsResult(null) === false, 'null 不应被识别为 insights result');
}

function testMergedResultsStatementIndexCollision(): void {
  console.log('\n--- testMergedResultsStatementIndexCollision ---');
  // 模拟两个文件合并后 statementIndex 冲突的场景
  // 文件 A 的 statement 0 和文件 B 的 statement 0 有相同的 statementIndex
  const merged: AnalyzeResult = {
    statements: [
      // 文件 A 的 statement 0
      {
        statementIndex: 0,
        statementType: 'INSERT',
        sourceName: 'etl/fileA.sql',
        nodes: [{ id: 'a1', type: 'table', label: 't1', qualifiedName: 'db.t1' }],
        edges: [],
        joinCount: 0,
        complexityScore: 1,
      },
      // 文件 B 的 statement 0（statementIndex 冲突！）
      {
        statementIndex: 0,
        statementType: 'SELECT',
        sourceName: 'etl/fileB.sql',
        nodes: [
          { id: 'b1', type: 'table', label: 't1', qualifiedName: 'db.t1' },
          { id: 'b2', type: 'table', label: 't2', qualifiedName: 'db.t2' },
        ],
        edges: [],
        joinCount: 0,
        complexityScore: 1,
      },
    ],
    globalLineage: {
      nodes: [
        {
          id: 'table_t1',
          type: 'table',
          label: 't1',
          canonicalName: { schema: 'db', name: 't1' },
          statementRefs: [{ statementIndex: 0 }, { statementIndex: 0 }],
        },
        {
          id: 'table_t2',
          type: 'table',
          label: 't2',
          canonicalName: { schema: 'db', name: 't2' },
          statementRefs: [{ statementIndex: 0 }],
        },
      ],
      edges: [],
    },
    issues: [],
    summary: {
      statementCount: 2,
      tableCount: 2,
      columnCount: 0,
      joinCount: 0,
      complexityScore: 1,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
  };

  const { stats } = convertToInsightsGraph(merged);
  // t1 被 fileA 和 fileB 同时引用，t2 只被 fileB 引用
  // 应该有 2 个脚本节点（fileA 和 fileB）
  assert(stats.scriptCount === 2, `合并后脚本数应为 2，实际 ${stats.scriptCount}`);
  console.log('统计:', JSON.stringify(stats));
}

function testEmptyInput(): void {
  console.log('\n--- testEmptyInput ---');
  const empty: AnalyzeResult = {
    statements: [],
    globalLineage: { nodes: [], edges: [] },
    issues: [],
    summary: {
      statementCount: 0,
      tableCount: 0,
      columnCount: 0,
      joinCount: 0,
      complexityScore: 0,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
  };

  const { stats } = convertToInsightsGraph(empty);
  assert(stats.scriptCount === 0, `空输入的脚本数应为 0，实际 ${stats.scriptCount}`);
  assert(stats.uniqueTableCount === 0, `空输入的表数应为 0，实际 ${stats.uniqueTableCount}`);
}

function testTableWithNoScript(): void {
  console.log('\n--- testTableWithNoScript ---');
  // 表有 statementRefs，但对应的 statement 没有 sourceName
  const result: AnalyzeResult = {
    statements: [
      {
        statementIndex: 0,
        statementType: 'SELECT',
        // 没有 sourceName
        nodes: [],
        edges: [],
        joinCount: 0,
        complexityScore: 1,
      },
    ],
    globalLineage: {
      nodes: [
        {
          id: 't1',
          type: 'table',
          label: 't1',
          canonicalName: { name: 'db.t1' },
          statementRefs: [{ statementIndex: 0 }],
        },
      ],
      edges: [],
    },
    issues: [],
    summary: {
      statementCount: 1,
      tableCount: 1,
      columnCount: 0,
      joinCount: 0,
      complexityScore: 1,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
  };

  const { stats } = convertToInsightsGraph(result);
  // 没有 sourceName 的表应归到 "(unreferenced)" 占位脚本
  assert(stats.scriptCount === 1, `应有 1 个占位脚本，实际 ${stats.scriptCount}`);
}

// 运行所有测试
console.log('🔧 数据洞察 data-mapper 单元测试\n');
testBasicConversion();
testIsInsightsResult();
testMergedResultsStatementIndexCollision();
testEmptyInput();
testTableWithNoScript();
console.log('\n🎉 全部测试通过！');
