/**
 * Governance data hook — manages scan state, reports, and contracts.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  governanceApi,
  type GovernanceReport,
  type ContractInfo,
  type ScanResponse,
} from '@/lib/governance-api';

export function useGovernanceData(projectId: string | null) {
  const [report, setReport] = useState<GovernanceReport | null>(null);
  const [contracts, setContracts] = useState<ContractInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshReport = useCallback(async () => {
    if (!projectId) return;
    try {
      const reports = await governanceApi.getReport(projectId, 1);
      setReport(reports[0] ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  const refreshContracts = useCallback(async () => {
    try {
      const list = await governanceApi.listContracts();
      setContracts(list);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const scan = useCallback(async (): Promise<ScanResponse | null> => {
    if (!projectId) return null;
    setScanning(true);
    setError(null);
    try {
      const result = await governanceApi.scan(projectId);
      await refreshReport();
      return result;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setScanning(false);
    }
  }, [projectId, refreshReport]);

  useEffect(() => {
    refreshContracts();
    refreshReport();
  }, [refreshContracts, refreshReport]);

  return {
    report,
    contracts,
    scanning,
    error,
    scan,
    refreshReport,
    refreshContracts,
  };
}
