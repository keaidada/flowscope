/**
 * Server-side SQLite client for serve mode.
 *
 * When flowscope-cli is running in serve mode, browser-side storage
 * is delegated to the local SQLite database via REST API.
 * This module replaces the sql.js WASM layer in serve mode.
 */

const BASE = '/api/db';

interface ProjectFile {
  name: string;
  path: string;
  content: string;
  language: string;
  size: number;
  dialect: string;
  is_procedure: number;
  transformed_content: string;
  created_at: string;
  updated_at: string;
}

interface SchemaFile {
  name: string;
  path: string;
  content: string;
  size: number;
  created_at: string;
  updated_at: string;
}

interface FileResult {
  filePath: string;
  resultJson: string;
  contentHash: string;
}

export interface LineageNodeRow {
  node_id: string;
  node_type: string;
  label: string;
  qualified_name: string | null;
  statement_index: number;
  resolution_source: string | null;
  file_path: string;
  file_name?: string;
  dir_path?: string;
}

export interface LineageColumnRow {
  column_id: string;
  label: string;
  qualified_name: string | null;
  parent_node_id: string | null;
  expression: string | null;
  statement_index: number;
  file_path: string;
  file_name?: string;
  dir_path?: string;
}

export interface LineageEdgeRow {
  edge_id: string;
  from_id: string;
  to_id: string;
  edge_type: string;
  expression: string | null;
  statement_index: number | null;
  file_path: string;
  file_name?: string;
  dir_path?: string;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) throw new Error(`Server DB API error: ${res.status} ${res.statusText}`);
  if (res.status === 204) return undefined as T;
  // Handle empty response body (e.g. POST returning 200 with no content)
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// ── project_files ──────────────────────────────────────────────────────

export async function loadProjectFiles(projectId: string): Promise<ProjectFile[]> {
  return api<ProjectFile[]>('GET', `/project-files?projectId=${encodeURIComponent(projectId)}`);
}

export async function saveProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  // Send all files in a single request — the Rust server handles large JSON fine
  await api<void>('POST', '/project-files', { project_id: projectId, files });
}

// ── file metadata (no content) ────────────────────────────────────────

export interface ProjectFileMeta {
  name: string;
  path: string;
  dir_id: string;
  language: string;
  size: number;
  created_at: string;
  updated_at: string;
}

export async function loadFilesMeta(projectId: string): Promise<ProjectFileMeta[]> {
  return api<ProjectFileMeta[]>('GET', `/files-meta?projectId=${encodeURIComponent(projectId)}`);
}

// ── single file content ───────────────────────────────────────────────

export async function loadFileContent(projectId: string, filePath: string): Promise<string | null> {
  const resp = await api<{ content: string | null }>(
    'GET',
    `/file-content?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`
  );
  return resp.content;
}

export async function loadFileContentsBatch(
  projectId: string,
  paths: string[]
): Promise<Map<string, string>> {
  // Fetch content for each path individually but in parallel batches of 50
  const BATCH = 50;
  const result = new Map<string, string>();
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const responses = await Promise.all(
      batch.map(async (p) => {
        const content = await loadFileContent(projectId, p);
        return [p, content ?? ''] as const;
      })
    );
    for (const [p, c] of responses) {
      result.set(p, c);
    }
  }
  return result;
}

// ── incremental upsert / delete / rename ──────────────────────────────

export async function upsertProjectFiles(projectId: string, files: ProjectFile[]): Promise<void> {
  await api<void>('POST', '/file-upsert-batch', {
    project_id: projectId,
    files: files.map((f) => ({
      name: f.name,
      path: f.path,
      content: f.content,
      language: f.language,
      size: f.size || new TextEncoder().encode(f.content).length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })),
  });
}

export async function deleteProjectFilesByPaths(projectId: string, paths: string[]): Promise<void> {
  await api<void>('POST', '/file-delete-batch', { projectId, paths });
}

export async function renameProjectFile(
  projectId: string,
  oldPath: string,
  newPath: string,
  newName: string,
  isFolder: boolean
): Promise<void> {
  await api<void>('POST', '/file-rename', {
    projectId,
    oldPath,
    newPath,
    newName,
    isFolder,
  });
}

// ── directories ───────────────────────────────────────────────────────

export interface ProjectDirectory {
  id: string;
  project_id: string;
  parent_id: string;
  name: string;
  path: string;
  level: number;
  file_count: number;
  child_count: number;
}

export async function loadDirectories(projectId: string): Promise<ProjectDirectory[]> {
  return api<ProjectDirectory[]>('GET', `/directories?projectId=${encodeURIComponent(projectId)}`);
}

// ── projects ───────────────────────────────────────────────────────────

export interface ProjectMeta {
  id: string;
  name: string;
  dialect: string;
  run_mode: string;
  template_mode: string;
  schema_sql: string;
  selected_file_ids: string;
  active_file_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function loadProjects(): Promise<ProjectMeta[]> {
  return api<ProjectMeta[]>('GET', '/projects');
}

export async function saveProject(meta: ProjectMeta): Promise<void> {
  await api<void>('POST', '/projects', { project: meta });
}

export async function deleteProject(projectId: string): Promise<void> {
  await api<void>('DELETE', `/projects?projectId=${encodeURIComponent(projectId)}`);
}

// ── view_states ─────────────────────────────────────────────────────────

export async function loadViewState(projectId: string): Promise<string | null> {
  return api<string | null>('GET', `/view-states?projectId=${encodeURIComponent(projectId)}`);
}

export async function saveViewState(projectId: string, stateJson: string): Promise<void> {
  await api<void>('POST', '/view-states', { project_id: projectId, state_json: stateJson });
}

// ── schema_files ───────────────────────────────────────────────────────

export async function loadSchemaFiles(projectId: string): Promise<SchemaFile[]> {
  return api<SchemaFile[]>('GET', `/schema-files?projectId=${encodeURIComponent(projectId)}`);
}

export async function saveSchemaFiles(projectId: string, files: SchemaFile[]): Promise<void> {
  await api<void>('POST', '/schema-files', { project_id: projectId, files });
}

// ── analysis_cache ─────────────────────────────────────────────────────

export async function getCacheResult(key: string): Promise<{ cached: boolean; result?: unknown }> {
  return api('GET', `/cache?key=${encodeURIComponent(key)}`);
}

export async function setCacheResult(key: string, result: unknown): Promise<void> {
  await api<void>('POST', '/cache', { key, result });
}

export async function clearCache(): Promise<void> {
  await api<void>('POST', '/cache/clear');
}

export async function deleteCacheResult(key: string): Promise<void> {
  await api<void>('DELETE', `/cache?key=${encodeURIComponent(key)}`);
}

// ── project_file_results ───────────────────────────────────────────────

export async function getFileResult(
  projectId: string,
  filePath: string
): Promise<{ found: boolean; resultJson?: string; contentHash?: string }> {
  return api('GET', `/file-result?projectId=${encodeURIComponent(projectId)}&filePath=${encodeURIComponent(filePath)}`);
}

export async function getFileResults(projectId: string): Promise<FileResult[]> {
  const resp = await api<{ files: FileResult[] }>('GET', `/file-results?projectId=${encodeURIComponent(projectId)}`);
  return resp.files;
}

export async function setFileResult(
  projectId: string,
  filePath: string,
  resultJson: string,
  contentHash: string
): Promise<void> {
  await api<void>('POST', '/file-results', {
    project_id: projectId,
    file_path: filePath,
    result_json: resultJson,
    content_hash: contentHash,
  });
}

/** Batch save file-result pointer rows (lightweight, one per file). */
export interface ProjectFileResultRow {
  file_path: string;
  content_hash: string;
  updated_at: string;
  file_name?: string;
  dir_path?: string;
}
export async function saveProjectFileResults(
  projectId: string,
  rows: ProjectFileResultRow[]
): Promise<void> {
  await api<void>('POST', '/file-results', {
    project_id: projectId,
    rows: rows.map((r) => ({ file_path: r.file_path, content_hash: r.content_hash })),
  });
}
export async function loadProjectFileResults(
  projectId: string
): Promise<ProjectFileResultRow[]> {
  const resp = await api<{ files: Array<{ filePath: string; contentHash: string; fileName?: string; dirPath?: string }> }>('GET', `/file-results?projectId=${encodeURIComponent(projectId)}`);
  return resp.files.map(f => ({
    file_path: f.filePath,
    content_hash: f.contentHash || '',
    updated_at: '',
    file_name: f.fileName,
    dir_path: f.dirPath,
  }));
}

/** 轻量查询 file_path + file_name，不含 result_json 等大字段 */
export async function loadProjectFileResultsLight(
  projectId: string
): Promise<{ file_path: string; file_name?: string }[]> {
  const resp = await api<{ files: Array<{ filePath: string; fileName?: string }> }>('GET', `/file-results/light?projectId=${encodeURIComponent(projectId)}`);
  return resp.files.map(f => ({
    file_path: f.filePath,
    file_name: f.fileName,
  }));
}

export async function deleteProjectFileResults(
  projectId: string,
  filePaths: string[],
): Promise<void> {
  await api<void>('DELETE', '/file-results', { project_id: projectId, file_paths: filePaths });
}

export interface AnomalyRow {
  id?: number;
  projectId: string;
  filePath: string;
  scriptName: string;
  scriptContent: string;
  severity: string;
  anomalyType: string;
  message: string;
  detail: string;
  isTest: number;
  createdAt?: string;
}

export async function saveAnomaly(
  projectId: string,
  row: Omit<AnomalyRow, 'id' | 'createdAt' | 'projectId'>,
): Promise<void> {
  await api<void>('POST', '/anomalies', {
    project_id: projectId,
    file_path: row.filePath,
    script_name: row.scriptName,
    script_content: row.scriptContent,
    severity: row.severity,
    anomaly_type: row.anomalyType,
    message: row.message,
    detail: row.detail,
    is_test: row.isTest,
  });
}

// ── lineage ────────────────────────────────────────────────────────────

export async function getLineageNodes(projectId: string, filePath?: string): Promise<LineageNodeRow[]> {
  const params = new URLSearchParams({ projectId });
  if (filePath) params.set('filePath', filePath);
  return api<LineageNodeRow[]>('GET', `/lineage/nodes?${params}`);
}

export async function getLineageColumns(projectId: string, filePath?: string): Promise<LineageColumnRow[]> {
  const params = new URLSearchParams({ projectId });
  if (filePath) params.set('filePath', filePath);
  return api<LineageColumnRow[]>('GET', `/lineage/columns?${params}`);
}

export async function getLineageEdges(projectId: string, filePath?: string, edgeType?: string): Promise<LineageEdgeRow[]> {
  const params = new URLSearchParams({ projectId });
  if (filePath) params.set('filePath', filePath);
  if (edgeType) params.set('edgeType', edgeType);
  return api<LineageEdgeRow[]>('GET', `/lineage/edges?${params}`);
}

export async function saveLineageBatch(
  projectId: string,
  nodes: LineageNodeRow[],
  columns: LineageColumnRow[],
  edges: LineageEdgeRow[]
): Promise<void> {
  await api<void>('POST', '/lineage', {
    project_id: projectId,
    nodes,
    columns,
    edges,
  });
}

// ── table_level_edges (物化预计算) ─────────────────────────────────────

export async function saveTableLevelEdges(
  projectId: string,
  edges: Array<[string, string, string]>
): Promise<void> {
  await api<void>('POST', '/table-level-edges', { project_id: projectId, edges });
}

export async function loadTableLevelEdges(
  projectId: string
): Promise<Array<[string, string, string]>> {
  return api<Array<[string, string, string]>>('GET', `/table-level-edges?projectId=${encodeURIComponent(projectId)}`);
}

// ── table_metadata / column_metadata ───────────────────────────────────

export interface TableMetadataRow {
  id: number;
  project_id: string;
  catalog: string;
  schema_name: string;
  table_name: string;
  table_type: string;
  origin: string;
  temporary: boolean;
  partition_keys: string;
  cluster_keys: string;
  file_format: string;
  location: string;
  properties_json: string;
  owner: string;
  comment: string;
  row_count: number;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  status: number;
}

export interface ColumnMetadataRow {
  id: number;
  project_id: string;
  table_id: number;
  column_name: string;
  ordinal: number;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  is_partition: boolean;
  default_value: string | null;
  comment: string;
  created_at: string;
  updated_at: string;
  status: number;
}

export async function getTableMetadata(projectId: string): Promise<TableMetadataRow[]> {
  return api<TableMetadataRow[]>('GET', `/table-metadata?projectId=${encodeURIComponent(projectId)}`);
}

export async function getColumnMetadata(projectId: string): Promise<ColumnMetadataRow[]> {
  return api<ColumnMetadataRow[]>('GET', `/column-metadata?projectId=${encodeURIComponent(projectId)}`);
}

export async function saveTableMetadata(
  projectId: string,
  tables: TableMetadataRow[],
  columns: ColumnMetadataRow[]
): Promise<void> {
  await api<void>('POST', '/table-metadata', { project_id: projectId, tables, columns });
}
