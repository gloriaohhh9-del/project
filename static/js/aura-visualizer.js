// A MilkDrop-style music visualizer in WebGL 2, written for Aura.
//
// It uses the same techniques as the classic visualizers (MilkDrop, projectM,
// Winamp AVS, Windows Media Player's Battery): every frame the previous frame
// is drawn back into itself through a warp (zoom, rotate, swirl, ripple,
// wobble), dimmed a little (decay), and then new waveforms and shapes are
// drawn on top. Those few rules, repeated 30 times a second, produce the
// trails, tunnels and liquid smears these visualizers are known for. A last
// pass composites the result to the screen (echo, kaleidoscope, glow, hue,
// solarize, invert, vignette).
//
// Presets are original. Each one is a set of base values plus a per-frame
// function driven by the music (bass, mid, treb and their smoothed "_att"
// versions, around 1.0 on average, as in MilkDrop). Switching preset blends
// every value over a few seconds, so changes melt rather than cut.
//
// The feedback buffer starts as the listener's artwork, and the waves and
// shapes take their colours from it.
window.AuraVisualizer = (function () {
  const SIM_FPS = 30;

  // --- Audio: waveform, spectrum and MilkDrop-like band levels ---

  const FFT_N = 1024;
  const WAVE_N = 512;
  const SPEC_N = 256;

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = (-2 * Math.PI) / size;
      for (let j = 0; j < half; j++) {
        const wr = Math.cos(step * j);
        const wi = Math.sin(step * j);
        for (let i = j; i < n; i += size) {
          const k = i + half;
          const tr = re[k] * wr - im[k] * wi;
          const ti = re[k] * wi + im[k] * wr;
          re[k] = re[i] - tr;
          im[k] = im[i] - ti;
          re[i] += tr;
          im[i] += ti;
        }
      }
    }
  }

  // Returns read(t), to be called once per simulation frame, in order. It
  // keeps running averages, so bass/mid/treb mean "compared to how this song
  // has sounded for the last few seconds", like MilkDrop's.
  function audioReader(buffer) {
    const sr = buffer.sampleRate;
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const win = new Float32Array(FFT_N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1)));
    const re = new Float32Array(FFT_N);
    const im = new Float32Array(FFT_N);
    const waveL = new Float32Array(WAVE_N);
    const waveR = new Float32Array(WAVE_N);
    const spec = new Float32Array(SPEC_N);
    const binHz = sr / FFT_N;
    const bands = {
      bass: [Math.max(1, Math.round(20 / binHz)), Math.round(250 / binHz)],
      mid: [Math.round(250 / binHz), Math.round(2000 / binHz)],
      treb: [Math.round(2000 / binHz), Math.min(FFT_N / 2, Math.round(11000 / binHz))],
    };

    // A floor for the running averages, so near-silence doesn't read as huge
    // relative jumps.
    let peak = 0;
    for (let i = 0; i < L.length; i += 97) peak = Math.max(peak, Math.abs(L[i]));
    const floor = { bass: 0, mid: 0, treb: 0 };
    const avg = { bass: 0, mid: 0, treb: 0 };
    const out = {
      waveL, waveR, spec,
      bass: 1, mid: 1, treb: 1, bass_att: 1, mid_att: 1, treb_att: 1, vol: 1,
      beat: false, beatPulse: 0, level: 0,
    };
    let first = true;
    let lastBeat = -1;

    return function read(t, level, beat) {
      const centre = Math.floor(t * sr);
      const start = centre - FFT_N / 2;
      for (let i = 0; i < FFT_N; i++) {
        const k = start + i;
        const x = k >= 0 && k < L.length ? (L[k] + R[k]) * 0.5 : 0;
        re[i] = x * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let i = 0; i < WAVE_N; i++) {
        const k = centre - WAVE_N / 2 + i;
        const ok = k >= 0 && k < L.length;
        waveL[i] = ok ? L[k] / (peak || 1) : 0;
        waveR[i] = ok ? R[k] / (peak || 1) : 0;
      }
      for (let i = 0; i < SPEC_N; i++) {
        const m = Math.hypot(re[i + 1], im[i + 1]);
        spec[i] = spec[i] * 0.5 + Math.min(1.5, Math.sqrt(m) * 0.12) * 0.5;
      }

      for (const name of ["bass", "mid", "treb"]) {
        const [lo, hi] = bands[name];
        let sum = 0;
        for (let k = lo; k < hi; k++) sum += Math.hypot(re[k], im[k]);
        if (first) {
          avg[name] = sum;
          floor[name] = sum * 0.2;
        }
        floor[name] = Math.max(floor[name], sum * 0.05);
        avg[name] = avg[name] * 0.985 + sum * 0.015;
        const imm = Math.min(3, sum / Math.max(avg[name], floor[name], 1e-6));
        out[name] = imm;
        out[name + "_att"] = out[name + "_att"] * 0.85 + imm * 0.15;
      }
      first = false;
      out.vol = (out.bass + out.mid + out.treb) / 3;
      out.level = level == null ? Math.min(1.2, out.vol * 0.6) : level;

      // Beats come from the caller when it has them (the video maker measures
      // them over the whole song); otherwise from bass jumps.
      const frame = Math.round(t * SIM_FPS);
      const hit = beat == null ? out.bass > 1.35 && out.bass > out.bass_att * 1.2 : beat;
      out.beat = hit && frame - lastBeat > SIM_FPS * 0.22;
      if (out.beat) lastBeat = frame;
      out.beatPulse = out.beat ? 1 : out.beatPulse * 0.84;
      return out;
    };
  }

  // --- Colour ---

  function saturation(c) {
    const max = Math.max(...c);
    return max ? (max - Math.min(...c)) / max : 0;
  }

  const luma = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;

  // Everything the visualizer takes from the artwork:
  // - vivid: five of its colours, brightened, for waves and shapes;
  // - gradient: its colours from darkest to lightest (256 steps), which every
  //   frame is graded through so the whole video stays in its palette;
  // - vibe: how bright, colourful, contrasty, warm and detailed it is, which
  //   steers the choice of presets and the overall exposure.
  function readArtwork(source) {
    const res = 48;
    const c = document.createElement("canvas");
    c.width = c.height = res;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, res, res);
    const data = ctx.getImageData(0, 0, res, res).data;
    const px = [];
    for (let i = 0; i < data.length; i += 4) px.push([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);

    // Vibe.
    const lum = px.map(luma);
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const brightness = mean(lum);
    const contrast = Math.sqrt(mean(lum.map((v) => (v - brightness) ** 2)));
    const sat = mean(px.map(saturation));
    const warmth = mean(px.map((p) => p[0] - p[2]));
    let edges = 0;
    for (let y = 0; y < res - 1; y++) {
      for (let x = 0; x < res - 1; x++) {
        const i = y * res + x;
        edges += Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + res] - lum[i]);
      }
    }
    edges /= (res - 1) * (res - 1);
    const vibe = {
      brightness,
      contrast,
      saturation: sat,
      warmth,
      edges,
      // 1 = soft, painterly, flowing; 0 = sharp, detailed, geometric.
      flow: Math.max(0, Math.min(1, 1 - (edges - 0.015) / 0.09)),
    };

    // Main colours (k-means).
    const K = 8;
    const byLum = px.map((p, i) => [lum[i], p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    let centres = Array.from({ length: K }, (_, i) => byLum[Math.floor(((i + 0.5) / K) * byLum.length)].slice());
    let counts = new Array(K).fill(0);
    for (let iter = 0; iter < 10; iter++) {
      const sums = centres.map(() => [0, 0, 0]);
      counts = new Array(K).fill(0);
      for (const p of px) {
        let best = 0;
        let bestD = Infinity;
        centres.forEach((cc, k) => {
          const d = (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2 + (p[2] - cc[2]) ** 2;
          if (d < bestD) [best, bestD] = [k, d];
        });
        sums[best].forEach((_, d) => (sums[best][d] += p[d]));
        counts[best]++;
      }
      centres = centres.map((cc, k) => (counts[k] ? sums[k].map((v) => v / counts[k]) : cc));
    }
    const used = centres.filter((_, k) => counts[k] > px.length * 0.01);

    const vivid = used
      .map((col, k) => ({ col, score: saturation(col) * 0.7 + Math.max(...col) * 0.3 + (counts[k] / px.length) * 0.4 }))
      .sort((a, b) => b.score - a.score)
      .map(({ col }) => {
        const m = Math.max(...col) || 1;
        // Brighten to glow, but a grey stays grey.
        return col.map((v) => Math.min(1, Math.max(0.12, v / m) * 0.95));
      })
      .slice(0, 5);
    while (vivid.length < 5) vivid.push(vivid[vivid.length % Math.max(1, vivid.length)] || [0.9, 0.9, 0.9]);

    // Darkest to lightest, with a near-black start and a light end so
    // trails can fade out and highlights can glow without leaving the palette.
    const stops = used.slice().sort((a, b) => luma(a) - luma(b));
    const darkest = stops[0];
    const lightest = stops[stops.length - 1];
    stops.unshift(darkest.map((v) => v * 0.12));
    stops.push(lightest.map((v) => v + (1 - v) * 0.55));
    const gradient = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const u = (i / 255) * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(u));
      const f = u - k;
      for (let d = 0; d < 3; d++) gradient[i * 4 + d] = Math.round((stops[k][d] + (stops[k + 1][d] - stops[k][d]) * f) * 255);
      gradient[i * 4 + 3] = 255;
    }
    return { vivid, gradient, vibe };
  }

  // --- Shaders ---

  const VS_FULL = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const HUE_GLSL = `
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}`;

  // The feedback ("warp") pass: last frame, moved and dimmed.
  const FS_WARP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D prev;
uniform vec2 texel;
uniform float time, zoom, zoomExp, rot, warp, warpSpeed, warpScale;
uniform float cx, cy, dx, dy, sx, sy, swirl, tunnel, ripple, rippleFreq;
uniform float decay, blur, darkenCenter, hueDrift, dither;
uniform vec4 ob; uniform float obSize;
uniform vec4 ib; uniform float ibSize;
uniform sampler2D art;
uniform float artAmt, artZoom, artRot, artDx, artDy, artFlow;
uniform float shockAmt, shockAge, shockSpeed;
${HUE_GLSL}
void main() {
  vec2 uv = vUv;
  vec2 c = vec2(cx, cy);
  vec2 p = uv - c;
  float rad = length(uv - 0.5) * 1.41421;
  float z = zoom + tunnel * (rad - 0.5) + ripple * sin(rad * rippleFreq - time * 3.0);
  z = pow(max(z, 0.05), pow(zoomExp, rad * 2.0 - 1.0));
  float r = rot + swirl * (1.0 - rad);
  float cs = cos(r), sn = sin(r);
  p = mat2(cs, -sn, sn, cs) * p;
  p /= z;
  p /= vec2(sx, sy);
  float wt = time * warpSpeed;
  float ws = 6.0 / max(warpScale, 0.05);
  float w = warp * 0.0035;
  p.x += w * sin(wt * 0.333 + ws * (uv.x * 0.83 - uv.y * 0.49) + 1.0);
  p.y += w * cos(wt * 0.375 - ws * (uv.x * 0.41 + uv.y * 0.97) + 2.0);
  p.x += w * cos(wt * 0.753 - ws * (uv.x * 1.17 + uv.y * 0.21) + 3.0);
  p.y += w * sin(wt * 0.825 + ws * (uv.x * 0.29 - uv.y * 1.13) + 4.0);
  vec2 s = c + p - vec2(dx, dy);

  // Beat shockwave: a ring that pushes outward from the centre after each
  // beat, fading as it travels.
  if (shockAmt > 0.0) {
    vec2 d = uv - 0.5;
    float front = shockAge * shockSpeed;
    float ring = exp(-pow((length(d) - front) / 0.045, 2.0)) * exp(-shockAge * 2.2);
    s -= normalize(d + 1e-5) * ring * shockAmt * 0.035;
  }

  vec3 col = textureLod(prev, s, 0.0).rgb;
  if (blur > 0.0) {
    vec3 b = textureLod(prev, s + vec2(texel.x, 0.0), 0.0).rgb + textureLod(prev, s - vec2(texel.x, 0.0), 0.0).rgb
           + textureLod(prev, s + vec2(0.0, texel.y), 0.0).rgb + textureLod(prev, s - vec2(0.0, texel.y), 0.0).rgb;
    col = mix(col, b * 0.25, blur);
  }
  if (hueDrift != 0.0) col = hueRot(col, hueDrift);
  col *= decay;

  // The artwork keeps flowing in underneath: a slowly moving view of it,
  // rippled by the same motion as the feedback, so trails fade into the
  // painting instead of into black.
  if (artAmt > 0.0) {
    vec2 q = uv - 0.5;
    float ac = cos(artRot), as = sin(artRot);
    q = mat2(ac, -as, as, ac) * q / artZoom;
    vec2 at = 0.5 + q + vec2(artDx, artDy) + (s - uv) * artFlow;
    col = mix(col, texture(art, at).rgb, artAmt);
  }
  col -= dither * fract(sin(dot(uv + fract(time), vec2(12.9898, 78.233))) * 43758.5453) / 255.0;
  col *= 1.0 - darkenCenter * smoothstep(0.09, 0.0, length(uv - 0.5));

  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  col = mix(col, ob.rgb, ob.a * step(edge, obSize));
  col = mix(col, ib.rgb, ib.a * step(edge, obSize + ibSize) * step(obSize, edge));
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

  // Waves and shapes: coloured triangles, optionally showing the last frame
  // inside them (MilkDrop's "textured" shapes, which make endless tunnels).
  const VS_DRAW = `#version 300 es
in vec2 aPos;
in vec2 aTex;
in vec4 aCol;
out vec2 vTex;
out vec4 vCol;
void main() { vTex = aTex; vCol = aCol; gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0); }`;

  const FS_DRAW = `#version 300 es
precision highp float;
in vec2 vTex;
in vec4 vCol;
out vec4 o;
uniform sampler2D prev;
uniform float textured;
void main() {
  vec4 c = vCol;
  if (textured > 0.5) c.rgb *= texture(prev, vTex).rgb;
  o = c;
}`;

  // The final picture: echo, kaleidoscope, glow and colour.
  const FS_COMP = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D tex;
uniform float time, echoZoom, echoAlpha, echoFlipX, echoFlipY, gamma, bloom;
uniform float kaleidoSegs, kaleidoAmt, kaleidoRot, invert, solarize, hue, vignette, brighten;
uniform sampler2D grad;
uniform sampler2D art;
uniform float gradeAmt, artShow;
uniform float bump, chroma, mirrorX, mirrorY, mosaic, mosaicCells, grain;
${HUE_GLSL}
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
// The feedback image, with an RGB split towards the edges and embossed
// "chrome" lighting from its own brightness.
vec3 base(vec2 uv) {
  vec3 col = texture(tex, uv).rgb;
  if (chroma > 0.0) {
    vec2 d = (uv - 0.5) * chroma * 0.035;
    col = vec3(texture(tex, uv + d).r, col.g, texture(tex, uv - d).b);
  }
  if (bump > 0.0) {
    vec2 e = 1.5 / vec2(textureSize(tex, 0));
    float l0 = dot(texture(tex, uv).rgb, LUMA);
    float lx = dot(texture(tex, uv + vec2(e.x, 0.0)).rgb, LUMA);
    float ly = dot(texture(tex, uv + vec2(0.0, e.y)).rgb, LUMA);
    vec3 n = normalize(vec3((l0 - lx) * 22.0, (l0 - ly) * 22.0, 1.0));
    vec3 L = normalize(vec3(-0.5, 0.6, 0.65));
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(reflect(-L, n).z, 0.0), 24.0);
    col = mix(col, col * (0.3 + diff * 1.0) + spec * 0.55, bump);
  }
  return col;
}
vec2 kaleido(vec2 uv) {
  vec2 p = uv - 0.5;
  float seg = 6.28318 / kaleidoSegs;
  float a = mod(atan(p.y, p.x) + kaleidoRot, seg);
  a = abs(a - seg * 0.5);
  return 0.5 + length(p) * vec2(cos(a), sin(a));
}
vec3 look(vec2 uv) {
  vec3 col = base(uv);
  if (echoAlpha > 0.0) {
    vec2 e = (uv - 0.5) / echoZoom;
    if (echoFlipX > 0.5) e.x = -e.x;
    if (echoFlipY > 0.5) e.y = -e.y;
    col = mix(col, texture(tex, e + 0.5).rgb, echoAlpha);
  }
  if (bloom > 0.0) col += (textureLod(tex, uv, 3.0).rgb * 0.6 + textureLod(tex, uv, 5.0).rgb * 0.4) * bloom;
  return col;
}
vec3 scene(vec2 uv) {
  vec3 col = look(uv);
  if (kaleidoAmt > 0.0) col = mix(col, look(kaleido(uv)), kaleidoAmt);
  return col;
}
void main() {
  vec2 uv = vUv;
  vec3 col = scene(uv);
  float mAmt = max(mirrorX, mirrorY);
  if (mAmt > 0.0) {
    vec2 m = uv;
    if (mirrorX > 0.0) m.x = 0.5 - abs(uv.x - 0.5);
    if (mirrorY > 0.0) m.y = 0.5 - abs(uv.y - 0.5);
    col = mix(col, scene(m), mAmt);
  }
  if (mosaic > 0.0) {
    vec2 q = (floor(uv * mosaicCells) + 0.5) / mosaicCells;
    col = mix(col, scene(q), mosaic);
  }
  col *= gamma;
  col += brighten * col * col;
  if (hue != 0.0) col = hueRot(col, hue);
  col = mix(col, abs(sin(col * 3.14159 * 1.5)), solarize);
  col = mix(col, 1.0 - clamp(col, 0.0, 1.0), invert);
  col = clamp(col, 0.0, 1.0);
  // Grade through the artwork's own colours (darkest to lightest), keeping
  // a little of the original colour so waves still read as distinct.
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 graded = texture(grad, vec2(l, 0.5)).rgb;
  col = mix(col, graded + (col - l) * 0.6, gradeAmt);
  col *= 1.0 - vignette * smoothstep(0.35, 0.75, length(vUv - 0.5));
  if (grain > 0.0) col += (fract(sin(dot(vUv * 731.0 + fract(time * 7.13), vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * grain;
  col = mix(clamp(col, 0.0, 1.0), texture(art, vUv).rgb, artShow);
  o = vec4(col, 1.0);
}`;

  // --- Preset values ---

  const DEFAULTS = {
    zoom: 1, zoomExp: 1, rot: 0, warp: 0, warpSpeed: 1, warpScale: 1,
    cx: 0.5, cy: 0.5, dx: 0, dy: 0, sx: 1, sy: 1,
    swirl: 0, tunnel: 0, ripple: 0, rippleFreq: 14,
    decay: 0.97, blur: 0, darkenCenter: 0, hueDrift: 0,
    ob: [0, 0, 0], obA: 0, obSize: 0, ib: [0, 0, 0], ibA: 0, ibSize: 0,
    echoZoom: 1, echoAlpha: 0, echoFlipX: 0, echoFlipY: 0,
    gamma: 1, bloom: 0.3, kaleidoSegs: 6, kaleidoAmt: 0, kaleidoRot: 0,
    invert: 0, solarize: 0, hue: 0, vignette: 0.3, brighten: 0,
    artAmt: 0.04, artZoom: 1, artRot: 0, artDx: 0, artDy: 0, artFlow: 6, gradeAmt: 0.5,
    shockAmt: 0, shockSpeed: 0.9, bump: 0, chroma: 0, mirrorX: 0, mirrorY: 0, mosaic: 0, mosaicCells: 48, grain: 0.012,
  };

  // The artwork, untouched: the video opens on this and blends into the first preset.
  const STILL = {
    name: "Artwork",
    base: { decay: 1, bloom: 0, vignette: 0, artAmt: 0, gradeAmt: 0, grain: 0 },
    frame() {},
    waves: () => [],
    shapes: () => [],
  };

  const TAU = Math.PI * 2;
  const DT = 1 / SIM_FPS;

  // --- Helpers presets draw with ---

  // 3D: rotate a point around the X axis then the Y axis, and project it
  // with perspective onto the screen (x, y in -1..1 fill the frame).
  function rot3(x, y, z, ax, ay) {
    let c = Math.cos(ax);
    let sn = Math.sin(ax);
    [y, z] = [y * c - z * sn, y * sn + z * c];
    c = Math.cos(ay);
    sn = Math.sin(ay);
    return [x * c + z * sn, y, -x * sn + z * c];
  }
  function project([x, y, z], dist = 2.8) {
    const k = dist / (dist + z);
    return [0.5 + x * k * 0.5, 0.5 + y * k * 0.5];
  }

  // A sphere of n points; each point is pushed out by the spectrum.
  function spherePoints(n, rad, ax, ay, a, push) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const phi = i * 2.39996;
      const k = rad * (1 + a.spec[(i * 7) % 96] * push);
      pts.push(project(rot3(Math.cos(phi) * r * k, y * k, Math.sin(phi) * r * k, ax, ay)));
    }
    return pts;
  }

  // A wireframe torus as rings, its tube swelling with the bass.
  function torusPaths(rings, segs, R, r, ax, ay) {
    const paths = [];
    for (let i = 0; i < rings; i++) {
      const u = (i / rings) * TAU;
      const path = [];
      for (let j = 0; j <= segs; j++) {
        const v = (j / segs) * TAU;
        path.push(project(rot3((R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v), ax, ay)));
      }
      paths.push(path);
    }
    return paths;
  }

  // Rose curve r = cos(k*theta), wobbled by the waveform.
  function rosePath(k, rad, rot, a, wobble) {
    const n = 420;
    const path = [];
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * TAU;
      const r = rad * Math.cos(k * th) * (1 + a.waveL[i % 512] * wobble);
      path.push([0.5 + r * Math.cos(th + rot), 0.5 + r * Math.sin(th + rot)]);
    }
    return path;
  }

  // Lissajous figure, wobbled by the waveform.
  function lissajousPath(fa, fb, phase, amp, a, wobble) {
    const n = 420;
    const path = [];
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * TAU;
      const w = 1 + a.waveL[i % 512] * wobble;
      path.push([0.5 + amp * w * Math.sin(fa * u + phase), 0.5 + amp * w * Math.sin(fb * u)]);
    }
    return path;
  }

  // Moves particles on, slows them by drag, drops old ones and ones that
  // left the frame.
  function stepParticles(list, drag, maxAge) {
    for (const q of list) {
      q.x += q.vx * DT;
      q.y += q.vy * DT;
      q.vx *= drag;
      q.vy *= drag;
      q.age += DT;
    }
    return list.filter((q) => q.age < maxAge && q.x > -0.1 && q.x < 1.1 && q.y > -0.1 && q.y < 1.1);
  }

  // MilkDrop-style motion vectors: a grid of short streaks showing where
  // the feedback is carrying the picture.
  function motionVectors(p, nx, ny, len) {
    const paths = [];
    const cr = Math.cos(p.rot);
    const sr = Math.sin(p.rot);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) / nx;
        const y = (j + 0.5) / ny;
        const px = (x - p.cx) / p.zoom;
        const py = (y - p.cy) / p.zoom;
        const sx = p.cx + px * cr - py * sr - p.dx;
        const sy = p.cy + px * sr + py * cr - p.dy;
        paths.push([[x, y], [x + (x - sx) * len, y + (y - sy) * len]]);
      }
    }
    return paths;
  }

  // Deterministic pseudo-random number in 0..1.
  function hash(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // Each preset has an energy (0 calm .. 1 intense)
  // and a flow (1 soft and liquid .. 0 sharp and geometric); the video maker
  // matches energy to the song's sections and flow to the artwork.
  const PRESETS = [
    {
      name: "Velvet Drift",
      energy: 0.1,
      flow: 0.95,
      base: { artAmt: 0.045, decay: 0.985, warp: 0.8, warpScale: 1.4, blur: 0.35, bloom: 0.35, darkenCenter: 0.3 },
      frame(p, a, t) {
        p.zoom = 1.006 + 0.012 * (a.bass_att - 1);
        p.rot = 0.0025 * Math.sin(t * 0.21);
        p.dx = 0.0012 * Math.sin(t * 0.13);
        p.dy = 0.0012 * Math.cos(t * 0.17);
        p.warp = 0.8 + 0.6 * a.mid_att;
      },
      waves: (a, t, s, pal) => [
        { mode: "circle", color: pal(0, t * 4), alpha: 0.55, rad: 0.22 + 0.04 * a.bass_att, scale: 0.8 * (0.4 + a.level), thick: 2, smooth: 3, rot: t * 0.1 },
      ],
      shapes: () => [],
    },
    {
      name: "Mirror Lake",
      energy: 0.2,
      flow: 0.9,
      base: { artAmt: 0.04, decay: 0.965, echoAlpha: 0.5, echoFlipY: 1, warp: 0.5, hueDrift: 0.002, bloom: 0.35, vignette: 0.4 },
      frame(p, a, t) {
        p.zoom = 1.004;
        p.dy = -0.0035;
        p.sx = 1.0 + 0.004 * Math.sin(t * 0.3);
        p.echoZoom = 1.0 + 0.04 * Math.sin(t * 0.15);
      },
      waves: (a, t, s, pal) => [
        { mode: "dual", color: pal(1, t * 3), color2: pal(2, t * 3), alpha: 0.75, y: 0.62, sep: 0.06, scale: 0.9 * (0.5 + a.level), thick: 2.5, smooth: 2, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Silk Ribbons",
      energy: 0.35,
      flow: 0.85,
      base: { artAmt: 0.035, decay: 0.975, warp: 1.2, warpSpeed: 0.8, bloom: 0.5, zoom: 0.996 },
      frame(p, a, t) {
        p.rot = 0.008 + 0.006 * (a.mid_att - 1);
        p.zoom = 0.994 - 0.006 * (a.bass - 1);
        p.hue = 0.25 * Math.sin(t * 0.05);
      },
      waves: (a, t, s, pal) => [
        { mode: "scope", color: pal(0, t * 6), color2: pal(3, t * 6), alpha: 0.7, scale: 1.2 * (0.5 + a.level), thick: 2, rot: t * 0.21, additive: true, smooth: 1 },
      ],
      shapes: () => [],
    },
    {
      name: "Spiral Garden",
      energy: 0.45,
      flow: 0.2,
      base: { artAmt: 0.04, decay: 0.955, kaleidoSegs: 6, kaleidoAmt: 1, bloom: 0.45, swirl: 0.02 },
      frame(p, a, t) {
        p.zoom = 1.015 + 0.02 * (a.bass_att - 1);
        p.swirl = 0.02 + 0.015 * Math.sin(t * 0.2);
        p.kaleidoRot = t * 0.05;
      },
      waves: (a, t, s, pal) => [
        { mode: "dots", color: pal(0, t * 10), color2: pal(2, t * 10), alpha: 0.85, rad: 0.32, scale: 0.8 * (0.4 + a.level), thick: 3.5, rot: t * 0.3, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Prism Tunnel",
      energy: 0.45,
      flow: 0.15,
      base: { artAmt: 0.035, decay: 0.97, bloom: 0.35, darkenCenter: 0.2, vignette: 0.45 },
      frame(p, a, t) {
        p.zoom = 1.0 + 0.01 * (a.bass_att - 1);
        p.rot = 0.004 * Math.sin(t * 0.17);
      },
      waves: (a, t, s, pal) => [
        { mode: "circle", color: pal(1, t * 8), alpha: 0.8, rad: 0.12 + 0.03 * a.bass, scale: 0.6 * (0.4 + a.level), thick: 2.5, smooth: 3, additive: true },
      ],
      shapes: (a, t, s, pal) => [
        { sides: 4, x: 0.5, y: 0.5, rad: 0.62, ang: t * 0.12 + 0.02 * a.bass, color: [1, 1, 1, 0.92], color2: [1, 1, 1, 0.92], textured: true, texZoom: 1.12 + 0.04 * (a.bass_att - 1), texAng: 0.03 * Math.sin(t * 0.3), border: [...pal(2, t * 5), 0.5], thick: 2 },
      ],
    },
    {
      name: "Ember Bloom",
      energy: 0.6,
      flow: 0.6,
      base: { artAmt: 0.04, decay: 0.94, bloom: 0.65, ripple: 0.012, rippleFreq: 22, darkenCenter: 0.4 },
      frame(p, a, t) {
        p.zoom = 1.02 + 0.035 * (a.bass - 1);
        p.ripple = 0.008 + 0.012 * a.treb_att;
        p.hue = -0.2 + 0.1 * Math.sin(t * 0.07);
      },
      waves: (a, t, s, pal) => [
        { mode: "specRing", color: pal(0, 0), color2: pal(1, 0), alpha: 0.9, rad: 0.16, scale: 1.0 * (0.4 + a.level), thick: 2.5, rot: t * 0.15, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Liquid Orbit",
      energy: 0.5,
      flow: 0.9,
      base: { artAmt: 0.035, decay: 0.97, warp: 2.0, warpScale: 0.8, bloom: 0.55 },
      frame(p, a, t) {
        p.zoom = 1.008 + 0.01 * (a.bass_att - 1);
        p.rot = 0.015 + 0.01 * (a.mid - 1);
        p.warp = 1.5 + 1.2 * a.treb_att;
      },
      waves: () => [],
      shapes: (a, t, s, pal) =>
        [0, 1, 2].map((i) => {
          const ang = t * (0.45 + i * 0.13) + (i * TAU) / 3;
          const r = 0.22 + 0.06 * Math.sin(t * 0.5 + i) + 0.04 * (a.bass - 1);
          return {
            sides: 32, x: 0.5 + r * Math.cos(ang), y: 0.5 + r * Math.sin(ang),
            rad: 0.035 + 0.03 * a.bass_att * (0.3 + a.level), ang: 0,
            color: [...pal(i, t * 6), 0.9], color2: [...pal(i + 1, t * 6), 0], additive: true,
          };
        }),
    },
    {
      name: "Neon Lattice",
      energy: 0.75,
      flow: 0.1,
      base: { artAmt: 0.03, decay: 0.925, kaleidoSegs: 8, kaleidoAmt: 1, echoAlpha: 0.35, echoZoom: 1.3, bloom: 0.45, obSize: 0.008 },
      frame(p, a, t) {
        p.zoom = 1.03 + 0.03 * (a.bass_att - 1);
        p.rot = 0.01 * Math.sin(t * 0.4);
        p.obA = 0.15 + 0.7 * a.beatPulse;
        p.kaleidoRot = -t * 0.04;
      },
      waves: (a, t, s, pal) => [
        { mode: "line", color: pal(2, t * 12), color2: pal(0, t * 12), alpha: 0.9, x: 0.5, y: 0.5, len: 1.1, scale: 1.2 * (0.4 + a.level), thick: 2.5, rot: t * 0.6, additive: true },
      ],
      shapes: () => [],
      borders: (a, t, s, pal) => ({ ob: pal(1, t * 20) }),
    },
    {
      name: "Bass Quake",
      energy: 0.85,
      flow: 0.4,
      base: { artAmt: 0.035, decay: 0.93, bloom: 0.5, blur: 0.25, vignette: 0.35 },
      init: (s) => (s.dir = 1),
      frame(p, a, t, s) {
        if (a.beat) s.dir = -s.dir;
        p.zoom = 1.0 + 0.11 * a.beatPulse + 0.01 * (a.bass_att - 1);
        p.rot = s.dir * (0.006 + 0.03 * a.beatPulse);
        p.solarize = 0.25 * a.beatPulse;
        p.warp = 0.5 + 2 * a.beatPulse;
        p.shockAmt = 0.6;
      },
      waves: (a, t, s, pal) => [
        { mode: "circle", color: pal(0, t * 15), alpha: 0.95, rad: 0.18 + 0.08 * a.beatPulse, scale: 1.2 * (0.4 + a.level), thick: 4, smooth: 2, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Starburst",
      energy: 0.8,
      flow: 0.3,
      base: { artAmt: 0.03, decay: 0.9, tunnel: 0.08, darkenCenter: 0.6, bloom: 0.6, hueDrift: 0.015 },
      frame(p, a, t) {
        p.zoom = 1.05 + 0.04 * (a.bass_att - 1);
        p.rot = 0.006 * Math.sin(t * 0.33);
        p.tunnel = 0.06 + 0.06 * a.treb_att;
      },
      waves: (a, t, s, pal) => [
        { mode: "dots", color: pal(0, t * 20), color2: pal(3, t * 20), alpha: 0.9, rad: 0.45, scale: 1.6 * (0.3 + a.level), thick: 2.5, rot: -t * 0.5, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Plasma Fold",
      energy: 0.65,
      flow: 0.8,
      base: { artAmt: 0.035, decay: 0.975, warp: 3.5, warpScale: 0.55, warpSpeed: 1.4, kaleidoSegs: 4, kaleidoAmt: 0.55, bloom: 0.5, hueDrift: 0.01 },
      frame(p, a, t) {
        p.zoom = 1.01 + 0.02 * (a.bass - 1);
        p.swirl = 0.06 * Math.sin(t * 0.23);
        p.kaleidoRot = t * 0.07;
      },
      waves: (a, t, s, pal) => [
        { mode: "spectrum", color: pal(1, t * 9), color2: pal(2, t * 9), alpha: 0.85, y: 0.3, scale: 1.0 * (0.4 + a.level), thick: 2.5, mirror: true, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Hyperspace",
      energy: 1.0,
      flow: 0.3,
      base: { artAmt: 0.025, decay: 0.92, tunnel: 0.12, echoAlpha: 0.25, echoZoom: 1.6, echoFlipX: 1, bloom: 0.45, darkenCenter: 0.5 },
      frame(p, a, t) {
        p.zoom = 1.07 + 0.06 * (a.bass - 1);
        p.rot = 0.02 * (a.mid_att - 1) + 0.01 * Math.sin(t * 0.5);
        p.invert = 0.35 * Math.max(0, a.beatPulse - 0.6);
        p.chroma = 0.6 * a.beatPulse;
        p.hue = 0.3 * Math.sin(t * 0.05);
      },
      waves: (a, t, s, pal) => [
        { mode: "specRing", color: pal(0, t * 25), color2: pal(2, t * 25), alpha: 0.95, rad: 0.1 + 0.05 * a.bass_att, scale: 1.3 * (0.4 + a.level), thick: 3, rot: t, additive: true },
      ],
      shapes: (a, t, s, pal) => [
        { sides: 6, x: 0.5, y: 0.5, rad: 0.09 + 0.05 * a.beatPulse, ang: -t * 0.8, color: [1, 1, 1, 0.85], color2: [1, 1, 1, 0.85], textured: true, texZoom: 0.6, texAng: t * 0.4, additive: true },
      ],
    },
    {
      name: "Firefly Swarm",
      energy: 0.3,
      flow: 0.8,
      base: { artAmt: 0.04, decay: 0.955, warp: 1.0, blur: 0.2, bloom: 0.55, zoom: 1.003 },
      init: (s) => (s.flies = []),
      frame(p, a, t, s) {
        p.rot = 0.003 * Math.sin(t * 0.2);
        while (s.flies.length < 90) {
          const n = s.flies.length + t * 13;
          s.flies.push({ x: hash(n), y: hash(n + 1), vx: 0, vy: 0, age: 0, seed: hash(n + 2) * 100 });
        }
        for (const f of s.flies) {
          // Each firefly wanders on its own slow current; highs make them dart.
          const ang = Math.sin(t * 0.4 + f.seed) * 3 + Math.cos(t * 0.23 + f.seed * 1.7) * 2;
          const sp = 0.03 + 0.05 * a.treb_att;
          f.vx += Math.cos(ang) * sp * 0.15;
          f.vy += Math.sin(ang) * sp * 0.15;
        }
        s.flies = stepParticles(s.flies, 0.9, 30);
      },
      waves: (a, t, s, pal) => [
        { points: s.flies.map((f) => [f.x, f.y]), color: pal(0, t * 6), color2: pal(2, t * 6), alpha: 0.5 + 0.4 * a.treb, thick: 3, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Spark Fountain",
      energy: 0.9,
      flow: 0.3,
      base: { artAmt: 0.03, decay: 0.9, tunnel: 0.05, bloom: 0.6, shockAmt: 0.6, darkenCenter: 0.3 },
      init: (s) => (s.sparks = []),
      frame(p, a, t, s) {
        p.zoom = 1.03 + 0.04 * (a.bass_att - 1);
        p.rot = 0.01 * Math.sin(t * 0.3);
        const burst = a.beat ? 70 : a.treb > 1.3 ? 4 : 0;
        for (let i = 0; i < burst; i++) {
          const n = t * 97 + i;
          const ang = hash(n) * TAU;
          const sp = 0.25 + hash(n + 1) * 0.6 * (0.5 + a.bass);
          s.sparks.push({ x: 0.5, y: 0.5, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, age: 0 });
        }
        s.sparks = stepParticles(s.sparks, 0.95, 2.5).slice(-400);
      },
      waves: (a, t, s, pal) => [
        { paths: s.sparks.map((q) => [[q.x, q.y], [q.x - q.vx * 0.06, q.y - q.vy * 0.06]]), color: pal(0, t * 15), color2: pal(1, t * 15), alpha: 0.9, thick: 2, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Shockwave",
      energy: 0.8,
      flow: 0.4,
      base: { artAmt: 0.035, decay: 0.95, shockAmt: 1.2, shockSpeed: 0.8, bloom: 0.5, vignette: 0.4 },
      frame(p, a, t) {
        p.zoom = 1.01 + 0.015 * (a.bass_att - 1);
        p.chroma = 0.15 + 0.8 * a.beatPulse;
        p.rot = 0.004 * Math.sin(t * 0.25);
      },
      waves: (a, t, s, pal) => [
        { mode: "circle", color: pal(0, t * 10), alpha: 0.9, rad: 0.08 + 0.3 * (1 - a.beatPulse), scale: 0.8 * (0.4 + a.level), thick: 3, smooth: 2, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Chrome Relief",
      energy: 0.5,
      flow: 0.75,
      base: { artAmt: 0.045, decay: 0.975, warp: 2.5, warpScale: 0.7, bump: 0.75, blur: 0.25, bloom: 0.3, artFlow: 9 },
      frame(p, a, t) {
        p.zoom = 1.004 + 0.008 * (a.bass_att - 1);
        p.warp = 2 + 1.5 * a.mid_att;
        p.bump = 0.75 + 0.15 * (a.bass_att - 1);
      },
      waves: (a, t, s, pal) => [
        { mode: "circle", color: pal(1, t * 5), alpha: 0.9, rad: 0.2 + 0.05 * a.bass_att, scale: 1.2 * (0.5 + a.level), thick: 6, smooth: 3, rot: t * 0.17 },
        { mode: "circle", color: pal(0, t * 5), alpha: 0.7, rad: 0.33, scale: 0.8 * (0.5 + a.level), thick: 4, smooth: 3, rot: -t * 0.11 },
      ],
      shapes: () => [],
    },
    {
      name: "Rose Garden",
      energy: 0.4,
      flow: 0.55,
      base: { artAmt: 0.04, decay: 0.95, mirrorX: 1, mirrorY: 1, swirl: 0.02, bloom: 0.45 },
      frame(p, a, t) {
        p.zoom = 1.01 + 0.015 * (a.bass_att - 1);
        p.swirl = 0.02 + 0.02 * Math.sin(t * 0.15);
      },
      waves: (a, t, s, pal) => {
        // The number of petals drifts slowly between 2 and 7.
        const k = 4.5 + 2.5 * Math.sin(t * 0.045);
        return [
          { paths: [rosePath(k, 0.32 + 0.05 * a.bass_att, t * 0.12, a, 0.25 * (0.4 + a.level))], color: pal(0, t * 8), color2: pal(3, t * 8), alpha: 0.8, thick: 2.5, additive: true },
        ];
      },
      shapes: () => [],
    },
    {
      name: "Orbiting Sphere",
      energy: 0.55,
      flow: 0.35,
      base: { artAmt: 0.035, decay: 0.9, echoAlpha: 0.2, echoZoom: 1.4, bloom: 0.55, darkenCenter: 0.2 },
      init: (s) => (s.ax = 0),
      frame(p, a, t, s) {
        p.zoom = 1.02 + 0.02 * (a.bass_att - 1);
        s.ax += DT * (0.3 + 0.5 * a.mid_att);
      },
      waves: (a, t, s, pal) => [
        { points: spherePoints(320, 0.55 + 0.12 * a.bass, s.ax, t * 0.37, a, 0.35 * (0.4 + a.level)), color: pal(0, t * 8), color2: pal(2, t * 8), alpha: 0.85, thick: 3, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Lissajous Loom",
      energy: 0.3,
      flow: 0.5,
      base: { artAmt: 0.04, decay: 0.96, bloom: 0.4, blur: 0.15 },
      frame(p, a, t, s) {
        p.zoom = 1.006;
        p.rot = 0.005 * Math.sin(t * 0.17);
        s.p = p;
      },
      waves: (a, t, s, pal) => [
        { paths: [lissajousPath(3, 2, t * 0.4, 0.38, a, 0.2 * (0.4 + a.level))], color: pal(1, t * 5), color2: pal(0, t * 5), alpha: 0.8, thick: 2, additive: true },
        { paths: motionVectors(s.p, 18, 18, 6), color: pal(2, t * 3), alpha: 0.25 + 0.2 * a.mid, thick: 1.5, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Pixel Pulse",
      energy: 0.85,
      flow: 0.05,
      base: { artAmt: 0.03, decay: 0.88, bloom: 0.4, mosaicCells: 40, grain: 0.04, vignette: 0.4 },
      frame(p, a, t) {
        p.zoom = 1.02 + 0.03 * (a.bass - 1);
        p.mosaic = 0.85 * a.beatPulse;
        p.dy = 0.002;
      },
      waves: (a, t, s, pal) => {
        const bars = [];
        for (let i = 0; i < 32; i++) {
          const x = (i + 0.5) / 32;
          // Log-spaced bands, with the highs lifted so every bar moves.
          const lo = Math.floor(1 + 180 ** (i / 32));
          const hi = Math.max(lo + 1, Math.floor(1 + 180 ** ((i + 1) / 32)));
          let sum = 0;
          for (let k = lo; k < hi; k++) sum += a.spec[k];
          const h = Math.min(0.6, (sum / (hi - lo)) * (0.6 + i * 0.06) * 0.3 * (0.4 + a.level));
          bars.push([[x, 0.06], [x, 0.06 + h]]);
        }
        return [{ paths: bars, color: pal(0, t * 12), color2: pal(3, t * 12), alpha: 0.9, thick: 12 }];
      },
      shapes: () => [],
    },
    {
      name: "Twin Mirror",
      energy: 0.4,
      flow: 0.6,
      base: { artAmt: 0.04, decay: 0.96, mirrorX: 1, echoAlpha: 0.3, echoFlipY: 1, warp: 0.8, bloom: 0.45 },
      frame(p, a, t) {
        p.zoom = 1.008 + 0.01 * (a.bass_att - 1);
        p.dx = 0.003 * Math.sin(t * 0.21);
        p.rot = 0.006 * Math.sin(t * 0.13);
      },
      waves: (a, t, s, pal) => [
        { mode: "scope", x: 0.3, y: 0.55, color: pal(0, t * 7), color2: pal(1, t * 7), alpha: 0.8, scale: 0.9 * (0.5 + a.level), thick: 2.5, rot: t * 0.3, additive: true },
      ],
      shapes: () => [],
    },
    {
      name: "Torus Drift",
      energy: 0.6,
      flow: 0.45,
      base: { artAmt: 0.035, decay: 0.93, zoom: 0.995, bloom: 0.55, vignette: 0.4 },
      init: (s) => (s.ay = 0),
      frame(p, a, t, s) {
        p.zoom = 0.996 - 0.01 * (a.bass - 1);
        p.rot = 0.008;
        s.ay += DT * (0.25 + 0.4 * a.mid_att);
      },
      waves: (a, t, s, pal) => [
        { paths: torusPaths(14, 40, 0.5, 0.16 + 0.07 * a.bass_att, t * 0.3 + 0.9, s.ay), color: pal(1, t * 6), color2: pal(0, t * 6), alpha: 0.7, thick: 1.8, additive: true },
      ],
      shapes: () => [],
    },
  ];

  // --- Geometry ---

  function smoothArray(src, passes) {
    let a = Float32Array.from(src);
    for (let p = 0; p < passes; p++) {
      const b = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) b[i] = (a[Math.max(0, i - 1)] + a[i] * 2 + a[Math.min(a.length - 1, i + 1)]) * 0.25;
      a = b;
    }
    return a;
  }

  function wavePoints(w, a) {
    // Presets can also hand over their own geometry.
    if (w.paths) return { lines: w.paths, dots: [] };
    if (w.points) return { lines: [], dots: w.points };
    const L = smoothArray(a.waveL, w.smooth || 0);
    const R = smoothArray(a.waveR, w.smooth || 0);
    const sc = w.scale == null ? 1 : w.scale;
    const rot = w.rot || 0;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const cx = w.x == null ? 0.5 : w.x;
    const cy = w.y == null ? 0.5 : w.y;
    const place = (x, y) => [cx + x * cr - y * sr, cy + x * sr + y * cr];
    const lines = [];
    let pts = [];

    switch (w.mode) {
      case "line": {
        const n = 220;
        const len = w.len || 1;
        for (let i = 0; i < n; i++) pts.push(place((i / (n - 1) - 0.5) * len, L[Math.floor((i / n) * L.length)] * sc * 0.18));
        lines.push(pts);
        break;
      }
      case "dual": {
        const n = 220;
        for (const [src, off] of [[L, w.sep || 0.05], [R, -(w.sep || 0.05)]]) {
          pts = [];
          for (let i = 0; i < n; i++) pts.push([i / (n - 1), cy + off + src[Math.floor((i / n) * src.length)] * sc * 0.12]);
          lines.push(pts);
        }
        break;
      }
      case "circle": {
        const n = 200;
        const rad = w.rad || 0.25;
        for (let i = 0; i <= n; i++) {
          // Fade the last stretch into the start so the loop closes.
          const u = (i % n) / n;
          const k = Math.floor(u * L.length * 0.9);
          const blend = Math.max(0, (u - 0.85) / 0.15);
          const s = L[k] * (1 - blend) + L[0] * blend;
          const r = rad + s * sc * 0.1;
          const ang = u * TAU + rot;
          pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
        }
        lines.push(pts);
        break;
      }
      case "scope": {
        const n = 240;
        // Phase plot: each sample against one a moment later (mixed with the
        // other channel), which draws loops even for a mono song.
        const lag = 28;
        for (let i = 0; i < n; i++) {
          const k = i * 2;
          pts.push(place(L[k] * sc * 0.45, (R[k + lag] * 0.6 + L[k + lag] * 0.4) * sc * 0.45));
        }
        lines.push(pts);
        break;
      }
      case "spectrum": {
        const n = 128;
        const y0 = w.y == null ? 0.3 : w.y;
        for (const dir of w.mirror ? [1, -1] : [1]) {
          pts = [];
          for (let i = 0; i < n; i++) {
            const v = a.spec[Math.floor((i / n) ** 1.6 * SPEC_N * 0.9)];
            pts.push([i / (n - 1), 0.5 + dir * (y0 - 0.5) + dir * v * sc * 0.18]);
          }
          lines.push(pts);
        }
        break;
      }
      case "specRing": {
        const n = 180;
        const rad = w.rad || 0.2;
        for (let i = 0; i <= n; i++) {
          const u = (i % n) / n;
          const fold = Math.abs(u * 2 - 1);
          const v = a.spec[Math.floor(fold ** 1.5 * SPEC_N * 0.8)];
          const r = rad + v * sc * 0.12;
          const ang = u * TAU + rot;
          pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
        }
        lines.push(pts);
        break;
      }
      case "dots": {
        const n = 160;
        const rad = w.rad || 0.3;
        const dots = [];
        for (let i = 0; i < n; i++) {
          const ang = i * 2.39996 + rot;
          const r = rad * Math.sqrt((i + 0.5) / n) * (1 + L[i * 3] * sc * 0.15);
          dots.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
        }
        return { lines: [], dots };
      }
      default:
        break;
    }
    return { lines, dots: [] };
  }

  // --- Engine ---

  function create(size) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error("This browser can't run the visualizer (it needs WebGL 2). Try the “Artwork in motion” style instead.");

    function program(vs, fs) {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error("Visualizer shader error: " + gl.getShaderInfoLog(sh));
        gl.attachShader(p, sh);
      }
      gl.bindAttribLocation(p, 0, "aPos");
      gl.bindAttribLocation(p, 1, "aTex");
      gl.bindAttribLocation(p, 2, "aCol");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Visualizer shader error: " + gl.getProgramInfoLog(p));
      const locs = {};
      p.u = (name) => (name in locs ? locs[name] : (locs[name] = gl.getUniformLocation(p, name)));
      return p;
    }
    const warpProg = program(VS_FULL, FS_WARP);
    const drawProg = program(VS_DRAW, FS_DRAW);
    const compProg = program(VS_FULL, FS_COMP);

    const fullVao = gl.createVertexArray();
    gl.bindVertexArray(fullVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const drawVao = gl.createVertexArray();
    const drawBuf = gl.createBuffer();
    gl.bindVertexArray(drawVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, drawBuf);
    [[0, 2, 0], [1, 2, 8], [2, 4, 16]].forEach(([loc, n, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 32, off);
    });
    gl.bindVertexArray(null);

    // Half-float feedback when the GPU allows it: slow fades then leave no
    // stuck trails. Otherwise 8-bit with a little dither.
    const levels = Math.floor(Math.log2(size)) + 1;
    function makeTarget(fmt) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, size, size);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return ok ? { tex, fb } : null;
    }
    let floatOk = Boolean(gl.getExtension("EXT_color_buffer_float"));
    let targets = floatOk ? [makeTarget(gl.RGBA16F), makeTarget(gl.RGBA16F)] : [null];
    if (!targets[0] || !targets[1]) {
      floatOk = false;
      targets = [makeTarget(gl.RGBA8), makeTarget(gl.RGBA8)];
    }
    let src = 0;

    let pal = [[0.7, 0.5, 1], [0.4, 0.9, 1], [1, 0.5, 0.7], [1, 0.8, 0.4], [0.5, 1, 0.6]];
    let vibe = { brightness: 0.4, contrast: 0.2, saturation: 0.5, warmth: 0, edges: 0.05, flow: 0.5 };
    // Colour i of the artwork's palette. "shift" cycles smoothly through the
    // palette (90 = one colour along) instead of rotating the hue, so
    // colours change over time but never leave the artwork's own.
    const palFn = (i, shift = 0) => {
      const u = i + shift / 90;
      const k = Math.floor(u);
      const f = u - k;
      const a = pal[((k % pal.length) + pal.length) % pal.length];
      const b = pal[(((k + 1) % pal.length) + pal.length) % pal.length];
      const e = f * f * (3 - 2 * f);
      return a.map((v, d) => v + (b[d] - v) * e);
    };

    function makeTexture(width, height) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, width > 1 && height === 1 ? gl.CLAMP_TO_EDGE : gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, height === 1 ? gl.CLAMP_TO_EDGE : gl.MIRRORED_REPEAT);
      return tex;
    }
    const artTex = makeTexture(size, size);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    const gradTex = makeTexture(256, 1);
    const greyRamp = new Uint8Array(256 * 4).map((_, i) => (i % 4 === 3 ? 255 : i >> 2));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, greyRamp);

    // Takes in the artwork (centre square): fills the feedback buffer with
    // it, keeps it to flow back in underneath, and reads its colours and vibe.
    function seed(image) {
      const w = image.naturalWidth || image.width;
      const h = image.naturalHeight || image.height;
      const side = Math.min(w, h);
      const sq = document.createElement("canvas");
      sq.width = sq.height = size;
      sq.getContext("2d").drawImage(image, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
      const read = readArtwork(sq);
      pal = read.vivid;
      vibe = read.vibe;
      gl.bindTexture(gl.TEXTURE_2D, gradTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, read.gradient);
      gl.bindTexture(gl.TEXTURE_2D, artTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sq);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // Copy it in with a plain (no motion, no decay) warp pass.
      for (const target of targets) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
        gl.viewport(0, 0, size, size);
        warpPass(artTex, { ...DEFAULTS, decay: 1, artAmt: 0 }, 0, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      return vibe;
    }

    function warpPass(tex, p, time, dither) {
      gl.useProgram(warpProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(warpProg.u("prev"), 0);
      gl.uniform2f(warpProg.u("texel"), 1 / size, 1 / size);
      gl.uniform1f(warpProg.u("time"), time);
      gl.uniform1f(warpProg.u("dither"), dither);
      for (const k of ["zoom", "zoomExp", "rot", "warp", "warpSpeed", "warpScale", "cx", "cy", "dx", "dy", "sx", "sy", "swirl", "tunnel", "ripple", "rippleFreq", "decay", "blur", "darkenCenter", "hueDrift", "obSize", "ibSize"]) {
        gl.uniform1f(warpProg.u(k), p[k]);
      }
      gl.uniform4f(warpProg.u("ob"), p.ob[0], p.ob[1], p.ob[2], p.obA);
      gl.uniform4f(warpProg.u("ib"), p.ib[0], p.ib[1], p.ib[2], p.ibA);
      for (const k of ["artAmt", "artZoom", "artRot", "artDx", "artDy", "artFlow", "shockAmt", "shockSpeed"]) gl.uniform1f(warpProg.u(k), p[k]);
      gl.uniform1f(warpProg.u("shockAge"), time - lastBeatAt);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, artTex);
      gl.uniform1i(warpProg.u("art"), 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(fullVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // --- Preset playback and blending ---

    function instance(preset, t) {
      const s = {};
      if (preset.init) preset.init(s);
      return { preset, s, start: t };
    }
    let current = instance(STILL, 0);
    let previous = null;
    let blendStart = 0;
    let blendSec = 1;

    function setPreset(index, t, seconds = 3) {
      previous = current;
      current = instance(PRESETS[index], t);
      blendStart = t;
      blendSec = seconds;
    }

    function evaluate(inst, a, t) {
      const p = { ...DEFAULTS, ...inst.preset.base };
      p.ob = (inst.preset.base.ob || DEFAULTS.ob).slice();
      p.ib = (inst.preset.base.ib || DEFAULTS.ib).slice();
      if (inst.preset !== STILL) {
        // A slow drift through the artwork underneath, nudged by the bass.
        p.artZoom = 1.05 + 0.04 * Math.sin(t * 0.071) + 0.03 * (a.bass_att - 1);
        p.artRot = 0.08 * Math.sin(t * 0.031);
        p.artDx = 0.03 * Math.sin(t * 0.047);
        p.artDy = 0.03 * Math.cos(t * 0.039);
      }
      inst.preset.frame(p, a, t, inst.s);
      if (inst.preset.borders) Object.assign(p, inst.preset.borders(a, t, inst.s, palFn));
      if (inst.preset !== STILL) {
        // Beats bring the artwork forward for a moment.
        p.artAmt += 0.05 * a.beatPulse;
        // Exposure follows the artwork: bright art stays bright and airy,
        // dark art stays moody; a muted artwork is graded more strongly.
        p.gamma *= 0.92 + vibe.brightness * 0.2;
        p.vignette *= 1.3 - vibe.brightness;
        p.bloom *= 1.05 - vibe.brightness * 0.5;
        p.gradeAmt = Math.min(0.9, p.gradeAmt + (0.5 - vibe.saturation) * 0.4);
      }
      return p;
    }

    function mixParams(A, B, b) {
      const out = {};
      for (const k in A) {
        out[k] = Array.isArray(A[k]) ? A[k].map((v, i) => v + (B[k][i] - v) * b) : A[k] + (B[k] - A[k]) * b;
      }
      out.kaleidoSegs = A.kaleidoAmt === 0 ? B.kaleidoSegs : B.kaleidoAmt === 0 ? A.kaleidoSegs : b < 0.5 ? A.kaleidoSegs : B.kaleidoSegs;
      return out;
    }

    // --- Drawing waves and shapes into the feedback buffer ---

    const batches = new Map();
    function batch(additive, textured) {
      const key = (additive ? 1 : 0) + (textured ? 2 : 0);
      if (!batches.has(key)) batches.set(key, { additive, textured, data: [] });
      return batches.get(key).data;
    }
    function vert(out, x, y, u, v, c, alpha) {
      out.push(x, y, u, v, c[0], c[1], c[2], alpha);
    }
    function lineQuads(out, pts, half, c1, c2, alpha) {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const nx = (-(y1 - y0) / len) * half;
        const ny = ((x1 - x0) / len) * half;
        const u0 = i / (pts.length - 1);
        const u1 = (i + 1) / (pts.length - 1);
        const ca = c2 ? c1.map((v, k) => v + (c2[k] - v) * u0) : c1;
        const cb = c2 ? c1.map((v, k) => v + (c2[k] - v) * u1) : c1;
        vert(out, x0 + nx, y0 + ny, 0, 0, ca, alpha);
        vert(out, x0 - nx, y0 - ny, 0, 0, ca, alpha);
        vert(out, x1 + nx, y1 + ny, 0, 0, cb, alpha);
        vert(out, x1 + nx, y1 + ny, 0, 0, cb, alpha);
        vert(out, x0 - nx, y0 - ny, 0, 0, ca, alpha);
        vert(out, x1 - nx, y1 - ny, 0, 0, cb, alpha);
      }
    }

    function addWaves(inst, a, t, weight) {
      for (const w of inst.preset.waves(a, t, inst.s, palFn)) {
        const alpha = (w.alpha == null ? 1 : w.alpha) * weight;
        if (alpha <= 0.002) continue;
        const out = batch(w.additive, false);
        const half = (w.thick || 2) / size / 2;
        const { lines, dots } = wavePoints(w, a);
        for (const pts of lines) lineQuads(out, pts, half, w.color, w.color2, alpha);
        dots.forEach(([x, y], i) => {
          const c = w.color2 ? w.color.map((v, k) => v + (w.color2[k] - v) * (i / dots.length)) : w.color;
          const h = half * 1.4;
          vert(out, x - h, y - h, 0, 0, c, alpha);
          vert(out, x + h, y - h, 0, 0, c, alpha);
          vert(out, x + h, y + h, 0, 0, c, alpha);
          vert(out, x - h, y - h, 0, 0, c, alpha);
          vert(out, x + h, y + h, 0, 0, c, alpha);
          vert(out, x - h, y + h, 0, 0, c, alpha);
        });
      }
    }

    function addShapes(inst, a, t, weight) {
      for (const sh of inst.preset.shapes(a, t, inst.s, palFn)) {
        if (weight <= 0.002) continue;
        const out = batch(sh.additive, sh.textured);
        const n = sh.sides || 4;
        const tz = sh.texZoom || 1;
        const tc = Math.cos(sh.texAng || 0);
        const ts = Math.sin(sh.texAng || 0);
        const texAt = (ox, oy) => {
          const u = ox / (sh.rad * tz);
          const v = oy / (sh.rad * tz);
          return [0.5 + (u * tc - v * ts) * 0.5, 0.5 + (u * ts + v * tc) * 0.5];
        };
        const rim = [];
        for (let k = 0; k <= n; k++) {
          const ang = (k / n) * TAU + (sh.ang || 0) + Math.PI / n;
          rim.push([Math.cos(ang) * sh.rad, Math.sin(ang) * sh.rad]);
        }
        const c1 = sh.color;
        const c2 = sh.color2 || sh.color;
        for (let k = 0; k < n; k++) {
          const [ax, ay] = rim[k];
          const [bx, by] = rim[k + 1];
          vert(out, sh.x, sh.y, ...texAt(0, 0), c1, c1[3] * weight);
          vert(out, sh.x + ax, sh.y + ay, ...texAt(ax, ay), c2, c2[3] * weight);
          vert(out, sh.x + bx, sh.y + by, ...texAt(bx, by), c2, c2[3] * weight);
        }
        if (sh.border && sh.border[3] > 0) {
          lineQuads(batch(false, false), rim.map(([x, y]) => [sh.x + x, sh.y + y]), (sh.thick || 2) / size / 2, sh.border, null, sh.border[3] * weight);
        }
      }
    }

    function drawBatches(prevTex) {
      gl.useProgram(drawProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, prevTex);
      gl.uniform1i(drawProg.u("prev"), 0);
      gl.enable(gl.BLEND);
      gl.bindVertexArray(drawVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, drawBuf);
      // Plain first, then textured shapes, then glowing (additive) strokes.
      for (const key of [0, 2, 3, 1]) {
        const b = batches.get(key);
        if (!b || !b.data.length) continue;
        gl.blendFunc(gl.SRC_ALPHA, b.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(drawProg.u("textured"), b.textured ? 1 : 0);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.data), gl.STREAM_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, b.data.length / 8);
      }
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      batches.clear();
    }

    let params = { ...DEFAULTS, ...STILL.base };
    let lastBeatAt = -100;

    // One simulation frame at time t (seconds) with audio frame a.
    function step(a, t) {
      if (a.beat) lastBeatAt = t;
      const b = previous ? Math.min(1, Math.max(0, (t - blendStart) / blendSec)) : 1;
      const bs = b * b * (3 - 2 * b);
      const pNew = evaluate(current, a, t);
      if (previous && b < 1) {
        params = mixParams(evaluate(previous, a, t), pNew, bs);
      } else {
        params = pNew;
        previous = null;
      }

      const dst = 1 - src;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[dst].fb);
      gl.viewport(0, 0, size, size);
      warpPass(targets[src].tex, params, t, floatOk ? 0 : 1.5);
      if (previous) {
        addWaves(previous, a, t, 1 - bs);
        addShapes(previous, a, t, 1 - bs);
      }
      addWaves(current, a, t, previous ? bs : 1);
      addShapes(current, a, t, previous ? bs : 1);
      drawBatches(targets[src].tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, targets[dst].tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      src = dst;
    }

    // Composites the current frame to the canvas. artShow 0..1 shows the
    // untouched artwork on top (used to resolve back into it at the end).
    function present(t, artShow = 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, size, size);
      gl.useProgram(compProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets[src].tex);
      gl.uniform1i(compProg.u("tex"), 0);
      gl.uniform1f(compProg.u("time"), t);
      gl.uniform1f(compProg.u("artShow"), artShow);
      gl.uniform1f(compProg.u("gradeAmt"), params.gradeAmt);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, gradTex);
      gl.uniform1i(compProg.u("grad"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, artTex);
      gl.uniform1i(compProg.u("art"), 2);
      gl.activeTexture(gl.TEXTURE0);
      for (const k of ["echoZoom", "echoAlpha", "echoFlipX", "echoFlipY", "gamma", "bloom", "kaleidoSegs", "kaleidoAmt", "kaleidoRot", "invert", "solarize", "hue", "vignette", "brighten", "bump", "chroma", "mirrorX", "mirrorY", "mosaic", "mosaicCells", "grain"]) {
        gl.uniform1f(compProg.u(k), params[k]);
      }
      gl.disable(gl.BLEND);
      gl.bindVertexArray(fullVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    return {
      canvas,
      seed,
      step,
      present,
      setPreset,
      get vibe() {
        return vibe;
      },
      get presetName() {
        return current.preset.name;
      },
    };
  }

  return { create, audioReader, PRESETS, SIM_FPS };
})();
