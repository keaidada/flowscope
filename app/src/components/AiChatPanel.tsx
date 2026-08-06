/**
 * AiChatPanel — right-side AI assistant panel.
 *
 * Features:
 * - Chat with DeepSeek/Ollama via backend SSE proxy
 * - Auto-injects current SQL/file context
 * - Streaming responses (逐字渲染)
 * - Collapsible
 */

import { useState, useRef, useEffect, useCallback, createElement } from 'react';
import {
  Sparkles, Send, Loader2, X, Settings, Trash2,
  Bot, User, AlertCircle, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface AiChatPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  currentFilePath?: string;
  currentSql?: string;
}

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const port = (window as unknown as { __FSCOPE_PORT__?: number }).__FSCOPE_PORT__;
    if (port) return `http://localhost:${port}`;
  }
  return '';
}

export function AiChatPanel({ open, onClose, projectId, currentFilePath, currentSql }: AiChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState({
    provider: 'ollama',
    api_key: '',
    model: 'qwen2.5:3b',
    endpoint: 'http://localhost:11434',
    system_prompt: '你是一个 SQL 血缘分析和数据治理助手。帮助用户理解 SQL 脚本的血缘关系、表和字段的来源，提供 SQL 解释和优化建议。',
    temperature: 0.7,
  });
  const [configSaved, setConfigSaved] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Preset models for quick switching.
  const PRESETS = [
    { label: 'Ollama · qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b', endpoint: 'http://localhost:11434', api_key: 'ollama' },
    { label: 'DeepSeek · deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com', api_key: '' },
    { label: 'DeepSeek · deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner', endpoint: 'https://api.deepseek.com', api_key: '' },
  ];

  // Load config on mount / project change.
  useEffect(() => {
    if (!projectId) return;
    fetch(`${apiBase()}/api/ai/config?project_id=${projectId}`)
      .then(r => r.json())
      .then(c => {
        setConfig({
          provider: c.provider || 'ollama',
          api_key: c.api_key || '',
          model: c.model || 'qwen2.5:3b',
          endpoint: c.endpoint || 'http://localhost:11434',
          system_prompt: c.system_prompt || '你是一个 SQL 血缘分析和数据治理助手。帮助用户理解 SQL 脚本的血缘关系、表和字段的来源，提供 SQL 解释和优化建议。',
          temperature: c.temperature ?? 0.7,
        });
      })
      .catch(() => {});
  }, [projectId]);

  const saveConfig = async (cfg?: typeof config) => {
    if (!projectId) return;
    try {
      const c = cfg ?? config;
      await fetch(`${apiBase()}/api/ai/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, ...c }),
      });
      if (!cfg) {
        setConfigSaved(true);
        setShowSettings(false);
        setTimeout(() => setConfigSaved(false), 1500);
      }
    } catch (e) { console.error('save config failed', e); }
  };

  // Quick model switch: swap provider/model and persist immediately.
  const quickSwitchModel = (preset: { provider: string; model: string; endpoint: string; api_key: string }) => {
    const next = {
      ...config,
      provider: preset.provider,
      model: preset.model,
      endpoint: preset.endpoint,
      api_key: config.api_key || preset.api_key,
    };
    setConfig(next);
    saveConfig(next);
  };

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Welcome message.
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        role: 'assistant',
        content: '你好！我是 SQL 血缘分析助手。我可以帮你：\n\n• 解释 SQL 脚本的血缘关系\n• 分析表和字段的来源\n• 提供 SQL 优化建议\n\n请直接提问，或打开一个脚本后问我关于它的问题。',
      }]);
    }
  }, []);

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading || !projectId) return;

    const userMsg: Message = { role: 'user', content: input.trim() };
    const newMessages = [...messages.filter(m => m.role !== 'system'), userMsg];
    setMessages([...newMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${apiBase()}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
          context: currentSql ? {
            file_path: currentFilePath,
            sql: currentSql,
          } : undefined,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        setError(`请求失败: ${res.status} ${text}`);
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: `❌ 请求失败: ${res.status}` };
          return copy;
        });
        return;
      }

      // Read SSE stream (robust: accumulate buffer across chunks so
      // multi-line SSE events are parsed correctly).
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let sseBuffer = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (terminated by blank line \n\n).
          let sepIdx;
          while ((sepIdx = sseBuffer.indexOf('\n\n')) !== -1) {
            const event = sseBuffer.slice(0, sepIdx);
            sseBuffer = sseBuffer.slice(sepIdx + 2);
            for (const line of event.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') { sseBuffer = ''; break; }
              if (data.startsWith('[ERROR]')) {
                setError(data.slice(7));
                fullContent += `\n\n❌ ${data.slice(7)}`;
                sseBuffer = '';
                break;
              }
              if (data) {
                fullContent += data;
                setMessages(prev => {
                  const copy = [...prev];
                  copy[copy.length - 1] = { role: 'assistant', content: fullContent };
                  return copy;
                });
              }
            }
          }
        }
        // Flush any remaining partial event.
        if (sseBuffer.startsWith('data:')) {
          const data = sseBuffer.slice(5).trim();
          if (data && data !== '[DONE]') {
            fullContent += data;
            setMessages(prev => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: 'assistant', content: fullContent };
              return copy;
            });
          }
        }
      }

      // If no content was received, show a fallback.
      if (!fullContent) {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: '(AI 未返回内容，请检查 API Key 配置)' };
          return copy;
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', content: `❌ 错误: ${msg}` };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }, [input, loading, projectId, messages, currentSql, currentFilePath]);

  if (!open) return null;

  return (
    <div className="flex flex-col h-full border-l bg-background shrink-0" style={{ width: '380px' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0 bg-muted/20">
        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/10">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
        </div>
        <span className="font-semibold text-sm">AI 助手</span>
        {/* Model quick-switch dropdown */}
        <select
          value={`${config.provider}|${config.model}`}
          onChange={e => {
            const preset = PRESETS.find(p => `${p.provider}|${p.model}` === e.target.value);
            if (preset) quickSwitchModel(preset);
          }}
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border focus:outline-none max-w-[130px]"
          title="切换模型"
        >
          {PRESETS.map(p => (
            <option key={`${p.provider}|${p.model}`} value={`${p.provider}|${p.model}`}>{p.label}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-0.5">
          {configSaved && <span className="text-[10px] text-green-600 flex items-center gap-0.5 mr-1"><Check className="h-3 w-3" /></span>}
          <button onClick={() => setMessages([{ role: 'assistant', content: '对话已清空，可以开始新的提问。' }])} className="p-1 rounded hover:bg-accent" title="清空对话">
            <Trash2 className="h-4 w-4" />
          </button>
          <button onClick={() => setShowSettings(!showSettings)} className={cn('p-1 rounded hover:bg-accent', showSettings && 'bg-accent')} title="设置">
            <Settings className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b px-3 py-3 space-y-2.5 bg-muted/10 shrink-0">
          <div className="text-[11px] text-muted-foreground mb-1">
            当前模型：{config.provider} / {config.model}
          </div>
          {config.provider === 'deepseek' && (
            <div className="flex items-center gap-2">
              <label className="w-16 text-[11px] text-muted-foreground shrink-0">API Key</label>
              <input type="password" value={config.api_key} onChange={e => setConfig({ ...config, api_key: e.target.value })}
                placeholder="sk-..." className="flex-1 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="w-16 text-[11px] text-muted-foreground shrink-0">Endpoint</label>
            <input value={config.endpoint} onChange={e => setConfig({ ...config, endpoint: e.target.value })}
              className="flex-1 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <label className="w-16 text-[11px] text-muted-foreground shrink-0">System</label>
            <textarea value={config.system_prompt} onChange={e => setConfig({ ...config, system_prompt: e.target.value })}
              rows={3} className="flex-1 text-[11px] px-2 py-1 rounded border bg-transparent focus:outline-none resize-none"
              placeholder="AI 系统提示词" />
          </div>
          <div className="flex items-center gap-2">
            <label className="w-16 text-[11px] text-muted-foreground shrink-0">温度</label>
            <input type="number" step="0.1" min="0" max="1" value={config.temperature}
              onChange={e => setConfig({ ...config, temperature: Number(e.target.value) })}
              className="w-20 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none" />
          </div>
          <Button size="sm" className="h-7 w-full text-xs mt-1" onClick={() => saveConfig()}>保存配置</Button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-auto px-3 py-3 space-y-3">
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} loading={loading && i === messages.length - 1} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-1.5 border-t bg-destructive/5 text-[11px] text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Input */}
      <div className="border-t p-2 shrink-0">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="输入问题... (Enter 发送, Shift+Enter 换行)"
            rows={2}
            className="flex-1 text-xs px-2 py-1.5 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            disabled={loading}
          />
          <Button
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={handleSend}
            disabled={!input.trim() || loading || !projectId}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {/* Quick prompts */}
        <div className="flex flex-wrap gap-1 mt-1.5">
          {['解释这个脚本', '读了哪些表？', '优化建议'].map(prompt => (
            <button
              key={prompt}
              onClick={() => setInput(prompt)}
              disabled={loading}
              className="text-[10px] px-2 py-0.5 rounded-full border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, loading }: { message: Message; loading?: boolean }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) return null;

  return (
    <div className={cn('flex gap-2', isUser && 'flex-row-reverse')}>
      <div className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
        isUser ? 'bg-blue-500/10' : 'bg-primary/10'
      )}>
        {isUser ? <User className="h-3.5 w-3.5 text-blue-500" /> : <Bot className="h-3.5 w-3.5 text-primary" />}
      </div>
      <div className={cn(
        'flex-1 min-w-0 rounded-lg px-3 py-2 text-xs leading-relaxed',
        isUser
          ? 'bg-blue-500/5 text-foreground'
          : 'bg-muted/30 text-foreground'
      )}>
        {loading && !message.content ? (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-[11px]">思考中...</span>
          </div>
        ) : isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <Markdown content={message.content} />
        )}
      </div>
    </div>
  );
}

// ── Lightweight Markdown renderer ─────────────────────────────────

/** Render common Markdown (headings, bold, italic, code, lists, tables, links). */
function Markdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let listStack: string[] = []; // ordered? 'ol' : 'ul'
  let tableBuffer: string[][] = [];

  const flushList = () => {
    for (const t of listStack) {
      out.push(`</${t}>`);
    }
    listStack = [];
  };
  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    out.push(<table key={`t${i}`} className="my-1.5 border-collapse text-[11px] w-full">
      <thead><tr>{tableBuffer[0].map((c, ci) => <th key={ci} className="border border-border px-1.5 py-0.5 text-left font-semibold bg-muted/40">{inline(c)}</th>)}</tr></thead>
      <tbody>
        {tableBuffer.slice(2).map((row, ri) => (
          <tr key={ri}>{row.map((c, ci) => <td key={ci} className="border border-border px-1.5 py-0.5">{inline(c)}</td>)}</tr>
        ))}
      </tbody>
    </table>);
    tableBuffer = [];
  };

  // Process block-level tokens.
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fence / code block
    if (trimmed.startsWith('```')) {
      flushList(); flushTable();
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      out.push(
        <pre key={`c${i}`} className="bg-muted rounded p-2 my-1.5 overflow-x-auto text-[10px] font-mono leading-relaxed">
          {lang && <div className="text-[9px] text-muted-foreground mb-1">{lang}</div>}
          {codeLines.join('\n')}
        </pre>
      );
      continue;
    }

    // Inline code-only line
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length > 2 && !trimmed.includes('``')) {
      flushList(); flushTable();
      out.push(<pre key={`ci${i}`} className="bg-muted rounded px-1.5 py-0.5 my-1 inline-block text-[10px] font-mono">{trimmed.slice(1, -1)}</pre>);
      i++;
      continue;
    }

    // Heading
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushList(); flushTable();
      const level = hMatch[1].length;
      const Tag = (level === 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4') as 'h1' | 'h2' | 'h3' | 'h4';
      out.push(<Tag key={`h${i}`} className={cn('font-semibold mt-2 mb-1', level === 1 ? 'text-sm' : level === 2 ? 'text-sm' : 'text-xs')}>{inline(hMatch[2])}</Tag>);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^([-*_]\s*){3,}$/.test(trimmed)) {
      flushList(); flushTable();
      out.push(<hr key={`hr${i}`} className="my-2 border-border" />);
      i++;
      continue;
    }

    // Table separator row: |---|---|
    if (trimmed.startsWith('|') && /^\|[\s:|-]+\|$/.test(trimmed) && tableBuffer.length === 1) {
      // skip separator
      i++;
      continue;
    }
    // Table data row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushList();
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map(c => c.trim());
      tableBuffer.push(cells);
      i++;
      continue;
    } else {
      flushTable();
    }

    // List item
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ulMatch || olMatch) {
      const isOl = !!olMatch;
      const contentText = (olMatch || ulMatch)![1];
      if (listStack.length === 0) {
        // Use React.createElement for the dynamic list tag.
        out.push(createElement(
          isOl ? 'ol' : 'ul',
          { key: `l${i}`, className: isOl ? 'list-decimal pl-4 my-1 space-y-0.5' : 'list-disc pl-4 my-1 space-y-0.5' }
        ));
        listStack.push(isOl ? 'ol' : 'ul');
      }
      // Nested list: if content starts with indent markers, treat as sub-list (simplified).
      out.push(<li key={`li${i}`} className="leading-relaxed">{inline(contentText)}</li>);
      i++;
      continue;
    } else {
      flushList();
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      flushList();
      const quoteText = trimmed.replace(/^>\s?/, '');
      out.push(<div key={`q${i}`} className="border-l-2 border-muted pl-2 my-1 text-muted-foreground">{inline(quoteText)}</div>);
      i++;
      continue;
    }

    // Empty line → paragraph break
    if (trimmed === '') {
      out.push(<div key={`sp${i}`} className="h-1" />);
      i++;
      continue;
    }

    // Regular paragraph
    flushList();
    out.push(<p key={`p${i}`} className="my-1 leading-relaxed">{inline(trimmed)}</p>);
    i++;
  }

  flushList();
  flushTable();

  return <div className="markdown-body">{out}</div>;
}

/** Render inline Markdown: code, bold, italic, links. */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Tokenize: code spans first, then bold/italic/link.
  const tokens: Array<{ type: string; text: string; href?: string }> = [];
  let rest = text;
  let tokenRe = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/;
  while (rest) {
    const m = rest.match(tokenRe);
    if (!m) {
      if (rest) tokens.push({ type: 'text', text: rest });
      break;
    }
    if (m.index! > 0) tokens.push({ type: 'text', text: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) tokens.push({ type: 'code', text: tok.slice(1, -1) });
    else if (tok.startsWith('**')) tokens.push({ type: 'bold', text: tok.slice(2, -2) });
    else if (tok.startsWith('*')) tokens.push({ type: 'italic', text: tok.slice(1, -1) });
    else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) tokens.push({ type: 'link', text: lm[1], href: lm[2] });
      else tokens.push({ type: 'text', text: tok });
    }
    rest = rest.slice(m.index! + m[0].length);
  }

  tokens.forEach((tok, idx) => {
    if (tok.type === 'code') {
      parts.push(<code key={idx} className="bg-muted px-1 py-0.5 rounded text-[10px] font-mono">{tok.text}</code>);
    } else if (tok.type === 'bold') {
      parts.push(<strong key={idx} className="font-semibold">{inline(tok.text)}</strong>);
    } else if (tok.type === 'italic') {
      parts.push(<em key={idx} className="italic">{inline(tok.text)}</em>);
    } else if (tok.type === 'link') {
      parts.push(<a key={idx} href={tok.href} target="_blank" rel="noreferrer" className="text-primary underline">{tok.text}</a>);
    } else {
      parts.push(<span key={idx}>{tok.text}</span>);
    }
  });
  return parts;
}
