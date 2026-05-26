/**
 * BlochSphere.jsx — Interactive Three.js Bloch sphere.
 *
 * Controls:
 *   Drag  — rotate the sphere freely (OrbitControls with damping)
 *   Scroll / +− buttons — zoom in/out
 *   Auto-rotates slowly until the user first touches the sphere, then stops.
 *
 * Physics:
 *   State vector → partial trace → single-qubit ρ → Bloch vector (x,y,z).
 *   Arrow animates via SLERP over 300 ms.
 *   Mixed/noisy states: arrow shrinks + turns grey + purity wireframe appears.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { statevectorToBloch, slerp, magnitude } from '../utils/blochMath'

const ANIM_MS     = 300
const CAM_DEFAULT = 3.2
const CAM_MIN     = 1.8
const CAM_MAX     = 7.0

// Axis lengths — Y kept shorter so it doesn't dominate the view
const AXIS_LEN   = 1.18   // X and Z
const Y_AXIS_LEN = 0.82   // Y (blue) — visually shorter

export default function BlochSphere({ statevector, noiseActive }) {
  const mountRef      = useRef(null)
  const rendererRef   = useRef(null)
  const sceneRef      = useRef(null)
  const cameraRef     = useRef(null)
  const controlsRef   = useRef(null)   // OrbitControls instance
  const arrowRef      = useRef(null)
  const pureSphRef    = useRef(null)
  const animRef       = useRef(null)
  const frameRef      = useRef(null)
  const userTouchedRef = useRef(false) // stops auto-rotate after first drag

  const [qubitIdx,  setQubitIdx]  = useState(0)
  const [numQubits, setNumQubits] = useState(1)
  const [purity,    setPurity]    = useState(1)
  const [blochXYZ,  setBlochXYZ]  = useState([0, 0, 1])
  const [isAutoSpin, setIsAutoSpin] = useState(true)  // shown in header

  // ---- Scene setup (once on mount) ------------------------------------------
  useEffect(() => {
    const container = mountRef.current
    if (!container) return

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x0d0d0d, 1)
    renderer.setSize(container.clientWidth, container.clientHeight)
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // Scene
    const scene = new THREE.Scene()
    sceneRef.current = scene

    // Camera
    const camera = new THREE.PerspectiveCamera(
      38, container.clientWidth / container.clientHeight, 0.01, 100,
    )
    camera.position.set(CAM_DEFAULT * 0.7, CAM_DEFAULT * 0.55, CAM_DEFAULT * 0.7)
    camera.lookAt(0, 0, 0)
    cameraRef.current = camera

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.35))
    const dl = new THREE.DirectionalLight(0xffffff, 0.7)
    dl.position.set(3, 5, 3)
    scene.add(dl)

    // --- Sphere geometry -------------------------------------------------------
    const sGeo = new THREE.SphereGeometry(1, 36, 36)

    // Wireframe shell
    scene.add(new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({
      color: 0x163322, wireframe: true, transparent: true, opacity: 0.18,
    })))

    // Faint backface tint
    scene.add(new THREE.Mesh(sGeo, new THREE.MeshPhongMaterial({
      color: 0x001a0d, transparent: true, opacity: 0.08, side: THREE.BackSide,
    })))

    // Equatorial + meridian circles
    scene.add(makeCircle(1, 0x1e3c28, 'xz'))
    scene.add(makeCircle(1, 0x162a1e, 'xy'))
    scene.add(makeCircle(1, 0x162a1e, 'yz'))

    // --- Axes -----------------------------------------------------------------
    addAxis(scene, AXIS_LEN,   AXIS_LEN * 0.5,   'x', 0xff3333)
    addAxis(scene, Y_AXIS_LEN, Y_AXIS_LEN * 0.5, 'y', 0x3355ff)
    addAxis(scene, AXIS_LEN,   AXIS_LEN * 0.5,   'z', 0x22cc55)

    // Axis labels
    addLabel(scene, 'X',   AXIS_LEN + 0.14,    0,                0,               0xff4444)
    addLabel(scene, 'Y',   0,                  Y_AXIS_LEN + 0.14, 0,              0x4466ff)
    addLabel(scene, 'Z',   0,                  0,                AXIS_LEN + 0.14, 0x33ee66)
    addLabel(scene, '|0⟩', 0,                  0,                1.22,            0xaaaaaa)
    addLabel(scene, '|1⟩', 0,                  0,               -1.22,            0x888888)

    // --- State vector arrow ---------------------------------------------------
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 0),
      0.88, 0xffaa00, 0.14, 0.07,
    )
    scene.add(arrow)
    arrowRef.current = arrow

    // --- Purity sphere --------------------------------------------------------
    const pureSph = new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({
      color: 0xffaa00, wireframe: true, transparent: true, opacity: 0,
    }))
    scene.add(pureSph)
    pureSphRef.current = pureSph

    // --- OrbitControls --------------------------------------------------------
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping     = true
    controls.dampingFactor     = 0.06
    controls.enablePan         = false      // pan doesn't make sense for a sphere
    controls.minDistance       = CAM_MIN
    controls.maxDistance       = CAM_MAX
    controls.autoRotate        = true       // slow spin until user interacts
    controls.autoRotateSpeed   = 0.9
    // Tell OrbitControls it owns the mousewheel so we don't need a separate handler
    controls.enableZoom        = true
    controls.zoomSpeed         = 0.6
    controlsRef.current        = controls

    // Stop auto-rotate the moment the user grabs the sphere
    controls.addEventListener('start', () => {
      if (!userTouchedRef.current) {
        userTouchedRef.current = true
        controls.autoRotate = false
        setIsAutoSpin(false)
      }
    })

    // --- Animation loop -------------------------------------------------------
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate)
      controls.update()   // required for damping + autoRotate

      // SLERP progress
      const anim = animRef.current
      if (anim && anim.progress < 1) {
        anim.progress = Math.min(1, anim.progress + 16 / ANIM_MS)
        _setArrow(slerp(anim.from, anim.to, easeInOut(anim.progress)))
      }

      renderer.render(scene, camera)
    }
    animate()

    // --- Resize ---------------------------------------------------------------
    const ro = new ResizeObserver(() => {
      if (!container) return
      const w = container.clientWidth, h = container.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(container)

    return () => {
      ro.disconnect()
      controls.dispose()
      cancelAnimationFrame(frameRef.current)
      renderer.dispose()
      if (container.contains(renderer.domElement))
        container.removeChild(renderer.domElement)
    }
  }, []) // eslint-disable-line

  // ---- Statevector → Bloch vector -------------------------------------------
  useEffect(() => {
    if (!statevector?.length) return

    const n = Math.round(Math.log2(statevector.length))
    setNumQubits(n)

    const bloch = statevectorToBloch(statevector, Math.min(qubitIdx, n - 1))
    const mag   = magnitude(bloch)
    setPurity(mag)
    setBlochXYZ(bloch)

    const isMixed = mag < 0.05

    const arrow   = arrowRef.current
    const fromDir = arrow
      ? (() => { const d = new THREE.Vector3(); arrow.getWorldDirection(d); return [d.x, d.y, d.z] })()
      : [0, 0, 1]

    animRef.current = {
      from: fromDir,
      to:   isMixed ? [0, 0, 1] : bloch.map(v => v / mag),
      progress: 0,
      length:   mag,
      isMixed,
    }

    if (pureSphRef.current) {
      pureSphRef.current.scale.setScalar(Math.max(mag, 0.02))
      pureSphRef.current.material.opacity = (noiseActive || isMixed) ? 0.14 : 0
    }
  }, [statevector, qubitIdx, noiseActive])

  // ---- Arrow update (called from RAF loop) ----------------------------------
  const _setArrow = (dir) => {
    const arrow = arrowRef.current
    if (!arrow) return
    const a   = animRef.current
    const mag = a?.length ?? 1

    if (a?.isMixed || mag < 0.05) {
      arrow.setLength(0.015, 0, 0)
      arrow.setColor(new THREE.Color(0x333333))
      return
    }

    const v3 = new THREE.Vector3(...dir)
    if (v3.lengthSq() < 1e-10) return
    v3.normalize()
    arrow.setDirection(v3)

    const visLen  = Math.min(mag * 0.88, 0.88)
    const headLen = Math.min(0.14, 0.14 * mag)
    const headRad = Math.min(0.07, 0.07 * mag)
    arrow.setLength(visLen, headLen, headRad)

    const colour = new THREE.Color().lerpColors(
      new THREE.Color(0x333333),
      new THREE.Color(0xffaa00),
      Math.pow(mag, 0.5),
    )
    arrow.setColor(colour)
  }

  // ---- Zoom buttons (adjust camera distance toward/away from origin) --------
  const zoom = useCallback((delta) => {
    const cam = cameraRef.current
    if (!cam) return
    const d = cam.position.length()
    const nd = Math.max(CAM_MIN, Math.min(CAM_MAX, d + delta))
    cam.position.setLength(nd)
    // Also update OrbitControls internal state so damping stays consistent
    controlsRef.current?.update()
  }, [])

  // ---- Reset rotation to default view --------------------------------------
  const resetView = useCallback(() => {
    const cam = cameraRef.current
    const ctrl = controlsRef.current
    if (!cam || !ctrl) return
    cam.position.set(CAM_DEFAULT * 0.7, CAM_DEFAULT * 0.55, CAM_DEFAULT * 0.7)
    cam.lookAt(0, 0, 0)
    ctrl.reset()
    ctrl.autoRotate = true
    userTouchedRef.current = false
    setIsAutoSpin(true)
  }, [])

  // ---- Render ---------------------------------------------------------------
  return (
    <div className="panel" style={{ gridColumn: 2, gridRow: 1 }}>
      <div className="panel-header">
        <span className="panel-title">BLOCH SPHERE</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {noiseActive && <span className="noise-badge on">NOISE ●</span>}

          {/* Auto-spin indicator */}
          <span style={{ color: isAutoSpin ? '#333' : '#00ff88', fontSize: 9,
                         cursor: 'pointer', userSelect: 'none' }}
                onClick={resetView}
                title={isAutoSpin ? 'Auto-spinning' : 'Click to reset view & resume spin'}>
            {isAutoSpin ? '⟳ spin' : '⟳ reset'}
          </span>

          <span style={{ color: '#555', fontSize: 9 }}>
            [{blochXYZ.map(v => v.toFixed(2)).join(', ')}]
          </span>
          <span style={{
            color: purity > 0.95 ? '#00ff88' : purity > 0.5 ? '#ffaa00' : '#ff4444',
            fontSize: 10,
          }}>
            γ={purity.toFixed(3)}
          </span>

          <button onClick={() => zoom(-0.4)} style={btnStyle} title="Zoom in">+</button>
          <button onClick={() => zoom( 0.4)} style={btnStyle} title="Zoom out">−</button>
        </div>
      </div>

      {numQubits > 1 && (
        <div className="qubit-selector">
          <span>Qubit:</span>
          <select value={qubitIdx} onChange={e => setQubitIdx(Number(e.target.value))}>
            {Array.from({ length: numQubits }, (_, i) => (
              <option key={i} value={i}>q[{i}]</option>
            ))}
          </select>
          <span style={{ marginLeft: 8, color: '#444', fontSize: 9 }}>partial trace</span>
        </div>
      )}

      {/* Drag hint — fades after first interaction */}
      {isAutoSpin && (
        <div style={{
          position: 'absolute', bottom: 10, left: 0, right: 0,
          textAlign: 'center', fontSize: 9, color: '#333',
          pointerEvents: 'none', userSelect: 'none', zIndex: 10,
          letterSpacing: '0.08em',
        }}>
          drag to rotate · scroll to zoom
        </div>
      )}

      <div ref={mountRef} style={{ flex: 1, minHeight: 0, cursor: 'grab' }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Three.js helpers
// ---------------------------------------------------------------------------

/** Draw one axis (positive arm + faint negative stub). */
function addAxis(scene, posLen, negLen, axis, colour) {
  const dir = { x: axis === 'x', y: axis === 'y', z: axis === 'z' }

  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(dir.x ? posLen : 0, dir.y ? posLen : 0, dir.z ? posLen : 0),
    ]),
    new THREE.LineBasicMaterial({ color: colour }),
  ))

  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(dir.x ? -negLen : 0, dir.y ? -negLen : 0, dir.z ? -negLen : 0),
    ]),
    new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.3 }),
  ))
}

function makeCircle(radius, colour, plane) {
  const pts = Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2
    const c = Math.cos(a) * radius, s = Math.sin(a) * radius
    if (plane === 'xz') return new THREE.Vector3(c, 0, s)
    if (plane === 'xy') return new THREE.Vector3(c, s, 0)
    return new THREE.Vector3(0, c, s)
  })
  return new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: colour }),
  )
}

function addLabel(scene, text, x, y, z, colour) {
  const canvas = document.createElement('canvas')
  canvas.width = 160; canvas.height = 72
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#' + colour.toString(16).padStart(6, '0')
  ctx.font = 'bold 34px JetBrains Mono, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 80, 36)
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }),
  )
  sprite.position.set(x, y, z)
  sprite.scale.set(0.38, 0.18, 1)
  scene.add(sprite)
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

const btnStyle = {
  background: 'transparent',
  border: '1px solid #222',
  color: '#888',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 13,
  width: 20, height: 18,
  lineHeight: '14px',
  padding: 0,
  borderRadius: 2,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
