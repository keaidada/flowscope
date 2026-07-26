import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

async function run() {
  const SQL = await initSqlJs({
    locateFile: (file: string) => require.resolve('sql.js/dist/' + file),
  });
  const db = new SQL.Database();

  // minimal schema setup (same as duckdb.ts)
  db.run(
    'CREATE TABLE IF NOT EXISTS lineage_statements (project_id TEXT NOT NULL, file_path TEXT NOT NULL, statement_index INTEGER NOT NULL, statement_type TEXT NOT NULL, source_name TEXT, sql_text TEXT, join_count INTEGER NOT NULL DEFAULT 0, complexity_score INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, file_path, statement_index))'
  );
  db.run(
    'CREATE TABLE IF NOT EXISTS lineage_nodes (project_id TEXT NOT NULL, file_path TEXT NOT NULL, node_id TEXT NOT NULL, node_type TEXT NOT NULL, label TEXT NOT NULL, qualified_name TEXT, statement_index INTEGER NOT NULL, resolution_source TEXT, PRIMARY KEY (project_id, file_path, node_id))'
  );
  db.run(
    'CREATE TABLE IF NOT EXISTS lineage_columns (project_id TEXT NOT NULL, file_path TEXT NOT NULL, column_id TEXT NOT NULL, label TEXT NOT NULL, qualified_name TEXT, parent_node_id TEXT, expression TEXT, statement_index INTEGER NOT NULL, PRIMARY KEY (project_id, file_path, column_id))'
  );
  db.run(
    'CREATE TABLE IF NOT EXISTS lineage_edges (project_id TEXT NOT NULL, file_path TEXT NOT NULL, edge_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL, expression TEXT, statement_index INTEGER, PRIMARY KEY (project_id, file_path, edge_id))'
  );
  db.run(
    'CREATE TABLE IF NOT EXISTS lineage_table_flows (project_id TEXT NOT NULL, file_path TEXT NOT NULL, source_table TEXT NOT NULL, target_table TEXT NOT NULL, PRIMARY KEY (project_id, file_path, source_table, target_table))'
  );

  // Synthetic small AnalyzeResult
  const result = {
    statements: [
      {
        statementIndex: 0,
        statementType: 'SELECT',
        sourceName: 'a.sql',
        nodes: [
          {
            id: 'n1',
            type: 'table',
            label: 'db.table1',
            qualifiedName: 'db.table1',
            resolutionSource: 'mock',
          },
        ],
        edges: [],
        joinCount: 0,
        complexityScore: 0,
      },
    ],
    resolvedSchema: {
      tables: [{ name: 'table1', schema: 'db', temporary: false, columns: [{ name: 'col1' }] }],
    },
    globalLineage: { nodes: [], edges: [] },
    issues: [],
    summary: {
      statementCount: 1,
      tableCount: 1,
      columnCount: 1,
      joinCount: 0,
      complexityScore: 0,
      issueCount: { errors: 0, warnings: 0, infos: 0 },
      hasErrors: false,
    },
  };

  // writeLineageData-like operations
  try {
    db.run("DELETE FROM lineage_statements WHERE project_id = 'test' AND file_path = 'a.sql'");
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO lineage_statements (project_id, file_path, statement_index, statement_type, source_name, sql_text, join_count, complexity_score, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(['test', 'a.sql', 0, 'SELECT', 'a.sql', 'select 1', 0, 0, Date.now()]);
    stmt.free();

    const nodeIns = db.prepare(
      'INSERT OR REPLACE INTO lineage_nodes (project_id, file_path, node_id, node_type, label, qualified_name, statement_index, resolution_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    nodeIns.run(['test', 'a.sql', 'n1', 'table', 'db.table1', 'db.table1', 0, 'mock']);
    nodeIns.free();

    db.run('COMMIT');
    console.log('writeLineageData success');
  } catch (e) {
    console.error('writeLineageData failed', e);
  }

  // writeTableFlows-like
  try {
    db.run("DELETE FROM lineage_table_flows WHERE project_id = 'test' AND file_path = 'a.sql'");
    const ins = db.prepare(
      'INSERT OR REPLACE INTO lineage_table_flows (project_id, file_path, source_table, target_table) VALUES (?, ?, ?, ?)'
    );
    ins.run(['test', 'a.sql', 'db.table1', 'db.table2']);
    ins.free();
    console.log('writeTableFlows success');
  } catch (e) {
    console.error('writeTableFlows failed', e);
  }

  // export DB to file
  const data = db.export();
  fs.writeFileSync(path.join(process.cwd(), 'tmp-test-flowscope.sqlite'), Buffer.from(data));
  console.log('DB exported to tmp-test-flowscope.sqlite');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
