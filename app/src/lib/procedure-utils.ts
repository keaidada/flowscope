/**
 * BigQuery stored procedure to DML conversion utilities.
 *
 * Uses the Rust/Wasm engine's sanitize_procedure function which performs
 * AST-level extraction of DML/SELECT from BEGIN...END blocks.
 * Handles all syntax correctly: triple-quoted strings, nested control flow,
 * FORMAT placeholders, EXECUTE IMMEDIATE, etc.
 */

import { sanitizeProcedure, initWasm, isWasmInitialized } from '@pondpilot/flowscope-core';

/**
 * Extract DML from a stored procedure.
 * Delegates to the Rust/Wasm engine for AST-level parsing.
 */
export async function extractDmlFromProcedure(content: string, dialect?: string): Promise<string | null> {
  if (dialect && dialect !== 'bigquery') return null;
  if (!isWasmInitialized()) {
    await initWasm();
  }
  return sanitizeProcedure(content);
}
