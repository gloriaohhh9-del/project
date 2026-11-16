// Music video on the Analyze results, made entirely in the browser (no
// server work, no API cost). The artwork shown above is the first frame;
// from there it is split into its main colours, and each colour group moves
// to its own part of the song (bass, loudness, beats, highs) while the whole
// picture drifts, ripples and glows. The song's structure sets the bigger
// changes: each section gets its own scene (see planScenes). The song is
// measured here from the listener's own file. The canvas is recorded in real time with the song as
// its soundtrack, so the video is exactly as long as the track.
window.AuraVideo = (function () {
  const SIZE = 720; // output is SIZE x SIZE
  const PAD = 40; // spare pixels around the frame so moving colours never show an edge
  const FPS = 30;
  const EASE_IN_SEC = 1.5; // effects fade in, so frame one is the untouched artwork
  const FADE_OUT_SEC = 1.5;
  // H.264 level 4.0 (the "28" at the end): level 3.0 ("1E") is too small for
  // a 720x720 or 1280x720 frame, and Chrome's encoder then sometimes
  // records nothing at all.
  const MIME_TYPES = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1.42E028,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  // Set when an MP4 recording comes out broken; later recordings use WebM.
  let mp4Failed = false;

  function pickMimeType() {
    if (!window.MediaRecorder) return null;
    const types = mp4Failed ? MIME_TYPES.filter((type) => type.includes("webm")) : MIME_TYPES;
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  // The recorder's last piece of data can arrive just after it reports it
  // has stopped, so this waits a moment before putting the file together.
  function collectRecording(recorder, chunks, fallbackType) {
    return new Promise((resolve) => setTimeout(resolve, 300)).then(
      () => new Blob(chunks, { type: recorder.mimeType || fallbackType || "video/webm" })
    );
  }

  // Resolves to true when the browser can open the file and it has a picture.
  function isPlayable(blob) {
    if (!blob.size) return Promise.resolve(false);
    return new Promise((resolve) => {
      const probe = document.createElement("video");
      const url = URL.createObjectURL(blob);
      const done = (ok) => {
        clearTimeout(timer);
        probe.removeAttribute("src");
        probe.load();
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 10000);
      probe.muted = true;
      probe.preload = "metadata";
      probe.onloadedmetadata = () => done(probe.videoWidth > 0);
      probe.onerror = () => done(false);
      probe.src = url;
    });
  }

  function brokenRecordingMessage(blob) {
    if (blob.type.includes("mp4")) {
      mp4Failed = true;
      return "This browser's MP4 recorder produced a broken file. Please click Create again; it will record as WebM this time.";
    }
    return "The recording came out empty. Please try again, and keep this tab open and visible while it records.";
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  // --- Audio features, one value per video frame, each scaled to ~0..1 ---

  function percentile(values, p) {
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 1;
  }

  function normalize(values) {
    const top = percentile(values, 0.95) || 1;
    return values.map((v) => Math.min(1.2, v / top));
  }

  function measure(buffer) {
    const sr = buffer.sampleRate;
    const n = buffer.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }

    // One-pole filters split the signal into lows (bass, kick) and highs
    // (hats, air); the full signal gives overall loudness.
    const lowA = 1 - Math.exp((-2 * Math.PI * 150) / sr);
    const highA = 1 - Math.exp((-2 * Math.PI * 3000) / sr);
    const hop = Math.round(sr / FPS);
    const frames = Math.ceil(n / hop);
    const loud = new Float32Array(frames);
    const bass = new Float32Array(frames);
    const treble = new Float32Array(frames);
    let low = 0;
    let mid = 0;
    for (let f = 0; f < frames; f++) {
      let sumAll = 0;
      let sumLow = 0;
      let sumHigh = 0;
      const end = Math.min(n, (f + 1) * hop);
      for (let i = f * hop; i < end; i++) {
        const x = mono[i];
        low += lowA * (x - low);
        mid += highA * (x - mid);
        const high = x - mid;
        sumAll += x * x;
        sumLow += low * low;
        sumHigh += high * high;
      }
      const count = Math.max(1, end - f * hop);
      loud[f] = Math.sqrt(sumAll / count);
      bass[f] = Math.sqrt(sumLow / count);
      treble[f] = Math.sqrt(sumHigh / count);
    }

    // Beats: frames where the bass jumps well above its recent average.
    const flux = new Float32Array(frames);
    for (let f = 1; f < frames; f++) flux[f] = Math.max(0, bass[f] - bass[f - 1]);
    const fluxN = normalize(flux);
    const beat = new Float32Array(frames);
    let avg = 0;
    for (let f = 0; f < frames; f++) {
      avg += (fluxN[f] - avg) * 0.05;
      beat[f] = fluxN[f] > Math.max(0.35, avg * 2.2) ? Math.min(1, fluxN[f]) : 0;
    }

    return { loud: normalize(loud), bass: normalize(bass), treble: normalize(treble), beat };
  }

  // --- Drawing ---

  function loadArtwork() {
    const img = document.getElementById("artwork-image");
    let src = img && img.currentSrc;
    if (!src) {
      // Procedural fallback art is an inline SVG.
      const svg = document.querySelector("#artwork-frame svg");
      if (!svg) return Promise.reject(new Error("There's no artwork to animate yet."));
      src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    }
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Couldn't load the artwork."));
      image.src = src;
    });
  }

  // --- Colour groups ---

  const GROUPS = 4;
  const MASK_RES = 128; // masks are built small and scaled up, which softens their edges

  function smallCopy(image, res) {
    const c = document.createElement("canvas");
    c.width = c.height = res;
    c.getContext("2d").drawImage(image, 0, 0, res, res);
    return c;
  }

  // Splits the artwork into its main colours (k-means on a small copy) and
  // returns one full-size layer per colour, ordered dark to light. Each
  // pixel belongs softly to its nearest colours, so neighbouring layers
  // overlap a little instead of leaving hard cut lines when they move.
  function colourLayers(square, side) {
    const pixels = smallCopy(square, MASK_RES).getContext("2d").getImageData(0, 0, MASK_RES, MASK_RES).data;
    const count = MASK_RES * MASK_RES;
    const rgb = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      rgb[i * 3] = pixels[i * 4];
      rgb[i * 3 + 1] = pixels[i * 4 + 1];
      rgb[i * 3 + 2] = pixels[i * 4 + 2];
    }
    const lum = (i) => rgb[i * 3] * 0.3 + rgb[i * 3 + 1] * 0.59 + rgb[i * 3 + 2] * 0.11;

    // Start from evenly spaced brightness levels so the result is the same
    // every time for the same artwork.
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => lum(a) - lum(b));
    let centres = Array.from({ length: GROUPS }, (_, k) => {
      const i = order[Math.floor(((k + 0.5) / GROUPS) * count)];
      return [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    });
    const nearest = new Uint8Array(count);
    for (let iter = 0; iter < 12; iter++) {
      const sums = centres.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < count; i++) {
        let best = 0;
        let bestD = Infinity;
        for (let k = 0; k < GROUPS; k++) {
          const d = (rgb[i * 3] - centres[k][0]) ** 2 + (rgb[i * 3 + 1] - centres[k][1]) ** 2 + (rgb[i * 3 + 2] - centres[k][2]) ** 2;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        nearest[i] = best;
        const acc = sums[best];
        acc[0] += rgb[i * 3];
        acc[1] += rgb[i * 3 + 1];
        acc[2] += rgb[i * 3 + 2];
        acc[3]++;
      }
      centres = centres.map((c, k) => (sums[k][3] ? sums[k].slice(0, 3).map((v) => v / sums[k][3]) : c));
    }
    const ranked = centres
      .map((c, k) => ({ k, lum: c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11 }))
      .sort((a, b) => a.lum - b.lum)
      .map((g) => g.k);

    return ranked.map((k) => {
      const mask = document.createElement("canvas");
      mask.width = mask.height = MASK_RES;
      const mctx = mask.getContext("2d");
      const img = mctx.createImageData(MASK_RES, MASK_RES);
      let cx = 0;
      let cy = 0;
      let total = 0;
      for (let i = 0; i < count; i++) {
        const on = nearest[i] === k ? 255 : 0;
        img.data[i * 4 + 3] = on;
        if (on) {
          cx += i % MASK_RES;
          cy += Math.floor(i / MASK_RES);
          total++;
        }
      }
      mctx.putImageData(img, 0, 0);

      const layer = document.createElement("canvas");
      layer.width = layer.height = side;
      const l = layer.getContext("2d");
      l.drawImage(square, 0, 0, side, side);
      l.globalCompositeOperation = "destination-in";
      l.imageSmoothingEnabled = true;
      l.imageSmoothingQuality = "high";
      l.drawImage(mask, 0, 0, side, side);
      const scale = side / MASK_RES;
      return {
        canvas: layer,
        share: total / count,
        cx: total ? (cx / total) * scale : side / 2,
        cy: total ? (cy / total) * scale : side / 2,
      };
    });
  }

  // --- Scenes: what the video does when ---

  const MIN_SCENE_SEC = 8;
  const MAX_SCENE_SEC = 20;
  const TRANSITION_SEC = 1.5;
  const LEAD_IN_SEC = 0.3; // a change starts just before the moment it marks

  // Six looks, calmest to most intense. Loud, busy parts of the song get the
  // later ones. Every number is a setting the drawing code reads, and they
  // all blend smoothly from one scene to the next.
  const LOOKS = [
    { reach: 0.7, grow: 0.7, rippleH: 0.5, rippleV: 0, rippleF: 0.7, trail: 0, trailTurn: 0, trailZoom: 1, mirror: 0, shatter: 0, glow: 0.6, grade: 0.08, cam: 0.2 }, // float
    { reach: 1, grow: 1.8, rippleH: 1, rippleV: 0.3, rippleF: 1, trail: 0.15, trailTurn: 0, trailZoom: 1.004, mirror: 0, shatter: 0, glow: 0.9, grade: 0.16, cam: 0.4 }, // swell
    { reach: 1.3, grow: 1, rippleH: 1.6, rippleV: 0.9, rippleF: 0.6, trail: 0.3, trailTurn: 0.002, trailZoom: 1.003, mirror: 0, shatter: 0, glow: 1, grade: 0.22, cam: 0.6 }, // flow
    { reach: 1.2, grow: 1.2, rippleH: 0.8, rippleV: 0.4, rippleF: 1.2, trail: 0.2, trailTurn: 0.001, trailZoom: 1.002, mirror: 0.85, shatter: 0, glow: 1.1, grade: 0.26, cam: 0.6 }, // mirror
    { reach: 1.4, grow: 1.4, rippleH: 0.8, rippleV: 0.8, rippleF: 1.4, trail: 0.7, trailTurn: 0.012, trailZoom: 1.012, mirror: 0, shatter: 0, glow: 1.2, grade: 0.3, cam: 0.8 }, // vortex
    { reach: 1.6, grow: 1.6, rippleH: 1.2, rippleV: 1.2, rippleF: 1.6, trail: 0.25, trailTurn: 0.003, trailZoom: 1.006, mirror: 0, shatter: 1, glow: 1.6, grade: 0.34, cam: 1 }, // shatter
  ];
  const SCENE_NUMBERS = ["reach", "grow", "rippleH", "rippleV", "rippleF", "trail", "trailTurn", "trailZoom", "mirrorX", "mirrorY", "shatter", "glow", "grade", "panX", "panY", "zoom", "tilt"];

  function distance(a, b) {
    return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
  }

  function meanVector(vectors, from, to) {
    const out = [0, 0, 0, 0];
    const count = Math.max(1, to - from);
    for (let i = from; i < to; i++) vectors[i].forEach((v, d) => (out[d] += v / count));
    return out;
  }

  // Finds where the song really changes (by comparing the few seconds before
  // each moment with the few seconds after), groups the parts that sound
  // alike, and gives each part a scene.
  function planScenes(features, duration) {
    const frames = features.loud.length;
    const block = Math.round(FPS / 2);
    const secPerBlock = block / FPS;
    const n = Math.max(1, Math.floor(frames / block));

    const vectors = [];
    for (let b = 0; b < n; b++) {
      const sums = [0, 0, 0, 0];
      for (let f = b * block; f < (b + 1) * block; f++) {
        sums[0] += features.loud[f] || 0;
        sums[1] += features.bass[f] || 0;
        sums[2] += features.treble[f] || 0;
        sums[3] += features.beat[f] > 0 ? 1 : 0;
      }
      vectors.push(sums.map((v) => v / block));
    }
    // Rescale so a quiet song's small changes count as much as a loud one's.
    for (let d = 0; d < 4; d++) {
      const mean = vectors.reduce((s, v) => s + v[d], 0) / n;
      const std = Math.sqrt(vectors.reduce((s, v) => s + (v[d] - mean) ** 2, 0) / n) || 1;
      vectors.forEach((v) => (v[d] = (v[d] - mean) / std));
    }

    const span = 8; // blocks compared on each side (4 seconds)
    const novelty = new Float32Array(n);
    for (let b = span; b < n - span; b++) {
      novelty[b] = distance(meanVector(vectors, b - span, b), meanVector(vectors, b, b + span));
    }
    const noveltyMean = novelty.reduce((s, v) => s + v, 0) / n;
    const noveltyStd = Math.sqrt(novelty.reduce((s, v) => s + (v - noveltyMean) ** 2, 0) / n);
    const bar = noveltyMean + 0.25 * noveltyStd;

    const cuts = [];
    Array.from(novelty.keys())
      .sort((a, b) => novelty[b] - novelty[a])
      .forEach((b) => {
        const time = b * secPerBlock;
        if (novelty[b] < bar || time < MIN_SCENE_SEC || time > duration - MIN_SCENE_SEC) return;
        if (cuts.every((c) => Math.abs(c - time) >= MIN_SCENE_SEC)) cuts.push(time);
      });
    cuts.sort((a, b) => a - b);

    // Even a very steady song keeps changing.
    const edges = [0];
    [...cuts, duration].forEach((end) => {
      const start = edges[edges.length - 1];
      const parts = Math.ceil((end - start) / MAX_SCENE_SEC);
      for (let p = 1; p <= parts; p++) edges.push(start + ((end - start) * p) / parts);
    });

    // Land each change on the nearest beat when there's one close by.
    for (let e = 1; e < edges.length - 1; e++) {
      const f = Math.round(edges[e] * FPS);
      for (let off = 0; off <= 12; off++) {
        if (features.beat[f - off] > 0 || features.beat[f + off] > 0) {
          edges[e] = (features.beat[f - off] > 0 ? f - off : f + off) / FPS;
          break;
        }
      }
    }

    const parts = [];
    for (let e = 0; e < edges.length - 1; e++) {
      const from = Math.min(n - 1, Math.floor(edges[e] / secPerBlock));
      const to = Math.min(n, Math.max(from + 1, Math.floor(edges[e + 1] / secPerBlock)));
      parts.push({ start: edges[e], vector: meanVector(vectors, from, to) });
    }

    // Parts that sound alike share a type, e.g. repeated choruses.
    const types = [];
    parts.forEach((part) => {
      let type = types.findIndex((t) => distance(t.vector, part.vector) < 1.2);
      if (type < 0) {
        type = types.length;
        types.push({ vector: part.vector, seen: 0, energy: part.vector[0] + part.vector[1] + part.vector[3] });
      }
      part.type = type;
      part.occurrence = types[type].seen++;
    });
    const byEnergy = types.map((_, i) => i).sort((a, b) => types[a].energy - types[b].energy);

    let previous = -1;
    return parts.map((part, i) => {
      const rank = types.length > 1 ? byEnergy.indexOf(part.type) / (types.length - 1) : 0.5;
      // A repeat of a part returns in a related look, not an identical one.
      let index = Math.round(rank * (LOOKS.length - 1)) + [0, 1, -1][part.occurrence % 3];
      index = Math.max(0, Math.min(LOOKS.length - 1, index));
      if (index === previous) index += index < LOOKS.length - 1 ? 1 : -1;
      previous = index;

      const look = LOOKS[index];
      const flip = part.occurrence % 2 ? -1 : 1;
      const angle = i * 2.399; // golden angle: the camera never settles into a pattern
      return {
        ...look,
        start: part.start,
        lookIndex: index,
        bandShift: (part.type + part.occurrence) % 4,
        hue: (part.type * 67 + part.occurrence * 31 + 200) % 360,
        trailTurn: look.trailTurn * flip,
        mirrorX: flip > 0 ? look.mirror : 0,
        mirrorY: flip > 0 ? 0 : look.mirror,
        panX: Math.cos(angle) * SIZE * 0.03 * (0.4 + look.cam * 0.6),
        panY: Math.sin(angle) * SIZE * 0.03 * (0.4 + look.cam * 0.6),
        zoom: 0.1 + look.cam * 0.05,
        tilt: 0.04 * look.cam * flip,
        burst: i ? Math.max(0.4, Math.min(1, distance(parts[i - 1].vector, part.vector) / 2)) : 0,
      };
    });
  }

  function makeRenderer(canvas, artwork, features, duration) {
    const out = canvas.getContext("2d");
    const side = SIZE + PAD * 2;
    const frames = features.loud.length;
    const scenes = planScenes(features, duration);

    // Centre square of the artwork (generated art is already square).
    const w = artwork.naturalWidth || artwork.width || SIZE;
    const h = artwork.naturalHeight || artwork.height || SIZE;
    const square = document.createElement("canvas");
    square.width = square.height = side;
    const cropSide = Math.min(w, h);
    square.getContext("2d").drawImage(artwork, (w - cropSide) / 2, (h - cropSide) / 2, cropSide, cropSide, 0, 0, side, side);

    // Underlay: a heavily blurred copy (shrunk then stretched), so wherever a
    // colour layer moves away it uncovers matching soft colour, not a hole.
    const blurred = smallCopy(square, 24);
    const layers = colourLayers(square, side);
    // Which part of the music each colour group follows, darkest first.
    // Scenes rotate this list, so the groups swap roles through the song.
    const BANDS = ["bass", "loud", "beat", "treble"];

    function workspace(size) {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      return { canvas: c, ctx: c.getContext("2d") };
    }
    const { canvas: scene, ctx: sc } = workspace(side);
    sc.imageSmoothingEnabled = true;
    // The camera's view, with PAD spare pixels around it for the ripple.
    const { canvas: cam, ctx: cc } = workspace(side);
    const { canvas: rip, ctx: rc } = workspace(side);
    // The previous frame, for trails.
    const { canvas: trail, ctx: tc } = workspace(SIZE);

    // Smoothed copies so motion glides instead of twitching.
    const level = { bass: 0, loud: 0, beat: 0, treble: 0 };
    let slow = 0;
    let lastFrame = -1;
    let beatCount = 0;

    function at(arr, f) {
      return arr[Math.max(0, Math.min(frames - 1, f))] || 0;
    }

    function random(a, b) {
      const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
      return x - Math.floor(x);
    }

    // How one colour group moves when it follows one part of the music.
    function groupMotion(i, bandName, t, reach, growBy) {
      const band = level[bandName];
      const phase = i * 1.7 + 0.4;
      let dx = reach * 0.6 * Math.sin(t * (0.11 + i * 0.03) + phase);
      let dy = reach * 0.6 * Math.cos(t * (0.09 + i * 0.025) + phase * 1.3);
      let grow = band * 0.05 * growBy;
      let turn = 0.012 * Math.sin(t * 0.07 + phase);
      if (bandName === "bass") grow += band * 0.03 * growBy;
      if (bandName === "beat") {
        dx += Math.cos(phase) * band * reach * 0.6;
        dy += Math.sin(phase) * band * reach * 0.6;
      }
      if (bandName === "treble") {
        dx += band * 3 * Math.sin(t * 9 + phase);
        dy += band * 3 * Math.cos(t * 7 + phase);
        turn += band * 0.01 * Math.sin(t * 5);
      }
      return [dx, dy, grow, turn];
    }

    function smooth(u) {
      u = Math.max(0, Math.min(1, u));
      return u * u * (3 - 2 * u);
    }

    return function draw(t) {
      const f = Math.floor(t * FPS);
      if (f !== lastFrame) {
        for (let i = Math.max(lastFrame + 1, f - 5); i <= f; i++) {
          slow += (at(features.loud, i) - slow) * 0.02;
          level.bass += (at(features.bass, i) - level.bass) * 0.3;
          level.loud += (at(features.loud, i) - level.loud) * 0.12;
          level.treble += (at(features.treble, i) - level.treble) * 0.35;
          level.beat = Math.max(level.beat * 0.85, at(features.beat, i));
          if (at(features.beat, i) > 0 && at(features.beat, i - 1) === 0) beatCount++;
        }
        lastFrame = f;
      }
      const k = Math.min(1, Math.max(0, t) / EASE_IN_SEC);
      const ease = k * k * (3 - 2 * k);

      // Where we are in the song: the current scene, blended from the one
      // before it for a moment after each change.
      let index = 0;
      while (index < scenes.length - 1 && t + LEAD_IN_SEC >= scenes[index + 1].start) index++;
      const now = scenes[index];
      const before = scenes[Math.max(0, index - 1)];
      const u = index ? smooth((t + LEAD_IN_SEC - now.start) / TRANSITION_SEC) : 1;
      const mix = {};
      SCENE_NUMBERS.forEach((key) => (mix[key] = before[key] + (now[key] - before[key]) * u));
      const hue = before.hue + (((now.hue - before.hue + 540) % 360) - 180) * u;
      const burst = t >= now.start ? now.burst * Math.exp(-(t - now.start) / 0.5) : 0;
      // The whole song builds a little from start to finish.
      const arc = 1 + 0.4 * Math.max(0, Math.min(1, t / duration));

      // 1. Colour groups, each moving to its own part of the music: it
      // swells around its own centre, drifts on its own path, and the beat
      // and treble groups add a kick and a shimmer.
      sc.globalAlpha = 1;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.drawImage(blurred, 0, 0, side, side);
      layers.forEach((layer, i) => {
        // Big groups (usually the background) move less, so the whole
        // picture doesn't slosh around.
        const reach = 24 * (1.1 - layer.share * 0.8) * mix.reach * arc;
        const a = groupMotion(i, BANDS[(i + before.bandShift) % 4], t, reach, mix.grow);
        const b = groupMotion(i, BANDS[(i + now.bandShift) % 4], t, reach, mix.grow);
        const [dx, dy, grow, turn] = a.map((v, n) => v + (b[n] - v) * u);
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.translate(layer.cx + ease * dx, layer.cy + ease * dy);
        sc.rotate(ease * turn);
        sc.scale(1 + ease * grow, 1 + ease * grow);
        sc.drawImage(layer.canvas, -layer.cx, -layer.cy);
      });
      // Frame one is the untouched artwork; it hands over to the moving
      // layers as the effects ease in.
      if (ease < 1) {
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = 1 - ease;
        sc.drawImage(square, 0, 0);
        sc.globalAlpha = 1;
      }

      // 2. Camera: each scene heads for its own position and zoom, with a
      // slow drift and a kick on beats and scene changes. Frame one shows
      // the whole artwork; the zoom then eases up to cover the drift, tilt
      // and ripple, so no edge shows.
      const tilt = ease * (mix.tilt + 0.012 * Math.sin(t * 0.05));
      const panX = ease * (mix.panX + 0.012 * SIZE * Math.sin(t * 0.07 + 1.3));
      const panY = ease * (mix.panY + 0.012 * SIZE * Math.cos(t * 0.05));
      const zoom = 1 + mix.zoom + 0.04 * slow + 0.025 * level.beat + 0.015 * Math.sin(t * 0.21) + burst * 0.05;
      const span = SIZE + (side * zoom - SIZE) * ease;
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.translate(side / 2 + panX, side / 2 + panY);
      cc.rotate(tilt);
      cc.drawImage(scene, -span / 2, -span / 2, span, span);

      // 3. Ripple: thin slices slide on a wave whose size follows the
      // music's energy. Sideways first, then up and down.
      const slice = 6;
      const limit = PAD - 2;
      const amp = ease * (1.5 + level.loud * 7 + level.bass * 4);
      const ampH = amp * mix.rippleH;
      const ampV = amp * mix.rippleV;
      const wave = (pos, size) =>
        Math.max(-limit, Math.min(limit, size * Math.sin(pos * 0.018 * mix.rippleF + t * 1.6) + size * 0.5 * Math.sin(pos * 0.041 * mix.rippleF - t * 0.9)));
      rc.clearRect(0, 0, side, side);
      for (let y = 0; y < side; y += slice) {
        rc.drawImage(cam, 0, y, side, slice, wave(y, ampH), y, side, slice);
      }
      out.globalCompositeOperation = "source-over";
      out.globalAlpha = 1;
      out.setTransform(1, 0, 0, 1, 0, 0);
      for (let x = 0; x < SIZE; x += slice) {
        out.drawImage(rip, PAD + x, PAD - wave(x, ampV), slice, SIZE, x, 0, slice, SIZE);
      }

      // 4. Trails: the previous frame stays behind, turned and enlarged a
      // little, so bright areas smear and spiral.
      const trailAmount = ease * mix.trail;
      if (trailAmount > 0.005) {
        out.save();
        out.globalCompositeOperation = "lighten";
        out.globalAlpha = trailAmount;
        out.translate(SIZE / 2, SIZE / 2);
        out.rotate(mix.trailTurn);
        out.scale(mix.trailZoom, mix.trailZoom);
        out.drawImage(trail, -SIZE / 2, -SIZE / 2);
        out.restore();
      }
      tc.globalCompositeOperation = "copy";
      tc.drawImage(canvas, 0, 0);

      // 5. Mirror: one half reflects onto the other.
      if (ease * mix.mirrorX > 0.005) {
        out.save();
        out.beginPath();
        out.rect(SIZE / 2, 0, SIZE / 2, SIZE);
        out.clip();
        out.globalAlpha = ease * mix.mirrorX;
        out.translate(SIZE, 0);
        out.scale(-1, 1);
        out.drawImage(canvas, 0, 0);
        out.restore();
      }
      if (ease * mix.mirrorY > 0.005) {
        out.save();
        out.beginPath();
        out.rect(0, SIZE / 2, SIZE, SIZE / 2);
        out.clip();
        out.globalAlpha = ease * mix.mirrorY;
        out.translate(0, SIZE);
        out.scale(1, -1);
        out.drawImage(canvas, 0, 0);
        out.restore();
      }

      // 6. Shatter: on beats, blocks of the picture jump out of place.
      const shatter = ease * mix.shatter * level.beat;
      if (shatter > 0.03) {
        const cell = SIZE / 6;
        out.save();
        out.globalAlpha = Math.min(1, shatter * 1.5);
        for (let n = 0; n < 8; n++) {
          const x = Math.floor(random(beatCount, n) * 6) * cell;
          const y = Math.floor(random(n, beatCount + 1) * 6) * cell;
          const jumpX = (random(beatCount + 2, n) - 0.5) * 80 * shatter;
          const jumpY = (random(n, beatCount + 3) - 0.5) * 80 * shatter;
          out.drawImage(canvas, x, y, cell, cell, x + jumpX, y + jumpY, cell, cell);
        }
        out.restore();
      }

      // 7. Glow on each beat, and a flash when the scene changes.
      const glow = ease * (level.beat * 0.18 * mix.glow + burst * 0.3);
      if (glow > 0.004) {
        out.save();
        out.globalCompositeOperation = "lighter";
        out.globalAlpha = Math.min(1, glow);
        const g = 1.04;
        out.drawImage(canvas, (SIZE * (1 - g)) / 2, (SIZE * (1 - g)) / 2, SIZE * g, SIZE * g);
        out.restore();
      }

      // 8. Colour: each scene tints the picture its own way, and a soft
      // wash shifts over the song, stronger when the highs are bright.
      out.globalCompositeOperation = "color";
      out.globalAlpha = ease * mix.grade;
      out.fillStyle = `hsl(${(hue + t * 2) % 360}, 75%, 50%)`;
      out.fillRect(0, 0, SIZE, SIZE);
      out.globalCompositeOperation = "soft-light";
      out.globalAlpha = ease * (0.06 + level.treble * 0.1);
      out.fillStyle = `hsl(${(t * 8 + level.treble * 60) % 360}, 80%, 55%)`;
      out.fillRect(0, 0, SIZE, SIZE);

      // 9. Fade to black over the last moments.
      const left = duration - t;
      if (left < FADE_OUT_SEC) {
        out.globalCompositeOperation = "source-over";
        out.globalAlpha = Math.min(1, 1 - left / FADE_OUT_SEC);
        out.fillStyle = "#000";
        out.fillRect(0, 0, SIZE, SIZE);
      }
      out.globalCompositeOperation = "source-over";
      out.globalAlpha = 1;
    };
  }

  // --- Visualizer style (MilkDrop / WMP-like, see aura-visualizer.js) ---

  // The artwork is the whole video's source: it's the first frame, it melts
  // into the first preset, it keeps flowing underneath the trails, every
  // frame is graded through its colours, and the video resolves back into
  // it at the end. Each section of the song (from planScenes) gets a preset
  // that suits both the section's energy and the artwork's character (soft
  // and painterly art gets liquid presets, sharp detailed art geometric
  // ones), and presets blend into each other over a few seconds on a beat.
  const RESOLVE_SEC = 4;

  function choosePresets(scenes, vibe) {
    const presets = window.AuraVisualizer.PRESETS;
    // Bold, contrasty, colourful art leans a little more intense overall.
    const artEnergy = Math.min(1, vibe.contrast * 1.6 + vibe.saturation * 0.35);
    const used = new Array(presets.length).fill(0);
    let last = -1;
    return scenes.map((scene) => {
      const sectionEnergy = scene.lookIndex / (LOOKS.length - 1);
      const target = sectionEnergy * 0.75 + artEnergy * 0.25;
      let best = 0;
      let bestScore = Infinity;
      presets.forEach((p, i) => {
        const score =
          Math.abs(p.energy - target) * 1.2 + Math.abs(p.flow - vibe.flow) * 0.9 + used[i] * 0.2 + (i === last ? 10 : 0);
        if (score < bestScore) [best, bestScore] = [i, score];
      });
      used[best]++;
      last = best;
      return best;
    });
  }

  function makeVisualizerRenderer(canvas, artwork, buffer, features, duration) {
    const out = canvas.getContext("2d");
    const vis = window.AuraVisualizer.create(SIZE);
    const vibe = vis.seed(artwork);
    const read = window.AuraVisualizer.audioReader(buffer);
    const scenes = planScenes(features, duration);
    const frames = features.loud.length;
    const plan = choosePresets(scenes, vibe);

    let sim = -1;
    let next = 0;
    return function draw(t) {
      const target = Math.floor(t * FPS);
      // After the tab was hidden, carry on from now rather than racing to catch up.
      if (target - sim > 6) sim = target - 1;
      while (sim < target) {
        sim++;
        const st = sim / FPS;
        while (next < scenes.length && scenes[next].start <= st) {
          vis.setPreset(plan[next], st, next ? 2.5 : 3.5);
          next++;
        }
        const f = Math.min(frames - 1, sim);
        vis.step(read(st, features.loud[f], features.beat[f] > 0), st);
      }
      // Resolve back into the artwork, so the video ends where it began.
      const resolve = Math.min(1, Math.max(0, 1 - (duration - t) / Math.min(RESOLVE_SEC, duration / 3)));
      vis.present(t, resolve * resolve * (3 - 2 * resolve));
      out.drawImage(vis.canvas, 0, 0, SIZE, SIZE);
    };
  }

  // --- Panel ---

  function init() {
    const panel = document.getElementById("artwork-video");
    if (!panel || panel.dataset.ready) return;
    panel.dataset.ready = "1";

    const songInput = document.getElementById("music_file");
    const fileRow = document.getElementById("video-file-row");
    const fileInput = document.getElementById("video-song-file");
    const muteBox = document.getElementById("video-mute");
    const startBtn = document.getElementById("video-start");
    const cancelBtn = document.getElementById("video-cancel");
    const stage = document.getElementById("video-stage");
    const canvas = document.getElementById("video-canvas");
    const progressBar = document.getElementById("video-progress-bar");
    const timeEl = document.getElementById("video-time");
    const result = document.getElementById("video-result");
    const player = document.getElementById("video-player");
    const downloadLink = document.getElementById("video-download");
    const statusBox = document.getElementById("video-status");
    const statusText = document.getElementById("video-status-text");

    canvas.width = canvas.height = SIZE;
    let session = null;
    let resultUrl = null;

    // The song picked for analysis is reused when it's still in the form;
    // otherwise (e.g. after a reload) the listener picks it again here.
    fileRow.hidden = Boolean(songInput && songInput.files[0]);

    function setStatus(kind, text) {
      statusBox.hidden = !text;
      statusBox.className = "editor-status" + (kind ? " is-" + kind : "");
      statusText.textContent = text || "";
    }

    function finish() {
      startBtn.disabled = false;
      cancelBtn.hidden = true;
      session = null;
    }

    async function start() {
      const mimeType = pickMimeType();
      if (mimeType === null || !canvas.captureStream) {
        setStatus("error", "This browser can't record video. Try a recent Chrome, Edge, Firefox or Safari.");
        return;
      }
      const file = chosenSong();
      if (!file) {
        fileRow.hidden = false;
        setStatus("error", "Choose the song file to use as the soundtrack.");
        return;
      }

      startBtn.disabled = true;
      result.hidden = true;
      setStatus("busy", "Listening to the song…");

      let audioCtx;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const [artwork, buffer] = await Promise.all([
          loadArtwork(),
          file.arrayBuffer().then((data) => audioCtx.decodeAudioData(data)),
        ]);
        const features = measure(buffer);
        const duration = buffer.duration;
        const styleInput = document.querySelector('input[name="video-style"]:checked');
        const draw =
          styleInput && styleInput.value === "visualizer" && window.AuraVisualizer
            ? makeVisualizerRenderer(canvas, artwork, buffer, features, duration)
            : makeRenderer(canvas, artwork, features, duration);
        draw(0);
        stage.hidden = false;

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        const recordTap = audioCtx.createMediaStreamDestination();
        const speakers = audioCtx.createGain();
        speakers.gain.value = muteBox.checked ? 0 : 1;
        source.connect(recordTap);
        source.connect(speakers).connect(audioCtx.destination);
        muteBox.onchange = () => (speakers.gain.value = muteBox.checked ? 0 : 1);

        const stream = new MediaStream([
          ...canvas.captureStream(FPS).getVideoTracks(),
          ...recordTap.stream.getAudioTracks(),
        ]);
        const recorder = new MediaRecorder(stream, {
          mimeType: mimeType || undefined,
          videoBitsPerSecond: 6000000,
          audioBitsPerSecond: 192000,
        });
        const chunks = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

        session = { audioCtx, source, recorder, cancelled: false, raf: 0 };
        const current = session;
        recorder.onstop = async () => {
          cancelAnimationFrame(current.raf);
          audioCtx.close();
          stage.hidden = true;
          if (current.cancelled) {
            setStatus("", "");
            finish();
            return;
          }
          setStatus("busy", "Finishing the video…");
          const blob = await collectRecording(recorder, chunks, mimeType);
          const type = blob.type;
          if (!(await isPlayable(blob))) {
            setStatus("error", brokenRecordingMessage(blob));
            finish();
            return;
          }
          if (resultUrl) URL.revokeObjectURL(resultUrl);
          resultUrl = URL.createObjectURL(blob);
          player.src = resultUrl;
          downloadLink.href = resultUrl;
          downloadLink.download = "aura-video." + (type.includes("mp4") ? "mp4" : "webm");
          result.hidden = false;
          setStatus("done", "Your video is ready (" + formatTime(duration) + ").");
          finish();
        };

        await audioCtx.resume();
        recorder.start(1000);
        const startAt = audioCtx.currentTime + 0.05;
        source.start(startAt);
        source.onended = () => {
          draw(duration);
          setTimeout(() => recorder.state !== "inactive" && recorder.stop(), 60);
        };

        cancelBtn.hidden = false;
        setStatus("busy", "Recording… keep this tab open and visible until it finishes.");
        const tick = () => {
          const t = Math.max(0, audioCtx.currentTime - startAt);
          draw(Math.min(t, duration));
          progressBar.style.width = Math.min(100, (t / duration) * 100) + "%";
          timeEl.textContent = formatTime(t) + " / " + formatTime(duration);
          current.raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        if (audioCtx) audioCtx.close();
        stage.hidden = true;
        setStatus("error", err.message || "Couldn't make the video.");
        finish();
      }
    }

    function cancel() {
      if (!session) return;
      session.cancelled = true;
      session.source.onended = null;
      try {
        session.source.stop();
      } catch (e) {
        // already stopped
      }
      if (session.recorder.state !== "inactive") session.recorder.stop();
    }

    startBtn.addEventListener("click", start);
    cancelBtn.addEventListener("click", cancel);
    fileInput.addEventListener("change", () => setStatus("", ""));
    document.addEventListener("visibilitychange", () => {
      if (session && document.hidden) {
        setStatus("error", "Recording pauses its picture while this tab is hidden — come back to keep the video smooth.");
      } else if (session) {
        setStatus("busy", "Recording… keep this tab open and visible until it finishes.");
      }
    });
  }

  // --- AI video: a short Google clip, directed by the song and set to it ---

  const AI_SECONDS = 8;

  function chosenSong() {
    const analyzed = document.getElementById("music_file");
    const picked = document.getElementById("video-song-file");
    return (analyzed && analyzed.files[0]) || (picked && picked.files[0]) || null;
  }

  function countBeats(beat, from, to) {
    let count = 0;
    for (let f = from; f < to; f++) if (beat[f] > 0 && !(beat[f - 1] > 0)) count++;
    return count;
  }

  // The stretch of song with the most going on, starting on a beat.
  function pickExcerpt(features, duration) {
    const len = Math.min(AI_SECONDS, duration);
    const span = Math.round(len * FPS);
    const frames = features.loud.length;
    const totals = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) {
      totals[f + 1] = totals[f] + features.loud[f] + features.bass[f] + (features.beat[f] > 0 ? 6 : 0);
    }
    let best = 0;
    for (let f = 0; f + span <= frames; f++) {
      if (totals[f + span] - totals[f] > totals[best + span] - totals[best]) best = f;
    }
    for (let off = 0; off < FPS && best + off + span <= frames; off++) {
      if (features.beat[best + off] > 0) {
        best += off;
        break;
      }
    }
    return { start: best / FPS, len, startFrame: best, span };
  }

  // What the server turns into the clip's directions: what the music does
  // in each two seconds.
  function describeExcerpt(features, excerpt) {
    const parts = Math.max(1, Math.round(excerpt.len / 2));
    const size = excerpt.span / parts;
    const segments = [];
    for (let p = 0; p < parts; p++) {
      const from = Math.round(excerpt.startFrame + p * size);
      const to = Math.round(excerpt.startFrame + (p + 1) * size);
      const mean = (arr) => arr.slice(from, to).reduce((sum, v) => sum + v, 0) / Math.max(1, to - from);
      segments.push({
        energy: mean(features.loud),
        bass: mean(features.bass),
        treble: mean(features.treble),
        beats: countBeats(features.beat, from, to),
      });
    }
    return { seconds: Math.max(3, Math.round(excerpt.len)), segments };
  }

  // Where in the clip (0..1) to be at each frame of the excerpt: it runs
  // faster through loud moments and beats, slower through quiet ones.
  function motionCurve(features, excerpt) {
    const speeds = new Float32Array(excerpt.span);
    for (let i = 0; i < excerpt.span; i++) {
      let sum = 0;
      let count = 0;
      for (let f = excerpt.startFrame + i - 3; f <= excerpt.startFrame + i + 3; f++) {
        if (f < 0 || f >= features.loud.length) continue;
        sum += 0.35 + features.loud[f] + 0.3 * features.bass[f] + (features.beat[f] > 0 ? 0.8 : 0);
        count++;
      }
      speeds[i] = sum / Math.max(1, count);
    }
    const mean = speeds.reduce((sum, v) => sum + v, 0) / excerpt.span;
    const position = new Float32Array(excerpt.span);
    let travelled = 0;
    for (let i = 0; i < excerpt.span; i++) {
      speeds[i] /= mean;
      position[i] = travelled / excerpt.span;
      travelled += speeds[i];
    }
    return { speeds, position };
  }

  // Plays the clip silently while recording it with the excerpt of the song
  // as the only sound, so Google's generated audio never reaches the result.
  async function setToSong(audioCtx, buffer, features, excerpt, clipUrl, canvas) {
    const clip = document.createElement("video");
    clip.muted = true;
    clip.playsInline = true;
    // Some browsers only paint a video that's on the page, so it sits there
    // too small to see while the canvas shows it.
    clip.className = "ai-video-source";
    canvas.parentNode.appendChild(clip);
    clip.src = clipUrl;
    await new Promise((resolve, reject) => {
      clip.oncanplaythrough = resolve;
      clip.onerror = () => reject(new Error("Couldn't open the video Google made."));
    });

    canvas.width = clip.videoWidth || 1280;
    canvas.height = clip.videoHeight || 720;
    const out = canvas.getContext("2d");
    const { speeds, position } = motionCurve(features, excerpt);
    const clipLength = clip.duration;
    let pulse = 0;
    let lastFrame = -1;

    function draw(t) {
      const i = Math.min(excerpt.span - 1, Math.floor(t * FPS));
      for (let n = lastFrame + 1; n <= i; n++) pulse = Math.max(pulse * 0.85, features.beat[excerpt.startFrame + n] || 0);
      lastFrame = Math.max(lastFrame, i);

      // Follow the motion curve, correcting any drift from where it should be.
      const drift = position[i] * clipLength - clip.currentTime;
      const rate = Math.max(0.25, Math.min(2.5, speeds[i] * (clipLength / excerpt.len) * (1 + drift * 0.6)));
      if (Math.abs(rate - clip.playbackRate) > 0.03) clip.playbackRate = rate;

      const ease = Math.min(1, t / 0.5);
      const grow = 1 + ease * 0.035 * pulse;
      const w = canvas.width * grow;
      const h = canvas.height * grow;
      out.globalCompositeOperation = "source-over";
      out.globalAlpha = 1;
      out.drawImage(clip, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      if (pulse > 0.02) {
        out.globalCompositeOperation = "lighter";
        out.globalAlpha = ease * pulse * 0.16;
        out.drawImage(canvas, 0, 0);
      }
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    const fade = audioCtx.createGain();
    const recordTap = audioCtx.createMediaStreamDestination();
    source.connect(fade).connect(recordTap);

    const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...recordTap.stream.getAudioTracks()]);
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 8000000,
      audioBitsPerSecond: 192000,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    // A video can report it's ready before it has a picture to give, so
    // recording only starts once the canvas really shows one.
    await audioCtx.resume();
    await clip.play();
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    probe.canvas.width = probe.canvas.height = 8;
    const hasPicture = () => {
      probe.drawImage(clip, 0, 0, 8, 8);
      return probe.getImageData(0, 0, 8, 8).data.some((v, n) => n % 4 !== 3 && v > 8);
    };
    const waitedFrom = Date.now();
    while (!hasPicture()) {
      if (Date.now() - waitedFrom > 4000) throw new Error("This browser couldn't show the video to record it. Please try Chrome.");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    draw(0);
    recorder.start(1000);
    const startAt = audioCtx.currentTime + 0.05;
    // Ends the excerpt with a short fade rather than cutting mid-note.
    fade.gain.setValueAtTime(1, startAt + Math.max(0, excerpt.len - 0.4));
    fade.gain.linearRampToValueAtTime(0, startAt + excerpt.len);
    source.start(startAt, excerpt.start, excerpt.len);

    return new Promise((resolve) => {
      let running = true;
      const tick = () => {
        if (!running) return;
        draw(Math.max(0, Math.min(excerpt.len, audioCtx.currentTime - startAt)));
        requestAnimationFrame(tick);
      };
      recorder.onstop = () => {
        running = false;
        clip.pause();
        collectRecording(recorder, chunks, mimeType).then(resolve);
      };
      source.onended = () => setTimeout(() => recorder.state !== "inactive" && recorder.stop(), 60);
      tick();
    });
  }

  function initAi() {
    const box = document.getElementById("ai-video");
    if (!box || box.dataset.ready) return;
    box.dataset.ready = "1";

    const startBtn = document.getElementById("ai-video-start");
    const statusBox = document.getElementById("ai-video-status");
    const statusText = document.getElementById("ai-video-status-text");
    const elapsedEl = document.getElementById("ai-video-elapsed");
    const stage = document.getElementById("ai-video-stage");
    const canvas = document.getElementById("ai-video-canvas");
    const result = document.getElementById("ai-video-result");
    const player = document.getElementById("ai-video-player");
    const downloadLink = document.getElementById("ai-video-download");
    let resultUrl = null;

    function setStatus(kind, text) {
      statusBox.hidden = !text;
      statusBox.className = "editor-status" + (kind ? " is-" + kind : "");
      statusText.textContent = text || "";
    }

    startBtn.addEventListener("click", async () => {
      // Checked before anything is sent to Google, so a video is never paid
      // for without its soundtrack.
      const file = chosenSong();
      if (!file) {
        document.getElementById("video-file-row").hidden = false;
        setStatus("error", "Choose the song file above first — it becomes the video's soundtrack.");
        return;
      }
      if (pickMimeType() === null || !canvas.captureStream) {
        setStatus("error", "This browser can't record video. Try a recent Chrome, Edge, Firefox or Safari.");
        return;
      }

      startBtn.disabled = true;
      result.hidden = true;
      const started = Date.now();
      elapsedEl.textContent = "0s";
      const timer = setInterval(() => {
        elapsedEl.textContent = Math.round((Date.now() - started) / 1000) + "s";
      }, 1000);
      // Created during the click, or browsers may refuse it sound later.
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      try {
        setStatus("busy", "Listening to your song…");
        const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
        const features = measure(buffer);
        const excerpt = pickExcerpt(features, buffer.duration);

        // The version picked in the editor is the first frame.
        const active = document.querySelector(".version-thumb.is-active");
        const body = new FormData();
        if (active) body.append("version", active.dataset.version);
        body.append("music", JSON.stringify(describeExcerpt(features, excerpt)));

        setStatus("busy", "Google is making your video…");
        const res = await fetch(box.dataset.url, { method: "POST", body, headers: { Accept: "application/json" } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.url) throw new Error(data.error || "Couldn't make the AI video (" + res.status + ").");
        const made = await fetch(data.url);
        if (!made.ok) throw new Error("Couldn't load the video Google made (" + made.status + ").");
        const clipUrl = URL.createObjectURL(await made.blob());

        setStatus("busy", "Setting it to your song… keep this tab open and visible.");
        stage.hidden = false;
        const blob = await setToSong(audioCtx, buffer, features, excerpt, clipUrl, canvas);
        URL.revokeObjectURL(clipUrl);
        if (!(await isPlayable(blob))) throw new Error(brokenRecordingMessage(blob));

        if (resultUrl) URL.revokeObjectURL(resultUrl);
        resultUrl = URL.createObjectURL(blob);
        player.src = resultUrl;
        downloadLink.href = resultUrl;
        downloadLink.download = "aura-ai-video." + (blob.type.includes("mp4") ? "mp4" : "webm");
        result.hidden = false;
        setStatus("done", "Your AI video is ready, set to " + formatTime(excerpt.start) + "–" + formatTime(excerpt.start + excerpt.len) + " of your song.");
      } catch (err) {
        setStatus("error", err.message || "Couldn't make the AI video.");
      } finally {
        clearInterval(timer);
        elapsedEl.textContent = "";
        stage.querySelectorAll("video").forEach((el) => el.remove());
        stage.hidden = true;
        startBtn.disabled = false;
        audioCtx.close();
      }
    });
  }

  function initAll() {
    init();
    initAi();
  }

  initAll();
  return { init: initAll };
})();
