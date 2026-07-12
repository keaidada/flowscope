/**
 * Backend context for analysis operations.
 *
 * All analysis runs through the Rust CLI backend via REST API.
 * The adapter is initialized once and shared across all components.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { BackendAdapter, BackendDetectionResult } from './backend-adapter';
import { createBackendAdapter } from './backend-adapter';

export interface BackendState {
  ready: boolean;
  error: string | null;
  isRetrying: boolean;
  backendType: 'rest' | null;
}

interface BackendContextValue extends BackendState {
  adapter: BackendAdapter | null;
  retry: () => void;
}

const BackendContext = createContext<BackendContextValue | null>(null);

interface BackendProviderProps {
  children: React.ReactNode;
}

export function BackendProvider({ children }: BackendProviderProps) {
  const [state, setState] = useState<BackendState>({
    ready: false,
    error: null,
    isRetrying: false,
    backendType: null,
  });
  const [adapter, setAdapter] = useState<BackendAdapter | null>(null);

  const retryBackend = useCallback(async () => {
    setState((prev) => ({ ...prev, error: null, isRetrying: true }));
    try {
      const result: BackendDetectionResult = await createBackendAdapter();
      setAdapter(result.adapter);
      setState({ ready: true, error: null, isRetrying: false, backendType: 'rest' });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setState({ ready: false, error: `Failed to initialize backend: ${errorMessage}`, isRetrying: false, backendType: null });
      setAdapter(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initializeBackend = async () => {
      try {
        const result: BackendDetectionResult = await createBackendAdapter();
        if (cancelled) return;
        setAdapter(result.adapter);
        setState({ ready: true, error: null, isRetrying: false, backendType: 'rest' });
      } catch (error: unknown) {
        if (cancelled) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        setState({ ready: false, error: `Failed to initialize backend: ${errorMessage}`, isRetrying: false, backendType: null });
        setAdapter(null);
      }
    };
    initializeBackend();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo(() => ({ ...state, adapter, retry: retryBackend }), [state, adapter, retryBackend]);
  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>;
}

export function useBackend(): BackendContextValue {
  const context = useContext(BackendContext);
  if (!context) throw new Error('useBackend must be used within a BackendProvider');
  return context;
}

export function useBackendReady() {
  const { ready, error, isRetrying, retry, backendType } = useBackend();
  return { ready, error, isRetrying, retry, backendType };
}
