/**
 * UNUSED by templates/dashboard.html — optional field path replaced by engine.js
 * (MissionEngine). Kept for reference; do not script-include unless deliberately
 * re-enabling the older gl-field + gl-swarm stack.
 */
/**
 * Mission Field — hand-rolled WebGL2 background (July 2026).
 * Telemetry uniforms drive energy; progressive fallback when WebGL2 /
 * prefers-reduced-motion. No external GPU deps.
 */
(function (global) {
  "use strict";

  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform float uTime;
uniform vec2 uRes;
uniform float uLive;
uniform float uBuilding;
uniform float uReview;
uniform float uBlocked;
uniform float uRam;
uniform float uProgress;
uniform float uDpr;
uniform vec4 uPulse; // x, y, age(s), type (-1 none, 0 done→green, 1 blocked→red)

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float hash13(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

// Hex lattice SDF (mission grid)
float hexDist(vec2 p) {
  p = abs(p);
  return max(p.x * 0.866025 + p.y * 0.5, p.y) - 1.0;
}

vec3 tonemap(vec3 x) {
  // ACES-ish filmic
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);

  float energy = clamp(uLive * 0.1 + uBuilding * 0.08 + uReview * 0.05, 0.0, 1.2);
  float t = uTime * (0.1 + energy * 0.06 + uRam * 0.05);

  // Domain-warped nebula
  vec2 q = p * 1.65;
  q += 0.4 * vec2(fbm(q + t * 0.35), fbm(q + vec2(5.2, 1.3) - t * 0.55));
  float n = fbm(q * 1.35 + t * 0.22);
  float n2 = fbm(q * 2.8 - t * 0.12);
  float n3 = fbm(q * 0.7 + vec2(t * 0.08, -t * 0.05));

  float lobe = smoothstep(0.22, 0.88, n);
  float veins = smoothstep(0.52, 0.96, n2);
  float deep = smoothstep(0.15, 0.7, n3);

  // Deep void base (never pure black)
  vec3 col = mix(vec3(0.015, 0.02, 0.045), vec3(0.03, 0.04, 0.08), deep);

  // Active cyan/blue energy field
  vec3 activeCol = mix(vec3(0.02, 0.22, 0.65), vec3(0.08, 0.75, 0.92), n2);
  col += activeCol * lobe * (0.16 + energy * 0.62);

  // Building amber heat filaments
  col += vec3(0.65, 0.32, 0.04) * uBuilding * veins * 0.28;

  // Review violet haze
  col += vec3(0.42, 0.12, 0.72) * uReview * (1.0 - lobe * 0.6) * 0.16;

  // Blocked stress veins
  col += vec3(0.85, 0.06, 0.1) * uBlocked * smoothstep(0.55, 1.0, veins) * 0.4;

  // Hex tactical grid (fades with cinematic energy)
  float gridScale = 9.0 + uLive * 0.15;
  vec2 hp = p * gridScale;
  vec2 hid = floor(hp + 0.5);
  vec2 hlocal = (hp - hid) * 1.15;
  float hx = abs(hexDist(hlocal));
  float hline = smoothstep(0.04, 0.0, hx) * (0.04 + energy * 0.06);
  float cellPulse = 0.5 + 0.5 * sin(t * 2.0 + hash(hid) * 6.28);
  col += vec3(0.25, 0.55, 1.0) * hline * cellPulse * (0.35 + uProgress * 0.4);

  // Progress horizon scan band
  float bandY = 1.0 - uProgress * 0.42 - 0.12;
  float band = exp(-pow((uv.y - bandY) * 28.0, 2.0));
  col += vec3(0.2, 0.55, 1.0) * band * (0.12 + uProgress * 0.25);

  // Radial orbit rings (mission radius)
  float r = length(p);
  float ring1 = exp(-pow((r - 0.35 - uLive * 0.01) * 40.0, 2.0));
  float ring2 = exp(-pow((r - 0.62) * 55.0, 2.0));
  col += vec3(0.3, 0.7, 1.0) * (ring1 * 0.08 + ring2 * 0.05) * (0.4 + energy);

  // Agent spark constellation (density from live + building)
  float spark = 0.0;
  float sparkCap = min(18.0, uLive * 1.8 + uBuilding * 0.8 + 3.0);
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    if (fi >= sparkCap) break;
    float ang = hash(vec2(fi, 2.1)) * 6.28318 + t * (0.15 + hash(vec2(fi, 0.3)) * 0.2);
    float rad = 0.15 + hash(vec2(fi, 4.4)) * 0.7;
    vec2 sp = vec2(cos(ang), sin(ang)) * rad;
    sp += 0.04 * vec2(sin(t * 1.4 + fi), cos(t * 1.1 + fi * 0.7));
    float d = length(p - sp);
    float core = smoothstep(0.035, 0.0, d);
    float halo = smoothstep(0.12, 0.0, d) * 0.25;
    float blink = 0.55 + 0.45 * sin(t * 3.0 + fi * 1.7);
    spark += (core + halo) * blink;
  }
  col += vec3(0.55, 0.85, 1.0) * spark * (0.12 + energy * 0.4);

  // Soft starfield
  float stars = 0.0;
  for (int s = 0; s < 40; s++) {
    float si = float(s);
    vec2 st = vec2(hash(vec2(si, 1.0)), hash(vec2(si, 2.0)));
    st = (st - 0.5) * vec2(aspect, 1.0) * 1.8;
    float sd = length(p - st);
    float tw = 0.5 + 0.5 * sin(t * 2.5 + si * 3.1);
    stars += smoothstep(0.008, 0.0, sd) * tw * hash(vec2(si, 9.0));
  }
  col += vec3(0.75, 0.85, 1.0) * stars * 0.35;

  // RAM pressure vignette + heat
  float vig = smoothstep(0.15, 1.15, r * (0.8 + uRam * 0.55));
  col *= 1.0 - vig * (0.3 + uRam * 0.45);
  col += vec3(0.45, 0.05, 0.02) * uRam * vig * 0.15;

  // Subtle chromatic edge on high energy
  float edge = smoothstep(0.55, 0.95, r);
  col.r += edge * energy * 0.03;
  col.b += edge * energy * 0.02;

  // Event shockwave — task done (green) / blocked (red)
  if (uPulse.w >= 0.0) {
    float age = uPulse.z;
    float pd = abs(length(p - uPulse.xy) - age * 0.85);
    float wave = exp(-pd * pd * 220.0) * exp(-age * 1.9);
    vec3 pc = uPulse.w < 0.5 ? vec3(0.12, 0.9, 0.42) : vec3(0.95, 0.14, 0.1);
    col += pc * wave * 0.55;
  }

  // Film grain
  float g = (hash(uv * uRes * 0.5 + fract(t * 17.0)) - 0.5) * 0.04;
  col += g;

  col = tonemap(col * (1.25 + energy * 0.2));

  // Keep UI readable: soft luminance clamp
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= mix(1.0, 0.72, smoothstep(0.38, 0.75, lum));

  fragColor = vec4(col, 1.0);
}`;

  function createShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(err || "shader compile failed");
    }
    return sh;
  }

  function createProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || "link failed");
    }
    return p;
  }

  function MissionField(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.prog = null;
    this.buf = null;
    this.raf = 0;
    this.running = false;
    this.reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.uniforms = {
      live: 0,
      building: 0,
      review: 0,
      blocked: 0,
      ram: 0.3,
      progress: 0,
    };
    this._t0 = performance.now();
    this._ok = false;
    this._dpr = 1;
    this.swarm = null;
    this._anchors = {};
    this._pulse = null;

    // A GPU reset (driver crash, tab backgrounded too long, external monitor
    // unplugged) kills the context. Without these the raf loop keeps issuing
    // draw calls into a dead context and the canvas stays black forever.
    // Registered before _init so it survives a failed first init too; this is
    // the single owner of the canvas, the GL context and the particle layer, so
    // re-running _init here restores every downstream object as well.
    const self = this;
    canvas.addEventListener("webglcontextlost", function (e) {
      e.preventDefault(); // without this the browser never fires contextrestored
      self._restartOnRestore = self.running;
      self.stop();
      self.gl = null;
      self.swarm = null;
      self._ok = false;
    });
    canvas.addEventListener("webglcontextrestored", function () {
      try {
        self._init();
        self._ok = true;
        canvas.classList.remove("is-fallback");
        if (self._restartOnRestore) self.start();
      } catch (e) {
        console.warn("[mission-field] context restore failed:", e && e.message);
        self._ok = false;
        canvas.classList.add("is-fallback");
      }
    });

    try {
      this._init();
      this._ok = true;
    } catch (e) {
      console.warn("[mission-field] WebGL2 unavailable:", e && e.message);
      canvas.classList.add("is-fallback");
    }
  }

  MissionField.prototype._init = function () {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      desynchronized: true,
    });
    if (!gl) throw new Error("no webgl2");
    this.gl = gl;

    // Software rasterizer (headless / no GPU): shrink workload hard.
    let renderer = String(gl.getParameter(gl.RENDERER) || "");
    try {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) renderer += " " + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch (e) {
      /* masked */
    }
    this._soft = /swiftshader|llvmpipe|softpipe|software/i.test(renderer);

    const vs = createShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAG);
    this.prog = createProgram(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.locs = {
      uTime: gl.getUniformLocation(this.prog, "uTime"),
      uRes: gl.getUniformLocation(this.prog, "uRes"),
      uLive: gl.getUniformLocation(this.prog, "uLive"),
      uBuilding: gl.getUniformLocation(this.prog, "uBuilding"),
      uReview: gl.getUniformLocation(this.prog, "uReview"),
      uBlocked: gl.getUniformLocation(this.prog, "uBlocked"),
      uRam: gl.getUniformLocation(this.prog, "uRam"),
      uProgress: gl.getUniformLocation(this.prog, "uProgress"),
      uDpr: gl.getUniformLocation(this.prog, "uDpr"),
      uPulse: gl.getUniformLocation(this.prog, "uPulse"),
    };

    // Boid particle layer (transform feedback); nebula stays the fallback.
    if (typeof global.SwarmParticles === "function" && !this.reduced) {
      try {
        this.swarm = new global.SwarmParticles(gl, { soft: this._soft });
      } catch (e) {
        console.warn("[mission-field] particle layer unavailable:", e && e.message);
        this.swarm = null;
      }
    }

    this.resize();
  };

  // Deterministic anchor in field space from an id string.
  MissionField.prototype._anchorFor = function (id) {
    let h = 2166136261;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const a = (h >>> 0) / 4294967295;
    const b = ((Math.imul(h, 48271) >>> 0) % 100000) / 100000;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    return [(a - 0.5) * aspect * 0.72, (b - 0.5) * 0.72];
  };

  /**
   * dispatches: runningDispatches from /api/state; statuses: taskId → status.
   * Each dispatch becomes a particle cluster; anchors are remembered so a
   * later done/blocked pulse can fire at the cluster's last position.
   */
  MissionField.prototype.setClusters = function (dispatches, statuses) {
    const STATUS_CODE = { planning: 0, building: 1, review: 2, blocked: 3 };
    const clusters = [];
    for (const r of dispatches || []) {
      const key = r.taskId || r.id;
      const [x, y] = this._anchorFor(key);
      this._anchors[key] = [x, y];
      const st = statuses && statuses[r.taskId];
      clusters.push({
        x,
        y,
        status: STATUS_CODE[st] != null ? STATUS_CODE[st] : 1,
        intensity: Math.min(1, (Number(r.elapsedMs) || 0) / 900000),
      });
    }
    const keys = Object.keys(this._anchors);
    if (keys.length > 120) {
      for (const k of keys.slice(0, keys.length - 120)) delete this._anchors[k];
    }
    if (this.swarm) this.swarm.setClusters(clusters);
  };

  /** type: "done" | "blocked"; taskId locates the burst at its cluster. */
  MissionField.prototype.pulse = function (type, taskId) {
    const at = this._anchors[taskId] || [0, 0];
    this._pulse = {
      x: at[0],
      y: at[1],
      t0: performance.now(),
      type: type === "blocked" ? 1 : 0,
    };
  };

  MissionField.prototype._pulseVec = function () {
    if (!this._pulse) return [0, 0, 0, -1];
    const age = (performance.now() - this._pulse.t0) / 1000;
    if (age > 3) {
      this._pulse = null;
      return [0, 0, 0, -1];
    }
    return [this._pulse.x, this._pulse.y, age, this._pulse.type];
  };

  MissionField.prototype.refreshColors = function () {
    if (this.swarm) this.swarm.refreshColors();
  };

  MissionField.prototype.resize = function () {
    if (!this.gl) return;
    const dprCap = this._soft ? 0.45 : window.innerWidth < 700 ? 1.15 : 1.6;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.max(1, Math.floor(window.innerWidth * dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
    this._dpr = dpr;
  };

  MissionField.prototype.setTelemetry = function (t) {
    const u = this.uniforms;
    // Smooth toward targets so the field never snaps
    const lerp = (a, b, k) => a + (b - a) * k;
    const k = 0.18;
    u.live = lerp(u.live, Math.min(24, Number(t.live) || 0), k);
    u.building = lerp(u.building, Math.min(20, Number(t.building) || 0), k);
    u.review = lerp(u.review, Math.min(20, Number(t.review) || 0), k);
    u.blocked = lerp(u.blocked, Math.min(12, Number(t.blocked) || 0), k);
    u.ram = lerp(u.ram, Math.max(0, Math.min(1, (Number(t.ramPct) || 0) / 100)), k);
    u.progress = lerp(
      u.progress,
      Math.max(0, Math.min(1, (Number(t.progressPct) || 0) / 100)),
      k,
    );
  };

  MissionField.prototype._frame = function () {
    if (!this.running || !this.gl) return;
    const gl = this.gl;
    const u = this.uniforms;
    const now = performance.now();
    const time = (now - this._t0) / 1000;

    // Frame-time watchdog: if GPU path is actually software-slow, bail to the
    // static fallback instead of freezing the page.
    if (this._lastFrameAt) {
      const ft = now - this._lastFrameAt;
      this._slowFrames = ft > 90 ? (this._slowFrames || 0) + 1 : 0;
      if (this._slowFrames >= 8) {
        console.warn("[mission-field] too slow (" + Math.round(ft) + "ms/frame), using static fallback");
        this.stop();
        this.canvas.classList.add("is-fallback");
        const fb = document.getElementById("field-fallback");
        if (fb) fb.classList.add("is-on");
        this._ok = false;
        return;
      }
    }
    this._lastFrameAt = now;

    // Throttle on tiny viewports / low power: skip every other frame if needed
    if (this._skip) {
      this._skip = false;
      this.raf = requestAnimationFrame(this._onFrame);
      return;
    }
    if (this._soft || (window.innerWidth < 480 && (u.live || 0) < 2)) this._skip = true;

    gl.useProgram(this.prog);
    gl.uniform1f(this.locs.uTime, time);
    gl.uniform2f(this.locs.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.locs.uLive, u.live);
    gl.uniform1f(this.locs.uBuilding, u.building);
    gl.uniform1f(this.locs.uReview, u.review);
    gl.uniform1f(this.locs.uBlocked, u.blocked);
    gl.uniform1f(this.locs.uRam, u.ram);
    gl.uniform1f(this.locs.uProgress, u.progress);
    gl.uniform1f(this.locs.uDpr, this._dpr || 1);
    const pulse = this._pulseVec();
    gl.uniform4fv(this.locs.uPulse, pulse);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const loc = gl.getAttribLocation(this.prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (this.swarm) {
      const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
      try {
        this.swarm.render(time, aspect, this._dpr || 1, u.ram, pulse);
      } catch (e) {
        console.warn("[mission-field] particle layer failed, disabling:", e && e.message);
        this.swarm = null;
      }
    }
    this.raf = requestAnimationFrame(this._onFrame);
  };

  MissionField.prototype.start = function () {
    if (!this._ok || this.reduced) return;
    if (this.running) return;
    this.running = true;
    this._lastFrameAt = 0;
    this._slowFrames = 0;
    this._onFrame = this._frame.bind(this);
    this.resize();
    this.raf = requestAnimationFrame(this._onFrame);
  };

  MissionField.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  MissionField.prototype.destroy = function () {
    this.stop();
    if (this.swarm) this.swarm.destroy();
    if (this.gl && this.prog) this.gl.deleteProgram(this.prog);
  };

  global.MissionField = MissionField;
})(typeof window !== "undefined" ? window : globalThis);
