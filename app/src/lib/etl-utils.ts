/**
 * ETL utility functions: template variable quoting and PySpark SQL extraction.
 */

/**
 * Wraps bare `{var}` and `${var}` template variables in single quotes so the SQL
 * parser treats them as string literals. Already-quoted variables are left unchanged.
 *
 * @example
 *   quoteTemplateVars("WHERE dt = {date_id}")   // "WHERE dt = '{date_id}'"
 *   quoteTemplateVars("WHERE dt = '${DT}'")     // "WHERE dt = '${DT}'" (unchanged)
 */
export function quoteTemplateVars(sql: string): string {
  const lines = sql.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // Only process lines that contain unquoted {word} or ${word} patterns
    result.push(processLine(line));
  }

  return result.join('\n');
}

function processLine(line: string): string {
  // Step 1: Match {var} or ${var} where var is a simple identifier (word chars only)
  let result = line.replace(
    /(?<!')(\${)?\{([a-zA-Z_][a-zA-Z0-9_]*)}(?!')/g,
    (_match, dollar, name) => {
      if (dollar) {
        return `'$\{${name}}'`;
      }
      return `'{${name}}'`;
    }
  );

  // Step 2: Handle {expr} patterns that contain single quotes
  // e.g. {v_END.strftime('%Y-%m-%d')}   → '{v_END.strftime(''%Y-%m-%d'')}'
  // e.g. '{v_END.strftime('%Y-%m-%d')}' → '{v_END.strftime(''%Y-%m-%d'')}'
  result = result.replace(
    /('?)\{([^}]*'[^}]*)\}('?)/g,
    (_match, _openQuote, content) => {
      const escaped = content.replace(/'/g, "''");
      return `'{${escaped}}'`;
    }
  );

  return result;
}

/**
 * Extracts SQL statements from PySpark scripts.
 *
 * Handles these patterns:
 * - spark.sql(f"""...""")  — multi-line f-string SQL
 * - spark.sql("""...""")   — multi-line string SQL
 * - spark.sql("...")       — single-line SQL
 * - spark.sql(f"..." )     — single-line f-string SQL
 *
 * Returns an array of extracted SQL strings.
 */
export interface ExtractedSql {
  /** The extracted SQL text */
  sql: string;
  /** Line number in the original script where this SQL block starts (1-based) */
  startLine: number;
  /** Line number where this SQL block ends (1-based) */
  endLine: number;
}

export function extractSqlFromPySpark(script: string): ExtractedSql[] {
  const results: ExtractedSql[] = [];
  const lines = script.split('\n');

  // Match spark.sql(f""" or spark.sql(""" or spark.sql(f" or spark.sql(" anywhere in line
  const sqlStartRe = /spark\s*\.\s*sql\s*\(\s*(f)?\s*("""|")(.*)$/;
  let i = 0;

  while (i < lines.length) {
    const match = lines[i].match(sqlStartRe);
    if (!match) {
      i++;
      continue;
    }

    const isTriple = match[2] === '"""';
    const startLine = i + 1; // 1-based

    if (isTriple) {
      // Multi-line SQL: collect until we find the closing """
      const sqlLines: string[] = [match[3]]; // content after opening """

      i++;
      while (i < lines.length) {
        const closeIdx = lines[i].indexOf('"""');
        if (closeIdx !== -1) {
          // Found closing """
          sqlLines.push(lines[i].substring(0, closeIdx));
          i++; // move past this line
          break;
        }
        sqlLines.push(lines[i]);
        i++;
      }

      const sql = dedentSql(sqlLines);
      if (sql) {
        results.push({ sql: ensureSemicolon(sql), startLine, endLine: i });
      }
    } else {
      // Single-line SQL: find closing "
      const afterQuote = match[3];
      const closeIdx = afterQuote.lastIndexOf('"');
      if (closeIdx !== -1) {
        const sql = afterQuote.substring(0, closeIdx).trim();
        if (sql) {
          results.push({ sql: ensureSemicolon(sql), startLine, endLine: startLine });
        }
      }
      i++;
    }
  }

  return results;
}

/** Strip common leading whitespace from SQL lines, then trim. */
function dedentSql(lines: string[]): string {
  // Find the minimum indentation of non-empty lines
  let minIndent = Infinity;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) minIndent = indent;
  }

  if (minIndent === Infinity || minIndent === 0) {
    return lines.join('\n').trim();
  }

  // Strip common indent from each line
  const dedented = lines.map((l) => {
    if (l.trimEnd().length === 0) return '';
    return l.slice(minIndent);
  });

  return dedented.join('\n').trim();
}

/** Ensure SQL text ends with a semicolon. */
function ensureSemicolon(sql: string): string {
  const trimmed = sql.trimEnd();
  if (trimmed.endsWith(';')) return trimmed;
  return trimmed + ';';
}

/**
 * Combined ETL processing: extract SQL from PySpark script, then quote template vars.
 *
 * If the input looks like a PySpark script (contains `spark.sql(`),
 * extracts all SQL blocks, quotes variables in each, and returns them joined.
 * Otherwise, just quotes template vars in the input.
 */
export function processEtl(input: string): string {
  if (input.includes('spark.sql(')) {
    const extracted = extractSqlFromPySpark(input);
    if (extracted.length > 0) {
      return extracted
        .map((e) => {
          let sql = e.sql;
          // Remove Python f-string escapes: {{ → {
          sql = sql.replace(/\{\{/g, '{');
          sql = sql.replace(/\}\}/g, '}');
          return quoteTemplateVars(sql);
        })
        .join('\n\n');
    }
  }

  return quoteTemplateVars(input);
}

/**
 * Returns a summary of the ETL processing result.
 */
export function getEtlSummary(input: string, output: string): string {
  const changes: string[] = [];

  const varCount = (output.match(/'\{[a-zA-Z_][a-zA-Z0-9_]*\}'/g) || []).length;
  if (varCount > 0) {
    changes.push(`${varCount} 个模板变量已加引号`);
  }

  if (input.includes('spark.sql(')) {
    const extracted = extractSqlFromPySpark(input);
    if (extracted.length > 0) {
      changes.push(`从 PySpark 脚本提取了 ${extracted.length} 条 SQL`);
    }
  }

  return changes.length > 0 ? changes.join('，') : '无需处理';
}

/** A segment of text within a merged line for inline diff highlighting. */
export interface DiffSegment {
  text: string;
  /** Whether this segment differs from the original */
  highlight: boolean;
}

/**
 * A line in the merged ETL output view.
 */
export interface MergedLine {
  /** 1-based line number in the merged view */
  lineNum: number;
  /** Whether this line was removed (true) or kept/processed (false) */
  removed: boolean;
  /** The content: original for removed lines, processed for kept lines */
  content: string;
  /** Inline diff segments for highlighting changed portions (kept lines only) */
  segments: DiffSegment[];
  /** Whether the kept line differs from the corresponding original */
  changed: boolean;
  /** Whether this is a new line added in the output (not present in input) */
  added: boolean;
  /** The ETL-processed content before any manual edits. Used to diff user changes. */
  originalContent: string;
}

/** Compare two strings, return segments with 'highlight' marking differing portions. */
export function inlineDiff(original: string, processed: string): DiffSegment[] {
  if (original === processed) {
    return [{ text: processed, highlight: false }];
  }

  const segments: DiffSegment[] = [];

  // Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(original.length, processed.length);
  while (prefixLen < minLen && original[prefixLen] === processed[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (remaining after prefix)
  let suffixLen = 0;
  while (suffixLen < minLen - prefixLen &&
         original[original.length - 1 - suffixLen] === processed[processed.length - 1 - suffixLen]) {
    suffixLen++;
  }

  if (prefixLen > 0) {
    segments.push({ text: processed.substring(0, prefixLen), highlight: false });
  }

  const changedStart = prefixLen;
  const changedLen = processed.length - suffixLen - prefixLen;
  if (changedLen > 0) {
    segments.push({ text: processed.substring(changedStart, changedStart + changedLen), highlight: true });
  }

  if (suffixLen > 0) {
    segments.push({ text: processed.substring(processed.length - suffixLen), highlight: false });
  }

  return segments;
}

/**
 * Merge input and output line-by-line for inline display.
 * Removed lines appear at their original positions with strikethrough,
 * processed lines appear at their corresponding positions.
 */
export function mergeLines(input: string, output: string): MergedLine[] {
  if (input.includes('spark.sql(')) {
    return mergePySparkLines(input, output);
  }
  return mergeDirectLines(input, output);
}

function mergePySparkLines(input: string, output: string): MergedLine[] {
  const extracted = extractSqlFromPySpark(input);
  const inputLines = input.split('\n');
  const result: MergedLine[] = [];

  if (extracted.length === 0) {
    return mergeDirectLines(input, output);
  }

  // The output is processed SQL blocks separated by "\n\n". Each block ends with ";".
  const outputBlocks = output.split(/\n\n+/);
  const cleanedBlocks = outputBlocks.map((b) => b.trim());

  // Walk through all input lines, interleaving Python lines and SQL blocks
  let blockIdx = 0;
  let i = 0;

  while (i < inputLines.length) {
    const lineNum = i + 1;

    // Check if we're at the start of a SQL block
    if (blockIdx < extracted.length && lineNum >= extracted[blockIdx].startLine) {
      const block = extracted[blockIdx];
      const processed = cleanedBlocks[blockIdx] ?? '';

      // Add the spark.sql(...) opening line as removed (always, even if empty)
      result.push({ lineNum: result.length + 1, removed: true, changed: false, added: false, content: inputLines[block.startLine - 1], segments: [], originalContent: inputLines[block.startLine - 1] });

      // Add processed SQL lines
      const processedLines = processed.split('\n');
      for (const pl of processedLines) {
        result.push({ lineNum: result.length + 1, removed: false, changed: true, added: true, content: pl, segments: [{ text: pl, highlight: true }], originalContent: pl });
      }

      // Skip past this SQL block in input
      i = block.endLine;
      blockIdx++;
      continue;
    }

    // Non-SQL line: always include (empty lines too, to match left textarea)
    result.push({ lineNum: result.length + 1, removed: true, changed: false, added: false, content: inputLines[i], segments: [], originalContent: inputLines[i] });
    i++;
  }

  return result;
}

function mergeDirectLines(input: string, output: string): MergedLine[] {
  const inputLines = input.split('\n');
  const outputLines = output.split('\n');
  const result: MergedLine[] = [];
  const maxLen = Math.max(inputLines.length, outputLines.length);

  for (let i = 0; i < maxLen; i++) {
    const inLine = inputLines[i] ?? '';
    const outLine = outputLines[i] ?? '';

    // If both are same, show as unchanged kept line
    if (inLine === outLine) {
      result.push({ lineNum: result.length + 1, removed: false, changed: false, added: false, content: outLine, segments: [{ text: outLine, highlight: false }], originalContent: outLine });
      continue;
    }

    // Different: show original as removed, then processed as changed
    // When output has a line not present in input, mark as added
    result.push({ lineNum: result.length + 1, removed: true, changed: false, added: false, content: inLine, segments: [], originalContent: inLine });
    result.push({ lineNum: result.length + 1, removed: false, changed: true, added: inLine === '', content: outLine, segments: inlineDiff(inLine, outLine), originalContent: outLine });
  }

  return result;
}
