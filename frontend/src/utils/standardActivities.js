/**
 * The standard 12-category activity catalog — the fixed list Floor View and
 * AI Analysis render. MUST stay in sync with the backend:
 * backend/services/activity_catalog.py::STANDARD_ACTIVITIES
 *
 * This is deliberately NOT fetched from the project's activity plan: that
 * plan comes from the Activity Excel (the BoQ items) and drives the
 * Executive dashboard. Floor View / AI Analysis roll raw Gemini components
 * into these standard categories server-side (the `mapped` field on every
 * analysis response, via the global StandardComponentMapping classifier).
 */
export const STANDARD_ACTIVITIES = [
  'Structural and Civil Works',
  'Flooring Tiling',
  'Blockwork and Ceilings',
  'Painting Polishing and Finishes',
  'Architectural Details',
  'Mechanical',
  'Electrical',
  'Plumbing',
  'Interior Design and Space Planning',
  'Lighting Fixtures and Fittings',
  'Doors Windows and Fixed Openings',
  'Furniture and Fixtures',
]
