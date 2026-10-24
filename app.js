// Liquid Glass playground.
// Analytic rounded-rect / squircle SDF driving the edge math recovered from
// QuartzCore's glass_background_lpf / glass_foreground_lpf (default.metallib,
// macOS 26): circular-cap edgeOffset refraction along the SDF gradient, a
// directional highlight cone, and the 7-tap spectral walk along the normal.
// All lengths are in points (CSS px) so the macOS preset uses the real numbers.
(() => {
'use strict';
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
if (!gl) { document.body.textContent = 'WebGL2 required'; return; }

const VS = `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Cover-fit wallpaper into a (downscaled) screen-space target.
const COVER_FS = `#version 300 es
precision highp float;
uniform sampler2D uImg;
uniform vec2 uRes, uCover;
out vec4 O;
void main(){
  vec2 s = gl_FragCoord.xy / uRes;
  O = vec4(texture(uImg, 0.5 + (s - 0.5) * uCover).rgb, 1.0);
}`;

// One axis of a separable gaussian. 17 taps spread over +-3 sigma.
const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes, uDir;
uniform float uSigma;
out vec4 O;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float stepT = max(uSigma * 3.0 / 8.0, 1.0);
  vec3 c = texture(uSrc, uv).rgb;
  float sum = 1.0;
  for (int i = 1; i <= 8; i++) {
    float x = float(i) * stepT;
    float w = exp(-x * x / (2.0 * uSigma * uSigma));
    vec2 o = uDir * x / uRes;
    c += (texture(uSrc, uv + o).rgb + texture(uSrc, uv - o).rgb) * w;
    sum += 2.0 * w;
  }
  O = vec4(c / sum, 1.0);
}`;

const GLASS_FS = `#version 300 es
precision highp float;
uniform sampler2D uImg, uBlur;
uniform vec2  uRes, uCover;
uniform float uDpr;
uniform vec2  uCenter;      // device px, y up
uniform vec2  uHalf;        // pt
uniform float uRadius;      // pt
uniform float uExp;         // corner exponent, 2 = circular
uniform float uBand, uRefract, uCurv, uCA;
uniform float uFrost;
uniform vec2  uLight;       // highlight direction
uniform float uSpread, uHlAmt, uHlHeight, uFill;
uniform float uEdgeAmt, uEdgeBand;
uniform float uBright, uTintAmt;
uniform vec3  uTint;
uniform float uShadow, uShRad;
uniform vec2  uShOff;
out vec4 O;

// Distance in pt, negative inside.
float sdf(vec2 q){
  vec2 w = abs(q) - uHalf + uRadius;
  vec2 m = max(w, 0.0);
  float c = uExp == 2.0 ? length(m) : pow(pow(m.x, uExp) + pow(m.y, uExp), 1.0 / uExp);
  return c + min(max(w.x, w.y), 0.0) - uRadius;
}

// QuartzCore edgeOffset: full amount at the edge, easing to 0 at depth 'band'
// with a circular cap (curvature 1) or linear ramp (curvature 0).
float edgeOffset(float d, float band, float amount){
  float s = clamp(-d / band, 0.0, 1.0);
  return amount * (1.0 - mix(s, sqrt(s * (2.0 - s)), uCurv));
}

vec3 sharp(vec2 px){
  vec2 s = px / uRes;
  vec2 g = uCover / uRes;
  return textureGrad(uImg, 0.5 + (s - 0.5) * uCover, vec2(g.x, 0.0), vec2(0.0, g.y)).rgb;
}
vec3 backdrop(vec2 px){
  vec3 c = sharp(px);
  return uFrost > 0.0 ? mix(c, texture(uBlur, px / uRes).rgb, uFrost) : c;
}

void main(){
  vec2 px = gl_FragCoord.xy;
  vec2 q  = (px - uCenter) / uDpr;
  float d = sdf(q);
  vec3 bg = sharp(px);

  float sh = uShadow * exp(-0.5 * pow(max(sdf(q - uShOff), 0.0) / max(uShRad, 0.5), 2.0));
  bg *= 1.0 - sh;

  float aa = max(fwidth(d), 1e-3);
  float cov = clamp(0.5 - d / aa, 0.0, 1.0);
  if (cov <= 0.0) { O = vec4(bg, 1.0); return; }

  vec2 g = vec2(sdf(q + vec2(0.5, 0.0)) - sdf(q - vec2(0.5, 0.0)),
                sdf(q + vec2(0.0, 0.5)) - sdf(q - vec2(0.0, 0.5)));
  g = length(g) > 1e-5 ? normalize(g) : vec2(0.0);

  // Refraction: sample outward along the gradient, like uv0 + edgeOffset*grad.
  vec2 off = g * edgeOffset(d, uBand, uRefract) * uDpr;
  vec3 glass;
  glass.r = backdrop(px + off * (1.0 - uCA)).r;
  glass.g = backdrop(px + off).g;
  glass.b = backdrop(px + off * (1.0 + uCA)).b;

  // glass_foreground: 3 taps outward (R*k, G*(1-k)) + 4 inward (G*(1-k), B*k).
  if (uEdgeAmt > 0.0) {
    vec2 base = px + off;
    vec2 stp = g * edgeOffset(d, uEdgeBand, uEdgeAmt) * uDpr;
    vec3 acc = vec3(0.0);
    float k = 1.0;
    for (int i = 0; i < 3; i++) {
      vec3 s = backdrop(base + k * stp);
      acc.r += s.r * k; acc.g += s.g * (1.0 - k); k -= 1.0 / 3.0;
    }
    k = 0.0;
    for (int i = 0; i < 4; i++) {
      vec3 s = backdrop(base - k * stp);
      acc.g += s.g * (1.0 - k); acc.b += s.b * k; k += 1.0 / 3.0;
    }
    float ring = clamp(edgeOffset(d, uEdgeBand, 1.0), 0.0, 1.0);
    glass = mix(glass, acc * vec3(0.5, 1.0 / 3.0, 0.5), ring);
  }

  glass *= uBright;
  glass = mix(glass, glass * uTint, uTintAmt);

  // Highlight cone (CASDFGlassHighlightEffect angle/spread/amount/height)
  // plus the opposite fill light (CASDFKeyFillHighlightEffect).
  float rim = edgeOffset(d, uHlHeight, 1.0);
  rim *= rim;
  float ca = dot(g, uLight);
  float half_ = 0.5 * uSpread;
  float key  = max(cos(min(acos(clamp( ca, -1.0, 1.0)) / half_, 1.0) * 1.5707963), 0.0);
  float fill = max(cos(min(acos(clamp(-ca, -1.0, 1.0)) / half_, 1.0) * 1.5707963), 0.0);
  glass += rim * (key * uHlAmt + fill * uFill);

  O = vec4(mix(bg, glass, cov), 1.0);
}`;

// ---- GL plumbing -----------------------------------------------------------
function shader(type, src){
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(fs){
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), u = {};
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
  return { p, u };
}
const pCover = program(COVER_FS), pBlur = program(BLUR_FS), pGlass = program(GLASS_FS);

gl.bindVertexArray(gl.createVertexArray());
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function tex(){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
const imgTex = tex();
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([8, 8, 12, 255]));
const rt = [0, 1].map(() => ({ t: tex(), f: gl.createFramebuffer() }));
let rtW = 0, rtH = 0;
function ensureRT(w, h){
  if (w === rtW && h === rtH) return;
  rtW = w; rtH = h;
  for (const r of rt) {
    gl.bindTexture(gl.TEXTURE_2D, r.t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, r.t, 0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

// ---- wallpapers --------------------------------------------------------------
const WALLS = [
  '11-Big-Sur-Day','11-Big-Sur-Night','11-Big-Sur-Color-Day','11-Big-Sur-Color-Night',
  '12-Monterey-Light','12-Monterey-Dark','13-Ventura-Light','13-Ventura-Dark',
  '14-Sonoma-Light','14-Sonoma-Dark','14-Sonoma-Horizon',
  '15-Sequoia-Light','15-Sequoia-Dark','15-Sequoia-Sunrise',
  '26-Tahoe-Light','26-Tahoe-Dark','26-Tahoe-Beach-Day','26-Tahoe-Beach-Dusk',
  '27-Golden-Gate'];
let wallIdx = 14, imgAspect = 1, wallReq = 0;
const wallName = i => WALLS[i].replace(/^\d+-/, '').replace(/-/g, ' ');
function loadWall(i){
  const req = ++wallReq, img = new Image();
  img.onload = () => {
    if (req !== wallReq) return;
    imgAspect = img.width / img.height;
    gl.bindTexture(gl.TEXTURE_2D, imgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  };
  img.src = `wallpapers/${WALLS[i]}.jpg`;
}

// ---- params (pt / degrees) ---------------------------------------------------
const DEFAULTS = {
  w: 360, h: 220, radius: 56, squircle: true, exp: 5,
  follow: true, followSpeed: 0.18,
  band: 32, refract: 40, curv: 1, ca: 0.08,
  frostRadius: 6, frost: 0.5,
  light: 90, spread: 180, hlAmt: 0.5, hlHeight: 6, fill: 0.25,
  edgeAmt: 6, edgeBand: 14,
  bright: 1.04, tint: '#ffffff', tintAmt: 0,
  shadow: 0.22, shRad: 18, shOffX: 0, shOffY: -8,
};
// Values recovered from QuartzCore (+defaultValues / GlassBackgroundFilter::render):
// displacement height 20 + curvature 1, refraction height 30, highlight
// angle pi/2 spread pi amount 0.5, key/fill amounts 0.5, shadow radius 10 offset {0,-10}.
// Continuous (squircle) corners are what CALayer uses for glass.
const MACOS = {
  squircle: true, band: 20, refract: 30, curv: 1,
  light: 90, spread: 180, hlAmt: 0.5, fill: 0.5,
  shRad: 10, shOffX: 0, shOffY: -10,
};
const state = Object.assign({}, DEFAULTS);
const pos = { x: 0, y: 0 }, target = { x: 0, y: 0 };   // CSS px, y down

const SCHEMA = [
  ['Shape'],
  ['w', 'Width', 40, 1200, 1],
  ['h', 'Height', 40, 900, 1],
  ['radius', 'Corner radius', 0, 450, 1],
  ['squircle', 'Squircle', 'toggle'],
  ['exp', 'Corner smoothing', 2, 10, 0.1, () => state.squircle],
  ['follow', 'Follow cursor', 'toggle'],
  ['followSpeed', 'Follow speed', 0.02, 1, 0.01, () => state.follow],
  ['Refraction'],
  ['band', 'Height', 1, 200, 0.5],
  ['refract', 'Amount', 0, 150, 0.5],
  ['curv', 'Curvature', 0, 1, 0.01],
  ['ca', 'Dispersion', 0, 0.5, 0.005],
  ['Frost'],
  ['frostRadius', 'Blur radius', 0, 60, 0.5],
  ['frost', 'Amount', 0, 1, 0.01],
  ['Highlight'],
  ['light', 'Angle', 0, 360, 1],
  ['spread', 'Spread', 10, 360, 1],
  ['hlAmt', 'Amount', 0, 1.5, 0.01],
  ['hlHeight', 'Height', 0.5, 60, 0.5],
  ['fill', 'Fill light', 0, 1.5, 0.01],
  ['Edge spectrum'],
  ['edgeAmt', 'Amount', 0, 40, 0.5],
  ['edgeBand', 'Height', 1, 80, 0.5],
  ['Body'],
  ['bright', 'Brightness', 0.5, 1.6, 0.01],
  ['tintAmt', 'Tint', 0, 1, 0.01],
  ['tint', 'Tint color', 'color'],
  ['Shadow'],
  ['shadow', 'Opacity', 0, 1, 0.01],
  ['shRad', 'Radius', 0.5, 80, 0.5],
  ['shOffX', 'Offset X', -60, 60, 0.5],
  ['shOffY', 'Offset Y', -60, 60, 0.5],
];

const body = document.getElementById('pb');
const controls = [];
const fmt = (v, st) => Number(v).toFixed(st >= 1 ? 0 : st >= 0.1 ? 1 : st >= 0.01 ? 2 : 3);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };
for (const item of SCHEMA) {
  if (item.length === 1) { body.appendChild(el('div', 'group', item[0])); continue; }
  const [k, label, a, b, step, visible] = item;
  if (a === 'toggle') {
    const row = el('div', 'btns'), btn = el('button');
    row.appendChild(btn); body.appendChild(row);
    btn.onclick = () => { state[k] = !state[k]; sync(); };
    controls.push({ k, row, sync: () => { btn.textContent = `${label}: ${state[k] ? 'on' : 'off'}`; btn.classList.toggle('on', state[k]); } });
    continue;
  }
  const row = el('div', 'row'), top = el('div', 'top'), val = el('span', 'val');
  top.append(el('span', '', label), val); row.appendChild(top);
  const input = el('input');
  if (a === 'color') {
    input.type = 'color';
    input.oninput = () => { state[k] = input.value; };
    controls.push({ k, row, sync: () => { input.value = state[k]; } });
  } else {
    Object.assign(input, { type: 'range', min: a, max: b, step });
    input.oninput = () => { state[k] = +input.value; val.textContent = fmt(state[k], step); };
    controls.push({ k, row, visible, sync: () => { input.value = state[k]; val.textContent = fmt(state[k], step); } });
  }
  row.appendChild(input); body.appendChild(row);
}
function sync(){
  for (const c of controls) { c.sync(); if (c.visible) c.row.hidden = !c.visible(); }
  canvas.className = state.follow ? 'follow' : 'drag';
}

const presets = el('div', 'btns');
const mkBtn = (txt, fn) => { const b = el('button', '', txt); b.onclick = fn; return b; };
const copyBtn = mkBtn('Copy JSON', () => {
  navigator.clipboard?.writeText(JSON.stringify(state, null, 2)).catch(() => {});
  copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy JSON', 1000);
});
presets.append(
  mkBtn('Reset', () => { Object.assign(state, DEFAULTS); sync(); }),
  mkBtn('macOS', () => { Object.assign(state, MACOS); sync(); }),
  copyBtn);
const walls = el('div', 'btns');
const wallBtn = mkBtn('', () => step(1));
wallBtn.id = 'wall';
const step = dir => { wallIdx = (wallIdx + dir + WALLS.length) % WALLS.length; wallBtn.textContent = wallName(wallIdx); loadWall(wallIdx); };
const prev = mkBtn('‹', () => step(-1)), next = mkBtn('›', () => step(1));
prev.style.flex = next.style.flex = '0 0 30px';
wallBtn.style.flex = '1';
walls.append(prev, wallBtn, next);
body.prepend(walls);
body.appendChild(presets);
wallBtn.textContent = wallName(wallIdx);
sync();

const panel = document.getElementById('panel');
if (innerWidth < 640) panel.classList.add('collapsed');
document.getElementById('ph').onclick = () => panel.classList.toggle('collapsed');
addEventListener('keydown', e => {
  if (e.key === 'h' || e.key === 'H') panel.style.display = panel.style.display === 'none' ? '' : 'none';
});

// ---- pointer -------------------------------------------------------------------
let drag = null;
canvas.addEventListener('pointermove', e => {
  if (state.follow) { target.x = e.clientX; target.y = e.clientY; }
  else if (drag) { target.x = pos.x = e.clientX - drag.x; target.y = pos.y = e.clientY - drag.y; }
});
canvas.addEventListener('pointerdown', e => {
  if (state.follow) { target.x = e.clientX; target.y = e.clientY; return; }
  const inside = Math.abs(e.clientX - pos.x) <= state.w / 2 && Math.abs(e.clientY - pos.y) <= state.h / 2;
  if (!inside) { target.x = pos.x = e.clientX; target.y = pos.y = e.clientY; }
  drag = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
const endDrag = () => { drag = null; canvas.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

let dpr = 1;
function resize(){
  dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
pos.x = target.x = innerWidth < 640 ? innerWidth / 2 : innerWidth / 2 - 130; pos.y = target.y = innerHeight / 2;

const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

// ---- frame ---------------------------------------------------------------------
let last = performance.now();
function frame(now){
  resize();
  const W = canvas.width, H = canvas.height;
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (state.follow) {
    const k = 1 - Math.pow(1 - state.followSpeed, dt * 60);
    pos.x += (target.x - pos.x) * k; pos.y += (target.y - pos.y) * k;
  }
  const ca = W / H;
  const cover = ca > imgAspect ? [1, imgAspect / ca] : [ca / imgAspect, 1];

  // Frost: blur the screen-space backdrop at a resolution that keeps sigma small.
  const sigma = state.frostRadius * dpr;
  const frostOn = state.frost > 0 && sigma >= 0.5;
  if (frostOn) {
    const div = sigma <= 12 ? 2 : sigma <= 24 ? 4 : 8;
    const w = Math.max(1, Math.ceil(W / div)), h = Math.max(1, Math.ceil(H / div));
    ensureRT(w, h);
    gl.viewport(0, 0, w, h);
    gl.useProgram(pCover.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, imgTex);
    gl.uniform1i(pCover.u.uImg, 0);
    gl.uniform2f(pCover.u.uRes, w, h);
    gl.uniform2f(pCover.u.uCover, cover[0], cover[1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt[0].f);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(pBlur.p);
    gl.uniform1i(pBlur.u.uSrc, 0);
    gl.uniform2f(pBlur.u.uRes, w, h);
    gl.uniform1f(pBlur.u.uSigma, sigma / div);
    gl.uniform2f(pBlur.u.uDir, 1, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt[1].f);
    gl.bindTexture(gl.TEXTURE_2D, rt[0].t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.uniform2f(pBlur.u.uDir, 0, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt[0].f);
    gl.bindTexture(gl.TEXTURE_2D, rt[1].t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  gl.viewport(0, 0, W, H);
  const { p, u } = pGlass;
  gl.useProgram(p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, imgTex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rt[0].t);
  gl.uniform1i(u.uImg, 0); gl.uniform1i(u.uBlur, 1);
  gl.uniform2f(u.uRes, W, H);
  gl.uniform2f(u.uCover, cover[0], cover[1]);
  gl.uniform1f(u.uDpr, dpr);
  gl.uniform2f(u.uCenter, pos.x * dpr, H - pos.y * dpr);
  const hw = state.w / 2, hh = state.h / 2;
  gl.uniform2f(u.uHalf, hw, hh);
  gl.uniform1f(u.uRadius, Math.min(state.radius, hw, hh));
  gl.uniform1f(u.uExp, state.squircle ? state.exp : 2);
  gl.uniform1f(u.uBand, state.band);
  gl.uniform1f(u.uRefract, state.refract);
  gl.uniform1f(u.uCurv, state.curv);
  gl.uniform1f(u.uCA, state.ca);
  gl.uniform1f(u.uFrost, frostOn ? state.frost : 0);
  const a = state.light * Math.PI / 180;
  gl.uniform2f(u.uLight, Math.cos(a), Math.sin(a));
  gl.uniform1f(u.uSpread, Math.max(state.spread, 1) * Math.PI / 180);
  gl.uniform1f(u.uHlAmt, state.hlAmt);
  gl.uniform1f(u.uHlHeight, state.hlHeight);
  gl.uniform1f(u.uFill, state.fill);
  gl.uniform1f(u.uEdgeAmt, state.edgeAmt);
  gl.uniform1f(u.uEdgeBand, state.edgeBand);
  gl.uniform1f(u.uBright, state.bright);
  gl.uniform1f(u.uTintAmt, state.tintAmt);
  gl.uniform3fv(u.uTint, hexToRgb(state.tint));
  gl.uniform1f(u.uShadow, state.shadow);
  gl.uniform1f(u.uShRad, state.shRad);
  gl.uniform2f(u.uShOff, state.shOffX, state.shOffY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  requestAnimationFrame(frame);
}
loadWall(wallIdx);
requestAnimationFrame(frame);
})();
