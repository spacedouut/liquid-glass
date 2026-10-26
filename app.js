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
const DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcRes;
out vec4 O;
const float T = 1.619, WC = 0.7054, WS = 0.1473;
void main(){
  vec2 h = T / uSrcRes, uv = gl_FragCoord.xy * 2.0 / uSrcRes;
  vec4 c = texture(uSrc, uv) * (WC * WC)
         + (texture(uSrc, uv + vec2(-h.x, 0.0)) + texture(uSrc, uv + vec2(h.x, 0.0))
         +  texture(uSrc, uv + vec2(0.0, -h.y)) + texture(uSrc, uv + vec2(0.0, h.y))) * (WC * WS)
         + (texture(uSrc, uv + vec2(-h.x, -h.y)) + texture(uSrc, uv + vec2(-h.x, h.y))
         +  texture(uSrc, uv + vec2( h.x, -h.y)) + texture(uSrc, uv + vec2( h.x, h.y))) * (WS * WS);
  O = c;
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
uniform float uMinLod, uMaxLod;
uniform vec2  uRes, uCenter;
uniform float uDpr;
uniform float uShadow, uShRad;
uniform vec2  uShOff;
// Sibling CASDFLayer rim highlight (CASDFKeyFillHighlightEffect): it is NOT
// part of glass_background_lpf — CA draws it in a separate layer on top.
uniform float uRimHl, uRimHlH, uRimHlCurv, uRimHlSpread;
uniform vec2  uRimHlKey, uRimHlFill;
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
// Reading a coarse mip with plain bilinear shows the level's texel grid once
// it's magnified 4x+ (the "pixelated" blur). Levels >= 1 go through a cubic
// B-spline reconstruction instead (4 bilinear taps, Sigg & Hadwiger), and the
// two bracketing levels are mixed by hand since textureLod can't do that.
vec4 smpLevel(vec2 uv, float lvl){
  if (lvl < 0.5) return textureLod(srcTex, uv, 0.0);
  vec2 res = vec2(textureSize(srcTex, int(lvl)));
  vec2 p = uv * res - 0.5, f = fract(p), i = p - f;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 s0 = w0 + w1, s1 = 1.0 - s0;
  vec2 t0 = (i - 0.5 + w1 / s0) / res, t1 = (i + 1.5 + w3 / s1) / res;
  return (textureLod(srcTex, t0, lvl) * s0.x + textureLod(srcTex, vec2(t1.x, t0.y), lvl) * s1.x) * s0.y
       + (textureLod(srcTex, vec2(t0.x, t1.y), lvl) * s0.x + textureLod(srcTex, t1, lvl) * s1.x) * s1.y;
}
vec4 smp(vec2 uv, float lod){
  lod = clamp(lod, 0.0, uMaxLod);
  float l0 = floor(lod), t = lod - l0;
  vec4 a = smpLevel(uv, l0);
  return t > 0.0 ? mix(a, smpLevel(uv, l0 + 1.0), t) : a;
}
// Glass reads: the backdrop is captured at CABackdropLayer.scale, so nothing
// finer than that level exists under the glass.
vec4 smpG(vec2 uv, float lod){ return smp(uv, max(lod, uMinLod)); }

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
      vec3 rgb = killTiny(unPremul(smpG(uvLens, mipLod(uBG.blurMip))));
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
      // dist2 == dist3 in the real recipe: that segment is 0/0, which Metal's
      // fast saturate turns into 0. GLSL clamp(NaN) is undefined, so guard it.
      vec3 lo = uBG.knots.xyz, hi = uBG.knots.yzw, seg = vec3(notEqual(hi, lo));
      float eA = edgeOffset(d, 0.0, uBG.caEdge1, uBG.caAmount1);
      vec3 spA = seg * clamp((vec3(eA + d) - lo) / (hi - lo + 1.0 - seg), 0.0, 1.0);
      float lodA = (uBG.caLumaBias - dot(spA, uBG.spec)) * uBG.mipLodScale1;
      vec4 sA = smpG(uv0 + eA * grad, mipLod(lodA));
      sA = vec4(killTiny(sA.rgb), sA.a);
      if (uBG.caMixAmount > 0.0) {
        float eB = edgeOffset(d, 0.0, uBG.caEdge2, uBG.caAmount2);
        vec3 spB = seg * clamp((vec3(eB + d) - lo) / (hi - lo + 1.0 - seg), 0.0, 1.0);
        float lodB = (uBG.caLumaBias - dot(spB, uBG.spec)) * uBG.mipLodScale1;
        vec4 sB = smpG(uv0 + eB * grad, mipLod(lodB));
        sB = vec4(killTiny(sB.rgb), sB.a);
        float k = uBG.caMixAmount * clamp((d - uBG.caMixLo) / (uBG.caMixHi - uBG.caMixLo), 0.0, 1.0);
        s = mix(sA, sB, k);
      } else s = sA;
    } else {
      s = smpG(uv0, mipLod(uBG.mipLodScale1));
    }
    vec3 rgb = unPremul(s);
    if (uBG.mat2Amount > 0.0)
      rgb = mix(rgb, uBG.faceM * rgb + uBG.faceBias, uBG.mat2Amount);
    vec2 uvRim = uv0 + edgeOffset(d, 0.0, uBG.rimEdge, uBG.rimAmount) * grad;
    vec3 rgbR = uBG.rimM * killTiny(unPremul(smpG(uvRim, mipLod(uBG.mipLodScale3)))) + uBG.rimBias;
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
  // CA binds the fg source with mipmapping off and no lod: always level 0.
  float k = 1.0;
  for (int i = 0; i < 3; i++) {
    vec4 s = textureLod(srcTex, base + k * stp, 0.0);
    vec2 rg = s.rg / max(s.a, EPS);
    acc.x += rg.x * k; acc.y += rg.y * (1.0 - k); acc.a += s.a; k -= 1.0 / 3.0;
  }
  k = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 s = textureLod(srcTex, base - k * stp, 0.0);
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
  // Rim highlight: a crisp 1-2px white line just inside the edge, two 160 deg
  // cones (key at -45 deg lighting the down-right rim, fill at +135 deg
  // up-left), heights 1pt, curvature 0.7. vibrantColorMatrix keeps it white.
  if (uRimHl > 0.0) {
    vec4 th = sdfTex(q);
    float sh = clamp(-th.x / max(uRimHlH, 1e-3), 0.0, 1.0);
    float band = (1.0 - mix(sh, sqrt(sh * (2.0 - sh)), uRimHlCurv)) * step(th.x, 0.0);
    float half_ = 0.5 * uRimHlSpread;
    float key = max(cos(min(acos(clamp(dot(th.yz, uRimHlKey), -1.0, 1.0)) / half_, 1.0) * 1.5707963), 0.0);
    float fil = max(cos(min(acos(clamp(dot(th.yz, uRimHlFill), -1.0, 1.0)) / half_, 1.0) * 1.5707963), 0.0);
    c = mix(c, vec3(1.0), clamp(band * uRimHl * 0.5 * (key + fil), 0.0, 1.0));
  }
  // Dither: RGBA8 banding shows on smooth gradients otherwise.
  c += (fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
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
const pCover = program(COVER_FS), pDown = program(DOWN_FS), pQC = program(QC_FS);

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
// Screen-space backdrop the QC shaders sample: a real mip chain (immutable
// storage), each level rendered with DOWN_FS rather than generateMipmap so
// the pyramid is properly band-limited.
const back = { t: tex(), f: gl.createFramebuffer(), w: 0, h: 0, levels: 1, dirty: true };
// fp16 keeps the pyramid from banding on smooth gradients (8-bit mips read as
// blocky when magnified); RGBA8 fallback where color-buffer-float is missing.
const backFmt = gl.getExtension('EXT_color_buffer_float') ? gl.RGBA16F : gl.RGBA8;
function ensureBack(W, H, cover){
  if (back.w !== W || back.h !== H) {
    back.w = W; back.h = H; back.dirty = true;
    back.levels = Math.floor(Math.log2(Math.max(W, H))) + 1;
    // texStorage2D is one-shot per texture object: resize = fresh texture.
    // The FBO keeps the old one alive until the loop reattaches each level.
    gl.deleteTexture(back.t);
    back.t = tex();
    gl.bindTexture(gl.TEXTURE_2D, back.t);
    gl.texStorage2D(gl.TEXTURE_2D, back.levels, backFmt, W, H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }
  if (!back.dirty) return;
  back.dirty = false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, back.f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, back.t, 0);
  gl.viewport(0, 0, W, H);
  gl.useProgram(pCover.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, imgTex);
  gl.uniform1i(pCover.u.uImg, 0);
  gl.uniform2f(pCover.u.uRes, W, H);
  gl.uniform2f(pCover.u.uCover, cover[0], cover[1]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Fill each mip level from the previous one. Narrowing BASE/MAX_LEVEL to the
  // source level keeps this legal (no feedback loop) while reusing one texture.
  gl.bindTexture(gl.TEXTURE_2D, back.t);
  gl.useProgram(pDown.p);
  gl.uniform1i(pDown.u.uSrc, 0);
  let sw = W, sh = H;
  for (let i = 1; i < back.levels; i++) {
    const w = Math.max(1, W >> i), h = Math.max(1, H >> i);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, i - 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, i - 1);
    gl.uniform2f(pDown.u.uSrcRes, sw, sh);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, back.t, i);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    sw = w; sh = h;
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, back.levels - 1);
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
    back.dirty = true;
  };
  img.src = `wallpapers/${WALLS[i]}.jpg`;
}

// ---- params (pt / degrees) ---------------------------------------------------
const DEFAULTS = {
  w: 360, h: 220, radius: 56, squircle: true, exp: 5,
  follow: true, followResponse: 0.15, followDamping: 0.85,
  qAngle: 0, qDark: false, qRimHl: true, qFgOn: false, qFgStep: 3, qFgHeight: 20, qFgStrength: 1,
};
// glassBackground inputs AppKit sets on NSGlassEffectView (macOS 26.6), read live
// off the CABackdropLayer's CAFilter in a key titled window. Most amounts scale
// with the glass's short side S in pt. Under S = 160 the blur shrinks, the bleed
// fades out and the shadow gets darker. Dark mode only changes colors, and clear
// glass is the same in light and dark. An unfocused window gets a flat recipe
// with no outer refraction, bleed or shadow. Color matrices are
// [black, white, saturation(, fill alpha)] fed through set_ycc_composite.
const clamp01 = v => Math.min(Math.max(v, 0), 1);
function qcRecipe(S, clear, dark, active){
  const t = clamp01((S - 64) / 96), small = clamp01((160 - S) / 112);
  const r = {
    qClear: clear, qDark: dark, qActive: active,
    qInnerAmount: -60, qInnerHeight: 20,
    qOuterAmount: 0.2 * S, qOuterHeight: 0.125 * S, qRefrOpacity: clear ? 0 : 0.3,
    qBlur: clear ? 1 : Math.min(Math.max(4 - (160 - S) / 42, 4 / 3), 4),
    blurDist: [-0.5 * S, -1, 0, 0], qBlurOpacity: [1, 0.5, 0.5, 1],
    qBleedAmount: clear ? 0 : 0.35 * S, qBleedHeight: clear ? 0 : 0.35 * S,
    qBleedBlur: clear || t === 0 ? 0 : Math.min(0.7 * S, 160),
    qBleedOpacity: clear ? 0 : (dark ? 0.8 : 0.5) * t, qBleedDarken: dark ? 0 : 1,
    qShadowOpacity: clear ? 0 : 0.25 + (dark ? 0.15 : 0.25) * small,
    qShadowBlur: clear ? 0 : 40, qShadowHeight: 0.4 * S, qShadowVibrancy: clear ? 0 : t,
    qSdrHold: 1, qClamp: clear ? 1.375824 : dark ? 1 : 1.06961,
    qCaptureScale: clear ? 0.5 : 0.25,   // CABackdropLayer.scale
  };
  if (clear) Object.assign(r, { qFaceBlack: 0.075, qFaceWhite: 1.15, qFaceSat: 1.06, qFill: 0, qFillRgb: 1,
    qBleedCM: [0.75, 1, 1.2], qShadowCM: [0, 1, 1.2, 0.1] });
  else if (dark) Object.assign(r, { qFaceBlack: 0.2, qFaceWhite: 0.6, qFaceSat: 1, qFill: 0.4, qFillRgb: 0,
    qBleedCM: [0, 0.5, 1], qShadowCM: [0, 0.5, 1, 0] });
  else Object.assign(r, { qFaceBlack: S < 64 ? 0.85 : 0.5, qFaceWhite: 1.03, qFaceSat: 1,
    qFill: S < 64 ? 0.25 : 0.4, qFillRgb: 1, qBleedCM: [0.9, 1, 1.2], qShadowCM: [0, 1, 1.8, 0.12] });
  if (!active) Object.assign(r, {
    qOuterAmount: 0, qOuterHeight: 0, qRefrOpacity: 0, blurDist: [0, 0, 0, 0], qBlurOpacity: [1, 1, 1, 1],
    qBleedBlur: 0, qBleedOpacity: 0, qShadowOpacity: 0, qShadowBlur: 0, qShadowVibrancy: 0,
    qSdrHold: 0, qClamp: 1,
  }, clear ? { qBlur: 10, qFaceBlack: dark ? 0.05 : 0.2, qFaceWhite: dark ? 0.8 : 0.95, qFaceSat: 1, qFill: dark ? 0.05 : 0.1 }
           : { qFaceWhite: dark ? 0.6 : 0.95, qFill: 0.35 });
  return r;
}
// Same for every variant.
const QC_FIXED = {
  refrDist: [-1, 0], bleedDist: [1, 0],
  shadowAmount: 75, shadowRadius: 24, shadowOffset: [0, 8],
  sdrDist: [-2, -1], sdrWhite: 0.97, sdrShadowOpacity: 0.24,
};
const applyRecipe = st => Object.assign(st, qcRecipe(Math.min(st.w, st.h), st.qClear, st.qDark, st.qActive));
Object.assign(DEFAULTS, { qSized: true }, qcRecipe(Math.min(DEFAULTS.w, DEFAULTS.h), false, false, true));
// Values recovered from QuartzCore (+defaultValues / GlassBackgroundFilter::render):
// displacement height 20 + curvature 1, refraction height 30, highlight
// angle pi/2 spread pi amount 0.5, key/fill amounts 0.5, shadow radius 10 offset {0,-10}.
// Continuous (squircle) corners are what CALayer uses for glass.
const MACOS = { squircle: true, qAngle: 0 };
const state = Object.assign({}, DEFAULTS);
// ?key=value overrides for any param (e.g. ?qDark=1&follow=0) — handy for testing.
// qClear/qDark/qActive/w/h pick the recipe first, then the remaining overrides apply.
const params = new URLSearchParams(location.search);
const applyParams = () => { for (const [k, v] of params)
  if (k in state) state[k] = typeof state[k] === 'boolean' ? v === 'true' || v === '1' : isNaN(+v) ? v : +v; };
applyParams(); applyRecipe(state); applyParams();
const pos = { x: 0, y: 0 }, target = { x: 0, y: 0 }, vel = { x: 0, y: 0 };   // CSS px, y down

const SCHEMA = [
  ['Shape'],
  ['w', 'Width', 40, 1200, 1],
  ['h', 'Height', 40, 900, 1],
  ['radius', 'Corner radius', 0, 450, 1],
  ['squircle', 'Squircle', 'toggle'],
  ['exp', 'Corner smoothing', 2, 10, 0.1, () => state.squircle],
  ['follow', 'Follow cursor', 'toggle'],
  ['followResponse', 'Follow response', 0.05, 1, 0.01, () => state.follow],
  ['followDamping', 'Follow damping', 0.2, 1, 0.01, () => state.follow],
  ['Variant'],
  ['qClear', 'Clear glass', 'toggle'],
  ['qDark', 'Dark mode', 'toggle'],
  ['qRimHl', 'Rim highlight', 'toggle'],
  ['qActive', 'Window focused', 'toggle'],
  ['qSized', 'Size-driven amounts', 'toggle'],
  ['Refraction'],
  ['qAngle', 'Angle', -180, 180, 1],
  ['qInnerAmount', 'Inner amount', -150, 150, 0.5],
  ['qInnerHeight', 'Inner height', 1, 200, 0.5],
  ['qOuterAmount', 'Outer amount', -150, 150, 0.5],
  ['qOuterHeight', 'Outer height', 1, 200, 0.5],
  ['qRefrOpacity', 'Outer mix', 0, 1, 0.01],
  ['qBlur', 'Blur radius', 0, 30, 0.1],
  ['Bleed'],
  ['qBleedAmount', 'Offset', 0, 200, 0.5],
  ['qBleedHeight', 'Height', 0, 200, 0.5],
  ['qBleedBlur', 'Blur radius', 0, 300, 1],
  ['qBleedOpacity', 'Opacity', 0, 1, 0.01],
  ['Face'],
  ['qFaceBlack', 'Black', 0, 1, 0.005],
  ['qFaceWhite', 'White', 0.5, 1.5, 0.005],
  ['qFaceSat', 'Saturation', 0, 2, 0.01],
  ['qFill', 'White fill', 0, 1, 0.01],
  ['qClamp', 'Clamp', 0, 2, 0.001],
  ['Shadow'],
  ['qShadowOpacity', 'Opacity', 0, 1, 0.01],
  ['qShadowBlur', 'Blur radius', 0, 120, 1],
  ['Edge spectrum'],
  ['qFgOn', 'Foreground pass', 'toggle'],
  ['qFgStep', 'Step', 0, 40, 0.5, () => state.qFgOn],
  ['qFgHeight', 'Height', 1, 80, 0.5, () => state.qFgOn],
  ['qFgStrength', 'Strength', 0, 1, 0.01, () => state.qFgOn],
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
    btn.onclick = () => {
      state[k] = !state[k];
      if (k === 'qClear' || k === 'qDark' || k === 'qActive' || (k === 'qSized' && state.qSized)) {
        if (state[k] && (k === 'qClear' || k === 'qDark')) { state.qClear = state.qDark = false; state[k] = true; }   // variants are exclusive
        applyRecipe(state);
      }
      sync();
    };
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
    input.oninput = () => {
      state[k] = +input.value;
      if ((k === 'w' || k === 'h') && state.qSized) { applyRecipe(state); sync(); }
      else val.textContent = fmt(state[k], step);
    };
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
  mkBtn('macOS', () => { Object.assign(state, MACOS); applyRecipe(state); sync(); }),
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


// ---- frame ---------------------------------------------------------------------
let last = performance.now();
function frame(now){
  resize();
  const W = canvas.width, H = canvas.height;
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (state.follow) {
    // SwiftUI .interactiveSpring() by default (response 0.15 s, damping 0.85):
    // k = (2pi / response)^2, c = 2 damping sqrt(k), mass 1, in 1/480 s steps.
    const w0 = 2 * Math.PI / state.followResponse, k = w0 * w0, c = 2 * state.followDamping * w0;
    for (let n = Math.ceil(dt * 480), h = dt / n; n > 0; n--) {
      vel.x += (k * (target.x - pos.x) - c * vel.x) * h; vel.y += (k * (target.y - pos.y) - c * vel.y) * h;
      pos.x += vel.x * h; pos.y += vel.y * h;
    }
  } else vel.x = vel.y = 0;
  const ca = W / H;
  const cover = ca > imgAspect ? [1, imgAspect / ca] : [ca / imgAspect, 1];

  drawQC(W, H, cover);
  requestAnimationFrame(frame);
}
// CA::ColorMatrix::set_ycc_composite, closed form (probed on macOS 26.6):
// remap luma into [black, white] keeping chroma, saturate around luma, then
// composite under the premultiplied fill. Returns a column-major mat3 + bias.
function ycc(black, white, sat, fill = [0, 0, 0, 0]){
  const Y = [0.2126, 0.7152, 0.0722], k = white - black - 1, a = 1 - fill[3], m = [];
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) {
    let v = 0;   // (sat*I + (1-sat)*1Y^T) * (I + k*1Y^T)
    for (let j = 0; j < 3; j++) v += (sat * (row === j) + (1 - sat) * Y[j]) * ((j === col) + k * Y[col]);
    m.push(a * v);
  }
  return { m, b: [0, 1, 2].map(i => a * black + fill[i]) };
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
  // CASDFElementLayer's continuous corner isn't our superellipse: r56
  // continuous measures as radius*1.375 at exp 3 (0.3pt RMS fit).
  f('uHalf', hw, hh);
  f('uRadius', Math.min(state.radius * (state.squircle ? 1.375 : 1), hw, hh));
  f('uExp', state.squircle ? 3 : 2);
  f('uShadow', 0);   // the glass's own shadow term (tint) draws it
  f('globalAlpha', 1);
  gl.uniform1i(u.uFgOn, state.qFgOn ? 1 : 0);

  // pt -> uv; the displacement angle rotates the gradient.
  const sx = dpr / W, sy = dpr / H, a = state.qAngle * Math.PI / 180, ca = Math.cos(a), sn = Math.sin(a);
  gl.uniformMatrix2fv(u['uBG.gradTransform'], false, [sx * ca, sy * sn, -sx * sn, sy * ca]);
  gl.uniformMatrix2fv(u['uFG.gradTransform'], false, [sx, 0, 0, sy]);
  // Uniform formulas from CA::OGL::GlassBackgroundFilter::render. Radii are
  // 1.6 x input x S (S = backing scale = dpr); bleed/shadow radii are halved
  // and zeroed when their opacity is 0. Blur "knots" are BlurDistance0..3 and
  // "spec" is the BlurOpacity deltas, so the remap lerps an opacity curve over
  // the blur radius; it never reaches lod 0 at the rim.
  const X = QC_FIXED, S = 1.6 * dpr, inv = v => v > 0 ? 1 / v : 0, sat01 = v => Math.min(Math.max(v, 0), 1);
  const op = state.qBlurOpacity, cm = (n, c) => { m3(n + 'M', c.m); f(n + 'Bias', ...c.b); };
  f('uBG.caAmount1', state.qInnerAmount); f('uBG.caEdge1', inv(state.qInnerHeight));
  f('uBG.caAmount2', state.qOuterAmount); f('uBG.caEdge2', inv(state.qOuterHeight));
  f('uBG.caMixLo', X.refrDist[0]); f('uBG.caMixHi', X.refrDist[1]); f('uBG.caMixAmount', state.qRefrOpacity);
  f('uMaxLod', back.levels - 1);
  f('uMinLod', Math.min(Math.log2(1 / state.qCaptureScale), back.levels - 1));
  f('uBG.mipLodScale1', S * state.qBlur);
  f('uBG.mipLodScale3', state.qBleedOpacity > 0 ? S * 0.5 * state.qBleedBlur : 0);
  f('uBG.blurMip', state.qShadowOpacity > 0 ? S * 0.5 * state.qShadowBlur : 0);
  f('uBG.caLumaBias', op[0]); f('uBG.spec', op[0] - op[1], op[1] - op[2], op[2] - op[3]);
  f('uBG.knots', ...state.blurDist); f('uBG.chromaEnable', 1);
  f('uBG.rimAmount', state.qBleedAmount); f('uBG.rimEdge', inv(state.qBleedHeight));
  f('uBG.rimLo', X.bleedDist[0]); f('uBG.rimHi', X.bleedDist[1]); f('uBG.rimStrength', sat01(state.qBleedOpacity));
  f('uBG.specScaleBias', ...(state.qBleedDarken ? [1, 0] : [-1, 1]));
  const [bb, bw, bs] = state.qBleedCM, [sb, sw, ss, sa] = state.qShadowCM, fa = state.qFill, fr = state.qFillRgb * fa;
  cm('uBG.face', ycc(state.qFaceBlack, state.qFaceWhite, state.qFaceSat, [fr, fr, fr, fa]));
  f('uBG.mat2Amount', 1);
  cm('uBG.rim', ycc(bb, bw, bs));
  cm('uBG.tint', ycc(sb, sw, ss, [0, 0, 0, sa]));
  // SDR: headroom fraction h = 0, so holding tone is fully on and the SDR
  // shadow opacity adds straight onto the shadow fill alpha.
  f('uBG.tintAmount', state.qShadowVibrancy); f('uBG.tintAlpha', sa + state.qSdrHold * X.sdrShadowOpacity);
  f('uBG.lensAmount', X.shadowAmount); f('uBG.lensEdge', inv(state.qShadowHeight)); f('uBG.lensBase', 0);
  f('uBG.lensScale', sat01(state.qShadowOpacity)); f('uBG.profileScale', inv(X.shadowRadius));
  f('uBG.bleedUV', ...X.shadowOffset);   // sdfTex() takes pt, y up
  f('uBG.fadeAmount', state.qSdrHold); f('uBG.fadeLo', X.sdrDist[0]); f('uBG.fadeHi', X.sdrDist[1]); f('uBG.fadeScale', X.sdrWhite);
  f('uBG.hdrClampMax', state.qClamp); f('uBG.premulClamp', 0);   // inputClamp, ClampPreserveHue off
  // CASDFKeyFillHighlightEffect (sibling layer): key -45 deg, fill +135 deg,
  // spreads 160 deg, amounts 0.5, heights 1pt, curvature 0.7, white.
  f('uRimHl', state.qRimHl ? 1 : 0); f('uRimHlH', 1); f('uRimHlCurv', 0.7);
  f('uRimHlSpread', 160 * Math.PI / 180);
  f('uRimHlKey', Math.SQRT1_2, -Math.SQRT1_2); f('uRimHlFill', -Math.SQRT1_2, Math.SQRT1_2);

  // No standard macOS 26 glass instantiates glassForeground; these stay knobs.
  const c = 1, s = 0;
  f('uFG.rimAmount1', state.qOuterAmount); f('uFG.rimEdge1', inv(state.qOuterHeight)); f('uFG.rimBase1', 0);
  f('uFG.rimAmount2', state.qFgStep); f('uFG.rimEdge2', 1 / state.qFgHeight); f('uFG.rimBase2', 0);
  f('uFG.dirScaleU', c); f('uFG.dirScaleV', s); f('uFG.dirScaleU1', c); f('uFG.dirScaleV1', s);
  f('uFG.fadeLo', -11); f('uFG.fadeHi', -3);
  f('uFG.intensityLo', 1); f('uFG.intensityHi', 1 - state.qFgStrength);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

loadWall(wallIdx);
requestAnimationFrame(frame);
})();
