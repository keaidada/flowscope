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

export type GovernanceTab = 'dashboard' | 'models' | 'metrics' | 'contracts' | 'designer' | 'settings';

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
};
