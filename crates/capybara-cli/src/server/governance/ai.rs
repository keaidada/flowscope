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

/// Load AI config from governance DB. Returns default if not configured.
pub fn get_ai_config(conn: &Connection, project_id: &str) -> AiConfig {
    let row = conn
        .query_row(
            "SELECT provider, api_key, model, endpoint, system_prompt, temperature
             FROM ai_config WHERE project_id = ?1 AND status = 1",
            params![project_id],
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
        );
    row.unwrap_or_default()
}

/// Save AI config (upsert).
pub fn save_ai_config(
    conn: &Connection,
    project_id: &str,
    cfg: &AiConfig,
) -> Result<(), rusqlite::Error> {
    let now = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    conn.execute(
        "INSERT INTO ai_config (project_id, provider, api_key, model, endpoint, system_prompt, temperature, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)
         ON CONFLICT(project_id) DO UPDATE SET
            provider = excluded.provider,
            api_key = excluded.api_key,
            model = excluded.model,
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
            // Truncate very long SQL to ~4000 chars to stay within token limits.
            let truncated = if sql.len() > 4000 {
                &sql[..4000]
            } else {
                sql
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
