import type { StoredSchemaFile } from './schema-storage';

export interface ScopedSchemaMatch {
  schemaSQL: string;
  referencedTables: string[];
  matchedTables: string[];
  matchedBlockCount: number;
}

const TABLE_REFERENCE_PATTERNS = [
  /\bFROM\s+([`"[\]\w.$-]+)/gi,
  /\bJOIN\s+([`"[\]\w.$-]+)/gi,
  /\bUPDATE\s+([`"[\]\w.$-]+)/gi,
  /\bINSERT\s+(?:INTO|OVERWRITE\s+TABLE)\s+([`"[\]\w.$-]+)/gi,
  /\bMERGE\s+INTO\s+([`"[\]\w.$-]+)/gi,
  /\bUSING\s+([`"[\]\w.$-]+)/gi,
  /\bDELETE\s+FROM\s+([`"[\]\w.$-]+)/gi,
  /\bTRUNCATE\s+TABLE\s+([`"[\]\w.$-]+)/gi,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+|TEMP\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.$-]+)/gi,
] as const;

const CTE_NAME_PATTERN = /(?:\bWITH\b|,)\s*([`"[\]\w.$-]+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi;

const CREATE_OBJECT_PATTERN =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:EXTERNAL\s+)?(?:TEMPORARY\s+|TEMP\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.$-]+)/gi;

function normalizeIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[`"'[]+/, '')
    .replace(/[`"'\]]+$/, '')
    .replace(/[;,]+$/, '')
    .toLowerCase();
}

function addIdentifierVariants(target: Set<string>, rawValue: string): void {
  const normalized = normalizeIdentifier(rawValue);
  if (!normalized) return;

  target.add(normalized);

  const parts = normalized.split('.').filter(Boolean);
  if (parts.length > 0) {
    target.add(parts[parts.length - 1]);
  }
  if (parts.length > 1) {
    target.add(parts.slice(-2).join('.'));
  }
  if (parts.length > 2) {
    target.add(parts.slice(-3).join('.'));
  }
}

function collectCteNames(sql: string): Set<string> {
  const cteNames = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = CTE_NAME_PATTERN.exec(sql)) !== null) {
    addIdentifierVariants(cteNames, match[1]);
  }

  return cteNames;
}

export function extractReferencedTableNamesFromSql(sql: string): string[] {
  const tableNames = new Set<string>();
  const cteNames = collectCteNames(sql);

  for (const pattern of TABLE_REFERENCE_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) {
      const identifier = normalizeIdentifier(match[1]);
      if (!identifier || cteNames.has(identifier)) {
        continue;
      }
      addIdentifierVariants(tableNames, identifier);
    }
  }

  return Array.from(tableNames).sort();
}

export function extractReferencedTableNamesFromFiles(
  files: Array<{ name: string; content: string }>
): string[] {
  const tableNames = new Set<string>();

  for (const file of files) {
    for (const tableName of extractReferencedTableNamesFromSql(file.content)) {
      tableNames.add(tableName);
    }
  }

  return Array.from(tableNames).sort();
}

function findStatementEnd(content: string, startIndex: number): number {
  let depth = 0;
  let foundOpenParen = false;

  for (let index = startIndex; index < content.length; index++) {
    const char = content[index];

    if (char === '(') {
      depth += 1;
      foundOpenParen = true;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === ';' && foundOpenParen && depth === 0) {
      return index + 1;
    }

    if (
      index > startIndex + 10 &&
      foundOpenParen &&
      depth === 0 &&
      content.slice(index, index + 6).toUpperCase() === 'CREATE'
    ) {
      return index;
    }
  }

  return content.length;
}

export function buildScopedSchemaSQL(
  schemaFiles: StoredSchemaFile[],
  analyzedFiles: Array<{ name: string; content: string }>
): ScopedSchemaMatch {
  return buildScopedSchemaSQLForTableNames(
    schemaFiles,
    extractReferencedTableNamesFromFiles(analyzedFiles)
  );
}

export function buildScopedSchemaSQLForTableNames(
  schemaFiles: StoredSchemaFile[],
  referencedTableNames: string[]
): ScopedSchemaMatch {
  const referencedTableSet = new Set(
    referencedTableNames.map((tableName) => normalizeIdentifier(tableName))
  );
  const matchedTableSet = new Set<string>();
  const matchedBlocks: string[] = [];
  const emittedBlocks = new Set<string>();

  if (referencedTableSet.size === 0) {
    return {
      schemaSQL: '',
      referencedTables: [],
      matchedTables: [],
      matchedBlockCount: 0,
    };
  }

  for (const schemaFile of schemaFiles) {
    let match: RegExpExecArray | null;
    while ((match = CREATE_OBJECT_PATTERN.exec(schemaFile.content)) !== null) {
      const normalizedTableName = normalizeIdentifier(match[1]);
      if (!normalizedTableName) continue;

      const shortName = normalizedTableName.split('.').pop() || normalizedTableName;
      const schemaQualifiedName =
        normalizedTableName.split('.').length > 1
          ? normalizedTableName.split('.').slice(-2).join('.')
          : normalizedTableName;
      const shouldInclude =
        referencedTableSet.has(normalizedTableName) ||
        referencedTableSet.has(shortName) ||
        referencedTableSet.has(schemaQualifiedName);

      if (!shouldInclude) {
        continue;
      }

      const blockStart = match.index;
      const blockEnd = findStatementEnd(schemaFile.content, blockStart);
      const block = schemaFile.content.slice(blockStart, blockEnd).trim().replace(/;+$/, '');
      if (!block || emittedBlocks.has(block)) {
        continue;
      }

      emittedBlocks.add(block);
      matchedBlocks.push(`-- File: ${schemaFile.path}\n${block};`);
      matchedTableSet.add(normalizedTableName);
    }
  }

  return {
    schemaSQL: matchedBlocks.join('\n\n'),
    referencedTables: Array.from(referencedTableSet).sort(),
    matchedTables: Array.from(matchedTableSet).sort(),
    matchedBlockCount: matchedBlocks.length,
  };
}
