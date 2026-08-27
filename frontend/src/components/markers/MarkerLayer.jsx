/**
 * MarkerLayer — a renderer-agnostic pin overlay.
 *
 * Deliberately knows nothing about Issues, or about how the coordinates were
 * produced. It takes already-projected screen positions and draws pins. That
 * keeps it reusable for every marker type we expect to add later (AI-detected
 * defects, progress checkpoints, QA inspections, safety observations) — those
 * only need to supply a different `markerType` and colour entry.
 *
 * Two producers feed it today:
 *   • 360° panoramas — Panorama360's render-prop supplies {x, y, visible}
 *     recomputed as the sphere rotates (see pages/PanoramaViewer.jsx).
 *   • Flat photos — `projectFlat()` below, a trivial percentage-of-box mapping.
 */

// Pin colour by issue status, falling back to marker type for non-issue pins.
// Matches the app's existing status palette (see components/UI.jsx StatusBadge).
const STATUS_COLOR = {
  open: '#DC3A3A',
  in_progress: '#B8790C',
  resolved: '#12A05C',
  closed: '#6A7699',
}
const TYPE_COLOR = {
  issue: '#DC3A3A',
  ai_defect: '#7A6BE8',
  checkpoint: '#2F41C2',
  qa: '#3D53E0',
  safety: '#B8790C',
}

export function markerColor(marker) {
  return STATUS_COLOR[marker?.status] || TYPE_COLOR[marker?.markerType] || TYPE_COLOR.issue
}

/** Flat (non-360) images: u/v are simply fractions of the rendered box. */
export function projectFlat(points, width, height) {
  return points.map(p => ({
    id: p.id,
    x: p.u * width,
    y: p.v * height,
    visible: true,
  }))
}

/**
 * @param projected  [{ id, x, y, visible }] — screen positions
 * @param markers    [{ id, status, markerType, label, title }] — display data, keyed by id
 * @param selectedId marker to emphasise
 * @param onMarkerClick (id) => void
 * @param pendingPoint  { x, y } — the not-yet-saved marker being placed
 */
export default function MarkerLayer({
  projected = [],
  markers = [],
  selectedId = null,
  onMarkerClick,
  pendingPoint = null,
}) {
  const byId = new Map(markers.map(m => [m.id, m]))

  return (
    // Non-interactive by default so drag-to-look still works through the layer;
    // individual pins re-enable pointer events for themselves.
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {projected.map(p => {
        if (!p.visible) return null
        const m = byId.get(p.id) || {}
        const color = markerColor(m)
        const isSelected = selectedId === p.id
        return (
          <button
            key={p.id}
            title={m.title || 'Marker'}
            onClick={e => { e.stopPropagation(); onMarkerClick?.(p.id) }}
            onMouseDown={e => e.stopPropagation()}  // don't start a camera drag
            style={{
              position: 'absolute', left: p.x, top: p.y,
              transform: `translate(-50%, -100%) scale(${isSelected ? 1.25 : 1})`,
              transformOrigin: 'bottom center',
              pointerEvents: 'auto', cursor: 'pointer',
              background: 'none', border: 'none', padding: 0, lineHeight: 0,
              transition: 'transform .15s',
              filter: isSelected
                ? 'drop-shadow(0 0 6px rgba(255,255,255,.9))'
                : 'drop-shadow(0 1px 3px rgba(0,0,0,.5))',
              zIndex: isSelected ? 3 : 2,
            }}
          >
            <Pin color={color} pulse={isSelected} />
          </button>
        )
      })}

      {pendingPoint && (
        <div style={{
          position: 'absolute', left: pendingPoint.x, top: pendingPoint.y,
          transform: 'translate(-50%, -100%)', transformOrigin: 'bottom center',
          pointerEvents: 'none', zIndex: 4,
        }}>
          <Pin color="#2F41C2" pulse />
        </div>
      )}
    </div>
  )
}

function Pin({ color, pulse }) {
  return (
    <svg width="22" height="30" viewBox="0 0 22 30" style={pulse ? { animation: 'markerPulse 1.2s ease-in-out infinite' } : undefined}>
      <path
        d="M11 0C5 0 0 4.8 0 10.8 0 18.9 11 30 11 30s11-11.1 11-19.2C22 4.8 17 0 11 0z"
        fill={color} stroke="#fff" strokeWidth="1.6"
      />
      <circle cx="11" cy="10.8" r="4" fill="#fff" />
    </svg>
  )
}
