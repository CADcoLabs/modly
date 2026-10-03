import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@shared/stores/appStore'
import { useAgentStore } from '@shared/stores/agentStore'
import { useLlmModels, type LlmModel } from '@shared/stores/llmModelsStore'
import { useLlmDownloadsStore } from '@shared/services/llmDownloads'
import { formatBytes as fmtBytes } from '@shared/utils/format'
import { SseProgressBar } from './SseProgressBar'
import { vramFit } from './vramFit'
import { agentGrade } from './agentGrade'

// ─── Types ────────────────────────────────────────────────────────────────────

// Single source of truth lives in the shared catalog store; re-exported here so
// existing importers (AgentSection) keep resolving `LlmModel` from this module.
export type { LlmModel }

interface LlmStatus {
  vram_gb: number | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatBytes(n?: number): string {
  return n ? fmtBytes(n) : '—'
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ModelLibraryModal({ onClose }: { onClose: () => void }): JSX.Element {
  const apiUrl     = useAppStore((s) => s.apiUrl)
  const localModel = useAgentStore((s) => s.localModel)
  const setLocalModel = useAgentStore((s) => s.setLocalModel)

  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // The model list comes from the shared catalog store, so a download or delete
  // here immediately updates every other picker (chat, extension params,
  // chat) and vice-versa — no independent per-surface fetch.
  const { models, refresh: refreshModels } = useLlmModels()

  // Downloads live in a module-level store (src/shared/services/llmDownloads.ts)
  // so they keep running — and stay visible on reopen — after this modal closes.
  const downloads         = useLlmDownloadsStore((s) => s.downloads)
  const downloadError     = useLlmDownloadsStore((s) => s.error)
  const startDownload     = useLlmDownloadsStore((s) => s.start)
  const pauseDownload     = useLlmDownloadsStore((s) => s.pause)
  const cancelDownload    = useLlmDownloadsStore((s) => s.cancel)
  const dismissDownloadError = useLlmDownloadsStore((s) => s.dismissError)

  // Aborts every in-flight fetch (status/model list + any SSE stream) when the
  // modal unmounts, so closing it mid-download doesn't leak a fetch or call
  // setState on a component that's gone.
  const aliveRef            = useRef(true)
  const abortControllersRef = useRef(new Set<AbortController>())
  const dialogRef           = useRef<HTMLDivElement>(null)

  function withAbort<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    abortControllersRef.current.add(controller)
    return run(controller.signal).finally(() => { abortControllersRef.current.delete(controller) })
  }

  useEffect(() => {
    aliveRef.current = true
    const controllers = abortControllersRef.current
    return () => {
      aliveRef.current = false
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }
  }, [])

  // Escape closes the modal; Tab is trapped inside it while it's open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const refresh = useCallback(async () => {
    void refreshModels()   // shared model catalog (propagates to every picker)
    try {
      const s = await withAbort((signal) =>
        fetch(`${apiUrl}/llm/status`, { signal }).then((r) => r.json()),
      )
      if (!aliveRef.current) return
      setStatus(s)
    } catch {
      if (!aliveRef.current) return
      setStatus(null)
    }
  }, [apiUrl, refreshModels])

  // Once, on open (and if the API URL changes) — `refresh` is stable, see
  // useLlmModels. It used to be rebuilt on every render, so this effect re-ran
  // on every render and each pass forced another /llm/models + /llm/status.
  useEffect(() => { void refresh() }, [refresh])

  async function handleAdd() {
    setAdding(true)
    setError(null)
    try {
      const res = await window.electron.agent.addModel()
      if (!aliveRef.current) return
      if (res.error) setError(res.error)
      if (res.success) void refresh()
    } finally {
      if (aliveRef.current) setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    await fetch(`${apiUrl}/llm/models/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    void refresh()
  }

  // Downloads run in the shared store, possibly finishing while this modal is
  // closed — refresh the model list whenever one drops out (done/error/cancelled)
  // while we're mounted, so "downloaded" flips without waiting for a remount.
  const prevDownloadIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const prev = prevDownloadIdsRef.current
    const current = new Set(Object.keys(downloads).filter((id) => downloads[id] !== undefined))
    let finished = false
    for (const id of prev) if (!current.has(id)) finished = true
    prevDownloadIdsRef.current = current
    if (finished) void refresh()
  }, [downloads, refresh])

  const installed = models.filter((m) => m.downloaded)
  const suggested = models.filter((m) => !m.downloaded)

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm animate-fade-in" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Model library"
        tabIndex={-1}
        className="relative w-[960px] max-w-[94vw] max-h-[85vh] rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-[0_30px_60px_rgba(0,0,0,0.5)] overflow-hidden animate-slide-up-center flex flex-col focus:outline-none"
      >

        {/* Header */}
        <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-zinc-100 leading-tight">Models</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Local models shared by the whole app — chat agent and extensions.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => void handleAdd()}
              disabled={adding}
              className="px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-dark text-white text-[12px] font-medium transition-colors disabled:opacity-50"
            >
              {adding ? 'Adding…' : 'Add'}
            </button>
            <button onClick={onClose} aria-label="Close" className="text-zinc-600 hover:text-zinc-300 transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-5 shrink-0">
          {status === null && (
            <p className="text-[11px] text-zinc-500 flex items-center gap-2 pb-3">
              Cannot reach the Modly API.
              {/* The library does not poll, so a backend that was still starting
                * up needs a way back in short of reopening the modal. */}
              <button
                onClick={() => { void refresh() }}
                className="text-accent hover:underline underline-offset-2"
              >
                Retry
              </button>
            </p>
          )}
          {(error || downloadError) && (
            <p className="text-[11px] text-red-400 pb-3 flex items-center gap-2">
              <span className="flex-1">{error || downloadError}</span>
              <button
                onClick={() => { setError(null); dismissDownloadError() }}
                className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Dismiss
              </button>
            </p>
          )}
        </div>

        {/* Installed first, then the catalog's suggestions not yet downloaded */}
        <div className="px-5 pb-4 overflow-y-auto flex flex-col gap-5">
          {([
            { title: 'Installed', items: installed, empty: 'No model installed yet — add a .gguf file or download a suggestion below.' },
            { title: 'Suggested', items: suggested, empty: 'Every suggested model is installed.' },
          ]).map((section) => (
            <div key={section.title} className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                {section.title}
                <span className="ml-2 text-zinc-700">{section.items.length}</span>
              </h3>
              {section.items.length > 0 && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {section.items.map((m) => {
                    const dl        = downloads[m.id]
                    const tags      = m.tags ?? []
                    const isDefault = m.downloaded && localModel === m.id
                    // Size and VRAM say nothing about how well a model drives the
                    // agent — a 4B outscores a 20B here. The tooltip keeps a
                    // measured rate and an estimate visibly apart.
                    const grade     = agentGrade(m)
                    const fit       = vramFit(m.vram_estimate_mb, status?.vram_gb)
                    return (
                      <div
                        key={m.id}
                        className={`rounded-xl border px-3.5 py-3 flex flex-col gap-2 bg-zinc-900/40 ${isDefault ? 'border-accent/40' : 'border-zinc-800'}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[12.5px] font-medium text-zinc-200 leading-snug break-words" title={m.name}>{m.name}</p>
                          {isDefault && (
                            <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">Default</span>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-1">
                          {m.source === 'custom' && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-500">custom</span>
                          )}
                          {tags.includes('cad') && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-violet-400">CAD</span>
                          )}
                          {tags.includes('vision') && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-400">Vision</span>
                          )}
                          {grade && (
                            <span title={grade.title} className={`text-[9px] px-1.5 py-0.5 rounded border ${grade.className}`}>{grade.label}</span>
                          )}
                          {fit && (
                            <span className={`text-[9px] px-1.5 py-0.5 rounded border ${fit.className}`}>{fit.label}</span>
                          )}
                        </div>

                        <p className="text-[10.5px] text-zinc-500">
                          {formatBytes(m.size_bytes)}
                          {m.quant ? ` · ${m.quant}` : ''}
                          {m.vram_estimate_mb ? ` · ~${(m.vram_estimate_mb / 1000).toFixed(1)} GB VRAM` : ''}
                        </p>

                        {m.description && (
                          <p className="text-[10.5px] text-zinc-600 leading-relaxed line-clamp-3" title={m.description}>{m.description}</p>
                        )}

                        <div className="mt-auto pt-1 flex flex-col gap-2">
                          {dl && <SseProgressBar event={dl} />}
                          <div className="flex items-center gap-2">
                            {m.downloaded ? (
                              <>
                                {!isDefault && (
                                  <button
                                    onClick={() => setLocalModel(m.id)}
                                    className="text-[10.5px] px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors"
                                  >
                                    Select
                                  </button>
                                )}
                                <button
                                  onClick={() => handleDelete(m.id)}
                                  title="Delete model file"
                                  aria-label={`Delete ${m.name}`}
                                  className="ml-auto text-zinc-600 hover:text-red-400 transition-colors"
                                >
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                </button>
                              </>
                            ) : dl ? (
                              <>
                                {dl.paused ? (
                                  <button
                                    onClick={() => startDownload(m.id)}
                                    className="text-[10.5px] px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors"
                                  >
                                    Resume
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => void pauseDownload(m.id)}
                                    className="text-[10.5px] px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors"
                                  >
                                    Pause
                                  </button>
                                )}
                                <button
                                  onClick={() => void cancelDownload(m.id)}
                                  className="text-[10.5px] px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-red-400 transition-colors"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => startDownload(m.id)}
                                className="text-[10.5px] px-2.5 py-1 rounded-md bg-accent hover:bg-accent-dark text-white font-medium transition-colors"
                              >
                                Download
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {section.items.length === 0 && (
                <p className="text-[11px] text-zinc-600 py-2">{section.empty}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
