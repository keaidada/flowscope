/**
 * AiChatPanel — right-side AI assistant panel.
 *
 * Features:
 * - Chat with DeepSeek/Ollama via backend SSE proxy
 * - Auto-injects current SQL/file context
 * - Streaming responses (逐字渲染)
 * - Collapsible
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Sparkles, Send, Loader2, X, Settings, Copy, Check,
  Bot, AlertCircle, ChevronDown, Plus, Database, FileCode2,
  Wrench, Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ModelConfig {
  provider: string;
  api_key: string;
  model: string;
  endpoint: string;
  system_prompt: string;
  temperature: number;
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
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelConfig | null>(null);
  const [activeKey, setActiveKey] = useState('ollama|qwen2.5:3b');
  const [models, setModels] = useState<Record<string, ModelConfig>>({});
  const [configSaved, setConfigSaved] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Preset models for quick switching (each keeps its own config).
  const PRESETS = [
    { label: 'Ollama · qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b', endpoint: 'http://localhost:11434', api_key: 'ollama' },
    { label: 'DeepSeek · deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com', api_key: '' },
    { label: 'DeepSeek · deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner', endpoint: 'https://api.deepseek.com', api_key: '' },
  ] as const;

  const DEFAULT_SYSTEM_PROMPT = '你是一个 SQL 血缘分析和数据治理助手。帮助用户理解 SQL 脚本的血缘关系、表和字段的来源，提供 SQL 解释和优化建议。';

  const modelKey = (p: string, m: string) => `${p}|${m}`;

  // Get a model's effective config: preset defaults merged with any saved config.
  const modelConfig = useCallback((provider: string, model: string): ModelConfig => {
    const saved = models[modelKey(provider, model)];
    const preset = PRESETS.find(p => p.provider === provider && p.model === model);
    return {
      provider,
      api_key: saved?.api_key ?? preset?.api_key ?? '',
      model,
      endpoint: saved?.endpoint ?? preset?.endpoint ?? '',
      system_prompt: saved?.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature: saved?.temperature ?? 0.7,
    };
  }, [models]);

  // Effective config for the active model.
  const activeConfig = useMemo(() => {
    const [provider, model] = activeKey.split('|');
    return modelConfig(provider, model);
  }, [activeKey, modelConfig]);

  // Load config on mount / project change.
  useEffect(() => {
    if (!projectId) return;
    console.log('[ai] GET config for project=', projectId);
    fetch(`${apiBase()}/api/ai/config?project_id=${projectId}`)
      .then(r => r.json())
      .then(c => {
        console.log('[ai] GET config response active=', JSON.stringify(c.active), 'models=', c.models?.length ?? 0);
        const m = c.models || [];
        const map: Record<string, ModelConfig> = {};
        for (const item of m) {
          map[modelKey(item.provider, item.model)] = {
            provider: item.provider,
            api_key: item.api_key || '',
            model: item.model,
            endpoint: item.endpoint || '',
            system_prompt: item.system_prompt || DEFAULT_SYSTEM_PROMPT,
            temperature: item.temperature ?? 0.7,
          };
        }
        setModels(map);
        if (c.active?.provider && c.active?.model) {
          setActiveKey(modelKey(c.active.provider, c.active.model));
        }
      })
      .catch(() => {});
  }, [projectId]);

  const saveConfig = async (cfg?: ModelConfig) => {
    if (!projectId) return;
    console.log('[ai] saveConfig called, projectId=', projectId, 'cfg=', cfg ? `${cfg.provider}/${cfg.model}` : 'null(active)');
    try {
      const c = cfg ?? activeConfig;
      console.log('[ai] saveConfig PUT body=', JSON.stringify({ project_id: projectId, ...c }));
      const res = await fetch(`${apiBase()}/api/ai/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, ...c }),
      });
      console.log('[ai] saveConfig response status=', res.status);
      if (!res.ok) {
        const text = await res.text();
        console.log('[ai] saveConfig FAILED:', res.status, text);
      }
      if (cfg) {
        // Save just this model's config.
        setModels(prev => ({ ...prev, [modelKey(cfg.provider, cfg.model)]: cfg }));
      } else {
        // Saving settings dialog: model stays active, but merge into map.
        setModels(prev => ({ ...prev, [modelKey(activeConfig.provider, activeConfig.model)]: activeConfig }));
      }
    } catch (e) { console.error('[ai] saveConfig threw:', e); }
  };

  // Quick model switch: only change the active pointer, keep each model's own config.
  const quickSwitchModel = (provider: string, model: string) => {
    console.log('[ai] quickSwitchModel', provider, model, 'projectId=', projectId);
    setActiveKey(modelKey(provider, model));
    fetch(`${apiBase()}/api/ai/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, provider, model }),
    }).then(r => console.log('[ai] quickSwitch response', r.status)).catch(e => console.error('[ai] quickSwitch failed', e));
  };

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const clearChat = () => setMessages([]);
  const hasMessages = messages.length > 0;

  // Capability cards shown on the empty-state welcome screen.
  const CAPABILITIES = [
    { icon: FileCode2, title: '解释脚本', desc: '理解这段 SQL 在做什么', prompt: '帮我解释当前脚本的功能' },
    { icon: Database, title: '分析血缘', desc: '梳理表与字段的来源', prompt: '当前脚本读了哪些表？' },
    { icon: Wrench, title: '优化建议', desc: '找出可优化的地方', prompt: '给当前脚本一些优化建议' },
    { icon: Search, title: '排查问题', desc: '定位字段或表的去向', prompt: '帮我梳理这个脚本的血缘关系' },
  ];

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
    <div className="flex flex-col h-full border-l bg-background shrink-0" style={{ width: '400px' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-indigo-400 shadow-sm">
          <Sparkles className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-semibold text-[13px]">AI 对话</span>
        {hasMessages && (
          <button onClick={clearChat} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground" title="新对话">
            <Plus className="h-4 w-4" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {configSaved && <span className="text-[10px] text-green-600 flex items-center gap-0.5 mr-1"><Check className="h-3 w-3" /></span>}
          <button onClick={() => {
            const [p, m] = activeKey.split('|');
            setDraftKey(activeKey);
            setDraft(modelConfig(p, m));
            setShowSettings(true);
          }} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground" title="设置">
            <Settings className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground" title="收起">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body: welcome screen or messages */}
      {!hasMessages ? (
        <div className="flex-1 overflow-auto px-6 py-8">
          <div className="flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-indigo-400 flex items-center justify-center shadow-lg mb-5">
              <Sparkles className="h-8 w-8 text-primary-foreground" />
            </div>
            <h2 className="text-xl font-bold">你好，我是 FlowScope AI</h2>
            <p className="text-xs text-muted-foreground mt-2 mb-6 max-w-[260px] leading-relaxed">
              SQL 血缘分析助手，帮你理解脚本、梳理字段来源、优化查询。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {CAPABILITIES.map(cap => (
              <button
                key={cap.title}
                onClick={() => setInput(cap.prompt)}
                disabled={loading || !projectId}
                className="flex flex-col items-start gap-1 p-3 rounded-xl border bg-card hover:border-primary/50 hover:shadow-sm transition-all text-left group"
              >
                <cap.icon className="h-4 w-4 text-primary mb-0.5" />
                <span className="text-xs font-medium">{cap.title}</span>
                <span className="text-[10px] text-muted-foreground leading-snug">{cap.desc}</span>
              </button>
            ))}
          </div>
          {!projectId && (
            <p className="text-[10px] text-muted-foreground text-center mt-4">
              请先打开一个项目，才能开始对话。
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} loading={loading && i === messages.length - 1} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-1.5 border-t bg-destructive/5 text-[11px] text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Input */}
      <div className="border-t p-3 shrink-0 bg-muted/20">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="问问 FlowScope AI…"
            rows={2}
            className="flex-1 text-xs px-3 py-2 rounded-xl border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/60 resize-none leading-relaxed"
            disabled={loading}
          />
          <Button
            size="icon"
            className="h-9 w-9 rounded-xl shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground"
            onClick={handleSend}
            disabled={!input.trim() || loading || !projectId}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {/* Footer row: model switch + hint */}
        <div className="flex items-center mt-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 px-2 py-1 rounded-lg border bg-background hover:bg-accent transition-colors text-[11px] text-foreground">
                <Bot className="h-3 w-3 text-primary" />
                <span className="max-w-[150px] truncate">
                  {(() => {
                    const [p, m] = activeKey.split('|');
                    return PRESETS.find(x => x.provider === p && x.model === m)?.label ?? `${p}/${m}`;
                  })()}
                </span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>选择模型</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={activeKey}
                onValueChange={val => {
                  const [p, m] = val.split('|');
                  quickSwitchModel(p, m);
                }}
              >
                {PRESETS.map(p => (
                  <DropdownMenuRadioItem key={`${p.provider}|${p.model}`} value={`${p.provider}|${p.model}`}>
                    {p.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="ml-auto text-[10px] text-muted-foreground">
            Enter 发送 · Shift+Enter 换行
          </span>
        </div>
      </div>

      {/* Settings Dialog: edit ANY model's config, independent of active model */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>AI 设置</DialogTitle>
            <p className="text-[11px] text-muted-foreground">
              每个模型可单独配置，切换模型时互不影响。
            </p>
          </DialogHeader>

          <div className="space-y-3">
            {/* Model selector tabs */}
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(p => {
                const key = modelKey(p.provider, p.model);
                const isActive = key === activeKey;
                const isEditing = key === draftKey;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setDraftKey(key);
                      setDraft(modelConfig(p.provider, p.model));
                    }}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors',
                      isEditing
                        ? 'border-primary/60 bg-primary/10 text-foreground'
                        : isActive
                          ? 'border-primary/40 bg-muted text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {isActive && <Bot className="h-3 w-3 text-primary" />}
                    <span>{p.label}</span>
                    {isActive && !isEditing && <span className="text-[9px] px-1 rounded bg-primary/10 text-primary">当前</span>}
                  </button>
                );
              })}
            </div>

            {/* Edit form for the selected draft model */}
            {draftKey && draft && (
              <div className="space-y-2.5 rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium">配置：{draft.provider} / {draft.model}</span>
                  {draftKey === activeKey && <span className="text-[10px] text-primary">当前使用中</span>}
                </div>
                {draft.provider === 'deepseek' && (
                  <div className="flex items-center gap-2">
                    <label className="w-20 text-[11px] text-muted-foreground shrink-0">API Key</label>
                    <input type="password" value={draft.api_key} onChange={e => setDraft({ ...draft, api_key: e.target.value })}
                      placeholder="sk-..." className="flex-1 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label className="w-20 text-[11px] text-muted-foreground shrink-0">Endpoint</label>
                  <input value={draft.endpoint} onChange={e => setDraft({ ...draft, endpoint: e.target.value })}
                    className="flex-1 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div className="flex items-start gap-2">
                  <label className="w-20 text-[11px] text-muted-foreground shrink-0 pt-1">System</label>
                  <textarea value={draft.system_prompt} onChange={e => setDraft({ ...draft, system_prompt: e.target.value })}
                    rows={3} className="flex-1 text-[11px] px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                    placeholder="AI 系统提示词" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="w-20 text-[11px] text-muted-foreground shrink-0">温度</label>
                  <input type="number" step="0.1" min="0" max="1" value={draft.temperature}
                    onChange={e => setDraft({ ...draft, temperature: Number(e.target.value) })}
                    className="w-20 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => setDraftKey(null)}>取消</Button>
                  <Button size="sm" className="text-xs" onClick={async () => {
                    console.log('[ai] 保存该模型 clicked, draft=', draft);
                    await saveConfig(draft);
                    setConfigSaved(true);
                    setTimeout(() => setConfigSaved(false), 1500);
                  }}>
                    <Check className="h-3 w-3 mr-1" /> 保存该模型
                  </Button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="text-[10px] text-muted-foreground">
            提示：保存的配置只作用于对应模型；切换模型使用各自保存的配置。
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MessageBubble({ message, loading }: { message: Message; loading?: boolean }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [copied, setCopied] = useState(false);

  if (isSystem) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // User message: right-aligned blue bubble (Trae style).
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words shadow-sm">
          {message.content}
        </div>
      </div>
    );
  }

  // AI message: left-aligned, no bubble background (Trae style).
  return (
    <div className="flex gap-2.5 group">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-indigo-400 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
        <Bot className="h-4 w-4 text-primary-foreground" />
      </div>
      <div className="flex-1 min-w-0 text-xs leading-relaxed text-foreground">
        {loading && !message.content ? (
          <div className="flex items-center gap-2 text-muted-foreground py-2">
            <span className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0.3s]" />
            </span>
            <span className="text-[11px]">思考中…</span>
          </div>
        ) : (
          <>
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => <h1 className="text-sm font-semibold my-1.5">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-semibold my-1.5">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-xs font-semibold my-1.5">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-xs font-semibold my-1.5">{children}</h4>,
                  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-4 my-1 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 my-1 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                  a: ({ children, href }) => (
                    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">{children}</a>
                  ),
                  code: ({ className: _className, children }) => (
                    <code className="bg-muted px-1 py-0.5 rounded text-[10px] font-mono">{children}</code>
                  ),
                  pre: ({ children }) => (
                    <pre className="bg-muted rounded p-2 my-1.5 overflow-x-auto text-[10px] font-mono leading-relaxed">{children}</pre>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-1.5">
                      <table className="border-collapse text-[11px] w-full">{children}</table>
                    </div>
                  ),
                  th: ({ children }) => <th className="border border-border px-1.5 py-0.5 text-left font-semibold bg-muted/40">{children}</th>,
                  td: ({ children }) => <td className="border border-border px-1.5 py-0.5">{children}</td>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-muted pl-2 my-1 text-muted-foreground">{children}</blockquote>
                ),
                hr: () => <hr className="my-2 border-border" />,
              }}
            >
              {message.content}
            </ReactMarkdown>
            </div>
            {/* Copy button below the message */}
            <div className="flex justify-end mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-accent transition-colors text-muted-foreground"
                title="复制"
              >
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                <span className="text-[10px]">{copied ? '已复制' : '复制'}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

