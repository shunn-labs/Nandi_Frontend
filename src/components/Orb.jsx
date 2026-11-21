import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'

// ── Vertex shader: displaces sphere surface with noise ──
const vertexShader = `
  uniform float uTime;
  uniform float uAmplitude;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vDisplacement;

  // Simplex-style noise
  vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    float noise = snoise(position * 2.0 + uTime * 0.4);
    float noise2 = snoise(position * 4.0 - uTime * 0.6) * 0.5;
    float displacement = (noise + noise2) * (0.08 + uAmplitude * 0.35);
    vDisplacement = displacement;

    vec3 newPos = position + normal * displacement;
    vNormal = normalize(normalMatrix * normal);
    vPosition = newPos;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
  }
`

// ── Fragment shader: cyan glow with fresnel ──
const fragmentShader = `
  uniform float uTime;
  uniform float uAmplitude;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vDisplacement;

  void main() {
    // Fresnel
    vec3 viewDir = normalize(cameraPosition - vPosition);
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 2.5);

    // Base colour
    vec3 core = vec3(0.0, 0.65, 0.85);        // deep cyan
    vec3 glow = vec3(0.0, 0.92, 1.0);         // bright cyan
    vec3 highlight = vec3(0.6, 1.0, 1.0);     // white-cyan

    // Mix based on displacement and fresnel
    float disp = smoothstep(-0.1, 0.15, vDisplacement);
    vec3 color = mix(core, glow, disp);
    color = mix(color, highlight, fresnel * 0.7);

    // Pulse brightness with amplitude
    float brightness = 0.7 + uAmplitude * 0.6;
    color *= brightness;

    // Edge glow
    float alpha = 0.85 + fresnel * 0.15;

    gl_FragColor = vec4(color, alpha);
  }
`

/**
 * `amplitude` drives the orb through React props. `levelRef`, when given,
 * takes over: the animation loop reads `levelRef.current` every frame, so a
 * source that updates many times a second (a voice session's audio levels)
 * moves the orb without re-rendering whatever owns it.
 */
export default function Orb({ amplitude = 0, levelRef = null }) {
  const mountRef = useRef(null)
  const stateRef = useRef({
    renderer: null,
    scene: null,
    camera: null,
    mesh: null,
    uniforms: null,
    raf: null,
    smoothAmp: 0,
  })

  const amplitudeRef = useRef(amplitude)
  amplitudeRef.current = amplitude
  const levelSourceRef = useRef(levelRef)
  levelSourceRef.current = levelRef

  const init = useCallback(() => {
    const container = mountRef.current
    if (!container) return

    const width = container.clientWidth
    const height = container.clientHeight

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    camera.position.z = 3

    const uniforms = {
      uTime: { value: 0 },
      uAmplitude: { value: 0 },
    }

    const geometry = new THREE.SphereGeometry(0.9, 64, 64)
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
    })

    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    // Subtle ambient glow (point light behind)
    const light = new THREE.PointLight(0x00d4ff, 0.5, 10)
    light.position.set(0, 0, -2)
    scene.add(light)

    const state = stateRef.current
    state.renderer = renderer
    state.scene = scene
    state.camera = camera
    state.mesh = mesh
    state.uniforms = uniforms

    function animate(time) {
      state.raf = requestAnimationFrame(animate)

      const t = time * 0.001
      uniforms.uTime.value = t

      // Smooth amplitude transition
      const target = levelSourceRef.current ? (levelSourceRef.current.current || 0) : amplitudeRef.current
      state.smoothAmp += (target - state.smoothAmp) * 0.12
      uniforms.uAmplitude.value = state.smoothAmp

      // Gentle rotation
      mesh.rotation.y = t * 0.15
      mesh.rotation.x = Math.sin(t * 0.1) * 0.1

      renderer.render(scene, camera)
    }

    animate(0)
  }, [])

  useEffect(() => {
    init()

    const handleResize = () => {
      const container = mountRef.current
      const { renderer, camera } = stateRef.current
      if (!container || !renderer) return
      const w = container.clientWidth
      const h = container.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      const state = stateRef.current
      cancelAnimationFrame(state.raf)
      if (state.renderer) {
        state.renderer.dispose()
        state.renderer.domElement?.remove()
      }
    }
  }, [init])

  return (
    <div className="orb-container">
      <div ref={mountRef} className="orb-canvas" />
    </div>
  )
}
