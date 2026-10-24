// Liquid Glass playground — WebGL2 driver for the recovered QuartzCore shaders.
(() => {
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
if (!gl) { document.body.innerHTML = 'WebGL2 required'; return; }

const WALLS = [
  '11-Big-Sur-Day','11-Big-Sur-Night','11-Big-Sur-Color-Day','11-Big-Sur-Color-Night',
  '12-Monterey-Light','12-Monterey-Dark','13-Ventura-Light','13-Ventura-Dark',
  '14-Sonoma-Light','14-Sonoma-Dark','14-Sonoma-Horizon',
  '15-Sequoia-Light','15-Sequoia-Dark','15-Sequoia-Sunrise',
  '26-Tahoe-Light','26-Tahoe-Dark','26-Tahoe-Beach-Day','26-Tahoe-Beach-Dusk',
  '27-Golden-Gate'];

// ---- parameter model -------------------------------------------------
// uiMin/uiMax are slider ranges. Defaults: QuartzCore recovered values where
// known (see analysis/NOTES.md); amounts are in *pixels* and converted to
// texture uv by dividing by canvas height at uniform-fill time.
const PARAMS = [
  // geometry
  { id:'w',      label:'width',            def:380,  min:80,  max:900, step:1,    geo:1 },
  { id:'h',      label:'height',           def:240,  min:40,  max:800, step:1,    geo:1 },
  { id:'radius', label:'corner radius',    def:22,   min:0,   max:120, step:1,    geo:1 },
  // background pass — refraction / lens
  { id:'lensAmount',  label:'refraction px',  def:14,   min:0,   max:60,  step:0.5 },
  { id:'lensBand',    label:'refraction band',def:24,   min:2,   max:80,  step:0.5 }, // → lensEdge=1/band
  { id:'blurMip',     label:'blur',           def:6,    min:0,   max:16,  step:0.25},
  { id:'rimBlur',     label:'rim blur',       def:3,    min:0,   max:16,  step:0.25}, // mipLodScale3
  { id:'rimStrength', label:'rim specular',   def:0.9,  min:0,   max:4,   step:0.05},
  { id:'specGain',    label:'specular gain',  def:0.75, min:0,   max:2,   step:0.05}, // recovered 0.75
  // chromatic dispersion
  { id:'chroma',   label:'dispersion',     def:1,    min:0,   max:1,   step:1 },
  { id:'ca1',      label:'CA offset A px', def:6,    min:0,   max:40,  step:0.5 },
  { id:'ca2',      label:'CA offset B px', def:10,   min:0,   max:60,  step:0.5 },
  { id:'caMix',    label:'CA mix',         def:0.5,  min:0,   max:1,   step:0.02},
  // tint
  { id:'tintAmt',  label:'tint amount',    def:0.15, min:0,   max:1,   step:0.02},
  { id:'tintSat',  label:'tint saturate',  def:1.35, min:0,   max:2,   step:0.05},
  // foreground pass (edge glow)
  { id:'fgGlow',   label:'edge glow px',   def:9,    min:0,   max:40,  step:0.5 },
  { id:'fgBand',   label:'edge band',      def:16,   min:2,   max:60,  step:0.5 },
  // global
  { id:'alpha',    label:'opacity',        def:1,    min:0,   max:1,   step:0.02},
];
const MACOS = {}; PARAMS.forEach(p => MACOS[p.id] = p.def);
const state = Object.assign({}, MACOS);
let wallIdx = 14;                 // Tahoe Light default
let follow = false, fgOn = true;
let panel = { x: 0.5, y: 0.42 };  // fraction of canvas
let dirtySDF = true;

// ---- shaders / programs ----------------------------------------------
function compile(type, src, defs) {
  const s = gl.createShader(type);
  gl.shaderSource(s, (defs||'') + src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
  return s;
}
function program(fsDefs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsDefs ? fsDefs + GLASS_FRAG : fsDefs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw gl.getProgramInfoLog(p);
  return p;
}
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const pCopy = (() => { const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, `#version 300 es
layout(location=0) in vec2 pos; out vec2 uv0;
void main(){ uv0=vec2(pos.x,1.0-pos.y); gl_Position=vec4(pos*2.0-1.0,0.0,1.0);}`));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, COPY_FRAG));
  gl.linkProgram(p); return p; })();
const pBG = program('#version 300 es\n#define PASS_BACKGROUND\n');
const pFG = program('#version 300 es\n#define PASS_FOREGROUND\n');

// UBOs
const uboBG = gl.createBuffer(), uboFG = gl.createBuffer();
gl.bindBuffer(gl.UNIFORM_BUFFER, uboBG); gl.bufferData(gl.UNIFORM_BUFFER, 512, gl.DYNAMIC_DRAW);
gl.bindBuffer(gl.UNIFORM_BUFFER, uboFG); gl.bufferData(gl.UNIFORM_BUFFER, 512, gl.DYNAMIC_DRAW);
for (const [prog,name,buf,idx] of [[pBG,'GlassBackgroundUniforms',uboBG,0],[pFG,'GlassForegroundUniforms',uboFG,0]]) {
  const bi = gl.getUniformBlockIndex(prog, name);
  gl.uniformBlockBinding(prog, bi, idx);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, idx, buf);
}

// ---- textures --------------------------------------------------------
const srcTex = gl.createTexture();       // backdrop (mipmapped)
const sdfTex = gl.createTexture();       // RGBA16F sdf
let wallImg = null, wallReady = false;
function loadWall(i) {
  wallReady = false;
  const img = new Image();
  img.onload = () => { wallImg = img; wallReady = true; uploadBackdrop(); };
  img.src = `wallpapers/${WALLS[i]}.jpg`;
  document.getElementById('wallname').textContent =
    WALLS[i].replace(/^\d+-/,'').replace(/-/g,' ');
}
const SDF_PAD = 64, SDF_MAX = 1024;
let sdfW = 0, sdfH = 0;
function buildSDF() {
  const w = Math.round(state.w), h = Math.round(state.h), r = Math.min(state.radius, w/2, h/2);
  sdfW = w + 2*SDF_PAD; sdfH = h + 2*SDF_PAD;
  const n = sdfW * sdfH;
  const d = new Float32Array(n), a = new Float32Array(n);
  for (let y = 0; y < sdfH; y++) for (let x = 0; x < sdfW; x++) {
    const px = x - SDF_PAD, py = y - SDF_PAD;             // panel-local px
    // signed distance to rounded rect (negative inside)
    const cx = Math.min(Math.max(px, r), w - r), cy = Math.min(Math.max(py, r), h - r);
    let dist;
    const inX = px >= 0 && px <= w, inY = py >= 0 && py <= h;
    if (inX && inY) {
      const inCore = (px >= r && px <= w - r) || (py >= r && py <= h - r);
      dist = inCore ? -Math.min(px, w - px, py, h - py) - 1
                    : Math.hypot(px - cx, py - cy) - r - 1;
      if (dist < -1) dist = Math.max(dist, -Math.min(px, w-px, py, h-py));
    } else {
      const qx = Math.max(px - (w - r), r - px, 0), qy = Math.max(py - (h - r), r - py, 0);
      dist = Math.hypot(qx, qy) - (r + 1);
      if (inX || inY) dist = Math.min(dist, Math.hypot(px - cx, py - cy) - r);
    }
    d[y*sdfW + x] = dist;
    a[y*sdfW + x] = 1.0;   // keep .a=1 so the bleed band resample works
  }
  // gradient via central differences, normalized
  const out = new Float32Array(n * 4);
  for (let y = 0; y < sdfH; y++) for (let x = 0; x < sdfW; x++) {
    const i = y*sdfW + x;
    const gx = (d[y*sdfW + Math.min(x+1,sdfW-1)] - d[y*sdfW + Math.max(x-1,0)]);
    const gy = (d[Math.min(y+1,sdfH-1)*sdfW + x] - d[Math.max(y-1,0)*sdfW + x]);
    const l = Math.hypot(gx, gy) || 1;
    out[i*4+0] = d[i];
    out[i*4+1] = gx / l;
    out[i*4+2] = gy / l;
    out[i*4+3] = a[i];
  }
  gl.bindTexture(gl.TEXTURE_2D, sdfTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sdfW, sdfH, 0, gl.RGBA, gl.FLOAT, out);
  const flt = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, flt);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, flt);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function uploadBackdrop() {
  if (!wallReady) return;
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, null);
  // draw image cover-fit into the texture using an offscreen canvas
  const oc = document.createElement('canvas');
  oc.width = canvas.width; oc.height = canvas.height;
  const c2 = oc.getContext('2d');
  const s = Math.max(oc.width / wallImg.width, oc.height / wallImg.height);
  c2.drawImage(wallImg, (oc.width - wallImg.width*s)/2, (oc.height - wallImg.height*s)/2,
               wallImg.width*s, wallImg.height*s);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, oc);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_2D);
}

// ---- uniform fill -----------------------------------------------------
const PX = () => 1 / canvas.height;  // px → uv factor (square-ish ok for playground)
function fillBG() {
  const px = PX(), f = new Float32Array(54*4/4);  // std140: vec4 + 53 scalars ≈ but layout padded
  // careful: std140 pads vec2 bleedUV to 8 and specScaleBias to 8 — indices below
  // follow the declared field order with correct vec2 alignment.
  const F = new Float32Array(128);
  const S = (i,v)=>F[i]=v;
  // [0] gradTransform = identity mat2
  F[0]=1; F[1]=0; F[2]=0; F[3]=1;
  S(4,state.ca1*px); S(5,1/state.lensBand);          // caAmount1, caEdge1
  S(6,state.ca2*px); S(7,1/(state.lensBand*1.4));    // caAmount2, caEdge2
  S(8,-8); S(9,-2);                                // caMixLo, caMixHi
  S(10,state.blurMip);                             // mipLodScale1
  S(11,state.rimBlur);                             // mipLodScale3
  S(12,4*px); S(13,1/state.lensBand);              // rimAmount, rimEdge
  S(14,state.lensAmount*px); S(15,1/state.lensBand); // lensAmount, lensEdge
  F[16]=0; F[17]=0;                                // bleedUV (vec2 at 16)
  S(18,state.blurMip); S(19,1.0);                  // blurMip, profileScale
  // mat2 (identity) rows at 20-31
  F.set([1,0,0,0, 0,1,0,0, 0,0,1,0], 20);
  // mat3 rows at 32-43
  F.set([1,0,0,0, 0,1,0,0, 0,0,1,0], 32);
  // tint matrix rows at 44-55: saturate-ish matrix built from tintSat + slight lift
  const sat = state.tintSat, L=(x)=>x;
  const r=0.2125,g=0.7154,b=0.0721;
  F.set([ r*(1-sat)+sat, g*(1-sat),   b*(1-sat),   0,
          r*(1-sat),     g*(1-sat)+sat, b*(1-sat), 0,
          r*(1-sat),     g*(1-sat),   b*(1-sat)+sat, 0 ], 44);
  S(56,state.tintAmt);                             // tintAmount
  S(57,0.85);                                      // tintAlpha
  S(58,1.0);                                       // caLumaBias
  S(59,0.9); S(60,0.45); S(61,0.15);               // spec0..2
  S(62,0.0); S(63,0.33); S(64,0.66); S(65,1.0);    // knots
  S(66,-3); S(67,0);                               // rimLo, rimHi  (window ~recovered -3..0)
  S(68,state.rimStrength);                         // rimStrength
  S(69,0.0);                                       // mat2Amount (off by default)
  F[70]=state.specGain; F[71]=0.0;                 // specScaleBias (vec2)
  S(72,0.0);                                       // lensBase
  S(73,1.0);                                       // lensScale
  S(74,state.caMix);                               // caMixAmount
  S(75,0.0); S(76,-11); S(77,-3);                  // fade off; fadeLo/Hi = recovered window
  S(78,0.0); S(79,0.0);                            // hdrClamp off
  S(80,1.0); S(81,0);                              // fadeScale, _f49
  S(82,state.chroma);                              // chromaEnable
  gl.bindBuffer(gl.UNIFORM_BUFFER, uboBG);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, F);
}
function fillFG() {
  const px = PX(), F = new Float32Array(128);
  F[0]=1; F[1]=0; F[2]=0; F[3]=1;                  // gradTransform
  F[4]=state.fgGlow*px; F[5]=1/state.fgBand; F[6]=0;   // rim1: amount,edge,base
  F[7]=state.fgGlow*1.2*px; F[8]=1/state.fgBand; F[9]=0; // rim2
  F[10]=1; F[11]=0;                                 // dirScaleU,V
  F[12]=-state.fgBand; F[13]=-2;                    // fadeLo,fadeHi
  F[14]=0.0; F[15]=1.0;                             // intensityLo,Hi
  F[16]=1; F[17]=0;                                 // dirScaleU1,V1
  gl.bindBuffer(gl.UNIFORM_BUFFER, uboFG);
  gl.bufferSubData(gl.UNIFORM_BUFFER, 0, F);
}

// ---- frame -------------------------------------------------------------
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    uploadBackdrop();
  }
}
let mouse = { x: 0.5, y: 0.4 };
function frame() {
  resize();
  if (follow) { panel.x = mouse.x; panel.y = mouse.y; }
  if (dirtySDF) { buildSDF(); dirtySDF = false; }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.BLEND);
  gl.useProgram(pCopy);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(gl.getUniformLocation(pCopy,'t'),0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const dpr = canvas.width / innerWidth;
  const pw = state.w * dpr, ph = state.h * dpr;
  const px0 = panel.x * canvas.width - pw/2, py0 = panel.y * canvas.height - ph/2;

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const draw = (prog) => {
    gl.useProgram(prog);
    gl.uniform4f(gl.getUniformLocation(prog,'panelRect'), px0, py0, pw, ph);
    gl.uniform2f(gl.getUniformLocation(prog,'canvasSize'), canvas.width, canvas.height);
    gl.uniform2f(gl.getUniformLocation(prog,'sdfPad'), SDF_PAD, SDF_PAD);
    gl.uniform1f(gl.getUniformLocation(prog,'globalAlpha'), state.alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sdfTex);
    gl.uniform1i(gl.getUniformLocation(prog,'srcTex'),0);
    gl.uniform1i(gl.getUniformLocation(prog,'sdfTex'),1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  fillBG(); draw(pBG);
  if (fgOn) { fillFG(); draw(pFG); }
  requestAnimationFrame(frame);
}

// ---- UI ----------------------------------------------------------------
const sl = document.getElementById('sliders');
PARAMS.forEach(p => {
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = `<label>${p.label}</label>
    <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${state[p.id]}">
    <span class="val">${state[p.id]}</span>`;
  const inp = row.querySelector('input'), val = row.querySelector('.val');
  inp.oninput = () => { state[p.id] = +inp.value; val.textContent = inp.value;
                        if (p.geo) dirtySDF = true; };
  p._el = inp; p._val = val;
  sl.appendChild(row);
});
document.getElementById('reset').onclick = () => {
  PARAMS.forEach(p => { state[p.id] = MACOS[p.id]; p._el.value = p.def; p._val.textContent = p.def; });
  dirtySDF = true;
};
document.getElementById('wall').onclick = () => { wallIdx = (wallIdx+1) % WALLS.length; loadWall(wallIdx); };
const fb = document.getElementById('follow');
fb.onclick = () => { follow = !follow; fb.textContent = `Follow cursor: ${follow?'on':'off'}`; };
const fg = document.getElementById('fg');
fg.onclick = () => { fgOn = !fgOn; fg.textContent = `Edge glow: ${fgOn?'on':'off'}`; };

let dragging = false, dragOff = {x:0,y:0};
canvas.addEventListener('pointerdown', e => {
  const dpr = canvas.width/innerWidth;
  const pw = state.w*dpr, ph = state.h*dpr;
  const px0 = panel.x*canvas.width - pw/2, py0 = panel.y*canvas.height - ph/2;
  const mx = e.clientX*dpr, my = e.clientY*dpr;
  dragging = true; canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
  if (mx>=px0 && mx<=px0+pw && my>=py0 && my<=py0+ph) dragOff = {x:mx-px0, y:my-py0};
  else { dragOff = {x:pw/2, y:ph/2};
         panel.x = (mx-pw/2)/canvas.width; panel.y = (my-ph/2)/canvas.height; }
});
canvas.addEventListener('pointermove', e => {
  const dpr = canvas.width/innerWidth;
  mouse.x = e.clientX/innerWidth; mouse.y = e.clientY/innerHeight;
  if (dragging && !follow) {
    panel.x = (e.clientX*dpr - dragOff.x)/canvas.width;
    panel.y = (e.clientY*dpr - dragOff.y)/canvas.height;
  }
});
canvas.addEventListener('pointerup', () => { dragging=false; canvas.classList.remove('dragging'); });

loadWall(wallIdx);
requestAnimationFrame(frame);
})();
