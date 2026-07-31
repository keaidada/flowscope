//! Governance report generation and export.

use super::GovernanceReport;

/// Export governance report as JSON string.
pub fn export_json(report: &GovernanceReport) -> String {
    serde_json::to_string_pretty(report).unwrap_or_else(|_| "{}".to_string())
}

/// Export governance report as a self-contained HTML page.
pub fn export_html(report: &GovernanceReport) -> String {
    let health = report.health_score;
    let health_color = if health >= 80 {
        "#22c55e"
    } else if health >= 60 {
        "#eab308"
    } else {
        "#ef4444"
    };

    let violations_html: String = report
        .violations
        .iter()
        .map(|v| {
            let color = match v.severity {
                super::Severity::P0 => "#ef4444",
                super::Severity::P1 => "#eab308",
                super::Severity::P2 => "#3b82f6",
            };
            let label = v.severity.label();
            format!(
                r#"<div class="violation">
                    <span class="badge" style="background:{color}">{label}</span>
                    <span class="rule">{}</span>
                    <span class="title">{}</span>
                </div>"#,
                v.rule_id, v.title
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let pending_html: String = report
        .pending_runtime
        .iter()
        .map(|p| {
            format!(
                r#"<div class="pending">
                    <span class="badge pending">⏳ {}</span>
                    <span class="title">{}</span>
                </div>"#,
                p.check_type, p.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>数据治理报告 — {project_id}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: -apple-system, sans-serif; background: #f5f5f5; padding: 24px; }}
        .container {{ max-width: 900px; margin: 0 auto; }}
        .score-card {{
            background: white; border-radius: 12px; padding: 32px;
            text-align: center; margin-bottom: 24px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }}
        .score {{ font-size: 64px; font-weight: 700; color: {health_color}; }}
        .score-label {{ font-size: 14px; color: #666; margin-top: 8px; }}
        .section {{
            background: white; border-radius: 12px; padding: 24px;
            margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }}
        .section-title {{ font-size: 18px; font-weight: 600; margin-bottom: 16px; }}
        .violation {{
            display: flex; align-items: center; gap: 12px;
            padding: 12px 0; border-bottom: 1px solid #f0f0f0;
        }}
        .badge {{
            display: inline-block; padding: 2px 8px;
            border-radius: 4px; color: white; font-size: 12px; font-weight: 600;
        }}
        .badge.pending {{ background: #94a3b8; }}
        .rule {{ font-family: monospace; color: #666; font-size: 13px; min-width: 200px; }}
        .title {{ flex: 1; font-size: 14px; }}
        .pending {{ display: flex; align-items: center; gap: 12px; padding: 8px 0; }}
        .stats {{ display: flex; gap: 24px; justify-content: center; margin-top: 16px; }}
        .stat {{ text-align: center; }}
        .stat-value {{ font-size: 24px; font-weight: 600; }}
        .stat-label {{ font-size: 12px; color: #999; }}
        .footer {{ text-align: center; color: #999; font-size: 12px; margin-top: 24px; }}
    </style>
</head>
<body>
<div class="container">
    <div class="score-card">
        <div class="score">{health}</div>
        <div class="score-label">数据资产健康分 / 100</div>
        <div class="stats">
            <div class="stat"><div class="stat-value">{p0}</div><div class="stat-label">P0 严重</div></div>
            <div class="stat"><div class="stat-value">{p1}</div><div class="stat-label">P1 高风险</div></div>
            <div class="stat"><div class="stat-value">{p2}</div><div class="stat-label">P2 建议</div></div>
            <div class="stat"><div class="stat-value">{files}</div><div class="stat-label">文件数</div></div>
        </div>
    </div>
    <div class="section">
        <div class="section-title">⚠️ 违规清单 ({total})</div>
        {violations_html}
    </div>
    {pending_section}
    <div class="footer">FlowScope Governance Report — {created_at}</div>
</div>
</body>
</html>"#,
        project_id = report.project_id,
        health_color = health_color,
        health = health,
        p0 = report.summary.p0_count,
        p1 = report.summary.p1_count,
        p2 = report.summary.p2_count,
        files = report.summary.total_files,
        total = report.violations.len(),
        violations_html = violations_html,
        pending_section = if pending_html.is_empty() {
            String::new()
        } else {
            format!(
                r#"<div class="section"><div class="section-title">⏳ 待运行时验证</div>{pending_html}</div>"#
            )
        },
        created_at = report.created_at,
    )
}
