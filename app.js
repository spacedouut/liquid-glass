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

// Rounded rect in pt (negative inside); uExp 2 = circular corners, >2 = squircle.
const SDF_GLSL = `
uniform vec2  uHalf;
uniform float uRadius, uExp;
float sdf(vec2 q){
  vec2 w = abs(q) - uHalf + uRadius;
  vec2 m = max(w, 0.0);
  float c = uExp == 2.0 ? length(m) : pow(pow(m.x, uExp) + pow(m.y, uExp), 1.0 / uExp);
  return c + min(max(w.x, w.y), 0.0) - uRadius;
}`;

const GLASS_FS = `#version 300 es
precision highp float;
uniform sampler2D uImg, uBlur;
uniform vec2  uRes, uCover;
uniform float uDpr;
uniform vec2  uCenter;      // device px, y up
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

${SDF_GLSL}

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

// Faithful mode: glass_background_lpf + glass_foreground_lpf, transcribed from
// the recovered IR (see LiquidGlass.metal in the RE session) and composited the
// way CA does (premultiplied, ONE / ONE_MINUS_SRC_ALPHA). The only stand-in is
// the SDF texture: sdfTex() evaluates the same (dist, grad, alpha) analytically.
const QC_FS = `#version 300 es
precision highp float;
struct GlassBackgroundUniforms {
  mat2  gradTransform;
  float caAmount1, caEdge1, caAmount2, caEdge2, caMixLo, caMixHi;
  float mipLodScale1, mipLodScale3;
  float rimAmount, rimEdge, lensAmount, lensEdge;
  vec2  bleedUV;
  float blurMip, profileScale;
  mat3  faceM; vec3 faceBias;
  mat3  rimM;  vec3 rimBias;
  mat3  tintM; vec3 tintBias;
  float tintAmount, tintAlpha, caLumaBias;
  vec3  spec;
  vec4  knots;
  float rimLo, rimHi, rimStrength, mat2Amount;
  vec2  specScaleBias;
  float lensBase, lensScale, caMixAmount;
  float fadeAmount, fadeLo, fadeHi, hdrClampMax, premulClamp, fadeScale;
  float chromaEnable;
};
struct GlassForegroundUniforms {
  mat2  gradTransform;
  float rimAmount1, rimEdge1, rimBase1, rimAmount2, rimEdge2, rimBase2;
  float dirScaleU, dirScaleV, fadeLo, fadeHi, intensityLo, intensityHi;
  float dirScaleU1, dirScaleV1;
};
uniform GlassBackgroundUniforms uBG;
uniform GlassForegroundUniforms uFG;
uniform bool uFgOn;
uniform float globalAlpha;
uniform sampler2D srcTex;
uniform vec2  uRes, uCenter;
uniform float uDpr;
uniform float uShadow, uShRad;
uniform vec2  uShOff;
${SDF_GLSL}
out vec4 frag;

const float EPS = 1e-6, EPSAA = 1e-4;
const vec3 LUMA709 = vec3(0.2125, 0.7154, 0.0721);

vec4 sdfTex(vec2 q){
  float d = sdf(q);
  vec2 g = vec2(sdf(q + vec2(0.5, 0.0)) - sdf(q - vec2(0.5, 0.0)),
                sdf(q + vec2(0.0, 0.5)) - sdf(q - vec2(0.0, 0.5)));
  return vec4(d, length(g) > 1e-5 ? normalize(g) : vec2(0.0), 1.0);
}
float edgeOffset(float d, float base, float edge, float amount){
  float s = clamp(edge * -(base + d), 0.0, 1.0);
  return amount - amount * clamp(sqrt(s * (2.0 - s)), 0.0, 1.0);
}
float mipLod(float t){ return max(0.0, log2(t < 2.0 ? t * 0.5 + 1.0 : t)); }
vec3 unPremul(vec4 c){ return c.rgb / max(c.a, EPS); }
vec3 killTiny(vec3 c){ return c * step(vec3(EPS), abs(c)); }
float lensProfile(float x){
  float p = clamp(x * 0.25 + 0.5, 0.0, 1.0);
  float q = p * 4.0 - 2.0, q2 = q * q;
  float r = 0.002954 * q2 - 0.034454;
  r = r * q2 + 0.168213; r = r * q2 - 0.560547; r = r * q + 0.5;
  return r;
}
vec4 smp(vec2 uv, float lod){ return textureLod(srcTex, uv, lod); }

vec4 glassBackground(vec2 uv0, vec2 q){
  vec4 t = sdfTex(q);
  float d = t.x;
  float cov = clamp(0.5 - d / max(fwidth(d), EPSAA), 0.0, 1.0) * t.a;
  vec2 resamp = vec2(0.0);
  if (cov < 1.0) { vec4 r = sdfTex(q + uBG.bleedUV); resamp = vec2(r.x, r.a); }
  vec2 grad = uBG.gradTransform * t.yz;

  vec4 tint = vec4(0.0);
  if (cov < 1.0) {
    vec2 uvLens = uv0 + edgeOffset(d, uBG.lensBase, uBG.lensEdge, uBG.lensAmount) * grad;
    float mag = uBG.lensScale * resamp.y * lensProfile(resamp.x * uBG.profileScale);
    if (mag < 6.10352e-05 && cov == 0.0) return vec4(0.0);
    if (uBG.tintAmount > EPS) {
      vec3 rgb = killTiny(unPremul(smp(uvLens, mipLod(uBG.blurMip))));
      tint = vec4(uBG.tintM * rgb * uBG.tintAmount + uBG.tintBias, mix(uBG.tintAlpha, 1.0, uBG.tintAmount));
    } else {
      tint = vec4(uBG.tintBias, uBG.tintAlpha);
    }
    tint *= mag;
  }

  vec4 mainc = vec4(0.0);
  if (cov > 0.0) {
    vec4 s;
    if (uBG.chromaEnable != 0.0) {
      vec3 lo = uBG.knots.xyz, hi = uBG.knots.yzw;
      float eA = edgeOffset(d, 0.0, uBG.caEdge1, uBG.caAmount1);
      vec3 spA = clamp((vec3(eA + d) - lo) / (hi - lo), 0.0, 1.0);
      float lodA = (uBG.caLumaBias - dot(spA, uBG.spec)) * uBG.mipLodScale1;
      vec4 sA = smp(uv0 + eA * grad, mipLod(lodA));
      sA = vec4(killTiny(sA.rgb), sA.a);
      if (uBG.caMixAmount > 0.0) {
        float eB = edgeOffset(d, 0.0, uBG.caEdge2, uBG.caAmount2);
        vec3 spB = clamp((vec3(eB + d) - lo) / (hi - lo), 0.0, 1.0);
        float lodB = (uBG.caLumaBias - dot(spB, uBG.spec)) * uBG.mipLodScale1;
        vec4 sB = smp(uv0 + eB * grad, mipLod(lodB));
        sB = vec4(killTiny(sB.rgb), sB.a);
        float k = uBG.caMixAmount * clamp((d - uBG.caMixLo) / (uBG.caMixHi - uBG.caMixLo), 0.0, 1.0);
        s = mix(sA, sB, k);
      } else s = sA;
    } else {
      s = smp(uv0, mipLod(uBG.mipLodScale1));
    }
    vec3 rgb = unPremul(s);
    if (uBG.mat2Amount > 0.0)
      rgb = mix(rgb, uBG.faceM * rgb + uBG.faceBias, uBG.mat2Amount);
    vec2 uvRim = uv0 + edgeOffset(d, 0.0, uBG.rimEdge, uBG.rimAmount) * grad;
    vec3 rgbR = uBG.rimM * killTiny(unPremul(smp(uvRim, mipLod(uBG.mipLodScale3)))) + uBG.rimBias;
    float rim = clamp((d - uBG.rimLo) / (uBG.rimHi - uBG.rimLo), 0.0, 1.0);
    float lum = clamp(dot(rgb, LUMA709), 0.0, 1.0);
    float e = uBG.specScaleBias.x * lum + uBG.specScaleBias.y;
    e = e * e * rim; e = e * e * uBG.rimStrength;
    mainc = vec4(mix(rgb, rgbR, clamp(e, 0.0, 1.0)), 1.0);
  }
  vec4 o = mix(tint, mainc, cov);
  if (uBG.fadeAmount > 0.0) {
    float f = uBG.fadeLo > d ? 1.0 : (uBG.fadeHi < d ? 0.0 : 1.0 - (d - uBG.fadeLo) / (uBG.fadeHi - uBG.fadeLo));
    float sa = clamp(o.a, 0.0, 1.0);
    o = mix(o, vec4(uBG.fadeScale * o.rgb * sa / max(o.a, EPS), sa), f * uBG.fadeAmount);
  }
  if (uBG.hdrClampMax > 0.0) {
    float a = o.a;
    vec3 up = o.rgb / max(a, EPS);
    if (uBG.premulClamp > 0.0) {
      float m = max(max(up.r, up.g), up.b);
      if (m > uBG.hdrClampMax) up *= uBG.hdrClampMax / m;
    } else up = clamp(up, -0.75, uBG.hdrClampMax);
    o = vec4(up * a, a);
  }
  o.rgb *= globalAlpha;
  return o;
}

vec4 glassForeground(vec2 uv0, vec2 q){
  vec4 t = sdfTex(q);
  float d = t.x;
  float cov = clamp(0.5 - d / max(fwidth(d), EPSAA), 0.0, 1.0);
  if (t.a < 0.001) return vec4(0.0);
  vec2 n = t.yz;
  vec2 dirA = uFG.gradTransform * vec2(dot(n, vec2(uFG.dirScaleU1, -uFG.dirScaleV1)),
                                       dot(n, vec2(uFG.dirScaleV1,  uFG.dirScaleU1)));
  vec2 dirB = uFG.gradTransform * vec2(dot(n, vec2(uFG.dirScaleU, -uFG.dirScaleV)),
                                       dot(n, vec2(uFG.dirScaleV,  uFG.dirScaleU)));
  vec2 base = uv0 + edgeOffset(d, uFG.rimBase1, uFG.rimEdge1, uFG.rimAmount1) * dirA;
  vec2 stp  = edgeOffset(d, uFG.rimBase2, uFG.rimEdge2, uFG.rimAmount2) * dirB;
  vec4 acc = vec4(0.0);
  float k = 1.0;
  for (int i = 0; i < 3; i++) {
    vec4 s = smp(base + k * stp, 0.0);
    vec2 rg = s.rg / max(s.a, EPS);
    acc.x += rg.x * k; acc.y += rg.y * (1.0 - k); acc.a += s.a; k -= 1.0 / 3.0;
  }
  k = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 s = smp(base - k * stp, 0.0);
    vec2 gb = s.gb / max(s.a, EPS);
    acc.y += gb.x * (1.0 - k); acc.z += gb.y * k; acc.a += s.a; k += 1.0 / 3.0;
  }
  float a = acc.a * (1.0 / 7.0);
  float glow = a * a * cov * globalAlpha;
  vec3 rgb = acc.rgb * vec3(0.5, 1.0 / 3.0, 0.5) * glow;
  float fall = 1.0 - mix(uFG.intensityLo, uFG.intensityHi,
      clamp((d - uFG.fadeLo) / (uFG.fadeHi - uFG.fadeLo), 0.0, 1.0));
  return vec4(rgb, glow) * fall;
}

void main(){
  vec2 px = gl_FragCoord.xy, uv0 = px / uRes;
  vec2 q = (px - uCenter) / uDpr;
  vec3 c = smp(uv0, 0.0).rgb;
  c *= 1.0 - uShadow * exp(-0.5 * pow(max(sdf(q - uShOff), 0.0) / max(uShRad, 0.5), 2.0));
  vec4 bg = glassBackground(uv0, q);
  c = bg.rgb + c * (1.0 - bg.a);
  if (uFgOn) { vec4 fg = glassForeground(uv0, q); c = fg.rgb + c * (1.0 - fg.a); }
  frag = vec4(c, 1.0);
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
const pCover = program(COVER_FS), pBlur = program(BLUR_FS), pGlass = program(GLASS_FS), pQC = program(QC_FS);

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

const back = { t: tex(), f: gl.createFramebuffer(), w: 0, h: 0, dirty: true };
function ensureBack(W, H, cover){
  if (back.w !== W || back.h !== H) {
    back.w = W; back.h = H; back.dirty = true;
    gl.bindTexture(gl.TEXTURE_2D, back.t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, back.f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, back.t, 0);
  }
  if (!back.dirty) return;
  back.dirty = false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, back.f);
  gl.viewport(0, 0, W, H);
  gl.useProgram(pCover.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, imgTex);
  gl.uniform1i(pCover.u.uImg, 0);
  gl.uniform2f(pCover.u.uRes, W, H);
  gl.uniform2f(pCover.u.uCover, cover[0], cover[1]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, back.t);
  gl.generateMipmap(gl.TEXTURE_2D);
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
    back.dirty = true;
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
  qc: false,
  qAngle: 0, qAmount: 30, qHeight: 20, qAmount2: 15, qHeight2: 10, qMix: 0.5, qBlur: 4,
  qRimAmount: 8, qRimHeight: 3, qRimBlur: 1, qRimStrength: 6, qRimBright: 1.3, qSpec: 0.75,
  qSat: 1, qFaceBright: 1,
  qFgOn: true, qFgStep: 3, qFgHeight: 20, qFgStrength: 1,
};
// Values recovered from QuartzCore (+defaultValues / GlassBackgroundFilter::render):
// displacement height 20 + curvature 1, refraction height 30, highlight
// angle pi/2 spread pi amount 0.5, key/fill amounts 0.5, shadow radius 10 offset {0,-10}.
// Continuous (squircle) corners are what CALayer uses for glass.
const MACOS = {
  squircle: true, band: 20, refract: 30, curv: 1,
  light: 90, spread: 180, hlAmt: 0.5, fill: 0.5,
  shRad: 10, shOffX: 0, shOffY: -10,
  qAngle: 0, qHeight: 20, qAmount: 30, qSpec: 0.75,
};
const state = Object.assign({}, DEFAULTS);
const pos = { x: 0, y: 0 }, target = { x: 0, y: 0 };   // CSS px, y down

const analytic = () => !state.qc, quartz = () => state.qc;
const SCHEMA = [
  ['Shape'],
  ['w', 'Width', 40, 1200, 1],
  ['h', 'Height', 40, 900, 1],
  ['radius', 'Corner radius', 0, 450, 1],
  ['squircle', 'Squircle', 'toggle'],
  ['exp', 'Corner smoothing', 2, 10, 0.1, () => state.squircle],
  ['follow', 'Follow cursor', 'toggle'],
  ['followSpeed', 'Follow speed', 0.02, 1, 0.01, () => state.follow],
  ['Shader'],
  ['qc', 'QuartzCore port', 'toggle'],
  ['Refraction', analytic],
  ['band', 'Height', 1, 200, 0.5],
  ['refract', 'Amount', 0, 150, 0.5],
  ['curv', 'Curvature', 0, 1, 0.01],
  ['ca', 'Dispersion', 0, 0.5, 0.005],
  ['Frost', analytic],
  ['frostRadius', 'Blur radius', 0, 60, 0.5],
  ['frost', 'Amount', 0, 1, 0.01],
  ['Highlight', analytic],
  ['light', 'Angle', 0, 360, 1],
  ['spread', 'Spread', 10, 360, 1],
  ['hlAmt', 'Amount', 0, 1.5, 0.01],
  ['hlHeight', 'Height', 0.5, 60, 0.5],
  ['fill', 'Fill light', 0, 1.5, 0.01],
  ['Edge spectrum', analytic],
  ['edgeAmt', 'Amount', 0, 40, 0.5],
  ['edgeBand', 'Height', 1, 80, 0.5],
  ['Body', analytic],
  ['bright', 'Brightness', 0.5, 1.6, 0.01],
  ['tintAmt', 'Tint', 0, 1, 0.01],
  ['tint', 'Tint color', 'color'],
  ['Refraction', quartz],
  ['qAngle', 'Angle', -180, 180, 1],
  ['qAmount', 'Amount', 0, 150, 0.5],
  ['qHeight', 'Height', 1, 200, 0.5],
  ['qAmount2', 'Inner amount', 0, 150, 0.5],
  ['qHeight2', 'Inner height', 1, 200, 0.5],
  ['qMix', 'Inner mix', 0, 1, 0.01],
  ['qBlur', 'Blur (mip)', 0, 64, 0.5],
  ['Rim', quartz],
  ['qRimAmount', 'Offset', 0, 60, 0.5],
  ['qRimHeight', 'Height', 0.5, 40, 0.5],
  ['qRimBlur', 'Blur (mip)', 0, 32, 0.5],
  ['qRimStrength', 'Strength', 0, 40, 0.1],
  ['qRimBright', 'Brightness', 0.5, 3, 0.01],
  ['qSpec', 'Specular gain', 0, 2, 0.01],
  ['Grade', quartz],
  ['qSat', 'Saturation', 0, 2, 0.01],
  ['qFaceBright', 'Brightness', 0.5, 1.6, 0.01],
  ['Edge spectrum', quartz],
  ['qFgOn', 'Foreground pass', 'toggle'],
  ['qFgStep', 'Step', 0, 40, 0.5, () => state.qFgOn],
  ['qFgHeight', 'Height', 1, 80, 0.5, () => state.qFgOn],
  ['qFgStrength', 'Strength', 0, 1, 0.01, () => state.qFgOn],
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
let groupVis = null;
for (const item of SCHEMA) {
  if (item.length <= 2) {
    const g = el('div', 'group', item[0]);
    body.appendChild(g);
    groupVis = item[1] || null;
    if (groupVis) controls.push({ row: g, visible: groupVis, sync(){} });
    continue;
  }
  const [k, label, a, b, step, own] = item;
  const gv = groupVis;
  const visible = gv || own ? () => (!gv || gv()) && (!own || own()) : null;
  if (a === 'toggle') {
    const row = el('div', 'btns'), btn = el('button');
    row.appendChild(btn); body.appendChild(row);
    btn.onclick = () => { state[k] = !state[k]; sync(); };
    controls.push({ k, row, visible, sync: () => { btn.textContent = `${label}: ${state[k] ? 'on' : 'off'}`; btn.classList.toggle('on', state[k]); } });
    continue;
  }
  const row = el('div', 'row'), top = el('div', 'top'), val = el('span', 'val');
  top.append(el('span', '', label), val); row.appendChild(top);
  const input = el('input');
  if (a === 'color') {
    input.type = 'color';
    input.oninput = () => { state[k] = input.value; };
    controls.push({ k, row, visible, sync: () => { input.value = state[k]; } });
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
  const frostOn = !state.qc && state.frost > 0 && sigma >= 0.5;
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

  if (state.qc) { drawQC(W, H, cover); requestAnimationFrame(frame); return; }
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
function drawQC(W, H, cover){
  ensureBack(W, H, cover);
  gl.viewport(0, 0, W, H);
  const { p, u } = pQC;
  gl.useProgram(p);
  const f = (n, ...v) => u[n] && gl['uniform' + v.length + 'f'](u[n], ...v);
  const m3 = (n, a) => u[n] && gl.uniformMatrix3fv(u[n], false, a);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, back.t);
  gl.uniform1i(u.srcTex, 0);
  f('uRes', W, H); f('uDpr', dpr); f('uCenter', pos.x * dpr, H - pos.y * dpr);
  const hw = state.w / 2, hh = state.h / 2;
  f('uHalf', hw, hh); f('uRadius', Math.min(state.radius, hw, hh)); f('uExp', state.squircle ? state.exp : 2);
  f('uShadow', state.shadow); f('uShRad', state.shRad); f('uShOff', state.shOffX, state.shOffY);
  f('globalAlpha', 1);
  gl.uniform1i(u.uFgOn, state.qFgOn ? 1 : 0);

  // pt -> uv; the displacement angle rotates the gradient.
  const sx = dpr / W, sy = dpr / H, a = state.qAngle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  gl.uniformMatrix2fv(u['uBG.gradTransform'], false, [sx * c, sy * s, -sx * s, sy * c]);
  gl.uniformMatrix2fv(u['uFG.gradTransform'], false, [sx, 0, 0, sy]);
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const L = [0.2125, 0.7154, 0.0721], sat = state.qSat, br = state.qFaceBright, face = [];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++)
    face.push(br * ((1 - sat) * L[col] + (row === col ? sat : 0)));
  const rb = state.qRimBright;
  f('uBG.caAmount1', state.qAmount); f('uBG.caEdge1', 1 / state.qHeight);
  f('uBG.caAmount2', state.qAmount2); f('uBG.caEdge2', 1 / state.qHeight2);
  f('uBG.caMixLo', -11); f('uBG.caMixHi', -3); f('uBG.caMixAmount', state.qMix);
  f('uBG.mipLodScale1', state.qBlur); f('uBG.mipLodScale3', state.qRimBlur); f('uBG.blurMip', state.qBlur);
  f('uBG.rimAmount', state.qRimAmount); f('uBG.rimEdge', 1 / state.qRimHeight);
  f('uBG.rimLo', -state.qRimHeight); f('uBG.rimHi', 0); f('uBG.rimStrength', state.qRimStrength);
  f('uBG.lensAmount', state.qAmount); f('uBG.lensEdge', 1 / state.qHeight); f('uBG.lensBase', 0);
  f('uBG.lensScale', 1); f('uBG.profileScale', 1); f('uBG.bleedUV', 0, 0);
  m3('uBG.faceM', face); f('uBG.faceBias', 0, 0, 0);
  f('uBG.mat2Amount', sat !== 1 || br !== 1 ? 1 : 0);
  m3('uBG.rimM', [rb, 0, 0, 0, rb, 0, 0, 0, rb]); f('uBG.rimBias', 0, 0, 0);
  m3('uBG.tintM', I); f('uBG.tintBias', 0, 0, 0); f('uBG.tintAmount', 0); f('uBG.tintAlpha', 0);
  f('uBG.caLumaBias', 1); f('uBG.spec', 0.9, 0.45, 0.15); f('uBG.knots', 0, 1 / 3, 2 / 3, 1);
  f('uBG.specScaleBias', state.qSpec, 0);
  f('uBG.fadeAmount', 0); f('uBG.fadeLo', -11); f('uBG.fadeHi', -3); f('uBG.fadeScale', 1);
  f('uBG.hdrClampMax', 0); f('uBG.premulClamp', 0); f('uBG.chromaEnable', 1);

  f('uFG.rimAmount1', state.qAmount); f('uFG.rimEdge1', 1 / state.qHeight); f('uFG.rimBase1', 0);
  f('uFG.rimAmount2', state.qFgStep); f('uFG.rimEdge2', 1 / state.qFgHeight); f('uFG.rimBase2', 0);
  f('uFG.dirScaleU', c); f('uFG.dirScaleV', s); f('uFG.dirScaleU1', c); f('uFG.dirScaleV1', s);
  f('uFG.fadeLo', -11); f('uFG.fadeHi', -3);
  f('uFG.intensityLo', 1); f('uFG.intensityHi', 1 - state.qFgStrength);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

loadWall(wallIdx);
requestAnimationFrame(frame);
})();
