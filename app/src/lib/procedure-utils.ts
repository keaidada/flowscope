/**
 * BigQuery stored procedure to DML conversion utilities.
 *
 * Strategy: LINE-LEVEL filtering (not statement extraction).
 * Walks the procedure line by line, removes control-flow/declaration lines,
 * and unwraps EXECUTE IMMEDIATE blocks to show the inner SQL.
 */

/** Lines starting with these keywords (uppercased) are removed */
const REMOVE_PREFIXES = [
  'DECLARE',
  'SET ',
  'BEGIN',
  'END;',
  'END IF',
  'END LOOP',
  'END WHILE',
  'IF ',
  'IF(',
  'ELSEIF',
  'WHILE',
  'LOOP',
  'FOR ',
  'BREAK',
  'LEAVE',
  'CONTINUE',
  'RETURN',
  'RAISE',
  'EXCEPTION',
  'CALL ',
  'ASSERT',
];

/** Check if a line should be removed (control flow / declaration) */
function shouldRemoveLine(line: string): boolean {
  const trimmed = line.trim().toUpperCase();
  if (!trimmed) return false; // keep blank lines
  if (trimmed.startsWith('CREATE PROCEDURE') || trimmed.startsWith('CREATE OR REPLACE PROCEDURE')) return true;
  return REMOVE_PREFIXES.some((p) => trimmed.startsWith(p));
}

// Removed: replaceFormatPlaceholders — only %t replacement is needed, done inline

/**
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '%' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === '%') { out += '%'; i += 2; continue; }
      if ('diuoxX'.includes(next)) { out += '0'; i += 2; continue; }
      if (next === 's' || next === 'S' || next === 'c') { out += 'x'; i += 2; continue; }
      if ('feEgG'.includes(next)) { out += '0.0'; i += 2; continue; }
      if (next === 't' || next === 'T') { out += "'2024-01-01'"; i += 2; continue; }
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * Transform a BigQuery stored procedure into DML by line-level filtering.
 *
 * 1. Remove DECLARE/SET/BEGIN/END/IF/THEN/ELSE/comments
 * 2. Unwrap EXECUTE IMMEDIATE FORMAT("""...""") → inner SQL
 * 3. Unwrap EXECUTE IMMEDIATE """...""" → inner SQL
 * 4. Skip EXECUTE IMMEDIATE 'DROP TABLE...' (single-quote, one-liners)
 * 5. Keep everything else (CREATE TABLE AS SELECT, SELECT, INSERT, etc.)
 *
 * Returns the filtered content, or null if no DML found.
 */
export function extractBqDml(content: string): string | null {
  try {
    const lines = content.split('\n');
    const result: string[] = [];
    let inTripleQuote = false; // inside """ or ''' block
    let tripleChar = '';
    let skipExecuteImmediate = false; // EXECUTE IMMEDIATE '...' (single-line DROP etc)
    let inBlockComment = false; // inside /* ... */ block comment

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const trimmed = line.trim();
      const upper = trimmed.toUpperCase();

      // ── Handle multi-line block comments /* ... */ ──
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue; // skip entire line
      }
      // Single-line block comment: /* ... */
      if (trimmed.startsWith('/*') && trimmed.includes('*/')) continue;
      // Start of multi-line block comment
      if (trimmed.startsWith('/*') || trimmed.includes('/*')) {
        // Check if it closes on the same line
        const afterOpen = trimmed.slice(trimmed.indexOf('/*') + 2);
        if (!afterOpen.includes('*/')) {
          inBlockComment = true;
        }
        continue;
      }

      // ── Handle triple-quoted blocks (EXECUTE IMMEDIATE FORMAT("""...""")) ──
      if (inTripleQuote) {
        // Check if this line ends the triple quote
        const endIdx = line.indexOf(tripleChar);
        if (endIdx >= 0) {
          // End of triple-quoted block
          const beforeEnd = line.slice(0, endIdx);
          if (beforeEnd.trim()) result.push(beforeEnd);
          inTripleQuote = false;
          tripleChar = '';
          skipExecuteImmediate = false;
        } else {
          // Still inside triple-quoted block — this is SQL content
          if (!skipExecuteImmediate) {
            result.push(line);
          }
        }
        continue;
      }

      // ── Detect start of EXECUTE IMMEDIATE FORMAT(""" or """ ──
      if (upper.includes('EXECUTE IMMEDIATE')) {
        // Check for triple-quote start
        const dqIdx = line.indexOf('"""');
        const sqIdx = line.indexOf("'''");

        if (dqIdx >= 0 || sqIdx >= 0) {
          const quoteChar = dqIdx >= 0 ? '"""' : "'''";
          const afterQuote = line.slice(line.indexOf(quoteChar) + 3);

          // Check if it closes on the same line
          const closeIdx = afterQuote.indexOf(quoteChar);
          if (closeIdx >= 0) {
            // Single-line triple-quoted EXECUTE IMMEDIATE
            const sql = afterQuote.slice(0, closeIdx);
            if (sql.trim() && !sql.toUpperCase().trimStart().startsWith('DROP')) {
              result.push(sql);
            }
          } else {
            // Multi-line triple-quoted block starts here
            inTripleQuote = true;
            tripleChar = quoteChar;
            skipExecuteImmediate = false;
            // If there's content after the opening """, add it
            if (afterQuote.trim()) {
              result.push(afterQuote);
            }
          }
          continue;
        }

        // Single-quoted EXECUTE IMMEDIATE '...' (usually DROP TABLE)
        const singleQIdx = trimmed.indexOf("'");
        if (singleQIdx >= 0) {
          // Skip this line (DROP TABLE, etc.)
          continue;
        }

        // EXECUTE IMMEDIATE without quotes (variable reference) — skip
        continue;
      }

      // ── Normal line: check if it should be removed ──
      if (shouldRemoveLine(line)) {
        continue;
      }

      // ── Keep the line ──
      result.push(line);
    }

    // NOTE: We do NOT replace FORMAT placeholders inside SQL content.
    // The %t/%d in FORMAT_TIMESTAMP etc. are NOT FORMAT placeholders.
    // The original FORMAT() call handles them at runtime; for display we
    // leave them as-is, matching the folder import behavior.

    const finalText = result.join('\n').trim();

    if (!finalText) return null;

    // Check if there's any actual SQL content
    const hasSql = finalText.toUpperCase().includes('SELECT') ||
      finalText.toUpperCase().includes('INSERT') ||
      finalText.toUpperCase().includes('CREATE TABLE') ||
      finalText.toUpperCase().includes('MERGE') ||
      finalText.toUpperCase().includes('DELETE') ||
      finalText.toUpperCase().includes('UPDATE');

    if (!hasSql) return null;

    // Replace %t (FORMAT date placeholder) with a dummy date.
    // Only %t — not %d/%s/etc which conflict with FORMAT_TIMESTAMP patterns.
    return finalText.replace(/%t/gi, "'2024-01-01'");
  } catch {
    return null;
  }
}

// Re-export for compatibility
export { extractBqDml as extractDmlFromProcedure };
