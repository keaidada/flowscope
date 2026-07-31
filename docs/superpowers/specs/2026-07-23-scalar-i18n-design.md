# Scalar API Docs 国际化设计

## 背景

`/api/docs` 页面当前使用 Swagger UI 展示 OpenAPI 文档，HTML 硬编码为中文。项目已有 `utoipa-scalar` 依赖但未启用。需要切到 Scalar UI 并支持中英文切换。

## 方案

用 Scalar CDN 替换 Swagger UI CDN，通过 `localization.locale` 配置项控制语言。Scalar 内置 `zh-CN` 简体中文和 `en` 英文支持，无需手动维护翻译文案。

## 语言切换机制

- `GET /api/docs` → 通过 `Accept-Language` header 自动检测（`zh` 开头用中文，其余用英文）
- `GET /api/docs?lang=en` → 强制英文
- `GET /api/docs?lang=zh` → 强制中文
- 默认 `zh-CN`（向后兼容当前硬编码行为）

## 实现细节

### Rust 端 (`crates/capybara-cli/src/server/mod.rs`)

1. 删除 `SCALAR_HTML_CN` 常量和 Swagger UI 的 HTML 字符串
2. 新增 `scalar_html(lang: &str, title: &str) -> String` 函数，生成 Scalar HTML
3. 修改 `scalar_docs` handler，接收可选的 `lang` query 参数
4. 保留 `utoipa-scalar` 依赖待后续扩展

### HTML 结构

```html
<!doctype html>
<html lang="{lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    html { box-sizing: border-box; overflow: hidden; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; height: 100vh; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '/api/openapi.json',
      localization: { locale: '{locale}' },
    })
  </script>
</body>
</html>
```

### 语言映射

| `lang` 参数 | html lang | locale | title |
|-------------|-----------|--------|-------|
| `zh` | `zh-CN` | `zh-CN` | Capybara API 文档 |
| `en` | `en` | `en` | Capybara API Documentation |
| 未指定 | 检测 Accept-Language | 同上 | 同上 |

## 影响范围

只修改 `crates/capybara-cli/src/server/mod.rs` 一个文件。前端无需改动。

## 测试验证

1. 浏览器打开 `http://127.0.0.1:3000/api/docs` → 中文 Scalar UI
2. 浏览器打开 `http://127.0.0.1:3000/api/docs?lang=en` → 英文 Scalar UI
3. 浏览器打开 `http://127.0.0.1:3000/api/docs?lang=zh` → 中文 Scalar UI
4. 英文浏览器无 lang 参数打开 → 英文 Scalar UI
