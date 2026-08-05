/**
 * Governance API client and types.
 */

export type Severity = 'P0' | 'P1' | 'P2';

export interface ContractViolation {
  contract_id: string;
  contract_name: string;
  rule_id: string;
  rule_section: string;
  severity: Severity;
  title: string;
  detail: Record<string, unknown>;
  file_paths: string[];
}

export interface PendingRuntimeCheck {
  contract_id: string;
  check_type: string;
  description: string;
  query: string;
}

export interface GovernanceSummary {
  total_files: number;
  total_violations: number;
  p0_count: number;
  p1_count: number;
  p2_count: number;
  pending_runtime_count: number;
}

export interface GovernanceReport {
  project_id: string;
  health_score: number;
  dimension_scores: Record<string, number>;
  violations: ContractViolation[];
  pending_runtime: PendingRuntimeCheck[];
  summary: GovernanceSummary;
  created_at: string;
}

export interface ScanResponse {
  report_id: number;
  health_score: number;
  violation_count: number;
}

export interface ContractInfo {
  name: string;
  file_path: string;
  status: string;
  violation_count: number;
}

export interface ContractDetail {
  name: string;
  content: string;
  version: string;
  status: string;
}

export interface ModelEntry {
  id: number;
  project_id: string;
  table_name: string;
  model_layer: string;
  model_type: string;
  business_domain: string;
  owner: string;
  lifecycle: string;
  description: string;
  tags: string[];
  source: string;
  contract_id: string;
}

export interface ModelStats {
  total: number;
  by_layer: Record<string, number>;
  by_type: Record<string, number>;
  by_domain: Record<string, number>;
  by_lifecycle: Record<string, number>;
}

export interface MetricEntry {
  id: number;
  metric_name: string;
  metric_type: string;
  definition: string;
  sql_signature: string;
  expression: string;
  aggregation: string;
  business_filter: string;
  period: string;
  source_tables: string;
  dimensions: string[];
  owner: string;
  layer: string;
  lifecycle: string;
  contract_id: string;
  bound_model: string;
  bound_column: string;
}

export interface MetricConflict {
  id: number;
  conflict_type: string;
  metric_names: string[];
  detail: Record<string, unknown>;
  resolution: string;
  resolved: boolean;
}

export interface MetricStats {
  total: number;
  by_layer: Record<string, number>;
  by_owner: Record<string, number>;
  by_lifecycle: Record<string, number>;
  conflict_count: number;
}

export interface ScriptSummary {
  contract_id: string;
  script_name: string;
  metric_count: number;
  table_count: number;
}

export interface MetricQuality {
  total: number;
  filter_pct: number;
  owner_pct: number;
  period_pct: number;
  duplicate_metric_count: number;
  conflict_count: number;
}

export interface DuplicateGroup {
  dup_type: string;
  aggregation: string;
  normalized_expr: string;
  metric_names: string[];
  metric_count: number;
  bound_models: string[];
  suggestion: string;
}

export interface MetricFamily {
  bound_model: string;
  pattern: string;
  count: number;
  columns: string[];
  column_count: number;
  suggestion: string;
}

export interface ModelLoad {
  table_name: string;
  metric_count: number;
  source_count: number;
  agg_types: string[];
  load_level: string;
}

export interface OptimizationTip {
  tip_type: string;
  severity: string;
  title: string;
  description: string;
  affected_count: number;
}

export interface MetricAnalysis {
  quality: MetricQuality;
  duplicates: DuplicateGroup[];
  families: MetricFamily[];
  model_loads: ModelLoad[];
  tips: OptimizationTip[];
}

export type GovernanceTab = 'dashboard' | 'models' | 'metrics' | 'dimensions' | 'contracts' | 'designer' | 'settings';

// ── Dimension Registry types ──────────────────────────────────────
export interface DimensionEntry {
  id: number;
  dim_name: string;
  dim_name_cn: string;
  dim_column: string;
  master_table: string;
  attributes: string[];
  ref_count: number;
  ref_tables: string[];
  status: string;
  owner: string;
  description: string;
}

// ── Metric Decomposition types ────────────────────────────────────
export interface AtomicMetricEntry {
  id: number;
  metric_name: string;
  expression: string;
  agg_func: string;
  source_column: string;
  source_table: string;
  description: string;
  status: string;
}

export interface QualifierEntry {
  id: number;
  qualifier_name: string;
  qualifier_expr: string;
  field_name: string;
  ref_count: number;
}

export interface DerivedMetricEntry {
  id: number;
  metric_name: string;
  atomic_metric_name: string;
  qualifier_names: string[];
  time_period: string;
  stat_granularity: string[];
  full_expression: string;
  full_sql: string;
}

export interface DecomposeStats {
  total: number;
  atomic_count: number;
  qualifier_count: number;
  derived_count: number;
  compound_count: number;
  skipped_count: number;
}

// ── Summary Table Recommendation types ────────────────────────────
export interface SummaryRecommendation {
  id: number;
  recommended_table_name: string;
  recommended_layer: string;
  stat_granularity: string[];
  time_period: string;
  source_table: string;
  metric_count: number;
  metric_names: string[];
  suggested_sql: string;
  source_scripts: string[];
  potential_savings: string;
  status: string;
}

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const port = (window as unknown as { __FSCOPE_PORT__?: number }).__FSCOPE_PORT__;
    if (port) return `http://localhost:${port}`;
  }
  return '';
}

async function govFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}/api/governance${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`Governance API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export const governanceApi = {
  async listContracts(): Promise<ContractInfo[]> {
    return govFetch('/contracts');
  },

  async getContract(name: string): Promise<ContractDetail> {
    return govFetch(`/contracts/${encodeURIComponent(name)}`);
  },

  async createContract(name: string, content: string): Promise<void> {
    await govFetch('/contracts', {
      method: 'POST',
      body: JSON.stringify({ name, content }),
    });
  },

  async updateContract(name: string, content: string): Promise<void> {
    await govFetch(`/contracts/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  async deleteContract(name: string): Promise<void> {
    await govFetch(`/contracts/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  async validateContract(name: string): Promise<{ valid: boolean; errors?: string[] }> {
    return govFetch(`/contracts/${encodeURIComponent(name)}/validate`, { method: 'POST' });
  },

  async scan(projectId: string): Promise<ScanResponse> {
    return govFetch('/scan', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async getReport(projectId: string, limit = 5): Promise<GovernanceReport[]> {
    return govFetch(`/report?project_id=${encodeURIComponent(projectId)}&limit=${limit}`);
  },

  async getHealth(projectId: string): Promise<{
    total_score: number | null;
    dimension_scores: Record<string, number>;
    summary?: GovernanceSummary;
    trend: number[];
  }> {
    return govFetch(`/health?project_id=${encodeURIComponent(projectId)}`);
  },

  async exportReport(projectId: string, format: 'html' | 'json'): Promise<Blob> {
    const res = await fetch(`${apiBase()}/api/governance/export/${format}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    return res.blob();
  },

  // === Model management ===
  async listModels(queryString: string): Promise<ModelEntry[]> {
    return govFetch(`/models?${queryString}`);
  },

  async modelStats(projectId: string): Promise<ModelStats> {
    return govFetch(`/models/stats?project_id=${encodeURIComponent(projectId)}`);
  },

  async autoDiscover(projectId: string): Promise<{ discovered: number; created: number; updated: number }> {
    return govFetch('/models/auto', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async updateModel(projectId: string, name: string, data: Record<string, string>): Promise<void> {
    await govFetch(`/models/${encodeURIComponent(name)}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, ...data }),
    });
  },

  // === Metric management ===
  async listMetrics(queryString: string): Promise<MetricEntry[]> {
    return govFetch(`/metrics?${queryString}`);
  },

  async listScriptSummaries(projectId: string): Promise<ScriptSummary[]> {
    return govFetch(`/metrics/scripts?project_id=${encodeURIComponent(projectId)}`);
  },

  async metricConflicts(projectId: string): Promise<MetricConflict[]> {
    return govFetch(`/metrics/conflicts?project_id=${encodeURIComponent(projectId)}`);
  },

  async metricStats(projectId: string): Promise<MetricStats> {
    return govFetch(`/metrics/stats?project_id=${encodeURIComponent(projectId)}`);
  },

  async autoDetectMetrics(projectId: string): Promise<{ detected: number }> {
    return govFetch('/metrics/auto', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async importDbtMetrics(projectId: string): Promise<{
    imported: number;
    metrics: Array<Record<string, unknown>>;
    skipped: string[];
  }> {
    return govFetch('/metrics/import-dbt', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async extractLineageMetrics(projectId: string): Promise<{ extracted: number }> {
    return govFetch('/metrics/extract-lineage', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async metricAnalysis(projectId: string): Promise<MetricAnalysis> {
    return govFetch(`/metrics/analysis?project_id=${encodeURIComponent(projectId)}`);
  },

  // === Designer ===
  async genDdl(model: unknown, dialect: string): Promise<{ ddl: string }> {
    return govFetch('/gen-ddl', {
      method: 'POST',
      body: JSON.stringify({ model, dialect }),
    });
  },

  async reverseEngineer(sql: string): Promise<Record<string, unknown>[]> {
    return govFetch('/reverse-engineer', {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
  },

  async modelDiff(oldModel: unknown, newModel: unknown): Promise<{ added: string[]; removed: string[]; modified: Array<{ column: string; old_type: string; new_type: string }> }> {
    return govFetch('/model-diff', {
      method: 'POST',
      body: JSON.stringify({ old: oldModel, new: newModel }),
    });
  },

  // === Settings ===
  async getSettings(projectId: string): Promise<Record<string, unknown>> {
    return govFetch(`/settings?project_id=${encodeURIComponent(projectId)}`);
  },

  async updateSettings(projectId: string, data: Record<string, unknown>): Promise<void> {
    await govFetch(`/settings`, {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, ...data }),
    });
  },

  // === Contract templates ===
  async contractTemplates(): Promise<Array<{ name: string; description: string; content: string }>> {
    return govFetch('/contracts/templates');
  },

  // === Dimension Registry ===
  async discoverDimensions(projectId: string): Promise<{ discovered: number }> {
    return govFetch('/dimensions/discover', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async listDimensions(projectId: string, status?: string, limit = 50, offset = 0): Promise<{ items: DimensionEntry[]; total: number }> {
    const params = new URLSearchParams({ project_id: projectId, limit: String(limit), offset: String(offset) });
    if (status) params.set('status', status);
    return govFetch(`/dimensions?${params.toString()}`);
  },

  async updateDimension(projectId: string, dimId: number, data: { status?: string; dim_name?: string; dim_name_cn?: string; description?: string }): Promise<void> {
    await govFetch(`/dimensions/${dimId}`, {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, ...data }),
    });
  },

  // === Metric Decomposition ===
  async decomposeMetrics(projectId: string): Promise<DecomposeStats> {
    return govFetch('/metrics/decompose', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async listAtomicMetrics(projectId: string): Promise<AtomicMetricEntry[]> {
    return govFetch(`/metrics/atomic?project_id=${encodeURIComponent(projectId)}`);
  },

  async listQualifiers(projectId: string): Promise<QualifierEntry[]> {
    return govFetch(`/metrics/qualifiers?project_id=${encodeURIComponent(projectId)}`);
  },

  async listDerivedMetrics(projectId: string): Promise<DerivedMetricEntry[]> {
    return govFetch(`/metrics/derived?project_id=${encodeURIComponent(projectId)}`);
  },

  // === Summary Table Recommendations ===
  async generateSummaryRecs(projectId: string): Promise<{ generated: number }> {
    return govFetch('/recommendations/summary-tables', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  },

  async listSummaryRecs(projectId: string): Promise<SummaryRecommendation[]> {
    return govFetch(`/recommendations/summary-tables?project_id=${encodeURIComponent(projectId)}`);
  },

  async updateSummaryRec(projectId: string, recId: number, status: string): Promise<void> {
    await govFetch(`/recommendations/summary-tables/${recId}`, {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, status }),
    });
  },
};
