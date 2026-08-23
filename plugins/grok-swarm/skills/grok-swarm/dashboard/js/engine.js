/**
 * MissionEngine - WebGL2 mission field: domain-warped nebula fragment pass plus
 * a transform-feedback boid swarm. One GL context, one RAF loop, one global.
 *
 * Every visual quantity is driven by real /api/state telemetry. Fallback chain:
 * full (nebula + boids) -> nebula only -> static CSS gradient (#field-fallback).
 */
(function (global) {
  "use strict";

  var MAX_CLUSTERS = 16;
  var STRIDE = 5; // pos.xy, vel.xy, seed
  var ANCHOR_CAP = 120;
  var PULSE_LIFE = 3.0; // seconds
  var PULSE_OFF = new Float32Array([0, 0, 0, -1]);
  var PULSE_BUF = new Float32Array(4);

  // GLSL note: `active` is a reserved word in GLSL ES 3.00. No identifier in any
  // shader below may be named `active` (not even as a prefix-free local).

  // ---------------------------------------------------------------- nebula --

  var FIELD_VS =
    "#version 300 es\n" +
    "in vec2 aPos;\n" +
    "out vec2 vUv;\n" +
    "void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }";

  var FIELD_FS =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "in vec2 vUv;\n" +
    "out vec4 fragColor;\n" +
    "uniform float uTime;\n" +
    "uniform vec2 uRes;\n" +
    "uniform float uLive;\n" +
    "uniform float uBuilding;\n" +
    "uniform float uReview;\n" +
    "uniform float uBlocked;\n" +
    "uniform float uRam;\n" +
    "uniform float uProgress;\n" +
    "uniform float uDpr;\n" +
    "uniform vec4 uPulse;\n" + // x, y, age(s), type (-1 none, 0 done, 1 blocked)
    "uniform vec4 uClusters[" + MAX_CLUSTERS + "];\n" + // x, y, statusCode, intensity
    "uniform float uClusterCount;\n" +
    "uniform vec3 uStatusColors[4];\n" +
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n" +
    "float noise(vec2 p){\n" +
    "  vec2 i = floor(p); vec2 f = fract(p);\n" +
    "  float a = hash(i); float b = hash(i + vec2(1.0, 0.0));\n" +
    "  float c = hash(i + vec2(0.0, 1.0)); float d = hash(i + vec2(1.0, 1.0));\n" +
    "  vec2 u = f * f * (3.0 - 2.0 * f);\n" +
    "  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;\n" +
    "}\n" +
    "float fbm(vec2 p){\n" +
    "  float v = 0.0; float a = 0.5;\n" +
    "  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);\n" +
    "  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }\n" +
    "  return v;\n" +
    "}\n" +
    "float hexDist(vec2 p){ p = abs(p); return max(p.x * 0.866025 + p.y * 0.5, p.y) - 1.0; }\n" +
    "vec3 tonemap(vec3 x){\n" +
    "  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;\n" +
    "  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);\n" +
    "}\n" +
    "void main(){\n" +
    "  vec2 uv = vUv;\n" +
    "  float aspect = uRes.x / max(uRes.y, 1.0);\n" +
    "  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);\n" +
    "  float energy = clamp(uLive * 0.1 + uBuilding * 0.08 + uReview * 0.05, 0.0, 1.2);\n" +
    "  float t = uTime * (0.1 + energy * 0.06 + uRam * 0.05);\n" +
    // Shockwave refraction: the ring bends the medium it passes through.
    "  float pulseAge = uPulse.z;\n" +
    "  float pulseOn = step(0.0, uPulse.w);\n" +
    "  vec2 pd = p - uPulse.xy;\n" +
    "  float pdist = length(pd);\n" +
    "  float pradius = pulseAge * 0.85;\n" +
    "  float ringGauss = exp(-pow(pdist - pradius, 2.0) * 240.0) * exp(-pulseAge * 1.9) * pulseOn;\n" +
    "  vec2 warp = (pdist > 0.0001 ? pd / pdist : vec2(0.0)) * ringGauss * 0.06;\n" +
    "  vec2 pw = p + warp;\n" +
    // Domain-warped nebula.
    "  vec2 q = pw * 1.65;\n" +
    "  q += 0.4 * vec2(fbm(q + t * 0.35), fbm(q + vec2(5.2, 1.3) - t * 0.55));\n" +
    "  float n = fbm(q * 1.35 + t * 0.22);\n" +
    "  float n2 = fbm(q * 2.8 - t * 0.12);\n" +
    "  float n3 = fbm(q * 0.7 + vec2(t * 0.08, -t * 0.05));\n" +
    "  float lobe = smoothstep(0.22, 0.88, n);\n" +
    "  float veins = smoothstep(0.52, 0.96, n2);\n" +
    "  float deep = smoothstep(0.15, 0.7, n3);\n" +
    "  vec3 col = mix(vec3(0.015, 0.02, 0.045), vec3(0.03, 0.04, 0.08), deep);\n" +
    "  vec3 flowCol = mix(vec3(0.02, 0.22, 0.65), vec3(0.08, 0.75, 0.92), n2);\n" +
    "  col += flowCol * lobe * (0.16 + energy * 0.62);\n" +
    "  col += vec3(0.65, 0.32, 0.04) * uBuilding * veins * 0.28;\n" +
    "  col += vec3(0.42, 0.12, 0.72) * uReview * (1.0 - lobe * 0.6) * 0.16;\n" +
    "  col += vec3(0.85, 0.06, 0.1) * uBlocked * smoothstep(0.55, 1.0, veins) * 0.4;\n" +
    // Hex tactical grid.
    "  float gridScale = 9.0 + uLive * 0.15;\n" +
    "  vec2 hp = pw * gridScale;\n" +
    "  vec2 hid = floor(hp + 0.5);\n" +
    "  vec2 hlocal = (hp - hid) * 1.15;\n" +
    "  float hx = abs(hexDist(hlocal));\n" +
    "  float hline = smoothstep(0.04, 0.0, hx) * (0.04 + energy * 0.06);\n" +
    "  float cellPulse = 0.5 + 0.5 * sin(t * 2.0 + hash(hid) * 6.28);\n" +
    "  col += vec3(0.25, 0.55, 1.0) * hline * cellPulse * (0.35 + uProgress * 0.4);\n" +
    // Progress horizon band.
    "  float bandY = 1.0 - uProgress * 0.42 - 0.12;\n" +
    "  float band = exp(-pow((uv.y - bandY) * 28.0, 2.0));\n" +
    "  col += vec3(0.2, 0.55, 1.0) * band * (0.12 + uProgress * 0.25);\n" +
    // Mission radius rings.
    "  float r = length(p);\n" +
    "  float ring1 = exp(-pow((r - 0.35 - uLive * 0.01) * 40.0, 2.0));\n" +
    "  float ring2 = exp(-pow((r - 0.62) * 55.0, 2.0));\n" +
    "  col += vec3(0.3, 0.7, 1.0) * (ring1 * 0.08 + ring2 * 0.05) * (0.4 + energy);\n" +
    // Cluster wells: each running dispatch stains the nebula in its status color.
    "  int nCl = int(clamp(uClusterCount, 0.0, float(" + MAX_CLUSTERS + ")));\n" +
    "  for (int i = 0; i < " + MAX_CLUSTERS + "; i++) {\n" +
    "    if (i >= nCl) break;\n" +
    "    vec4 cl = uClusters[i];\n" +
    "    vec3 sc = uStatusColors[int(clamp(cl.z, 0.0, 3.0))];\n" +
    "    float cd = length(p - cl.xy);\n" +
    "    float halo = exp(-cd * cd * 26.0);\n" +
    "    float breathe = 0.68 + 0.32 * sin(uTime * (1.1 + cl.w * 2.4) + float(i) * 1.7);\n" +
    "    float corona = exp(-pow(cd - (0.1 + cl.w * 0.06), 2.0) * 420.0);\n" +
    "    col += sc * halo * (0.1 + cl.w * 0.16) * breathe;\n" +
    "    col += sc * corona * 0.1 * breathe;\n" +
    "  }\n" +
    // Starfield.
    "  float stars = 0.0;\n" +
    "  for (int s = 0; s < 40; s++) {\n" +
    "    float si = float(s);\n" +
    "    vec2 st = vec2(hash(vec2(si, 1.0)), hash(vec2(si, 2.0)));\n" +
    "    st = (st - 0.5) * vec2(aspect, 1.0) * 1.8;\n" +
    "    float sd = length(p - st);\n" +
    "    float tw = 0.5 + 0.5 * sin(t * 2.5 + si * 3.1);\n" +
    "    stars += smoothstep(0.008, 0.0, sd) * tw * hash(vec2(si, 9.0));\n" +
    "  }\n" +
    "  col += vec3(0.75, 0.85, 1.0) * stars * 0.35;\n" +
    // RAM pressure vignette and heat.
    "  float vig = smoothstep(0.15, 1.15, r * (0.8 + uRam * 0.55));\n" +
    "  col *= 1.0 - vig * (0.3 + uRam * 0.45);\n" +
    "  col += vec3(0.45, 0.05, 0.02) * uRam * vig * 0.15;\n" +
    "  float edge = smoothstep(0.55, 0.95, r);\n" +
    "  col.r += edge * energy * 0.03;\n" +
    "  col.b += edge * energy * 0.02;\n" +
    // Shockwave: leading ring, trailing echo, ignition core, chromatic split.
    "  if (uPulse.w >= 0.0) {\n" +
    "    float echo = exp(-pow(pdist - pradius * 0.6, 2.0) * 620.0) * exp(-pulseAge * 2.9);\n" +
    "    float core = exp(-pdist * pdist * 110.0) * exp(-pulseAge * 6.0);\n" +
    "    float rIn = exp(-pow(pdist - pradius * 1.04, 2.0) * 240.0) * exp(-pulseAge * 1.9);\n" +
    "    vec3 hot = uPulse.w < 0.5 ? vec3(0.14, 0.95, 0.48) : vec3(0.98, 0.16, 0.12);\n" +
    "    vec3 rim = uPulse.w < 0.5 ? vec3(0.5, 1.0, 0.86) : vec3(1.0, 0.58, 0.22);\n" +
    "    col += hot * ringGauss * 0.62 + rim * echo * 0.34 + hot * core * 0.85;\n" +
    "    col.r += rIn * 0.1;\n" +
    "    col.b += ringGauss * 0.08;\n" +
    "  }\n" +
    // Film grain.
    "  float g = (hash(uv * uRes * 0.5 + fract(t * 17.0)) - 0.5) * 0.04;\n" +
    "  col += g;\n" +
    "  col = tonemap(col * (1.25 + energy * 0.2));\n" +
    // Keep the UI readable above the field.
    "  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));\n" +
    "  col *= mix(1.0, 0.72, smoothstep(0.38, 0.75, lum));\n" +
    "  fragColor = vec4(col, 1.0);\n" +
    "}";

  // -------------------------------------------------------------- particles --

  var UPDATE_VS =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "in vec2 aPos;\n" +
    "in vec2 aVel;\n" +
    "in float aSeed;\n" +
    "out vec2 vPos;\n" +
    "out vec2 vVel;\n" +
    "out float vSeed;\n" +
    "uniform float uTime;\n" +
    "uniform float uDt;\n" +
    "uniform float uAspect;\n" +
    "uniform float uRam;\n" +
    "uniform vec4 uClusters[" + MAX_CLUSTERS + "];\n" +
    "uniform float uClusterCount;\n" +
    "uniform vec4 uPulse;\n" +
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }\n" +
    "float vnoise(vec2 p){\n" +
    "  vec2 i = floor(p); vec2 f = fract(p);\n" +
    "  float a = hash(i); float b = hash(i + vec2(1.0, 0.0));\n" +
    "  float c = hash(i + vec2(0.0, 1.0)); float d = hash(i + vec2(1.0, 1.0));\n" +
    "  vec2 u = f * f * (3.0 - 2.0 * f);\n" +
    "  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;\n" +
    "}\n" +
    "vec2 curl(vec2 p){\n" +
    "  float e = 0.12;\n" +
    "  float nx = vnoise(p + vec2(0.0, e)) - vnoise(p - vec2(0.0, e));\n" +
    "  float ny = vnoise(p + vec2(e, 0.0)) - vnoise(p - vec2(e, 0.0));\n" +
    "  return vec2(nx, -ny) / (2.0 * e);\n" +
    "}\n" +
    "void main(){\n" +
    "  vec2 pos = aPos;\n" +
    "  vec2 vel = aVel;\n" +
    "  float n = max(uClusterCount, 1.0);\n" +
    "  float ci = mod(floor(aSeed * 7919.0), n);\n" +
    "  float lane = fract(aSeed * 41.3);\n" + // stable per-particle shell offset
    "  vec2 force = vec2(0.0);\n" +
    "  float damp = 0.965;\n" +
    "  float maxSpeed = 0.5;\n" +
    "  if (uClusterCount < 0.5) {\n" +
    // Idle: ambient drift with a slow gyre, weak centering. The swarm rests.
    "    force += curl(pos * 1.4 + uTime * 0.05) * 0.14;\n" +
    "    force += vec2(-pos.y, pos.x) * 0.05;\n" +
    "    force += -pos * 0.015;\n" +
    "    maxSpeed = 0.13;\n" +
    "  } else {\n" +
    "    vec4 cl = uClusters[int(ci)];\n" +
    "    vec2 toA = cl.xy - pos;\n" +
    "    float d = length(toA);\n" +
    "    vec2 dir = d > 0.0001 ? toA / d : vec2(0.0);\n" +
    "    vec2 tang = vec2(-dir.y, dir.x);\n" +
    "    float statusCode = cl.z;\n" +
    "    float intensity = cl.w;\n" +
    "    if (statusCode < 0.5) {\n" +
    // planning: a loose contemplative cloud that slowly inhales and exhales.
    "      float breathe = 0.34 + 0.16 * sin(uTime * 0.6 + ci * 2.1);\n" +
    "      force += dir * (d - breathe) * 1.1;\n" +
    "      force += tang * 0.14;\n" +
    "      force += curl(pos * 2.0 + uTime * 0.12 + ci) * 0.2;\n" +
    "      maxSpeed = 0.24;\n" +
    "    } else if (statusCode < 1.5) {\n" +
    // building: banded orbital shells, faster and tighter as elapsed time grows.
    "      float shell = 0.1 + lane * (0.26 - intensity * 0.1);\n" +
    "      force += dir * (d - shell) * (2.2 + intensity * 1.6);\n" +
    "      float spin = (0.75 + intensity * 0.95) * (lane > 0.5 ? 1.0 : -1.0);\n" +
    "      force += tang * spin;\n" +
    "      force += curl(pos * 3.0 + uTime * 0.25 + ci) * 0.12;\n" +
    "      maxSpeed = 0.58 + intensity * 0.3;\n" +
    "    } else if (statusCode < 2.5) {\n" +
    // review: a tight, slow, deliberate rosette - almost still, scanning.
    "      float shell = 0.045 + lane * 0.05;\n" +
    "      force += dir * (d - shell) * 3.2;\n" +
    "      force += tang * (0.12 + 0.08 * sin(uTime * 0.9 + lane * 6.28));\n" +
    "      damp = 0.9;\n" +
    "      maxSpeed = 0.17;\n" +
    "    } else {\n" +
    // blocked: tethered and agitated - snaps back hard, shivers in place.
    "      force += dir * min(d, 0.8) * 2.6;\n" +
    "      float j = uTime * 9.0 + aSeed * 100.0;\n" +
    "      force += vec2(hash(vec2(j, aSeed)) - 0.5, hash(vec2(aSeed, j)) - 0.5) * 2.6;\n" +
    "      force += dir * sin(uTime * 5.5 + lane * 6.28) * 0.9;\n" +
    "      damp = 0.94;\n" +
    "      maxSpeed = 0.42;\n" +
    "    }\n" +
    "  }\n" +
    // RAM pressure agitates the whole field.
    "  force += curl(pos * 2.2 - uTime * 0.1) * uRam * 0.9;\n" +
    // Event shockwave: outward impulse plus a swirl, decaying with age.
    "  if (uPulse.w >= 0.0) {\n" +
    "    vec2 pd = pos - uPulse.xy;\n" +
    "    float pl = max(length(pd), 0.02);\n" +
    "    vec2 outward = pd / pl;\n" +
    "    float ring = exp(-pow(pl - uPulse.z * 0.9, 2.0) * 30.0) * exp(-uPulse.z * 2.2);\n" +
    "    force += outward * ring * 3.4;\n" +
    "    force += vec2(-outward.y, outward.x) * ring * (uPulse.w < 0.5 ? 1.6 : -1.6);\n" +
    "  }\n" +
    "  vel = (vel + force * uDt) * damp;\n" +
    "  float sp = length(vel);\n" +
    "  if (sp > maxSpeed) vel *= maxSpeed / sp;\n" +
    "  pos += vel * uDt;\n" +
    // Soft wrap at field bounds.
    "  float bx = uAspect * 0.62 + 0.1;\n" +
    "  if (pos.x > bx) pos.x = -bx; else if (pos.x < -bx) pos.x = bx;\n" +
    "  if (pos.y > 0.62) pos.y = -0.62; else if (pos.y < -0.62) pos.y = 0.62;\n" +
    "  vPos = pos; vVel = vel; vSeed = aSeed;\n" +
    "  gl_Position = vec4(0.0);\n" +
    "}";

  var UPDATE_FS =
    "#version 300 es\nprecision mediump float;\nout vec4 o;\nvoid main(){ o = vec4(0.0); }";

  var RENDER_VS =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "in vec2 aPos;\n" +
    "in vec2 aVel;\n" +
    "in float aSeed;\n" +
    "out vec3 vColor;\n" +
    "out float vAlpha;\n" +
    "out float vSpark;\n" +
    "uniform float uAspect;\n" +
    "uniform float uDpr;\n" +
    "uniform float uTime;\n" +
    "uniform float uClusterCount;\n" +
    "uniform vec4 uClusters[" + MAX_CLUSTERS + "];\n" +
    "uniform vec3 uStatusColors[4];\n" +
    "uniform vec3 uAmbientColor;\n" +
    "void main(){\n" +
    // Field space matches the nebula: p = (uv-0.5)*vec2(aspect,1) -> clip = p/vec2(aspect,1)*2
    "  vec2 clip = vec2(aPos.x / max(uAspect, 0.001), aPos.y) * 2.0;\n" +
    "  gl_Position = vec4(clamp(clip, -1.2, 1.2), 0.0, 1.0);\n" +
    "  float sp = length(aVel);\n" +
    "  vec3 col; float a; float size;\n" +
    "  if (uClusterCount < 0.5) {\n" +
    "    col = uAmbientColor;\n" +
    "    a = 0.16 + sp * 0.6;\n" +
    "    size = 1.1 + fract(aSeed * 91.7) * 1.4 + sp * 2.0;\n" +
    "  } else {\n" +
    "    float ci = mod(floor(aSeed * 7919.0), max(uClusterCount, 1.0));\n" +
    "    vec4 cl = uClusters[int(ci)];\n" +
    "    float statusCode = cl.z;\n" +
    "    col = uStatusColors[int(clamp(statusCode, 0.0, 3.0))];\n" +
    // Hotter cores on the fastest movers reads as real work happening.
    "    float heat = smoothstep(0.18, 0.55, sp);\n" +
    "    col = mix(col, min(col * 1.35 + 0.28, vec3(1.0)), heat);\n" +
    "    a = 0.22 + min(sp * 1.4, 0.55) + cl.w * 0.08;\n" +
    "    size = 1.1 + fract(aSeed * 91.7) * 1.4 + sp * 2.4 + cl.w * 0.6;\n" +
    "  }\n" +
    // A sparse minority twinkles, so the swarm never looks like uniform dust.
    "  float tw = step(0.94, fract(aSeed * 313.7));\n" +
    "  float blink = 0.5 + 0.5 * sin(uTime * 3.4 + aSeed * 62.8);\n" +
    "  vSpark = tw * blink;\n" +
    "  a *= 1.0 + vSpark * 0.9;\n" +
    "  vColor = col;\n" +
    "  vAlpha = a;\n" +
    "  gl_PointSize = (size + vSpark * 1.6) * uDpr;\n" +
    "}";

  var RENDER_FS =
    "#version 300 es\n" +
    "precision mediump float;\n" +
    "in vec3 vColor;\n" +
    "in float vAlpha;\n" +
    "in float vSpark;\n" +
    "out vec4 fragColor;\n" +
    "void main(){\n" +
    "  vec2 d = gl_PointCoord - 0.5;\n" +
    "  float r = dot(d, d) * 4.0;\n" +
    "  float m = exp(-r * 3.0);\n" +
    // Cheap anamorphic cross flare on the twinkling minority.
    "  float flare = vSpark * (exp(-abs(d.x) * 26.0) + exp(-abs(d.y) * 26.0)) * 0.22;\n" +
    "  fragColor = vec4(vColor * vAlpha * (m + flare), 1.0);\n" +
    "}";

  // ------------------------------------------------------------- gl helpers --

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var err = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(err || "shader compile failed");
    }
    return sh;
  }

  function link(gl, vsSrc, fsSrc, tfVaryings) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    if (tfVaryings) gl.transformFeedbackVaryings(p, tfVaryings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var lerr = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(lerr || "program link failed");
    }
    return p;
  }

  // Resolve any CSS color (including oklch tokens) to an rgb triplet by
  // rasterizing it into a 1x1 2d canvas - the only reliable cross-format path.
  var _swatch = null;
  function cssColorToRgb(css, fallbackCss) {
    try {
      if (!_swatch) {
        _swatch = document.createElement("canvas");
        _swatch.width = 1;
        _swatch.height = 1;
      }
      var ctx = _swatch.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000000";
      ctx.fillStyle = css || "";
      // An invalid color leaves fillStyle at the previous value; retry the fallback.
      if (ctx.fillStyle === "#000000" && fallbackCss) ctx.fillStyle = fallbackCss;
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    } catch (e) {
      return [0.4, 0.7, 1.0];
    }
  }

  // ------------------------------------------------------ particle sub-layer --

  function ParticleLayer(gl, soft) {
    this.gl = gl;
    this.soft = !!soft;
    this.flip = 0;
    this.clusterData = new Float32Array(MAX_CLUSTERS * 4);
    this.clusterCount = 0;
    this._lastT = 0;
    this.statusColors = new Float32Array(12);
    this.ambientColor = new Float32Array(3);

    this.progUpdate = link(gl, UPDATE_VS, UPDATE_FS, ["vPos", "vVel", "vSeed"]);
    this.progRender = link(gl, RENDER_VS, RENDER_FS, null);

    this.uU = {
      uTime: gl.getUniformLocation(this.progUpdate, "uTime"),
      uDt: gl.getUniformLocation(this.progUpdate, "uDt"),
      uAspect: gl.getUniformLocation(this.progUpdate, "uAspect"),
      uRam: gl.getUniformLocation(this.progUpdate, "uRam"),
      uClusters: gl.getUniformLocation(this.progUpdate, "uClusters"),
      uClusterCount: gl.getUniformLocation(this.progUpdate, "uClusterCount"),
      uPulse: gl.getUniformLocation(this.progUpdate, "uPulse")
    };
    this.uR = {
      uAspect: gl.getUniformLocation(this.progRender, "uAspect"),
      uDpr: gl.getUniformLocation(this.progRender, "uDpr"),
      uTime: gl.getUniformLocation(this.progRender, "uTime"),
      uClusters: gl.getUniformLocation(this.progRender, "uClusters"),
      uClusterCount: gl.getUniformLocation(this.progRender, "uClusterCount"),
      uStatusColors: gl.getUniformLocation(this.progRender, "uStatusColors"),
      uAmbientColor: gl.getUniformLocation(this.progRender, "uAmbientColor")
    };

    this._alloc();
  }

  ParticleLayer.prototype._alloc = function () {
    var gl = this.gl;
    var area = (global.innerWidth || 1200) * (global.innerHeight || 800);
    this.count = this.soft
      ? 1200
      : Math.max(3000, Math.min(22000, Math.floor(area / 55)));

    var data = new Float32Array(this.count * STRIDE);
    for (var i = 0; i < this.count; i++) {
      var o = i * STRIDE;
      data[o] = (Math.random() - 0.5) * 1.6;
      data[o + 1] = (Math.random() - 0.5) * 1.0;
      data[o + 2] = (Math.random() - 0.5) * 0.05;
      data[o + 3] = (Math.random() - 0.5) * 0.05;
      data[o + 4] = Math.random();
    }

    this.bufs = [gl.createBuffer(), gl.createBuffer()];
    this.vaosUpdate = [gl.createVertexArray(), gl.createVertexArray()];
    this.vaosRender = [gl.createVertexArray(), gl.createVertexArray()];
    this.tf = gl.createTransformFeedback();

    for (var b = 0; b < 2; b++) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufs[b]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
    }
    var bytes = STRIDE * 4;
    function setup(prog, vao, buf) {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      var aPos = gl.getAttribLocation(prog, "aPos");
      var aVel = gl.getAttribLocation(prog, "aVel");
      var aSeed = gl.getAttribLocation(prog, "aSeed");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, bytes, 0);
      gl.enableVertexAttribArray(aVel);
      gl.vertexAttribPointer(aVel, 2, gl.FLOAT, false, bytes, 8);
      gl.enableVertexAttribArray(aSeed);
      gl.vertexAttribPointer(aSeed, 1, gl.FLOAT, false, bytes, 16);
    }
    for (b = 0; b < 2; b++) {
      setup(this.progUpdate, this.vaosUpdate[b], this.bufs[b]);
      setup(this.progRender, this.vaosRender[b], this.bufs[b]);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };

  ParticleLayer.prototype.setColors = function (statusColors, ambientColor) {
    this.statusColors = statusColors;
    this.ambientColor = ambientColor;
    var gl = this.gl;
    gl.useProgram(this.progRender);
    gl.uniform3fv(this.uR.uStatusColors, statusColors);
    gl.uniform3fv(this.uR.uAmbientColor, ambientColor);
  };

  ParticleLayer.prototype.setClusters = function (clusterData, clusterCount) {
    this.clusterData = clusterData;
    this.clusterCount = clusterCount;
  };

  ParticleLayer.prototype.render = function (time, aspect, dpr, ram, pulse) {
    var gl = this.gl;
    var dt = this._lastT ? Math.min(0.05, time - this._lastT) : 0.016;
    this._lastT = time;
    var src = this.flip;
    var dst = 1 - this.flip;

    // Update pass: transform feedback only, rasterizer off.
    gl.useProgram(this.progUpdate);
    gl.uniform1f(this.uU.uTime, time);
    gl.uniform1f(this.uU.uDt, dt);
    gl.uniform1f(this.uU.uAspect, aspect);
    gl.uniform1f(this.uU.uRam, ram);
    gl.uniform4fv(this.uU.uClusters, this.clusterData);
    gl.uniform1f(this.uU.uClusterCount, this.clusterCount);
    gl.uniform4fv(this.uU.uPulse, pulse);

    gl.bindVertexArray(this.vaosUpdate[src]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.bufs[dst]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

    // Render pass: additive points over the nebula.
    gl.useProgram(this.progRender);
    gl.uniform1f(this.uR.uAspect, aspect);
    gl.uniform1f(this.uR.uDpr, dpr);
    gl.uniform1f(this.uR.uTime, time);
    gl.uniform4fv(this.uR.uClusters, this.clusterData);
    gl.uniform1f(this.uR.uClusterCount, this.clusterCount);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vaosRender[dst]);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);

    this.flip = dst;
  };

  ParticleLayer.prototype.destroy = function () {
    var gl = this.gl;
    try {
      if (this.progUpdate) gl.deleteProgram(this.progUpdate);
      if (this.progRender) gl.deleteProgram(this.progRender);
      if (this.bufs) {
        for (var i = 0; i < this.bufs.length; i++) gl.deleteBuffer(this.bufs[i]);
      }
      if (this.tf) gl.deleteTransformFeedback(this.tf);
    } catch (e) {
      /* context already lost */
    }
  };

  // ------------------------------------------------------------ MissionEngine --

  var STATUS_CODE = { planning: 0, building: 1, review: 2, blocked: 3 };

  function MissionEngine(canvas) {
    this.canvas = canvas || null;
    this.ok = false;
    this.gl = null;
    this.particles = null;
    this.running = false;
    this.raf = 0;
    this._soft = false;
    this._skip = false;
    this._dpr = 1;
    this._t0 = (global.performance && performance.now()) || Date.now();
    this._lastFrameAt = 0;
    this._slowFrames = 0;
    this._pulse = null;
    this._anchorKeys = [];
    this._anchors = Object.create(null);
    this._clusterData = new Float32Array(MAX_CLUSTERS * 4);
    this._clusterCount = 0;
    this._statusColors = new Float32Array([
      0.30, 0.62, 1.00,
      0.91, 0.64, 0.24,
      0.63, 0.42, 0.91,
      0.91, 0.30, 0.24
    ]);
    this._ambientColor = new Float32Array([0.30, 0.62, 1.00]);
    this.telemetry = { live: 0, building: 0, review: 0, blocked: 0, ram: 0.3, progress: 0 };

    this.reduced =
      typeof global.matchMedia === "function" &&
      !!global.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this._onFrame = this._frame.bind(this);

    if (!this.canvas) {
      console.warn("[mission-engine] no canvas element");
      return;
    }
    try {
      this._init();
      this.ok = true;
    } catch (e) {
      console.warn("[mission-engine] WebGL2 unavailable:", (e && e.message) || e);
      this.ok = false;
      try {
        this.canvas.classList.add("is-fallback");
      } catch (e2) {
        /* detached node */
      }
    }
  }

  MissionEngine.prototype._init = function () {
    var gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      desynchronized: true
    });
    if (!gl) throw new Error("no webgl2 context");
    this.gl = gl;

    // Software rasterizer (headless CI, no GPU): shrink the workload hard.
    var renderer = String(gl.getParameter(gl.RENDERER) || "");
    try {
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) renderer += " " + String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "");
    } catch (e) {
      /* renderer string masked by the browser */
    }
    this._soft = /swiftshader|llvmpipe|softpipe|software/i.test(renderer);

    this.prog = link(gl, FIELD_VS, FIELD_FS, null);

    var quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    var names = [
      "uTime", "uRes", "uLive", "uBuilding", "uReview", "uBlocked",
      "uRam", "uProgress", "uDpr", "uPulse", "uClusters", "uClusterCount",
      "uStatusColors"
    ];
    this.locs = {};
    for (var i = 0; i < names.length; i++) {
      this.locs[names[i]] = gl.getUniformLocation(this.prog, names[i]);
    }

    // Particle layer is optional: nebula alone is a valid degraded mode.
    if (!this.reduced) {
      try {
        this.particles = new ParticleLayer(gl, this._soft);
      } catch (e3) {
        console.warn("[mission-engine] particle layer unavailable:", (e3 && e3.message) || e3);
        this.particles = null;
      }
    }

    this.refreshColors();
    this.resize();
  };

  // ---- anchors -------------------------------------------------------------

  // Deterministic field-space anchor from an id string (FNV-1a + LCG scramble).
  MissionEngine.prototype._anchorFor = function (id) {
    var h = 2166136261;
    var s = String(id == null ? "" : id);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    var a = (h >>> 0) / 4294967295;
    var b = ((Math.imul(h, 48271) >>> 0) % 100000) / 100000;
    var w = this.canvas ? this.canvas.width : 1;
    var hgt = this.canvas ? this.canvas.height : 1;
    var aspect = w / Math.max(hgt, 1);
    return [(a - 0.5) * aspect * 0.72, (b - 0.5) * 0.72];
  };

  MissionEngine.prototype._rememberAnchor = function (key, xy) {
    if (!(key in this._anchors)) this._anchorKeys.push(key);
    this._anchors[key] = xy;
    while (this._anchorKeys.length > ANCHOR_CAP) {
      var old = this._anchorKeys.shift();
      delete this._anchors[old];
    }
  };

  // ---- public API ----------------------------------------------------------

  MissionEngine.prototype.setTelemetry = function (t) {
    var src = t || {};
    var u = this.telemetry;
    var k = 0.18;
    function lerp(a, b) { return a + (b - a) * k; }
    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
    u.live = lerp(u.live, Math.min(24, Math.max(0, num(src.live))));
    u.building = lerp(u.building, Math.min(20, Math.max(0, num(src.building))));
    u.review = lerp(u.review, Math.min(20, Math.max(0, num(src.review))));
    u.blocked = lerp(u.blocked, Math.min(12, Math.max(0, num(src.blocked))));
    u.ram = lerp(u.ram, Math.max(0, Math.min(1, num(src.ramPct) / 100)));
    u.progress = lerp(u.progress, Math.max(0, Math.min(1, num(src.progressPct) / 100)));
  };

  /**
   * One boid cluster per running dispatch (max 16). Anchors are remembered so a
   * later done/blocked pulse still lands where the cluster used to live.
   */
  MissionEngine.prototype.setClusters = function (dispatches, statuses) {
    var list = Array.isArray(dispatches) ? dispatches : [];
    var data = this._clusterData;
    data.fill(0);
    var n = 0;
    for (var i = 0; i < list.length && n < MAX_CLUSTERS; i++) {
      var r = list[i] || {};
      var key = r.taskId || r.id;
      if (key == null) continue;
      var xy = this._anchorFor(key);
      this._rememberAnchor(String(key), xy);
      var st = statuses ? statuses[r.taskId] : null;
      var code = STATUS_CODE[st];
      var elapsed = Number(r.elapsedMs);
      data[n * 4] = xy[0];
      data[n * 4 + 1] = xy[1];
      data[n * 4 + 2] = code == null ? 1 : code;
      data[n * 4 + 3] = Math.max(0, Math.min(1, (isFinite(elapsed) ? elapsed : 0) / 900000));
      n++;
    }
    this._clusterCount = n;
    if (this.particles) {
      try {
        this.particles.setClusters(data, n);
      } catch (e) {
        console.warn("[mission-engine] cluster upload failed:", (e && e.message) || e);
      }
    }
  };

  /** type: "done" | "blocked". taskId locates the burst at its cluster anchor. */
  MissionEngine.prototype.pulse = function (type, taskId) {
    var at = this._anchors[String(taskId)] || [0, 0];
    this._pulse = {
      x: at[0],
      y: at[1],
      t0: (global.performance && performance.now()) || Date.now(),
      type: type === "blocked" ? 1 : 0
    };
  };

  MissionEngine.prototype._pulseVec = function () {
    if (!this._pulse) return PULSE_OFF;
    var now = (global.performance && performance.now()) || Date.now();
    var age = (now - this._pulse.t0) / 1000;
    if (age > PULSE_LIFE) {
      this._pulse = null;
      return PULSE_OFF;
    }
    PULSE_BUF[0] = this._pulse.x;
    PULSE_BUF[1] = this._pulse.y;
    PULSE_BUF[2] = age;
    PULSE_BUF[3] = this._pulse.type;
    return PULSE_BUF;
  };

  /** Re-sample the CSS accent tokens (theme flip, Cinema toggle). */
  MissionEngine.prototype.refreshColors = function () {
    try {
      var cs = getComputedStyle(document.documentElement);
      function read(name, fb) {
        var v = (cs.getPropertyValue(name) || "").trim();
        return cssColorToRgb(v || fb, fb);
      }
      var planning = read("--blue", "#4d9fff");
      var building = read("--amber", "#e8a33d");
      var review = read("--purple", "#a06ae8");
      var blocked = read("--red", "#e84d3d");
      var green = read("--green", "#3ddc84");
      this._statusColors = new Float32Array(
        planning.concat(building, review, blocked)
      );
      // Idle ambience leans toward the "all clear" green when nothing is running.
      this._ambientColor = new Float32Array([
        (planning[0] + green[0]) * 0.5,
        (planning[1] + green[1]) * 0.5,
        (planning[2] + green[2]) * 0.5
      ]);
      if (this.particles) this.particles.setColors(this._statusColors, this._ambientColor);
    } catch (e) {
      console.warn("[mission-engine] color refresh failed:", (e && e.message) || e);
    }
  };

  MissionEngine.prototype.resize = function () {
    if (!this.gl || !this.canvas) return;
    var w0 = global.innerWidth || 1200;
    var h0 = global.innerHeight || 800;
    var dprCap = this._soft ? 0.45 : w0 < 700 ? 1.15 : 1.6;
    var dpr = Math.min(global.devicePixelRatio || 1, dprCap);
    var w = Math.max(1, Math.floor(w0 * dpr));
    var h = Math.max(1, Math.floor(h0 * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
    this._dpr = dpr;
  };

  MissionEngine.prototype.start = function () {
    if (!this.ok || this.reduced || this.running) return;
    this.running = true;
    this._lastFrameAt = 0;
    this._slowFrames = 0;
    this._skip = false;
    this.resize();
    this.raf = requestAnimationFrame(this._onFrame);
  };

  MissionEngine.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  MissionEngine.prototype._degrade = function (reason) {
    console.warn("[mission-engine] " + reason + "; using static fallback");
    this.stop();
    this.ok = false;
    try {
      if (this.canvas) this.canvas.classList.add("is-fallback");
      var fb = document.getElementById("field-fallback");
      if (fb) fb.classList.add("is-on");
    } catch (e) {
      /* DOM gone */
    }
  };

  MissionEngine.prototype._frame = function () {
    if (!this.running || !this.gl) return;
    var gl = this.gl;
    var u = this.telemetry;
    var now = (global.performance && performance.now()) || Date.now();
    var time = (now - this._t0) / 1000;

    // Watchdog: a nominally hardware path that is actually slow must not freeze
    // the page. Eight consecutive >90ms frames means we bail to static.
    if (this._lastFrameAt) {
      var ft = now - this._lastFrameAt;
      this._slowFrames = ft > 90 ? this._slowFrames + 1 : 0;
      if (this._slowFrames >= 8) {
        this._degrade("too slow (" + Math.round(ft) + "ms/frame)");
        return;
      }
    }
    this._lastFrameAt = now;

    // Soft renderers and tiny idle viewports render every other frame.
    if (this._skip) {
      this._skip = false;
      this.raf = requestAnimationFrame(this._onFrame);
      return;
    }
    if (this._soft || ((global.innerWidth || 1200) < 480 && u.live < 2)) this._skip = true;

    var pulse = this._pulseVec();

    try {
      gl.useProgram(this.prog);
      gl.uniform1f(this.locs.uTime, time);
      gl.uniform2f(this.locs.uRes, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.locs.uLive, u.live);
      gl.uniform1f(this.locs.uBuilding, u.building);
      gl.uniform1f(this.locs.uReview, u.review);
      gl.uniform1f(this.locs.uBlocked, u.blocked);
      gl.uniform1f(this.locs.uRam, u.ram);
      gl.uniform1f(this.locs.uProgress, u.progress);
      gl.uniform1f(this.locs.uDpr, this._dpr);
      gl.uniform4fv(this.locs.uPulse, pulse);
      gl.uniform4fv(this.locs.uClusters, this._clusterData);
      gl.uniform1f(this.locs.uClusterCount, this._clusterCount);
      gl.uniform3fv(this.locs.uStatusColors, this._statusColors);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    } catch (e) {
      this._degrade("nebula pass failed: " + ((e && e.message) || e));
      return;
    }

    if (this.particles) {
      var aspect = this.canvas.width / Math.max(this.canvas.height, 1);
      try {
        this.particles.render(time, aspect, this._dpr, u.ram, pulse);
      } catch (e2) {
        console.warn("[mission-engine] particle layer failed, disabling:", (e2 && e2.message) || e2);
        try {
          this.particles.destroy();
        } catch (e3) {
          /* already dead */
        }
        this.particles = null;
      }
    }

    if (gl.isContextLost && gl.isContextLost()) {
      this._degrade("context lost");
      return;
    }

    this.raf = requestAnimationFrame(this._onFrame);
  };

  MissionEngine.prototype.destroy = function () {
    this.stop();
    try {
      if (this.particles) this.particles.destroy();
      this.particles = null;
      if (this.gl && this.prog) this.gl.deleteProgram(this.prog);
      if (this.gl && this.buf) this.gl.deleteBuffer(this.buf);
      if (this.gl && this.quadVao) this.gl.deleteVertexArray(this.quadVao);
    } catch (e) {
      /* context already lost */
    }
  };

  global.MissionEngine = MissionEngine;
})(typeof window !== "undefined" ? window : globalThis);
