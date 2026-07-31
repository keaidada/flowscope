//! SQL fingerprinting: normalize SQL structure and compute a canonical hash.
//!
//! Normalization removes table names, column names, aliases, and literals,
//! preserving only the SQL structure (operations, functions, clauses).
//! Two scripts with the same fingerprint likely perform the same computation.

use sha2::{Digest, Sha256};

/// Result of fingerprinting a single file's analysis result.
#[derive(Debug, Clone)]
pub struct Fingerprint {
    pub file_path: String,
    pub canonical_hash: String,
    pub normalized_sql: String,
    pub structured_tokens: Vec<String>,
}

/// Fingerprint a single SQL string by normalizing its structure.
///
/// Normalization rules:
/// - Lowercase all keywords
/// - Replace table identifiers with `<T>`
/// - Replace column identifiers with `<COL>` (but keep aggregate function names)
/// - Replace string/number literals with `<LITERAL>`
/// - Collapse whitespace
pub fn fingerprint_sql(sql: &str) -> (String, String, Vec<String>) {
    let normalized = normalize_sql(sql);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    let tokens = extract_structured_tokens(&normalized);
    (hash, normalized, tokens)
}

/// Normalize SQL text to a canonical form for fingerprinting.
fn normalize_sql(sql: &str) -> String {
    let lower = sql.to_lowercase();
    let tokens = tokenize(&lower);
    let normalized = normalize_tokens(&tokens);
    normalized
}

/// Simple SQL tokenizer: split on whitespace and punctuation, keeping delimiters.
fn tokenize(sql: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in sql.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '.' {
            current.push(ch);
        } else {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            if !ch.is_whitespace() {
                tokens.push(ch.to_string());
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Keywords that precede table names.
const TABLE_KEYWORDS: &[&str] = &["from", "into", "join", "update", "table"];

/// SQL keywords that should be preserved (not replaced with <COL>).
const SQL_KEYWORDS: &[&str] = &[
    "select", "from", "where", "insert", "into", "update", "delete",
    "create", "drop", "alter", "join", "left", "right", "inner", "outer",
    "full", "cross", "on", "group", "by", "order", "having", "limit",
    "offset", "union", "intersect", "except", "with", "as", "distinct",
    "case", "when", "then", "else", "end", "and", "or", "not", "in",
    "exists", "between", "like", "is", "null", "true", "false",
    "asc", "desc", "all", "any", "values", "set", "merge", "using",
    "natural", "lateral", "window", "partition", "over", "rows", "range",
    "preceding", "following", "current", "row", "unbounded",
];

/// Aggregate/window function names to preserve.
const FUNC_NAMES: &[&str] = &[
    "sum", "count", "avg", "min", "max", "median", "stddev", "variance",
    "row_number", "rank", "dense_rank", "lag", "lead", "first_value",
    "last_value", "coalesce", "cast", "concat", "round", "abs",
    "date_diff", "date_add", "date_sub", "extract", "substring",
    "upper", "lower", "length", "trim", "replace",
    "ifnull", "nvl", "greatest", "least", "if", "datediff",
    "date_trunc", "to_char", "to_date", "now", "current_date",
];

fn normalize_tokens(tokens: &[String]) -> String {
    let mut result = Vec::with_capacity(tokens.len());
    let mut i = 0;

    while i < tokens.len() {
        let tok = &tokens[i];

        // String literal
        if tok == "'" || tok == "\"" || tok == "`" {
            // Skip until closing delimiter
            let delim = tok.as_str();
            result.push(if delim == "'" { "<literal>" } else { "<t>" }.to_string());
            i += 1;
            while i < tokens.len() && tokens[i] != delim {
                i += 1;
            }
            i += 1; // skip closing delimiter
            continue;
        }

        // Number
        if tok.chars().all(|c| c.is_ascii_digit() || c == '.') && !tok.is_empty() {
            result.push("<literal>".to_string());
            i += 1;
            continue;
        }

        // Check if previous token was a table keyword → this is a table name
        if i > 0 && TABLE_KEYWORDS.contains(&tokens[i - 1].as_str()) {
            // Skip schema prefix (e.g., "db.schema.table" → already one token due to '.' handling)
            result.push("<t>".to_string());
            i += 1;
            continue;
        }

        // SQL keyword → preserve
        if SQL_KEYWORDS.contains(&tok.as_str()) {
            result.push(tok.clone());
            i += 1;
            continue;
        }

        // Function name (identifier followed by '(') → preserve
        if i + 1 < tokens.len() && tokens[i + 1] == "(" {
            if FUNC_NAMES.contains(&tok.as_str()) {
                result.push(tok.clone());
            } else {
                result.push("<fn>".to_string());
            }
            i += 1;
            continue;
        }

        // Punctuation → preserve
        if tok.len() == 1 && !tok.chars().next().unwrap().is_alphanumeric() {
            result.push(tok.clone());
            i += 1;
            continue;
        }

        // Everything else → column identifier
        result.push("<col>".to_string());
        i += 1;
    }

    // Join with spaces, then collapse multiple spaces
    let joined = result.join(" ");
    let mut collapsed = String::with_capacity(joined.len());
    let mut prev_ws = false;
    for ch in joined.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                collapsed.push(' ');
            }
            prev_ws = true;
        } else {
            collapsed.push(ch);
            prev_ws = false;
        }
    }
    collapsed.trim().to_string()
}

/// Extract structured tokens (operations + functions) from normalized SQL.
/// Used for fuzzy similarity comparison.
fn extract_structured_tokens(normalized: &str) -> Vec<String> {
    let keywords = [
        "insert", "select", "update", "delete", "create", "drop", "alter",
        "from", "where", "join", "left", "right", "inner", "outer", "full",
        "cross", "on", "group by", "order by", "having", "limit", "offset",
        "union", "intersect", "except", "with", "as", "distinct",
        "case", "when", "then", "else", "end",
        "and", "or", "not", "in", "exists", "between", "like", "is",
        "<col>", "<literal>", "<t>",
    ];

    let funcs = [
        "sum", "count", "avg", "min", "max", "median", "stddev", "variance",
        "coalesce", "cast", "concat", "round", "abs",
        "date_diff", "date_add", "date_sub", "extract", "substring",
        "upper", "lower", "length", "trim", "replace",
        "row_number", "rank", "dense_rank", "lag", "lead",
        "first_value", "last_value", "ifnull", "nvl",
        "greatest", "least",
    ];

    let lower = normalized.to_lowercase();
    let mut tokens = Vec::new();

    for kw in &keywords {
        if lower.contains(kw) {
            tokens.push(kw.to_string());
        }
    }
    for func in &funcs {
        if lower.contains(func) {
            tokens.push(format!("fn:{func}"));
        }
    }

    tokens.sort();
    tokens.dedup();
    tokens
}

/// Compute Jaccard similarity between two sets of structured tokens.
pub fn jaccard_similarity(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let set_a: std::collections::HashSet<&String> = a.iter().collect();
    let set_b: std::collections::HashSet<&String> = b.iter().collect();
    let intersection = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();
    if union == 0 {
        return 0.0;
    }
    intersection as f64 / union as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fingerprint_identical_structure() {
        let sql_a = "INSERT INTO dws_gmv SELECT SUM(amount) FROM orders WHERE dt='2024-01-01'";
        let sql_b = "INSERT INTO dws_revenue SELECT SUM(pay_amount) FROM payments WHERE dt='2024-01-01'";
        let (hash_a, norm_a, _) = fingerprint_sql(sql_a);
        let (hash_b, norm_b, _) = fingerprint_sql(sql_b);
        assert_eq!(hash_a, hash_b, "Same structure should produce same hash");
        assert_eq!(norm_a, norm_b, "Normalized forms should be identical");
    }

    #[test]
    fn test_fingerprint_different_structure() {
        let sql_a = "SELECT SUM(amount) FROM orders";
        let sql_b = "SELECT COUNT(*) FROM orders GROUP BY region";
        let (hash_a, _, _) = fingerprint_sql(sql_a);
        let (hash_b, _, _) = fingerprint_sql(sql_b);
        assert_ne!(hash_a, hash_b, "Different structure should produce different hash");
    }

    #[test]
    fn test_jaccard_similarity() {
        let a = vec!["x".to_string(), "y".to_string(), "z".to_string()];
        let b = vec!["x".to_string(), "y".to_string(), "w".to_string()];
        let sim = jaccard_similarity(&a, &b);
        assert!((sim - 0.5).abs() < 0.01, "Jaccard should be 0.5");
    }

    #[test]
    fn test_normalize_literals() {
        let sql = "SELECT * FROM t WHERE x = 123 AND y = 'hello'";
        let (_, normalized, _) = fingerprint_sql(sql);
        assert!(normalized.contains("<literal>"), "Numbers should be normalized");
        assert!(!normalized.contains("123"), "Raw numbers should be removed");
        assert!(!normalized.contains("hello"), "String literals should be removed");
    }
}
