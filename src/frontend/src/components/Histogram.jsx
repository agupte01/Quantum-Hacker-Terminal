/**
 * Histogram.jsx — SVG bar chart of quantum measurement outcomes.
 *
 * Features:
 *  - Probability labels on top of each bar
 *  - Rotated x-axis labels so they never overlap, even for 8-qubit systems
 *  - Toggle between Probability and Counts view
 *  - Dual-series overlay for ideal vs noisy hardware results
 *  - Shor f(x) step-function plot mode
 */

import React, { useMemo, useEffect, useRef, useState } from 'react'

const MARGIN    = { top: 28, right: 16, bottom: 56, left: 48 }
const BAR_GAP   = 0.20
const MAX_BARS  = 32

const C_IDEAL = '#00ff88'
const C_HW    = '#ffaa00'
const C_FN    = '#4488ff'
const C_GRID  = '#1e1e1e'
const C_AXIS  = '#2a2a2a'
const C_TEXT  = '#666'
const C_LABEL = '#00cc66'

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------
export default function Histogram({ histogram, shorFunction }) {
  const bodyRef = useRef(null)
  const [dims,  setDims]  = useState({ width: 0, height: 0 })
  const [mode,  setMode]  = useState('prob')   // 'prob' | 'counts'

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setDims({ width: Math.max(1, r.width), height: Math.max(1, r.height) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- Shor f(x) plot --------------------------------------------------------
  if (shorFunction?.x_values) {
    return (
      <div className="panel" style={{ gridColumn: 2, gridRow: 2 }}>
        <HistHeader title="f(x) = aˣ mod N" extra={null} />
        <div className="histogram-body" ref={bodyRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <FunctionPlot fn={shorFunction} dims={dims} />
        </div>
      </div>
    )
  }

  // --- Standard probability / counts histogram --------------------------------
  const isDual = !!histogram?.hardware_probs
  return (
    <div className="panel" style={{ gridColumn: 2, gridRow: 2 }}>
      <HistHeader
        title="HISTOGRAM"
        extra={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {isDual && <span className="panel-badge">IDEAL vs HW</span>}
            <ModeToggle mode={mode} onChange={setMode} />
          </div>
        }
      />
      <div className="histogram-body" ref={bodyRef}
           style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 0 }}>
        {histogram
          ? <ProbBars histogram={histogram} dims={dims} mode={mode} />
          : <EmptyState />
        }
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Probability / Counts bars
// ---------------------------------------------------------------------------
function ProbBars({ histogram, dims, mode }) {
  const { probabilities: idealProbs, hardware_probs: hwProbs, counts: rawCounts } = histogram

  const entries = useMemo(() => {
    const keys = [...new Set([
      ...Object.keys(idealProbs || {}),
      ...Object.keys(hwProbs   || {}),
    ])].sort().slice(0, MAX_BARS)

    return keys.map(k => ({
      label:    k,
      ideal:    (idealProbs || {})[k] ?? 0,
      hw:       (hwProbs    || {})[k] ?? 0,
      counts:   (rawCounts  || {})[k] ?? 0,
    }))
  }, [idealProbs, hwProbs, rawCounts])

  if (!dims.width || entries.length === 0) return <EmptyState />

  const dual   = !!hwProbs
  const iW     = dims.width  - MARGIN.left - MARGIN.right
  const iH     = dims.height - MARGIN.top  - MARGIN.bottom

  if (iH <= 0 || iW <= 0) return null

  const groupW = iW / entries.length
  const nBars  = dual ? 2 : 1
  const barW   = Math.max(2, (groupW * (1 - BAR_GAP)) / nBars)

  // Y-axis domain
  const vals   = entries.flatMap(e => mode === 'counts'
    ? [e.counts]
    : [e.ideal, dual ? e.hw : 0])
  const maxVal = Math.max(...vals, 0.001)

  // Nice Y ticks
  const ticks  = niceTickValues(maxVal, 4)

  return (
    <svg width="100%" height="100%"
         viewBox={`0 0 ${dims.width} ${dims.height}`}
         preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="gi" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={C_IDEAL} stopOpacity="1" />
          <stop offset="100%" stopColor={C_IDEAL} stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="gh" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={C_HW} stopOpacity="1" />
          <stop offset="100%" stopColor={C_HW} stopOpacity="0.25" />
        </linearGradient>
        {/* Clip region so bars don't spill above the plot area */}
        <clipPath id="plot-clip">
          <rect x={MARGIN.left} y={MARGIN.top} width={iW} height={iH} />
        </clipPath>
      </defs>

      {/* Y-axis grid + tick labels */}
      {ticks.map(t => {
        const y = MARGIN.top + iH * (1 - t / maxVal)
        if (y < MARGIN.top - 1) return null
        return (
          <g key={t}>
            <line x1={MARGIN.left} y1={y} x2={MARGIN.left + iW} y2={y}
                  stroke={C_GRID} strokeWidth={1} strokeDasharray="3 3" />
            <text x={MARGIN.left - 6} y={y + 3.5}
                  textAnchor="end" fontSize={9} fill={C_TEXT}
                  fontFamily="JetBrains Mono, monospace">
              {mode === 'counts' ? Math.round(t) : t.toFixed(2)}
            </text>
          </g>
        )
      })}

      {/* Axes */}
      <line x1={MARGIN.left} y1={MARGIN.top} x2={MARGIN.left} y2={MARGIN.top + iH + 1}
            stroke={C_AXIS} strokeWidth={1} />
      <line x1={MARGIN.left} y1={MARGIN.top + iH}
            x2={MARGIN.left + iW} y2={MARGIN.top + iH}
            stroke={C_AXIS} strokeWidth={1} />

      {/* Y-axis title */}
      <text
        transform={`translate(11, ${MARGIN.top + iH / 2}) rotate(-90)`}
        textAnchor="middle" fontSize={9} fill={C_TEXT}
        fontFamily="JetBrains Mono, monospace">
        {mode === 'counts' ? 'Counts' : 'Probability'}
      </text>

      {/* Bars + labels (clipped) */}
      <g clipPath="url(#plot-clip)">
        {entries.map((e, i) => {
          const gx     = MARGIN.left + i * groupW + (groupW * BAR_GAP) / 2
          const val1   = mode === 'counts' ? e.counts : e.ideal
          const val2   = mode === 'counts' ? 0        : e.hw
          const barH1  = (val1 / maxVal) * iH
          const barH2  = (val2 / maxVal) * iH

          return (
            <g key={e.label}>
              {/* Ideal / primary bar */}
              <rect x={gx} y={MARGIN.top + iH - barH1}
                    width={barW} height={Math.max(0, barH1)}
                    fill="url(#gi)" rx={2} />
              {/* Hardware bar */}
              {dual && val2 > 0 && (
                <rect x={gx + barW + 1} y={MARGIN.top + iH - barH2}
                      width={barW} height={Math.max(0, barH2)}
                      fill="url(#gh)" rx={2} />
              )}
              {/* Value label above bar (skip if bar is too small) */}
              {barH1 > 12 && (
                <text x={gx + barW / 2} y={MARGIN.top + iH - barH1 - 3}
                      textAnchor="middle" fontSize={8} fill={C_IDEAL}
                      fontFamily="JetBrains Mono, monospace">
                  {mode === 'counts' ? val1 : val1.toFixed(3)}
                </text>
              )}
            </g>
          )
        })}
      </g>

      {/* X-axis labels — rotated so they never overlap */}
      {entries.map((e, i) => {
        const cx = MARGIN.left + i * groupW + groupW / 2
        const y  = MARGIN.top + iH + 8
        // Rotate 45° when there are more than 4 bars for readability
        const rotate = entries.length > 4
          ? `rotate(-45, ${cx}, ${y})`
          : ''
        const anchor = entries.length > 4 ? 'end' : 'middle'
        return (
          <text key={e.label}
                x={cx} y={y}
                textAnchor={anchor}
                transform={rotate}
                fontSize={9}
                fill={C_LABEL}
                fontFamily="JetBrains Mono, monospace">
            |{e.label}⟩
          </text>
        )
      })}

      {/* Legend */}
      {dual && (
        <g transform={`translate(${MARGIN.left + 6}, ${MARGIN.top + 6})`}>
          <rect width={8} height={8} fill={C_IDEAL} rx={1} />
          <text x={12} y={7.5} fontSize={8} fill={C_IDEAL}
                fontFamily="JetBrains Mono, monospace">Ideal</text>
          <rect x={48} width={8} height={8} fill={C_HW} rx={1} />
          <text x={60} y={7.5} fontSize={8} fill={C_HW}
                fontFamily="JetBrains Mono, monospace">Hardware</text>
        </g>
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Shor f(x) bar chart
// ---------------------------------------------------------------------------
function FunctionPlot({ fn, dims }) {
  const { x_values, y_values, label } = fn
  if (!x_values?.length || !dims.width) return null

  const iW   = dims.width  - MARGIN.left - MARGIN.right
  const iH   = dims.height - MARGIN.top  - MARGIN.bottom
  const maxY = Math.max(...y_values, 1)
  const barW = Math.max(1, iW / x_values.length - 0.5)

  return (
    <svg width="100%" height="100%"
         viewBox={`0 0 ${dims.width} ${dims.height}`}
         preserveAspectRatio="xMidYMid meet">
      <line x1={MARGIN.left} y1={MARGIN.top + iH}
            x2={MARGIN.left + iW} y2={MARGIN.top + iH}
            stroke={C_AXIS} strokeWidth={1} />

      {x_values.map((x, i) => {
        const barH = (y_values[i] / maxY) * iH
        const bx   = MARGIN.left + i * (barW + 0.5)
        return (
          <rect key={i} x={bx} y={MARGIN.top + iH - barH}
                width={barW} height={barH}
                fill={C_FN} opacity={0.82} rx={1} />
        )
      })}

      {/* Period guides — highlight period by shading every r-th bar */}
      <text x={MARGIN.left + iW / 2} y={dims.height - 6}
            textAnchor="middle" fontSize={10} fill={C_FN}
            fontFamily="JetBrains Mono, monospace">
        {label}
      </text>
      <text x={MARGIN.left - 4} y={MARGIN.top - 4}
            textAnchor="end" fontSize={8} fill={C_TEXT}
            fontFamily="JetBrains Mono, monospace">
        {maxY}
      </text>
      <text x={MARGIN.left - 4} y={MARGIN.top + iH + 3}
            textAnchor="end" fontSize={8} fill={C_TEXT}
            fontFamily="JetBrains Mono, monospace">0</text>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function niceTickValues(max, count) {
  const step = max / count
  const ticks = []
  for (let i = 1; i <= count; i++) ticks.push(parseFloat((step * i).toPrecision(2)))
  return ticks
}

function EmptyState() {
  return (
    <div style={{ color: '#444', fontSize: 12, padding: '20px 16px',
                  fontFamily: 'JetBrains Mono, monospace' }}>
      Run <span style={{ color: '#00ff88' }}>measure</span> to see results.
    </div>
  )
}

function HistHeader({ title, extra }) {
  return (
    <div className="panel-header">
      <span className="panel-title">{title}</span>
      {extra}
    </div>
  )
}

function ModeToggle({ mode, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {['prob', 'counts'].map(m => (
        <button key={m}
          onClick={() => onChange(m)}
          style={{
            background:  mode === m ? '#003322' : 'transparent',
            border:      `1px solid ${mode === m ? '#00ff88' : '#222'}`,
            color:       mode === m ? '#00ff88' : '#555',
            fontFamily:  'JetBrains Mono, monospace',
            fontSize:    9,
            padding:     '1px 6px',
            borderRadius: 2,
            cursor:      'pointer',
          }}>
          {m === 'prob' ? 'Prob' : 'Counts'}
        </button>
      ))}
    </div>
  )
}
