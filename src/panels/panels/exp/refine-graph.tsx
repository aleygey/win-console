/**
 * exp panel · Graph view — "关系图谱".
 *
 * Renders the experience knowledge graph as a hand-rolled (dependency-free) SVG:
 * experiences are nodes laid out on deterministic radial rings (one ring per
 * `kind`), and the typed chain edges (requires / refines / supports /
 * contradicts / see_also) are drawn between them with per-kind color, dash
 * style and arrowheads. Clicking a node highlights it plus its direct
 * neighbours and dims everything else; clicking empty space clears the focus.
 *
 * Data: `GET /refiner/graph` via {@link useExpClient}. The payload is the
 * exp plugin's chain-graph projection — `{ experiences, edges }` — mirrored by
 * the {@link GraphResponse} types below (see the plugin's
 * `src/api/index.ts` → `/refiner/graph` handler, and `src/store/graph.ts` for
 * the `EdgeKind` enum). We keep the local types narrow to exactly what the view
 * binds, so a server field rename surfaces here as a type error rather than a
 * silent blank.
 *
 * Layout note: the radial placement is fully deterministic (sorted by kind,
 * then by id within a ring) so the same data always paints the same picture —
 * no force simulation, no randomness, no layout libs.
 */

import {
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js"
import { useExpClient } from "../../api/client"
import "./refine-graph.css"

/* ──────────────────────────────────────────────────────────────────────────
   API payload types — narrow projection of `GET /refiner/graph`.
   ────────────────────────────────────────────────────────────────────────── */

/** Typed chain-edge relations between experiences. Mirrors the plugin's
 *  `EdgeKind` enum (store/graph.ts). All five are coloured + drawn distinctly. */
type EdgeKind = "requires" | "refines" | "supports" | "contradicts" | "see_also"

const EDGE_KINDS: EdgeKind[] = [
  "requires",
  "refines",
  "supports",
  "contradicts",
  "see_also",
]

/** One experience node in the graph (the `/refiner/graph` "lite" projection). */
type GraphExp = {
  id: string
  kind: string
  title: string
  abstract?: string
  task_type?: string
  scope?: string
  categories?: string[]
  review_status?: string
  reviewed_at?: number
  observation_count?: number
  last_refined_at?: number
}

/** One typed edge. `requires` / `refines` / `supports` are directed; the others
 *  are semantically symmetric but still stored from→to. */
type GraphEdge = {
  id?: string
  from: string
  to: string
  kind: EdgeKind
  reason?: string
  confidence?: number
  created_at?: number
  created_by?: string
  source_observation_id?: string
}

type GraphResponse = {
  experiences: GraphExp[]
  edges: GraphEdge[]
}

/* ──────────────────────────────────────────────────────────────────────────
   Edge-kind visual semantics.

   These hues are categorical (one per relation type) but route through the
   shared desaturated --kind-* token family (tokens.css) so the graph themes
   with the rest of the console and stays low-chroma / quiet — no saturated
   hardcoded hex. The token strings are used directly as SVG stroke / fill.
   ────────────────────────────────────────────────────────────────────────── */

type EdgeStyle = {
  /** Token-backed hue (`var(--kind-…)`) for stroke + arrowhead + legend. */
  color: string
  /** SVG dash pattern; omitted ⇒ solid. */
  dash?: string
  /** Chinese label shown in the legend. */
  label: string
  /** One-line semantics for the legend tooltip. */
  desc: string
  /** Whether the relation is directed (renders an arrowhead). */
  directed: boolean
}

const EDGE_STYLE: Record<EdgeKind, EdgeStyle> = {
  requires: {
    color: "var(--kind-pattern)",
    label: "先决条件",
    desc: "强依赖 · DAG · 必须先完成对端",
    directed: true,
  },
  refines: {
    color: "var(--kind-fact)",
    dash: "5,3",
    label: "细化",
    desc: "本条是对端的特化 / 补充",
    directed: true,
  },
  supports: {
    color: "var(--kind-recipe)",
    dash: "2,3",
    label: "支持",
    desc: "本条为对端提供支持证据",
    directed: true,
  },
  contradicts: {
    color: "var(--kind-rule_must)",
    dash: "6,3",
    label: "冲突",
    desc: "本条与对端直接矛盾",
    directed: false,
  },
  see_also: {
    color: "var(--text-weaker)",
    dash: "1,4",
    label: "相关",
    desc: "同话题可参考，方向弱",
    directed: false,
  },
}

/* ──────────────────────────────────────────────────────────────────────────
   Layout — deterministic radial rings, one ring per kind.
   ────────────────────────────────────────────────────────────────────────── */

// Square viewBox suits the circular layout and minimises meet-letterboxing when
// the canvas container is taller than it is wide.
const VIEW_W = 760
const VIEW_H = 760
const NODE_R = 6
const MARGIN = 64 // keep nodes off the canvas edge so labels have room

type Positioned = GraphExp & { x: number; y: number; deg: number; cluster: string }

/** First-level category (or the kind as a fallback) — the cluster a node belongs
 *  to, so related experiences group on the canvas instead of spreading evenly. */
function clusterKey(e: GraphExp): string {
  const c = (e.categories ?? [])[0]
  if (c) return c.includes("/") ? c.slice(0, c.indexOf("/")) : c
  return e.kind || "其他"
}

/**
 * Force-directed layout (deterministic Fruchterman–Reingold) with CATEGORY
 * CLUSTERING. Each category gets an anchor point on a ring around the canvas
 * centre; every node is pulled toward its category's anchor (in addition to edge
 * attraction + universal repulsion). So sparse / disconnected libraries no longer
 * collapse into one uniform square — they break into readable category clusters,
 * with edge-connected nodes drawn together within and across groups.
 *
 * Deterministic (id-seeded, no Math.random) so the same graph paints identically.
 */
function computeLayout(
  exps: GraphExp[],
  edges: GraphEdge[],
): { positioned: Positioned[]; byId: Map<string, Positioned> } {
  const cx = VIEW_W / 2
  const cy = VIEW_H / 2
  const n = exps.length
  if (n === 0) return { positioned: [], byId: new Map() }

  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }

  // Category anchors on a ring (deterministic order). One cluster ⇒ centre.
  const clusters = [...new Set(exps.map(clusterKey))].sort((a, b) => a.localeCompare(b))
  const anchor = new Map<string, { x: number; y: number }>()
  const ringR = clusters.length <= 1 ? 0 : Math.min(VIEW_W, VIEW_H) * 0.3
  clusters.forEach((c, i) => {
    const a = (i / clusters.length) * Math.PI * 2 - Math.PI / 2
    anchor.set(c, { x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR })
  })

  // Seed each node near its cluster anchor (id-sorted jitter angle).
  const sorted = [...exps].sort((a, b) => a.id.localeCompare(b.id))
  type Node = Positioned & { dx: number; dy: number }
  const nodes: Node[] = sorted.map((e, i) => {
    const cl = clusterKey(e)
    const c = anchor.get(cl) ?? { x: cx, y: cy }
    const a = (i / n) * Math.PI * 2
    return { ...e, deg: degree.get(e.id) ?? 0, cluster: cl, x: c.x + Math.cos(a) * 36, y: c.y + Math.sin(a) * 36, dx: 0, dy: 0 }
  })
  const pos = new Map(nodes.map((nd) => [nd.id, nd]))
  const links = edges.filter((e) => pos.has(e.from) && pos.has(e.to))

  const k = Math.sqrt((VIEW_W * VIEW_H) / n) * 0.42 // ideal edge length (tighter)
  let temp = VIEW_W / 8

  for (let it = 0; it < 340; it++) {
    for (const nd of nodes) {
      nd.dx = 0
      nd.dy = 0
    }
    // Repulsion — every pair (O(n²); fine for the sizes we render).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!
        const b = nodes[j]!
        const ddx = a.x - b.x
        const ddy = a.y - b.y
        const dist = Math.hypot(ddx, ddy) || 0.01
        const rep = (k * k) / dist
        a.dx += (ddx / dist) * rep
        a.dy += (ddy / dist) * rep
        b.dx -= (ddx / dist) * rep
        b.dy -= (ddy / dist) * rep
      }
    }
    // Attraction — along edges.
    for (const l of links) {
      const a = pos.get(l.from)!
      const b = pos.get(l.to)!
      const ddx = a.x - b.x
      const ddy = a.y - b.y
      const dist = Math.hypot(ddx, ddy) || 0.01
      const att = (dist * dist) / k
      a.dx -= (ddx / dist) * att
      a.dy -= (ddy / dist) * att
      b.dx += (ddx / dist) * att
      b.dy += (ddy / dist) * att
    }
    // Cluster gravity — pull each node to its CATEGORY anchor (the key change;
    // makes disconnected nodes form readable groups instead of one square).
    for (const nd of nodes) {
      const c = anchor.get(nd.cluster) ?? { x: cx, y: cy }
      nd.dx += (c.x - nd.x) * 0.06
      nd.dy += (c.y - nd.y) * 0.06
    }
    // Apply, capped by temperature; clamp to the viewport.
    for (const nd of nodes) {
      const dl = Math.hypot(nd.dx, nd.dy) || 0.01
      nd.x += (nd.dx / dl) * Math.min(dl, temp)
      nd.y += (nd.dy / dl) * Math.min(dl, temp)
      nd.x = Math.max(MARGIN, Math.min(VIEW_W - MARGIN, nd.x))
      nd.y = Math.max(MARGIN, Math.min(VIEW_H - MARGIN, nd.y))
    }
    temp *= 0.975 // cool
  }

  const positioned: Positioned[] = nodes
  const byId = new Map(positioned.map((p) => [p.id, p]))
  return { positioned, byId }
}

/** Node radius scaled by degree — hubs render larger. */
function nodeRadius(deg: number, on: boolean): number {
  const base = NODE_R + Math.min(deg, 8) * 0.7
  return on ? base + 3 : base
}

/* ──────────────────────────────────────────────────────────────────────────
   Component.
   ────────────────────────────────────────────────────────────────────────── */

export function RefineGraph(): JSX.Element {
  const client = useExpClient()

  const [graph, { refetch }] = createResource<GraphResponse>(() =>
    client.get<GraphResponse>("/refiner/graph"),
  )

  // Focused node id. Clicking a node focuses it and pulls its depth-N recall set
  // from the backend; clicking it again, or the empty canvas, clears the focus.
  const [focusId, setFocusId] = createSignal<string | null>(null)
  const [hiddenKinds, setHiddenKinds] = createSignal<Set<EdgeKind>>(new Set())
  // Recall depth (how many edge hops to pull when a node is clicked).
  const [depth, setDepth] = createSignal(1)
  // The backend's depth-N subgraph for the focused node (the "召回" set).
  const [recall, setRecall] = createSignal<{ nodes: Set<string>; edges: Set<string> } | null>(null)
  // Pan/zoom via the SVG viewBox (keeps node coords in the 0..VIEW space).
  const [vb, setVb] = createSignal({ x: 0, y: 0, w: VIEW_W, h: VIEW_H })
  // Per-node drag overrides (id → position), takes precedence over the layout.
  const [drag, setDrag] = createSignal<Map<string, { x: number; y: number }>>(new Map())

  const exps = createMemo(() => graph()?.experiences ?? [])
  const allEdges = createMemo(() => graph()?.edges ?? [])
  const layout = createMemo(() => computeLayout(exps(), allEdges()))

  // Category cluster centroids (from the laid-out nodes) → faint backdrop labels
  // so each group is legible. Only when there's more than one cluster.
  const clusterLabels = createMemo(() => {
    const groups = new Map<string, { x: number; y: number; n: number }>()
    for (const p of layout().positioned) {
      const g = groups.get(p.cluster) ?? { x: 0, y: 0, n: 0 }
      g.x += p.x
      g.y += p.y
      g.n += 1
      groups.set(p.cluster, g)
    }
    if (groups.size <= 1) return []
    return [...groups.entries()].map(([name, g]) => ({ name, x: g.x / g.n, y: g.y / g.n, n: g.n }))
  })

  /** Live position of a node: a drag override if any, else the force-layout slot.
   *  (Nodes stay put on focus — no teleport; focus only highlights/dims in place.) */
  function posOf(id: string): { x: number; y: number } {
    const o = drag().get(id)
    if (o) return o
    const b = layout().byId.get(id)
    return b ? { x: b.x, y: b.y } : { x: VIEW_W / 2, y: VIEW_H / 2 }
  }

  const edges = createMemo(() => {
    const byId = layout().byId
    const hidden = hiddenKinds()
    return allEdges().filter((e) => byId.has(e.from) && byId.has(e.to) && !hidden.has(e.kind))
  })

  const edgeKey = (e: GraphEdge) => e.id ?? `${e.kind}:${e.from}->${e.to}`

  /** Highlight set = the backend recall subgraph when loaded, else the focused
   *  node's direct neighbours over visible edges. */
  const highlight = createMemo<Set<string>>(() => {
    const id = focusId()
    if (!id) return new Set()
    const r = recall()
    if (r) return r.nodes
    const set = new Set<string>([id])
    for (const e of edges()) {
      if (e.from === id) set.add(e.to)
      else if (e.to === id) set.add(e.from)
    }
    return set
  })

  const isFocusMode = () => focusId() !== null
  const nodeDimmed = (id: string) => isFocusMode() && !highlight().has(id)

  // Related experiences of the focused node, grouped by edge kind (for the side
  // panel). Direct edges only (depth-1) — the clearest "what's related" list; the
  // depth selector still controls how far the graph dims/highlights.
  const relatedGroups = createMemo(() => {
    const id = focusId()
    if (!id) return [] as Array<{ kind: EdgeKind; items: Array<{ id: string; title: string; dir: "in" | "out" }> }>
    const titleOf = new Map(exps().map((e) => [e.id, e.title] as const))
    const groups = new Map<EdgeKind, Array<{ id: string; title: string; dir: "in" | "out" }>>()
    const add = (kind: EdgeKind, otherId: string, dir: "in" | "out") => {
      const arr = groups.get(kind) ?? []
      if (!arr.some((x) => x.id === otherId)) arr.push({ id: otherId, title: titleOf.get(otherId) ?? otherId, dir })
      groups.set(kind, arr)
    }
    for (const e of allEdges()) {
      if (e.from === id) add(e.kind, e.to, "out")
      else if (e.to === id) add(e.kind, e.from, "in")
    }
    return [...groups.entries()].map(([kind, items]) => ({ kind, items }))
  })
  const focusedTitle = () => {
    const id = focusId()
    return id ? (exps().find((e) => e.id === id)?.title ?? id) : ""
  }
  const edgeActive = (e: GraphEdge) => {
    const id = focusId()
    if (!id) return false
    const r = recall()
    if (r) return r.edges.has(edgeKey(e)) || (r.nodes.has(e.from) && r.nodes.has(e.to))
    return e.from === id || e.to === id
  }
  const edgeDimmed = (e: GraphEdge) => isFocusMode() && !edgeActive(e)

  function toggleKind(k: EdgeKind) {
    setHiddenKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  /** Pull the depth-N recall subgraph for a node from the exp backend — the same
   *  relationship+depth expansion the agent's retrieval uses. */
  async function loadRecall(id: string) {
    try {
      const r = await client.get<{ nodes?: string[]; edges?: GraphEdge[] }>(
        `/refiner/experience/${encodeURIComponent(id)}/neighbors?max_depth=${depth()}&direction=both`,
      )
      setRecall({
        nodes: new Set<string>([id, ...(r.nodes ?? [])]),
        edges: new Set<string>((r.edges ?? []).map(edgeKey)),
      })
    } catch {
      setRecall(null)
    }
  }

  function focusNode(id: string) {
    const willFocus = focusId() !== id
    setFocusId(willFocus ? id : null)
    if (willFocus) void loadRecall(id)
    else setRecall(null)
  }
  function clearFocus() {
    setFocusId(null)
    setRecall(null)
  }
  function changeDepth(d: number) {
    setDepth(d)
    const id = focusId()
    if (id) void loadRecall(id)
  }

  // Per-edge endpoint geometry (live positions; pad so arrowheads sit on the rim).
  function edgeGeom(e: GraphEdge) {
    const a = posOf(e.from)
    const b = posOf(e.to)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const pad = NODE_R + 3
    return { x1: a.x + ux * pad, y1: a.y + uy * pad, x2: b.x - ux * pad, y2: b.y - uy * pad }
  }

  // ── pan / zoom / drag interaction (pointer-based) ──────────────────────────
  let svgEl: SVGSVGElement | undefined
  let dragId: string | null = null
  let panLast: { x: number; y: number } | null = null
  let downAt: { x: number; y: number } | null = null
  let moved = false

  function toUser(cx: number, cy: number): { x: number; y: number } {
    if (!svgEl) return { x: 0, y: 0 }
    const pt = svgEl.createSVGPoint()
    pt.x = cx
    pt.y = cy
    const m = svgEl.getScreenCTM()
    if (!m) return { x: 0, y: 0 }
    const p = pt.matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }

  function onNodeDown(id: string, e: PointerEvent) {
    e.stopPropagation()
    dragId = id
    downAt = { x: e.clientX, y: e.clientY }
    moved = false
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  function onBgDown(e: PointerEvent) {
    panLast = { x: e.clientX, y: e.clientY }
    downAt = { x: e.clientX, y: e.clientY }
    moved = false
  }
  function onMove(e: PointerEvent) {
    if (dragId) {
      const u = toUser(e.clientX, e.clientY)
      const id = dragId
      setDrag((prev) => {
        const n = new Map(prev)
        n.set(id, u)
        return n
      })
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) moved = true
      return
    }
    if (panLast) {
      const dx = e.clientX - panLast.x
      const dy = e.clientY - panLast.y
      if (Math.hypot(dx, dy) > 3) moved = true
      const v = vb()
      const s = v.w / (svgEl?.clientWidth || VIEW_W)
      setVb({ x: v.x - dx * s, y: v.y - dy * s, w: v.w, h: v.h })
      panLast = { x: e.clientX, y: e.clientY }
    }
  }
  function onUp() {
    const wasNode = dragId
    dragId = null
    panLast = null
    if (!moved) {
      if (wasNode) focusNode(wasNode)
      else clearFocus()
    }
    downAt = null
    moved = false
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const v = vb()
    const u = toUser(e.clientX, e.clientY)
    const f = e.deltaY < 0 ? 0.85 : 1.18
    const nw = Math.max(140, Math.min(VIEW_W * 3, v.w * f))
    const nh = nw * (v.h / v.w)
    setVb({ x: u.x - (u.x - v.x) * (nw / v.w), y: u.y - (u.y - v.y) * (nh / v.h), w: nw, h: nh })
  }
  function zoomBy(f: number) {
    const v = vb()
    const cx = v.x + v.w / 2
    const cy = v.y + v.h / 2
    const nw = Math.max(140, Math.min(VIEW_W * 3, v.w * f))
    const nh = nw * (v.h / v.w)
    setVb({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh })
  }
  function resetView() {
    setVb({ x: 0, y: 0, w: VIEW_W, h: VIEW_H })
    setDrag(new Map())
  }

  const visibleKinds = createMemo<Set<EdgeKind>>(() => {
    const present = new Set<EdgeKind>()
    for (const e of allEdges()) present.add(e.kind)
    return present
  })

  return (
    <div class="rg-root">
      <Show
        when={!graph.loading}
        fallback={<div class="rg-state">加载关系图谱…</div>}
      >
        <Show
          when={!graph.error}
          fallback={
            <div class="rg-state rg-state-error">
              <span>加载失败：{String((graph.error as Error)?.message ?? graph.error)}</span>
              <button type="button" class="rg-retry" onClick={() => refetch()}>
                重试
              </button>
            </div>
          }
        >
          <Show
            when={exps().length > 0}
            fallback={<div class="rg-state">暂无经验，无法绘制关系图谱。</div>}
          >
            <div class="rg-canvas-wrap">
              <svg
                ref={svgEl}
                class="rg-svg"
                viewBox={`${vb().x} ${vb().y} ${vb().w} ${vb().h}`}
                preserveAspectRatio="xMidYMid meet"
                onPointerDown={onBgDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerLeave={onUp}
                onWheel={onWheel}
              >
                {/* One arrowhead marker per edge kind, tinted to the kind hue.
                    Markers can't inherit `currentColor` reliably across
                    browsers when the <line> is styled via class, so we mint a
                    dedicated marker id per kind. */}
                <defs>
                  <For each={EDGE_KINDS}>
                    {(k) => (
                      <marker
                        id={`rg-arrow-${k}`}
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                      >
                        <path d="M0,0 L10,5 L0,10 z" fill={EDGE_STYLE[k].color} />
                      </marker>
                    )}
                  </For>
                </defs>

                {/* Faint category labels behind everything, at each cluster's centroid. */}
                <g class="rg-clusters" aria-hidden="true">
                  <For each={clusterLabels()}>
                    {(c) => (
                      <text
                        class="rg-cluster-label"
                        x={c.x}
                        y={c.y}
                        text-anchor="middle"
                        style={{ "font-size": `${Math.min(34, 16 + c.n)}px` }}
                      >
                        {c.name}
                      </text>
                    )}
                  </For>
                </g>

                {/* Edges (drawn first so nodes sit on top). */}
                <g class="rg-edges">
                  <For each={edges()}>
                    {(e) => {
                      const g = edgeGeom(e)
                      const style = EDGE_STYLE[e.kind]
                      return (
                        <line
                          x1={g.x1}
                          y1={g.y1}
                          x2={g.x2}
                          y2={g.y2}
                          stroke={style.color}
                          stroke-width={edgeActive(e) ? 2.2 : 1.3}
                          stroke-dasharray={style.dash}
                          stroke-linecap="round"
                          class="rg-edge"
                          classList={{ "is-dim": edgeDimmed(e), "is-active": edgeActive(e) }}
                          marker-end={
                            style.directed ? `url(#rg-arrow-${e.kind})` : undefined
                          }
                        >
                          <title>
                            {style.label}
                            {e.reason ? ` · ${e.reason}` : ""}
                          </title>
                        </line>
                      )
                    }}
                  </For>
                </g>

                {/* Nodes. */}
                <g class="rg-nodes">
                  <For each={layout().positioned}>
                    {(n) => {
                      const focused = () => focusId() === n.id
                      return (
                        <g
                          class="rg-node"
                          classList={{
                            "is-on": focused(),
                            "is-dim": nodeDimmed(n.id),
                          }}
                          transform={`translate(${posOf(n.id).x},${posOf(n.id).y})`}
                          onPointerDown={(ev) => onNodeDown(n.id, ev)}
                        >
                          <circle
                            class="rg-node-dot"
                            data-kind={n.kind}
                            r={nodeRadius(n.deg, focused())}
                          />
                          <text
                            class="rg-node-label"
                            classList={{
                              // focus mode: labels for the focused node + its
                              // highlighted relations. overview: only big hubs —
                              // others reveal on hover via pure CSS (no re-render
                              // churn), so labels never pile up.
                              "is-shown": focusId() ? !nodeDimmed(n.id) : n.deg >= 4,
                            }}
                            x={
                              posOf(n.id).x >= VIEW_W / 2
                                ? nodeRadius(n.deg, focused()) + 4
                                : -(nodeRadius(n.deg, focused()) + 4)
                            }
                            y={4}
                            text-anchor={posOf(n.id).x >= VIEW_W / 2 ? "start" : "end"}
                          >
                            {n.title.length > 18 ? n.title.slice(0, 18) + "…" : n.title}
                          </text>
                          <title>
                            {n.title}
                            {"\n"}
                            kind: {n.kind}
                            {n.scope ? `  ·  scope: ${n.scope}` : ""}
                            {n.observation_count !== undefined
                              ? `  ·  obs: ${n.observation_count}`
                              : ""}
                          </title>
                        </g>
                      )
                    }}
                  </For>
                </g>
              </svg>

              {/* Toolbar — a single hairline "glass" panel: recall depth
                  (click a node → backend depth-N recall) + zoom / reset,
                  split by a hairline separator. */}
              <div class="rg-toolbar">
                <div class="rg-depth" title="点击节点后,按此深度沿关系边从后端召回相关经验(同 agent 召回逻辑)">
                  <span class="rg-depth-label">召回深度</span>
                  <For each={[1, 2, 3]}>
                    {(d) => (
                      <button
                        type="button"
                        class="rg-depth-btn"
                        data-active={depth() === d}
                        onClick={() => changeDepth(d)}
                      >
                        {d}
                      </button>
                    )}
                  </For>
                </div>
                <span class="rg-toolbar-sep" aria-hidden="true" />
                <div class="rg-zoom">
                  <button type="button" class="rg-zoom-btn" title="放大" onClick={() => zoomBy(0.85)}>
                    +
                  </button>
                  <button type="button" class="rg-zoom-btn" title="缩小" onClick={() => zoomBy(1.18)}>
                    −
                  </button>
                  <button type="button" class="rg-zoom-btn" title="重置视图" onClick={resetView}>
                    复位
                  </button>
                </div>
              </div>

              {/* Legend — also acts as a per-kind visibility toggle. Only kinds
                  actually present in the data are shown. */}
              <div class="rg-legend" role="group" aria-label="边类型图例">
                <For each={EDGE_KINDS.filter((k) => visibleKinds().has(k))}>
                  {(k) => {
                    const style = EDGE_STYLE[k]
                    const off = () => hiddenKinds().has(k)
                    return (
                      <button
                        type="button"
                        class="rg-legend-row"
                        data-off={off()}
                        title={style.desc}
                        onClick={() => toggleKind(k)}
                      >
                        <span
                          class="rg-legend-swatch"
                          style={{
                            "border-top-color": style.color,
                            "border-top-style": style.dash ? "dashed" : "solid",
                          }}
                          aria-hidden="true"
                        />
                        <span class="rg-legend-label">{style.label}</span>
                        <Show when={style.directed}>
                          <span class="rg-legend-dir" aria-hidden="true">
                            →
                          </span>
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </div>

              {/* Stats / focus chip. */}
              <div class="rg-stats">
                <span class="rg-stat">
                  <b>{exps().length}</b> 节点
                </span>
                <span class="rg-stat-sep" />
                <span class="rg-stat">
                  <b>{edges().length}</b> 边
                </span>
                <Show when={recall()}>
                  {(r) => (
                    <>
                      <span class="rg-stat-sep" />
                      <span class="rg-stat">
                        召回 <b>{r().nodes.size}</b> · 深度 {depth()}
                      </span>
                    </>
                  )}
                </Show>
                <Show when={focusId()}>
                  {(id) => {
                    const node = () => layout().byId.get(id())
                    return (
                      <>
                        <span class="rg-stat-sep" />
                        <button
                          type="button"
                          class="rg-focus-chip"
                          onClick={() => setFocusId(null)}
                          title="清除聚焦"
                        >
                          <span class="rg-focus-name">
                            {node()?.title ?? id()}
                          </span>
                          <span class="rg-focus-x" aria-hidden="true">
                            ×
                          </span>
                        </button>
                      </>
                    )
                  }}
                </Show>
              </div>

              {/* Related-experiences panel — click a node to see its relations
                  listed by kind (the node itself stays put; the graph dims to
                  highlight it + its relations in place). Click an item to jump. */}
              <Show when={isFocusMode()}>
                <aside class="rg-related">
                  <div class="rg-related-hd">
                    <span class="rg-related-title" title={focusedTitle()}>{focusedTitle()}</span>
                    <button type="button" class="rg-related-x" title="清除聚焦" onClick={() => clearFocus()}>
                      ×
                    </button>
                  </div>
                  <div class="rg-related-sub">相关经验</div>
                  <Show
                    when={relatedGroups().length > 0}
                    fallback={<div class="rg-related-empty">这条经验暂无关联边</div>}
                  >
                    <div class="rg-related-body">
                      <For each={relatedGroups()}>
                        {(g) => (
                          <div class="rg-related-group">
                            <div class="rg-related-kind" style={{ color: EDGE_STYLE[g.kind].color }}>
                              {EDGE_STYLE[g.kind].label}
                              <span class="rg-related-n">{g.items.length}</span>
                            </div>
                            <For each={g.items}>
                              {(it) => (
                                <button class="rg-related-item" title={it.title} onClick={() => focusNode(it.id)}>
                                  <span class="rg-related-dir" aria-hidden="true">
                                    {it.dir === "out" ? "→" : "←"}
                                  </span>
                                  <span class="rg-related-itemtitle">{it.title}</span>
                                </button>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </aside>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
