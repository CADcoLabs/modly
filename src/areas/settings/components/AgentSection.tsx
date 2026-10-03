import { useState, useEffect, useCallback } from 'react'
import {
  useAgentStore, PROVIDERS,
  type ThinkingMode, type ProviderId, type ExternalConfig,
} from '@shared/stores/agentStore'
import { useAppStore } from '@shared/stores/appStore'
import { consumeSse, type SseEvent } from '@shared/services/llmDownloads'
import { SseProgressBar } from '@shared/components/ui/SseProgressBar'
import { ModelLibraryModal } from '@shared/components/ui/ModelLibraryModal'
import type { LlmModel } from '@shared/stores/llmModelsStore'
import { formatBytes } from '@shared/utils/format'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-zinc-300">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-zinc-600">{hint}</p>}
    </div>
  )
}

function Group({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{title}</h3>
        {badge}
      </div>
      {children}
    </div>
  )
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }): JSX.Element {
  const cls = tone === 'ok'
    ? 'bg-emerald-500/15 text-emerald-400'
    : tone === 'warn'
      ? 'bg-amber-500/15 text-amber-400'
      : 'bg-zinc-700/40 text-zinc-400'
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{children}</span>
}

const inputCls = 'bg-zinc-900 border border-zinc-700/60 rounded-lg px-3 py-2 text-[12.5px] text-zinc-200 focus:outline-none focus:border-zinc-500'

// ─── Component ────────────────────────────────────────────────────────────────

export function AgentSection(): JSX.Element {
  const {
    provider, localModel, external, defaultThinking,
    setProvider, setExternal, setDefaultThinking,
  } = useAgentStore()
  const apiUrl = useAppStore((s) => s.apiUrl)

  // Local engine
  const [engineInstalled, setEngineInstalled] = useState<boolean | null>(null)
  const [engineInstall, setEngineInstall]     = useState<SseEvent | null>(null)
  const [engineError, setEngineError]         = useState<string | null>(null)
  const [models, setModels]                   = useState<LlmModel[]>([])
  const [showLibrary, setShowLibrary]         = useState(false)
  const [maxModels, setMaxModels]             = useState<string>('auto')
  const [resolvedMax, setResolvedMax]         = useState<number | null>(null)
  const [vramGb, setVramGb]                   = useState<number | null>(null)

  // External provider drafts
  const extCfg = external[provider]
  const [keyDraft, setKeyDraft]           = useState(extCfg?.apiKey ?? '')
  const [extModelDraft, setExtModelDraft] = useState(extCfg?.model ?? '')
  const [baseUrlDraft, setBaseUrlDraft]   = useState(extCfg?.baseUrl ?? '')
  const [extModels, setExtModels]         = useState<string[]>([])
  const [extTesting, setExtTesting]       = useState(false)
  const [extResult, setExtResult]         = useState<'ok' | 'error' | null>(null)

  const refreshLocal = useCallback(async () => {
    try {
      const [s, m, c] = await Promise.all([
        fetch(`${apiUrl}/llm/status`).then((r) => r.json()),
        fetch(`${apiUrl}/llm/models?downloaded=true`).then((r) => r.json()),
        fetch(`${apiUrl}/llm/config`).then((r) => r.json()),
      ])
      setEngineInstalled(Boolean(s.binary_installed))
      setModels(m.models ?? [])
      setMaxModels(String(c.max_models ?? 'auto'))
      setResolvedMax(c.resolved_max_models ?? null)
      setVramGb(c.vram_gb ?? null)
    } catch {
      setEngineInstalled(null)
    }
  }, [apiUrl])

  async function installEngine() {
    setEngineInstall({ percent: 0, status: 'Starting…' })
    setEngineError(null)
    try {
      await consumeSse(`${apiUrl}/llm/binary/install`, (e) => {
        if (e.error) setEngineError(e.error)
        else setEngineInstall(e)
      })
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e))
    } finally {
      setEngineInstall(null)
      void refreshLocal()
    }
  }

  async function changeMaxModels(value: string) {
    setMaxModels(value)
    try {
      const res = await fetch(`${apiUrl}/llm/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_models: value === 'auto' ? 'auto' : Number(value) }),
      })
      const data = await res.json()
      setResolvedMax(data.resolved_max_models ?? null)
    } catch { /* API unreachable — keep the optimistic value, refreshLocal will resync */ }
  }

  useEffect(() => { void refreshLocal() }, [refreshLocal])

  // Sync drafts when switching provider
  useEffect(() => {
    const cfg = useAgentStore.getState().external[provider]
    setKeyDraft(cfg?.apiKey ?? '')
    setExtModelDraft(cfg?.model ?? '')
    setBaseUrlDraft(cfg?.baseUrl ?? '')
    setExtModels([])
    setExtResult(null)
  }, [provider])

  function saveExternal() {
    const cfg: ExternalConfig = { apiKey: keyDraft.trim(), model: extModelDraft.trim() }
    if (provider === 'custom') cfg.baseUrl = baseUrlDraft.trim().replace(/\/$/, '')
    setExternal(provider, cfg)
  }

  async function handleTestExternal() {
    setExtTesting(true)
    setExtResult(null)
    try {
      const base = provider === 'custom' ? baseUrlDraft.trim().replace(/\/$/, '') : PROVIDERS[provider].baseUrl
      // POST, not a query string: a GET would put the API key in the uvicorn
      // access log, which ends up in runtime.log and in users' bug reports.
      const res = await fetch(`${apiUrl}/agent/external/models`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ base_url: base, api_key: keyDraft.trim() }),
      })
      const data: { models?: string[] } = await res.json()
      const found = (data.models ?? []).length > 0
      setExtModels(data.models ?? [])
      setExtResult(found ? 'ok' : 'error')
    } catch {
      setExtResult('error')
    } finally {
      setExtTesting(false)
    }
  }

  const THINKING_OPTIONS: { value: ThinkingMode; label: string; desc: string }[] = [
    { value: 'auto', label: 'Auto',     desc: 'The model decides whether to think' },
    { value: 'on',   label: 'Enabled',  desc: 'Forces thinking on every response' },
    { value: 'off',  label: 'Disabled', desc: 'Disables thinking (faster responses)' },
  ]

  const mcpConfigs = {
    opencode: `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "modly": {\n      "type": "local",\n      "command": ["modly-mcp"]\n    }\n  }\n}`,
    codex: `[mcp_servers.modly]\ncommand = "modly-mcp"`,
    claude: `{\n  "mcpServers": {\n    "modly": {\n      "command": "modly-mcp"\n    }\n  }\n}`,
  }

  return (
    <div className="flex flex-col gap-8 max-w-xl">
      <div>
        <h2 className="text-[18px] font-semibold text-zinc-100 mb-1">Agent</h2>
        <p className="text-[12px] text-zinc-500">Configure the LLM powering the chat — fully local by default.</p>
      </div>

      {/* Provider */}
      <Group title="Provider">
        <Field label="LLM provider" hint="Local runs entirely on this machine via llama.cpp. External providers require an API key.">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className={inputCls}
          >
            {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
              <option key={p} value={p}>{PROVIDERS[p].label}</option>
            ))}
          </select>
        </Field>
      </Group>

      {provider === 'local' ? (
        <Group
          title="Local engine (llama.cpp)"
          badge={
            engineInstalled === null ? <Badge tone="muted">API unreachable</Badge>
              : engineInstalled ? <Badge tone="ok">Engine installed</Badge>
              : <Badge tone="warn">Engine missing</Badge>
          }
        >
          {engineInstalled === false && (
            <div className="flex flex-col gap-2">
              {engineInstall ? (
                <SseProgressBar event={engineInstall} />
              ) : (
                <button
                  onClick={() => void installEngine()}
                  className="self-start px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-dark text-white text-[12px] font-medium transition-colors"
                >
                  Install engine
                </button>
              )}
              {engineError && <p className="text-[11px] text-red-400">{engineError}</p>}
            </div>
          )}
          {engineInstalled === null && (
            <button
              onClick={() => void refreshLocal()}
              className="self-start px-3 py-2 rounded-lg border border-zinc-700/60 bg-zinc-900 text-[12px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
            >
              Retry
            </button>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] font-medium text-zinc-300">Models</label>
              <button
                onClick={() => setShowLibrary(true)}
                className="px-3 py-1.5 rounded-lg border border-zinc-700/60 bg-zinc-900 text-[12px] text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors"
              >
                Browse
              </button>
            </div>
            {models.length === 0 ? (
              <p className="text-[11px] text-zinc-600">No model yet — open Browse to add or download one.</p>
            ) : (
              <ul className="border border-zinc-800 rounded-xl bg-zinc-900/40 divide-y divide-zinc-800">
                {/* The agent's selected model first, so it is what you see on closing Browse. */}
                {[...models].sort((a, b) => Number(b.id === localModel) - Number(a.id === localModel)).map((m) => (
                  <li key={m.id} className="px-4 py-2.5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[12.5px] text-zinc-200 truncate">{m.name}</span>
                      {m.id === localModel && <Badge tone="ok">Selected</Badge>}
                    </div>
                    {m.size_bytes ? <span className="shrink-0 text-[11px] text-zinc-500">{formatBytes(m.size_bytes)}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Field
            label="Simultaneous models"
            hint="How many local models may stay loaded at once (one llama-server process each). Auto sizes it from your GPU's VRAM — on 8 GB cards keep 1 so 3D generation always has room."
          >
            <select
              value={maxModels}
              onChange={(e) => void changeMaxModels(e.target.value)}
              className={inputCls}
            >
              <option value="auto">
                Auto{resolvedMax != null ? ` — ${resolvedMax} model${resolvedMax > 1 ? 's' : ''}${vramGb != null ? ` (${vramGb} GB VRAM)` : ''}` : ''}
              </option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={String(n)}>{n}</option>
              ))}
            </select>
          </Field>
        </Group>
      ) : (
        <Group title={PROVIDERS[provider].label}>
          {provider === 'custom' && (
            <Field label="Base URL" hint="Any OpenAI-compatible endpoint (llama-server, vLLM, LM Studio…). Without the trailing /chat/completions.">
              <input
                value={baseUrlDraft}
                onChange={(e) => { setBaseUrlDraft(e.target.value); setExtResult(null) }}
                placeholder="http://192.168.1.20:8080/v1"
                className={inputCls}
              />
            </Field>
          )}

          <Field
            label={PROVIDERS[provider].noKey ? 'API key (optional)' : 'API key'}
            hint={PROVIDERS[provider].noKey
              ? 'Not needed for a local Ollama — models already pulled with it are reused as-is.'
              : 'Stored locally on this machine only.'}
          >
            <div className="flex gap-2">
              <input
                type="password"
                value={keyDraft}
                onChange={(e) => { setKeyDraft(e.target.value); setExtResult(null) }}
                placeholder={PROVIDERS[provider].noKey ? '' : 'sk-…'}
                className={`${inputCls} flex-1`}
              />
              <button
                onClick={handleTestExternal}
                disabled={extTesting}
                className="px-3 py-2 rounded-lg border border-zinc-700/60 bg-zinc-900 text-[12px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-50 shrink-0"
              >
                {extTesting ? 'Testing…' : 'Test'}
              </button>
            </div>
            {extResult === 'ok' && (
              <p className="text-[11px] text-emerald-400">Connected — {extModels.length} model{extModels.length > 1 ? 's' : ''} available</p>
            )}
            {extResult === 'error' && (
              <p className="text-[11px] text-red-400">
                {provider === 'ollama'
                  ? 'Could not list models — is Ollama running?'
                  : `Could not list models — check the key${provider === 'custom' ? ' and URL' : ''}`}
              </p>
            )}
          </Field>

          <Field label="Model" hint="Model name used for the chat.">
            {extModels.length > 0 ? (
              <select value={extModelDraft} onChange={(e) => setExtModelDraft(e.target.value)} className={inputCls}>
                {/* Without it the browser shows the first model while the draft
                  * stays '' — Save then persisted an empty model name. */}
                {!extModelDraft && <option value="" disabled>Select a model…</option>}
                {!extModels.includes(extModelDraft) && extModelDraft && <option value={extModelDraft}>{extModelDraft}</option>}
                {extModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                value={extModelDraft}
                onChange={(e) => setExtModelDraft(e.target.value)}
                placeholder={provider === 'anthropic' ? 'claude-sonnet-5' : provider === 'openai' ? 'gpt-5.2' : provider === 'ollama' ? 'qwen2.5:3b' : 'model name'}
                className={inputCls}
              />
            )}
          </Field>

          <button
            onClick={saveExternal}
            className="self-start px-4 py-2 rounded-lg bg-accent hover:bg-accent-dark text-white text-[12px] font-medium transition-colors"
          >
            Save
          </button>
        </Group>
      )}

      {/* Thinking */}
      <Group title="Thinking">
        <Field label="Default mode" hint="Can be changed on the fly in the chat via the brain icon.">
          <div className="flex flex-col gap-2">
            {THINKING_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-start gap-3 cursor-pointer group">
                <div className="mt-0.5">
                  <input
                    type="radio"
                    name="thinking"
                    value={opt.value}
                    checked={defaultThinking === opt.value}
                    onChange={() => setDefaultThinking(opt.value)}
                    className="accent-violet-500"
                  />
                </div>
                <div>
                  <p className="text-[12.5px] text-zinc-200 group-hover:text-white transition-colors">{opt.label}</p>
                  <p className="text-[11px] text-zinc-600">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </Field>
      </Group>

      {/* MCP */}
      <Group title="MCP Server">
        <p className="text-[12px] text-zinc-400 leading-relaxed">
          Install this community package (made by <span className="text-zinc-300">DrHepa</span>) to control Modly from Claude Desktop, Codex or OpenCode:
        </p>
        <div className="relative">
          <pre className="bg-zinc-900 border border-zinc-700/60 rounded-lg px-4 py-3 text-[11px] text-zinc-400">npm install -g modly-cli-mcp</pre>
          <button
            onClick={() => navigator.clipboard.writeText('npm install -g modly-cli-mcp')}
            title="Copier"
            className="absolute top-2 right-2 text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {([
            { label: 'Claude Desktop', key: 'claude'   as const, hint: '~/.config/claude/claude_desktop_config.json' },
            { label: 'Codex CLI',      key: 'codex'    as const, hint: '~/.codex/config.toml' },
            { label: 'OpenCode',       key: 'opencode' as const, hint: '~/.config/opencode/config.json' },
          ] as const).map(({ label, key, hint }) => (
            <div key={key}>
              <p className="text-[11px] text-zinc-500 mb-1.5">{label} <span className="text-zinc-700">— {hint}</span></p>
              <div className="relative">
                <pre className="bg-zinc-900 border border-zinc-700/60 rounded-lg px-4 py-3 text-[11px] text-zinc-400 overflow-x-auto leading-relaxed whitespace-pre">
                  {mcpConfigs[key]}
                </pre>
                <button
                  onClick={() => navigator.clipboard.writeText(mcpConfigs[key])}
                  title="Copier"
                  className="absolute top-2 right-2 text-zinc-600 hover:text-zinc-300 transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </Group>

      {showLibrary && (
        <ModelLibraryModal onClose={() => { setShowLibrary(false); void refreshLocal() }} />
      )}
    </div>
  )
}
