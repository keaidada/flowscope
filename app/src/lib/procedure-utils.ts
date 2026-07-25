/**
 * BigQuery stored procedure to DML conversion utilities.
 *
 * Extracts DML/SELECT statements from CREATE PROCEDURE ... BEGIN ... END bodies,
 * including SQL from EXECUTE IMMEDIATE and SET variable patterns.
 *
 * Other dialect conversions can be added here as separate functions.
 */

const DML_KEYWORDS = [
  'SELECT', 'INSERT', 'DELETE', 'MERGE', 'UPDATE',
  'TRUNCATE', 'WITH', 'CREATE', 'EXPLAIN',
] as const;

const isDml = (s: string): boolean =>
  DML_KEYWORDS.some((k) => s.toUpperCase().trimStart().startsWith(k));

/** Check if a string looks like a complete SQL statement (not just a description mentioning DML keywords) */
const isSqlStatement = (s: string): boolean => {
  const upper = s.toUpperCase().trimStart();
  if (upper.startsWith('INSERT')) return /\bINTO\b/.test(upper);
  if (upper.startsWith('SELECT')) return true; // SELECT can have various forms
  if (upper.startsWith('DELETE')) return /\bFROM\b/.test(upper);
  if (upper.startsWith('UPDATE')) return /\bSET\b/.test(upper);
  if (upper.startsWith('MERGE')) return /\bUSING\b/.test(upper);
  return true; // CREATE, TRUNCATE, WITH, EXPLAIN are accepted as-is
};

/** Split procedure body into statements, handling nested BEGIN/END and strings */
function splitProcedureStatements(body: string): string[] {
  const results: string[] = [];
  let current = '';
  let i = 0;

  while (i < body.length) {
    const ch = body[i];

    // Track quoted strings to avoid splitting inside them
    if (ch === "'" || ch === '"' || (ch === '`' && body.slice(i, i + 3) !== '```')) {
      const quote = ch;
      current += ch;
      i++;
      while (i < body.length && body[i] !== quote) {
        if (body[i] === '\\') { current += body[i]; i++; }
        current += body[i];
        i++;
      }
      if (i < body.length) { current += body[i]; i++; }
      continue;
    }

    // Triple-quoted strings (""" or ''')
    if ((ch === '"' || ch === "'") && body.slice(i + 1, i + 3) === ch + ch) {
      const triple = body.slice(i, i + 3);
      current += triple;
      i += 3;
      while (i < body.length && body.slice(i, i + 3) !== triple) {
        current += body[i];
        i++;
      }
      if (i < body.length) { current += body.slice(i, i + 3); i += 3; }
      continue;
    }

    // Split at semicolons (simple, matching Rust sanitizer behavior)
    if (ch === ';') {
      results.push(current);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim()) results.push(current);
  return results;
}

/** Extract SQL from EXECUTE IMMEDIATE FORMAT("""...""") / EXECUTE IMMEDIATE """...""" / EXECUTE IMMEDIATE '...' */
function extractExecuteImmediateSql(s: string): string | null {
  const upper = s.toUpperCase().trimStart();
  if (!upper.startsWith('EXECUTE IMMEDIATE')) return null;

  const keywordEnd = s.toUpperCase().indexOf('IMMEDIATE');
  const afterKeyword = s.slice(keywordEnd + 9).trimStart();
  if (!afterKeyword) return null;

  // Case: FORMAT("""...""", ...) or FORMAT('...', ...)
  if (afterKeyword.toUpperCase().startsWith('FORMAT')) {
    const afterFormat = afterKeyword.slice(6).trimStart();
    const afterParen = afterFormat.startsWith('(') ? afterFormat.slice(1).trimStart() : afterFormat;
    const sql = extractFromQuotes(afterParen);
    if (!sql) return null;
    return replaceFormatPlaceholders(sql);
  }

  // Case: direct triple-quoted or single-quoted string
  return extractFromQuotes(afterKeyword);
}

/** Extract SQL from SET var = FORMAT("""...""") / SET var = '...' */
function extractSetStmtSql(s: string): string | null {
  const upper = s.toUpperCase().trimStart();
  if (!upper.startsWith('SET ')) return null;

  const eqPos = s.indexOf('=');
  if (eqPos < 0) return null;
  const afterEq = s.slice(eqPos + 1).trimStart();
  if (!afterEq) return null;

  // SET var = FORMAT("""...""", ...)
  if (afterEq.toUpperCase().startsWith('FORMAT')) {
    const afterFormat = afterEq.slice(6).trimStart();
    const afterParen = afterFormat.startsWith('(') ? afterFormat.slice(1).trimStart() : afterFormat;
    const sql = extractFromQuotes(afterParen);
    if (!sql) return null;
    return replaceFormatPlaceholders(sql);
  }

  // SET var = CONCAT(...) — skip
  if (afterEq.toUpperCase().startsWith('CONCAT')) return null;

  // SET var = '...' or SET var = "..."
  const ch = afterEq[0];
  if (ch !== "'" && ch !== '"') return null;

  let end = 1;
  while (end < afterEq.length && afterEq[end] !== ch) {
    if (afterEq[end] === '\\') end++;
    end++;
  }
  if (end >= afterEq.length) return null;
  return afterEq.slice(1, end);
}

/** Extract content from quoted string (supports triple-quoted and single-quoted) */
function extractFromQuotes(s: string): string | null {
  if (!s) return null;

  // Triple-quoted: """...""" or '''...'''
  if (
    (s[0] === '"' && s[1] === '"' && s[2] === '"') ||
    (s[0] === "'" && s[1] === "'" && s[2] === "'")
  ) {
    const triple = s.slice(0, 3);
    let end = 3;
    while (end < s.length && s.slice(end, end + 3) !== triple) end++;
    if (end >= s.length) return null;
    return s.slice(3, end);
  }

  // Single-quoted: "..." or '...'
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    let end = 1;
    while (end < s.length && s[end] !== q) {
      if (s[end] === '\\') end++;
      end++;
    }
    if (end >= s.length) return null;
    return s.slice(1, end);
  }

  return null;
}

/** Replace FORMAT placeholders with dummy values for SQL parsing */
function replaceFormatPlaceholders(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '%' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '%') { out += '%'; i += 2; continue; }
      if ('diuoxX'.includes(next)) { out += '0'; i += 2; continue; }
      if (next === 's' || next === 'S' || next === 'c') { out += 'x'; i += 2; continue; }
      if ('feEgG'.includes(next)) { out += '0.0'; i += 2; continue; }
      if (next === 't' || next === 'T') { out += '2024-01-01'; i += 2; continue; }
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * Extract DML/SELECT from a BigQuery stored procedure body.
 * Returns the concatenated DML statements, or null if none found.
 */
export function extractBqDml(content: string): string | null {
  try {
    const upper = content.toUpperCase();
    const beginIdx = upper.indexOf('BEGIN');
    const endIdx = upper.lastIndexOf('END');
    if (beginIdx < 0 || endIdx <= beginIdx) return null;

    const body = content.slice(beginIdx + 5, endIdx);
    const uncommented = body
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();

    const rawStmts = splitProcedureStatements(uncommented);
    const results: string[] = [];

    for (const stmt of rawStmts) {
      let s = stmt.trim();
      if (!s) continue;

      if (isDml(s) && isSqlStatement(s)) { results.push(s); continue; }

      const execSql = extractExecuteImmediateSql(s);
      if (execSql && isDml(execSql) && isSqlStatement(execSql)) { results.push(execSql); continue; }

      const setSql = extractSetStmtSql(s);
      if (setSql && isDml(setSql) && isSqlStatement(setSql)) { results.push(setSql); continue; }

      // Handle nested BEGIN blocks: strip leading keywords and retry
      let remainder = s;
      while (true) {
        const upper2 = remainder.toUpperCase().trimStart();
        const prefix = upper2.split(/\s+/)[0];
        if (prefix === 'BEGIN' || prefix === 'IF' || prefix === 'WHILE' || prefix === 'LOOP' || prefix === 'ELSE' || prefix === 'THEN') {
          const idx = upper2.indexOf(prefix);
          remainder = remainder.slice(idx + prefix.length).trimStart();
          // Try EXECUTE IMMEDIATE on remainder
          const innerExec = extractExecuteImmediateSql(remainder);
          if (innerExec && isDml(innerExec) && isSqlStatement(innerExec)) { results.push(innerExec); break; }
          const innerSet = extractSetStmtSql(remainder);
          if (innerSet && isDml(innerSet) && isSqlStatement(innerSet)) { results.push(innerSet); break; }
          if (isDml(remainder) && isSqlStatement(remainder)) { results.push(remainder); break; }
          continue;
        }
        break;
      }
    }

    return results.length > 0 ? results.join(';\n') : null;
  } catch {
    return null;
  }
}
