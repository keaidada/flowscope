import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

const __dirname = path.resolve();

(async () => {
  try {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file),
    });
    const db = new SQL.Database();

    db.run(`CREATE TABLE IF NOT EXISTS lineage_statements (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      statement_index INTEGER NOT NULL,
      statement_type TEXT NOT NULL,
      source_name TEXT,
      sql_text TEXT,
      join_count INTEGER NOT NULL DEFAULT 0,
      complexity_score INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, file_path, statement_index)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS lineage_nodes (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      label TEXT NOT NULL,
      qualified_name TEXT,
      statement_index INTEGER NOT NULL,
      resolution_source TEXT,
      PRIMARY KEY (project_id, file_path, node_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS lineage_columns (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      column_id TEXT NOT NULL,
      label TEXT NOT NULL,
      qualified_name TEXT,
      parent_node_id TEXT,
      expression TEXT,
      statement_index INTEGER NOT NULL,
      PRIMARY KEY (project_id, file_path, column_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS lineage_edges (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      expression TEXT,
      statement_index INTEGER,
      PRIMARY KEY (project_id, file_path, edge_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS lineage_table_flows (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      source_table TEXT NOT NULL,
      target_table TEXT NOT NULL,
      PRIMARY KEY (project_id, file_path, source_table, target_table)
    )`);

    const now = Date.now();

    // Simulate writeLineageData
    db.run("DELETE FROM lineage_statements WHERE project_id = 'test' AND file_path = 'a.sql'");
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO lineage_statements (project_id, file_path, statement_index, statement_type, source_name, sql_text, join_count, complexity_score, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(['test', 'a.sql', 0, 'SELECT', 'a.sql', 'select 1', 0, 0, now]);
    stmt.free();

    const nodeIns = db.prepare(
      'INSERT OR REPLACE INTO lineage_nodes (project_id, file_path, node_id, node_type, label, qualified_name, statement_index, resolution_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    nodeIns.run(['test', 'a.sql', 'n1', 'table', 'db.table1', 'db.table1', 0, 'mock']);
    nodeIns.free();

    console.log('writeLineageData simulation OK');

    // Simulate writeTableFlows
    db.run("DELETE FROM lineage_table_flows WHERE project_id = 'test' AND file_path = 'a.sql'");
    const ins = db.prepare(
      'INSERT OR REPLACE INTO lineage_table_flows (project_id, file_path, source_table, target_table) VALUES (?, ?, ?, ?)'
    );
    ins.run(['test', 'a.sql', 'db.table1', 'db.table2']);
    ins.free();

    console.log('writeTableFlows simulation OK');

    const data = db.export();
    fs.writeFileSync(path.join(process.cwd(), 'tmp-test-flowscope.sqlite'), Buffer.from(data));
    console.log('Exported DB to tmp-test-flowscope.sqlite');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
})();
