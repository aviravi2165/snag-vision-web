/**
 * WalkthroughBar.jsx
 *
 * The capture-session header for Site Capture (and the history strip for the
 * project). Shows:
 *   - past (completed) walkthroughs as a history strip — click to view read-only
 *   - the current active walkthrough with its live status badge
 *   - "Start Walkthrough N" when no walkthrough is active (captures are locked
 *     server-side until one is started — see services/walkthrough_service.py)
 *   - "Complete Walkthrough": calls request-complete first; if the backend
 *     reports expected-but-uncaptured rooms, a confirmation dialog asks
 *     "Go back / Complete anyway" before the final confirm-complete.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'

const STATUS_META = {
  draft:             { label: 'Draft',             color: '#9AA3C0' },
  capturing:         { label: 'Capturing',         color: '#E8A317' },
  ready_to_complete: { label: 'Ready to complete', color: '#6E7DEC' },
  completed:         { label: 'Completed',         color: '#22B96B' },
  ai_processing:     { label: 'AI analysing…',     color: '#E8A317' },
  ai_completed:      { label: 'AI complete',       color: '#22B96B' },
}

export default function WalkthroughBar({
  walkthroughs = [],
  current = null,
  nextNumber = 1,
  viewing = null,
  busy = false,
  onStartWalkthrough,
  onRequestComplete,
  onConfirmComplete,
  onViewWalkthrough,
  onExitView,
}) {
  const [dialogWarnings, setDialogWarnings] = useState(null)

  const completed = walkthroughs.filter(w =>
    ['completed', 'ai_processing', 'ai_completed'].includes(w.status)
  )

  const handleCompleteClick = async () => {
    if (busy) return
    try {
      const res = await onRequestComplete()   // { walkthrough, warnings }
      if (res?.warnings?.length) {
        setDialogWarnings(res.warnings)
      } else {
        await finishComplete()
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not request completion')
    }
  }

  const finishComplete = async () => {
    setDialogWarnings(null)
    await onConfirmComplete()
    toast.success('Walkthrough completed 🎉')
  }

  const statusMeta = current ? STATUS_META[current.status] : null

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>

        {/* ── Current walkthrough / Start CTA ── */}
        {current ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 14, color: 'var(--text-1)' }}>
              Walkthrough {current.number}
            </div>
            {statusMeta && (
              <span style={{
                fontSize: 11, fontWeight: 600, color: statusMeta.color,
                background: 'var(--bg-hover)', border: '1px solid var(--border)',
                borderRadius: 20, padding: '3px 10px',
              }}>
                ● {statusMeta.label}
              </span>
            )}
            {viewing && (
              <button className="btn-ghost" onClick={onExitView} style={{ fontSize: 12 }}>
                ← Exit read-only view
              </button>
            )}
            {['capturing', 'ready_to_complete'].includes(current.status) && (
              <button className="btn-primary" onClick={handleCompleteClick}
                disabled={busy} style={{ fontSize: 12, padding: '7px 14px' }}>
                {busy ? 'Working…' : '✓ Complete Walkthrough'}
              </button>
            )}
          </div>
        ) : (
          <button className="btn-primary" onClick={onStartWalkthrough} disabled={busy}
            style={{ fontSize: 12, padding: '7px 14px' }}>
            {busy ? 'Starting…' : `▶ Start Walkthrough ${nextNumber}`}
          </button>
        )}

        {/* ── History strip ── */}
        {completed.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 2 }}>History:</span>
            {completed.map(w => (
              <button
                key={w.id}
                onClick={() => onViewWalkthrough(w)}
                title={`Walkthrough ${w.number} · ${STATUS_META[w.status]?.label || w.status}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: 11, padding: '3px 9px', borderRadius: 20,
                  border: '1px solid var(--border)', cursor: 'pointer',
                  color: viewing?.id === w.id ? 'var(--amber)' : 'var(--text-2)',
                  background: viewing?.id === w.id ? 'var(--amber-glow)' : 'var(--bg-hover)',
                }}
              >
                <span style={{ color: '#22B96B', fontSize: 10 }}>✔</span>
                Walkthrough {w.number}
                {w.status === 'ai_completed' && (
                  <span style={{ fontSize: 10, color: 'var(--text-3)' }}>AI done</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── request-complete confirmation dialog ── */}
      {dialogWarnings && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div className="card" style={{ maxWidth: 460, width: '90%', padding: 22 }}>
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 16, color: 'var(--text-1)', marginBottom: 6 }}>
              ⚠️ {dialogWarnings.length} room{dialogWarnings.length === 1 ? '' : 's'} not captured yet
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>
              These expected points have no photo in this walkthrough:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 18 }}>
              {dialogWarnings.map(w => (
                <div key={w.room_id} style={{
                  fontSize: 12, color: 'var(--text-2)', background: 'var(--bg-hover)',
                  border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px',
                }}>
                  {w.room_name || w.room_id}
                  {w.floor_number != null && (
                    <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>Floor {w.floor_number}</span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" onClick={() => setDialogWarnings(null)} style={{ fontSize: 12 }}>
                ← Go back
              </button>
              <button className="btn-primary" onClick={finishComplete} style={{ fontSize: 12 }}>
                Complete anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
