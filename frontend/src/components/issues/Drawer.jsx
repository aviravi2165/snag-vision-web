/**
 * Drawer — right-side slide-over panel.
 *
 * Deliberately generic (no issue-specific logic) since this is the first
 * shared drawer in the codebase; other features can reuse it. Styling follows
 * the existing side-panel convention from pages/FloorMap.jsx: a `.card`-like
 * surface, a header with a ✕, and a scrolling body.
 */
export default function Drawer({ open, title, subtitle, onClose, width = 380, children, footer }) {
  if (!open) return null
  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width, maxWidth: '92%',
      background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)',
      boxShadow: '-8px 0 24px rgba(0,0,0,0.10)', zIndex: 20,
      display: 'flex', flexDirection: 'column', borderRadius: '0 10px 10px 0',
    }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border-dim)', flexShrink: 0,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 14, color: 'var(--text-1)' }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</div>
          )}
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          background: 'none', border: 'none', color: 'var(--text-3)',
          cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, flexShrink: 0,
        }}>✕</button>
      </div>

      <div style={{ padding: 16, overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {children}
      </div>

      {footer && (
        <div style={{ padding: 16, borderTop: '1px solid var(--border-dim)', flexShrink: 0 }}>
          {footer}
        </div>
      )}
    </div>
  )
}
