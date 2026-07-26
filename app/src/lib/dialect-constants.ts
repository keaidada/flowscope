/**
 * Dialect type and constants shared across the app.
 * Extracted to avoid circular imports between components and project-store.
 */

export type Dialect =
  | 'generic'
  | 'ansi'
  | 'bigquery'
  | 'clickhouse'
  | 'databricks'
  | 'duckdb'
  | 'hive'
  | 'mssql'
  | 'mysql'
  | 'oracle'
  | 'postgres'
  | 'redshift'
  | 'snowflake'
  | 'sqlite';

/** Human-readable labels for each dialect. */
const DIALECT_LABELS: Record<Dialect, string> = {
  generic: 'Generic SQL',
  ansi: 'ANSI SQL',
  bigquery: 'BigQuery',
  clickhouse: 'ClickHouse',
  databricks: 'Databricks',
  duckdb: 'DuckDB',
  hive: 'Hive',
  mssql: 'MS SQL Server',
  mysql: 'MySQL',
  oracle: 'Oracle',
  postgres: 'PostgreSQL',
  redshift: 'Redshift',
  snowflake: 'Snowflake',
  sqlite: 'SQLite',
};

/** All valid dialect values for runtime validation. */
export const VALID_DIALECTS: readonly Dialect[] = [
  'generic',
  'ansi',
  'bigquery',
  'clickhouse',
  'databricks',
  'duckdb',
  'hive',
  'mssql',
  'mysql',
  'oracle',
  'postgres',
  'redshift',
  'snowflake',
  'sqlite',
] as const;

/**
 * Dialect options for UI dropdowns, derived from VALID_DIALECTS.
 * Note: 'ansi' is excluded from UI since 'generic' serves the same purpose for users.
 */
export const DIALECT_OPTIONS: readonly { value: Dialect; label: string }[] = VALID_DIALECTS.filter(
  (d) => d !== 'ansi'
).map((value) => ({
  value,
  label: DIALECT_LABELS[value],
}));

/** Type guard to check if a value is a valid Dialect. */
export function isValidDialect(value: unknown): value is Dialect {
  return typeof value === 'string' && VALID_DIALECTS.includes(value as Dialect);
}
