//! AI assistant: proxy chat requests to DeepSeek / Ollama with SSE streaming.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// AI configuration for a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider: String,   // "deepseek" | "ollama"
    pub api_key: String,
    pub model: String,
    pub endpoint: String,
    pub system_prompt: String,
    pub temperature: f64,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "deepseek".into(),
            api_key: String::new(),
            model: "deepseek-chat".into(),
            endpoint: "https://api.deepseek.com".into(),
            system_prompt: "你是一个 SQL 血缘分析和数据治理助手。帮助用户理解 SQL 脚本的血缘关系、表和字段的来源，提供 SQL 解释和优化建议。".into(),
            temperature: 0.7,
        }
    }
}

/// Load the active model pointer from the legacy `ai_config` table.
/// Returns (provider, model).
fn get_active_model(conn: &Connection, project_id: &str) -> (String, String) {
    let row = conn
        .query_row(
            "SELECT provider, model FROM ai_config WHERE project_id = ?1 AND status = 1",
            params![project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );
    row.unwrap_or_else(|_| {
        let d = AiConfig::default();
        (d.provider, d.model)
    })
}

/// Load the active model's full config.
pub fn get_ai_config(conn: &Connection, project_id: &str) -> AiConfig {
    let (provider, model) = get_active_model(conn, project_id);
    get_model_config(conn, project_id, &provider, &model)
        .unwrap_or_else(|| AiConfig { provider, model, ..AiConfig::default() })
}

/// Load a specific model's config (or None if never configured).
pub fn get_model_config(
    conn: &Connection,
    project_id: &str,
    provider: &str,
    model: &str,
) -> Option<AiConfig> {
    conn.query_row(
        "SELECT provider, api_key, model, endpoint, system_prompt, temperature
         FROM ai_model_config WHERE project_id = ?1 AND provider = ?2 AND model = ?3",
        params![project_id, provider, model],
        |row| {
            Ok(AiConfig {
                provider: row.get(0)?,
                api_key: row.get(1)?,
                model: row.get(2)?,
                endpoint: row.get(3)?,
                system_prompt: row.get(4)?,
                temperature: row.get(5)?,
            })
        },
    )
    .ok()
}

/// List all configured models for a project (each with its own config).
pub fn list_model_configs(conn: &Connection, project_id: &str) -> Vec<AiConfig> {
    let mut stmt = match conn.prepare(
        "SELECT provider, api_key, model, endpoint, system_prompt, temperature
         FROM ai_model_config WHERE project_id = ?1",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map(params![project_id], |row| {
        Ok(AiConfig {
            provider: row.get(0)?,
            api_key: row.get(1)?,
            model: row.get(2)?,
            endpoint: row.get(3)?,
            system_prompt: row.get(4)?,
            temperature: row.get(5)?,
        })
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.filter_map(Result::ok).collect()
}

/// Save a specific model's config (upsert on project_id + provider + model).
pub fn save_model_config(
    conn: &Connection,
    project_id: &str,
    cfg: &AiConfig,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    conn.execute(
        "INSERT INTO ai_model_config (project_id, provider, api_key, model, endpoint, system_prompt, temperature, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(project_id, provider, model) DO UPDATE SET
            api_key = excluded.api_key,
            endpoint = excluded.endpoint,
            system_prompt = excluded.system_prompt,
            temperature = excluded.temperature,
            updated_at = excluded.updated_at",
        params![
            project_id,
            cfg.provider,
            cfg.api_key,
            cfg.model,
            cfg.endpoint,
            cfg.system_prompt,
            cfg.temperature,
            now,
        ],
    )?;
    Ok(())
}

/// Set which model is active (pointer stored in the legacy `ai_config` table).
pub fn set_active_model(
    conn: &Connection,
    project_id: &str,
    provider: &str,
    model: &str,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    conn.execute(
        "INSERT INTO ai_config (project_id, provider, model, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)
         ON CONFLICT(project_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            updated_at = excluded.updated_at",
        params![project_id, provider, model, now],
    )?;
    Ok(())
}

/// Save AI config (upsert). Kept for backward compat: also makes the model active.
pub fn save_ai_config(
    conn: &Connection,
    project_id: &str,
    cfg: &AiConfig,
) -> Result<(), rusqlite::Error> {
    save_model_config(conn, project_id, cfg)?;
    set_active_model(conn, project_id, &cfg.provider, &cfg.model)
}

// ── Chat types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,    // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub project_id: String,
    pub messages: Vec<ChatMessage>,
    /// Optional context to inject into the system prompt.
    pub context: Option<ChatContext>,
}

#[derive(Debug, Deserialize)]
pub struct ChatContext {
    pub file_path: Option<String>,
    pub sql: Option<String>,
    pub lineage_summary: Option<String>,
}

/// Build the messages array to send to the LLM, injecting context into
/// the system prompt.
pub fn build_llm_messages(cfg: &AiConfig, messages: &[ChatMessage], ctx: &Option<ChatContext>) -> Vec<ChatMessage> {
    let mut sys = cfg.system_prompt.clone();
    if let Some(ctx) = ctx {
        if let Some(ref fp) = ctx.file_path {
            sys.push_str(&format!("\n\n当前打开的脚本: {fp}"));
        }
        if let Some(ref sql) = ctx.sql {
            // Truncate very long SQL to ~4000 chars (char-safe for UTF-8).
            let truncated = if sql.chars().count() > 4000 {
                sql.chars().take(4000).collect::<String>()
            } else {
                sql.clone()
            };
            sys.push_str(&format!("\n\n脚本 SQL 内容:\n```sql\n{truncated}\n```"));
        }
        if let Some(ref lin) = ctx.lineage_summary {
            sys.push_str(&format!("\n\n血缘摘要:\n{lin}"));
        }
    }

    let mut result = vec![ChatMessage { role: "system".into(), content: sys }];
    result.extend(messages.iter().cloned());
    result
}

/// Build the HTTP request URL for the LLM provider.
pub fn provider_chat_url(cfg: &AiConfig) -> String {
    match cfg.provider.as_str() {
        "ollama" => {
            // Ollama OpenAI-compatible endpoint
            let base = cfg.endpoint.trim_end_matches('/');
            format!("{base}/v1/chat/completions")
        }
        _ => {
            // DeepSeek (OpenAI-compatible)
            let base = cfg.endpoint.trim_end_matches('/');
            format!("{base}/chat/completions")
        }
    }
}

/// Build the authorization header value.
pub fn auth_header(cfg: &AiConfig) -> Option<String> {
    if cfg.api_key.is_empty() {
        None
    } else {
        Some(format!("Bearer {}", cfg.api_key))
    }
}

/// JSON body for the chat completions request (OpenAI-compatible format).
#[derive(Debug, Serialize)]
pub struct LlmRequestBody {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    pub temperature: f64,
}

pub fn build_request_body(cfg: &AiConfig, messages: Vec<ChatMessage>) -> LlmRequestBody {
    LlmRequestBody {
        model: cfg.model.clone(),
        messages,
        stream: true,
        temperature: cfg.temperature,
    }
}

/// Parse one SSE line from the LLM response to extract content delta.
/// Returns Some(content) if there's a text delta, None if it's a control
/// message (role, finish_reason, usage, etc.).
pub fn parse_sse_delta(line: &str) -> Option<String> {
    // Lines look like: data: {"choices":[{"delta":{"content":"Hello"}}]}
    // or: data: [DONE]
    let trimmed = line.trim();
    if !trimmed.starts_with("data: ") {
        return None;
    }
    let json_str = &trimmed[6..];
    if json_str == "[DONE]" {
        return None;
    }
    // Parse JSON to extract delta.content.
    // We use a lightweight approach: find "content" in the delta.
    let v: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let choices = v.get("choices")?.as_array()?;
    let first = choices.first()?;
    let delta = first.get("delta")?;
    let content = delta.get("content")?.as_str()?;
    if content.is_empty() {
        return None;
    }
    Some(content.to_string())
}
