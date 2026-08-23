/**
 * UNUSED by templates/dashboard.html — optional field path replaced by engine.js
 * (MissionEngine). Kept for reference; do not script-include unless deliberately
 * re-enabling the older gl-field + gl-swarm stack.
 */
/**
 * Swarm Particles — WebGL2 transform-feedback GPU particle layer.
 * Each running dispatch is a boid cluster; behavior/color driven entirely by
 * real state (status, elapsed intensity, RAM pressure). Rendered additively
 * on top of the MissionField nebula pass, sharing its GL context.
 */
(function (global) {
  "use strict";

  var MAX_CLUSTERS = 16;
  var STRIDE = 5; // pos.xy, vel.xy, seed

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
    "uniform vec4 uClusters[" + MAX_CLUSTERS + "];\n" + // x, y, status, intensity
    "uniform float uClusterCount;\n" +
    "uniform vec4 uPulse;\n" + // x, y, age(s), type(-1 none, 0 done, 1 blocked)
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
    "  vec2 force = vec2(0.0);\n" +
    "  float damp = 0.965;\n" +
    "  float maxSpeed = 0.5;\n" +
    "  if (uClusterCount < 0.5) {\n" +
    "    // Idle: ambient drift, weak centering — the swarm is at rest.\n" +
    "    force += curl(pos * 1.4 + uTime * 0.05) * 0.12;\n" +
    "    force += -pos * 0.015;\n" +
    "    maxSpeed = 0.12;\n" +
    "  } else {\n" +
    "    vec4 cl = uClusters[int(ci)];\n" +
    "    vec2 toA = cl.xy - pos;\n" +
    "    float d = length(toA);\n" +
    "    vec2 dir = d > 0.0001 ? toA / d : vec2(0.0);\n" +
    "    float status = cl.z;\n" +
    "    float intensity = cl.w;\n" +
    "    if (status < 0.5) {\n" +
    "      // planning: loose contemplative cloud\n" +
    "      force += dir * min(d, 0.6) * 0.55;\n" +
    "      force += curl(pos * 2.0 + uTime * 0.12 + ci) * 0.18;\n" +
    "      maxSpeed = 0.22;\n" +
    "    } else if (status < 1.5) {\n" +
    "      // building: fast orbital work\n" +
    "      force += dir * min(d, 0.7) * 1.5;\n" +
    "      force += vec2(-dir.y, dir.x) * (0.5 + intensity * 0.7);\n" +
    "      force += curl(pos * 3.0 + uTime * 0.25 + ci) * 0.12;\n" +
    "      maxSpeed = 0.55 + intensity * 0.25;\n" +
    "    } else if (status < 2.5) {\n" +
    "      // review: tight, slow, deliberate\n" +
    "      force += dir * min(d, 0.8) * 2.4;\n" +
    "      damp = 0.9;\n" +
    "      maxSpeed = 0.16;\n" +
    "    } else {\n" +
    "      // blocked: agitated jitter, held in place\n" +
    "      force += dir * min(d, 0.8) * 2.0;\n" +
    "      float j = uTime * 9.0 + aSeed * 100.0;\n" +
    "      force += vec2(hash(vec2(j, aSeed)) - 0.5, hash(vec2(aSeed, j)) - 0.5) * 2.4;\n" +
    "      maxSpeed = 0.4;\n" +
    "    }\n" +
    "  }\n" +
    "  // RAM pressure agitates the whole field\n" +
    "  force += curl(pos * 2.2 - uTime * 0.1) * uRam * 0.9;\n" +
    "  // Event shockwave: outward impulse decaying with age\n" +
    "  if (uPulse.w >= 0.0) {\n" +
    "    vec2 pd = pos - uPulse.xy;\n" +
    "    float pl = max(length(pd), 0.02);\n" +
    "    float ring = exp(-pow(pl - uPulse.z * 0.9, 2.0) * 30.0) * exp(-uPulse.z * 2.2);\n" +
    "    force += (pd / pl) * ring * 3.0;\n" +
    "  }\n" +
    "  vel = (vel + force * uDt) * damp;\n" +
    "  float sp = length(vel);\n" +
    "  if (sp > maxSpeed) vel *= maxSpeed / sp;\n" +
    "  pos += vel * uDt;\n" +
    "  // Soft wrap at field bounds\n" +
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
    "uniform float uAspect;\n" +
    "uniform float uDpr;\n" +
    "uniform float uClusterCount;\n" +
    "uniform vec4 uClusters[" + MAX_CLUSTERS + "];\n" +
    "uniform vec3 uStatusColors[4];\n" + // planning, building, review, blocked
    "uniform vec3 uAmbientColor;\n" +
    "void main(){\n" +
    "  // Field space matches nebula: p = (uv-0.5)*vec2(aspect,1) → clip = p/vec2(aspect,1)*2\n" +
    "  vec2 clip = vec2(aPos.x / max(uAspect, 0.001), aPos.y) * 2.0;\n" +
    "  gl_Position = vec4(clamp(clip, -1.2, 1.2), 0.0, 1.0);\n" +
    "  float sp = length(aVel);\n" +
    "  vec3 col; float a;\n" +
    "  if (uClusterCount < 0.5) {\n" +
    "    col = uAmbientColor; a = 0.16 + sp * 0.6;\n" +
    "  } else {\n" +
    "    float ci = mod(floor(aSeed * 7919.0), max(uClusterCount, 1.0));\n" +
    "    float status = uClusters[int(ci)].z;\n" +
    "    col = uStatusColors[int(clamp(status, 0.0, 3.0))];\n" +
    "    a = 0.22 + min(sp * 1.4, 0.55);\n" +
    "  }\n" +
    "  vColor = col;\n" +
    "  vAlpha = a;\n" +
    "  gl_PointSize = (1.1 + fract(aSeed * 91.7) * 1.4 + sp * 2.0) * uDpr;\n" +
    "}";

  var RENDER_FS =
    "#version 300 es\n" +
    "precision mediump float;\n" +
    "in vec3 vColor;\n" +
    "in float vAlpha;\n" +
    "out vec4 fragColor;\n" +
    "void main(){\n" +
    "  vec2 d = gl_PointCoord - 0.5;\n" +
    "  float r = dot(d, d) * 4.0;\n" +
    "  float m = exp(-r * 3.0);\n" +
    "  fragColor = vec4(vColor * vAlpha * m, 1.0);\n" +
    "}";

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var err = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(err || "swarm shader compile failed");
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
      throw new Error(gl.getProgramInfoLog(p) || "swarm link failed");
    }
    return p;
  }

  // Resolve any CSS color (incl. oklch tokens) to linear-ish rgb triplet.
  function cssColorToRgb(css) {
    try {
      var cv = cssColorToRgb._cv || (cssColorToRgb._cv = document.createElement("canvas"));
      cv.width = cv.height = 1;
      var c2 = cv.getContext("2d", { willReadFrequently: true });
      c2.clearRect(0, 0, 1, 1);
      c2.fillStyle = "#000";
      c2.fillStyle = css;
      c2.fillRect(0, 0, 1, 1);
      var d = c2.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    } catch (e) {
      return [0.4, 0.7, 1.0];
    }
  }

  function SwarmParticles(gl, opts) {
    this.gl = gl;
    this.soft = !!(opts && opts.soft);
    this.count = 0;
    this.flip = 0;
    this.clusterData = new Float32Array(MAX_CLUSTERS * 4);
    this.clusterCount = 0;
    this._lastT = 0;

    this.progUpdate = link(gl, UPDATE_VS, UPDATE_FS, ["vPos", "vVel", "vSeed"]);
    this.progRender = link(gl, RENDER_VS, RENDER_FS, null);

    this.uU = {
      uTime: gl.getUniformLocation(this.progUpdate, "uTime"),
      uDt: gl.getUniformLocation(this.progUpdate, "uDt"),
      uAspect: gl.getUniformLocation(this.progUpdate, "uAspect"),
      uRam: gl.getUniformLocation(this.progUpdate, "uRam"),
      uClusters: gl.getUniformLocation(this.progUpdate, "uClusters"),
      uClusterCount: gl.getUniformLocation(this.progUpdate, "uClusterCount"),
      uPulse: gl.getUniformLocation(this.progUpdate, "uPulse"),
    };
    this.uR = {
      uAspect: gl.getUniformLocation(this.progRender, "uAspect"),
      uDpr: gl.getUniformLocation(this.progRender, "uDpr"),
      uClusters: gl.getUniformLocation(this.progRender, "uClusters"),
      uClusterCount: gl.getUniformLocation(this.progRender, "uClusterCount"),
      uStatusColors: gl.getUniformLocation(this.progRender, "uStatusColors"),
      uAmbientColor: gl.getUniformLocation(this.progRender, "uAmbientColor"),
    };

    this._alloc();
    this.refreshColors();
  }

  SwarmParticles.prototype._alloc = function () {
    var gl = this.gl;
    var area = (window.innerWidth || 1200) * (window.innerHeight || 800);
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
    var setup = function (glc, prog, vao, buf) {
      glc.bindVertexArray(vao);
      glc.bindBuffer(glc.ARRAY_BUFFER, buf);
      var aPos = glc.getAttribLocation(prog, "aPos");
      var aVel = glc.getAttribLocation(prog, "aVel");
      var aSeed = glc.getAttribLocation(prog, "aSeed");
      glc.enableVertexAttribArray(aPos);
      glc.vertexAttribPointer(aPos, 2, glc.FLOAT, false, bytes, 0);
      glc.enableVertexAttribArray(aVel);
      glc.vertexAttribPointer(aVel, 2, glc.FLOAT, false, bytes, 8);
      glc.enableVertexAttribArray(aSeed);
      glc.vertexAttribPointer(aSeed, 1, glc.FLOAT, false, bytes, 16);
    };
    for (b = 0; b < 2; b++) {
      setup(gl, this.progUpdate, this.vaosUpdate[b], this.bufs[b]);
      setup(gl, this.progRender, this.vaosRender[b], this.bufs[b]);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };

  SwarmParticles.prototype.refreshColors = function () {
    var gl = this.gl;
    var cs = getComputedStyle(document.documentElement);
    var read = function (name, fb) {
      var v = (cs.getPropertyValue(name) || "").trim();
      return cssColorToRgb(v || fb);
    };
    var planning = read("--blue", "#4d9fff");
    var building = read("--amber", "#e8a33d");
    var review = read("--purple", "#a06ae8");
    var blocked = read("--red", "#e84d3d");
    var ambient = read("--blue", "#4d9fff");
    this._statusColors = new Float32Array(
      [].concat(planning, building, review, blocked),
    );
    this._ambientColor = new Float32Array(ambient);
    gl.useProgram(this.progRender);
    gl.uniform3fv(this.uR.uStatusColors, this._statusColors);
    gl.uniform3fv(this.uR.uAmbientColor, this._ambientColor);
  };

  /** clusters: array of { x, y, status (0..3), intensity (0..1) } */
  SwarmParticles.prototype.setClusters = function (clusters) {
    var list = (clusters || []).slice(0, MAX_CLUSTERS);
    this.clusterCount = list.length;
    this.clusterData.fill(0);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      this.clusterData[i * 4] = c.x || 0;
      this.clusterData[i * 4 + 1] = c.y || 0;
      this.clusterData[i * 4 + 2] = c.status || 0;
      this.clusterData[i * 4 + 3] = Math.max(0, Math.min(1, c.intensity || 0));
    }
  };

  /** Step simulation + draw. pulse: [x, y, ageSeconds, type] or null. */
  SwarmParticles.prototype.render = function (time, aspect, dpr, ram, pulse) {
    var gl = this.gl;
    // MissionField owns the canvas and drops this layer on webglcontextlost, but
    // a loss mid-frame would otherwise spray GL errors from a dead context.
    if (gl.isContextLost()) return;
    var dt = this._lastT ? Math.min(0.05, time - this._lastT) : 0.016;
    this._lastT = time;
    var src = this.flip;
    var dst = 1 - this.flip;

    // -- update pass (transform feedback, no raster) --
    gl.useProgram(this.progUpdate);
    gl.uniform1f(this.uU.uTime, time);
    gl.uniform1f(this.uU.uDt, dt);
    gl.uniform1f(this.uU.uAspect, aspect);
    gl.uniform1f(this.uU.uRam, ram);
    gl.uniform4fv(this.uU.uClusters, this.clusterData);
    gl.uniform1f(this.uU.uClusterCount, this.clusterCount);
    gl.uniform4fv(this.uU.uPulse, pulse || [0, 0, 0, -1]);

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

    // -- render pass (additive points over nebula) --
    gl.useProgram(this.progRender);
    gl.uniform1f(this.uR.uAspect, aspect);
    gl.uniform1f(this.uR.uDpr, dpr);
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

  SwarmParticles.prototype.destroy = function () {
    var gl = this.gl;
    if (this.progUpdate) gl.deleteProgram(this.progUpdate);
    if (this.progRender) gl.deleteProgram(this.progRender);
    if (this.bufs) this.bufs.forEach(function (b) { gl.deleteBuffer(b); });
  };

  global.SwarmParticles = SwarmParticles;
})(typeof window !== "undefined" ? window : globalThis);
