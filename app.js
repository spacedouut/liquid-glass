// Liquid Glass playground — single-pass WebGL shader.
// Structure follows the analytic-squircle approach; the refracted backdrop is a
// mipmapped wallpaper texture, and the "macOS" preset uses values recovered
// from QuartzCore's CASDFGlass*Effect +defaultValues / filter record.
(() => {
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: true });
if (!gl) { document.body.innerHTML = 'WebGL2 required'; return; }

const vs = `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos,0.0,1.0); }`;

const BLUR_FS = `#version 300 es
precision highp float;
out vec4 O;
uniform sampler2D t;
uniform vec2 uRes;   // source res (this pass render size)
uniform vec2 uDir;   // (texelX,0) or (0,texelY) in uv
uniform float uSigma;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float w0 = 1.0, sum = w0;
  vec3 c = texture(t, uv).rgb * w0;
  for (int i = 1; i <= 8; i++) {
    float x = float(i) * uSigma;
    float w = exp(-x*x / (2.0*uSigma*uSigma));
    c += texture(t, uv + float(i)*uDir).rgb * w;
    c += texture(t, uv - float(i)*uDir).rgb * w;
    sum += 2.0*w;
  }
  O = vec4(c/sum, 1.0);
}`;

const COVER_FS = `#version 300 es
precision highp float;
out vec4 O;
uniform sampler2D t;
uniform vec2 uRes;
uniform vec2 uUvScale, uUvOff;
void main(){
  vec2 p = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  O = texture(t, vec2(0.5) + vec2(p.x*uRes.y/uRes.x, -p.y)*uUvScale + uUvOff);
}`;

const fs = `#version 300 es
precision highp float;
out vec4 O;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform sampler2D uBg;
uniform vec2  uUvScale, uUvOff;
uniform float uMaxLod;

uniform float uSize;      // half height of the shape (canvas-height units)
uniform float uAspect;    // width / height
uniform float uExp;       // squircle exponent
uniform float uBand;      // lens band width (inside depth)
uniform float uRefract;   // refraction strength
uniform float uCA;        // chromatic aberration
uniform float uLightAngle;
uniform float uRimInt;
uniform float uRimWidth;
uniform float uBackLight;
uniform float uBrighten;
uniform float uTintAmt;
uniform vec3  uTint;
uniform float uShadow;
uniform float uSpread;    // highlight cone angle, radians
uniform float uCurv;      // 0 = linear lens falloff, 1 = circular
uniform vec2  uShadowOff;
uniform float uShadowRad;
uniform float uBlur;
uniform float uShapeMode;  // 0 = squircle, 1 = rounded rect
uniform vec3  uRect;       // halfW, halfH, corner radius (canvas-height units)
uniform sampler2D uBgBlur;

vec2 bgUV(vec2 p){
  return vec2(0.5) + vec2(p.x * uRes.y / uRes.x, -p.y) * uUvScale + uUvOff;
}
vec3 scene(vec2 p, float lod){ return textureLod(uBg, bgUV(p), lod).rgb; }
vec3 scene(vec2 p){ return textureLod(uBg, bgUV(p), 0.0).rgb; }
vec3 sceneBlur(vec2 p){
  return mix(textureLod(uBg, bgUV(p), 0.0).rgb,
             textureLod(uBgBlur, bgUV(p), 0.0).rgb, uBlur);
}

float sdf(vec2 q){
  if (uShapeMode > 0.5) {
    vec2 b = vec2(uRect.x, uRect.y), r = vec2(uRect.z);
    vec2 w = abs(q) - b + r;
    return length(max(w,0.0)) + min(max(w.x,w.y),0.0) - uRect.z;
  }
  q.x /= uAspect;
  vec2 a = max(abs(q)/uSize, vec2(1e-5));
  float k = pow(pow(a.x,uExp)+pow(a.y,uExp), 1.0/uExp);
  return (k-1.0)*uSize;
}

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  vec2 q = p - uMouse;

  float d = sdf(q);
  float e = 0.0015;
  vec2 g = normalize(vec2(
      sdf(q+vec2(e,0.0))-d,
      sdf(q+vec2(0.0,e))-d
  ) + 1e-6);

  // Lens: zero in the middle, strongest at the rim.
  float inside = clamp(-d/uBand, 0.0, 1.0);
  float s = 1.0 - inside;
  float prof = mix(s, sqrt(s*(2.0-s)), uCurv);
  float amt = uRefract * prof;

  vec3 refr;
  refr.r = sceneBlur(p - g*amt*(1.0-uCA)).r;
  refr.g = sceneBlur(p - g*amt).g;
  refr.b = sceneBlur(p - g*amt*(1.0+uCA)).b;

  vec3 glass = refr * uBrighten;
  glass = mix(glass, glass*uTint, uTintAmt);

  // Directional rim light + faint counter light (highlight cone).
  vec2 L = vec2(cos(uLightAngle), sin(uLightAngle));
  float rim = exp(-abs(d+0.012)*uRimWidth);
  float angA = acos(clamp(dot(g, L),-1.0,1.0));
  float angB = acos(clamp(dot(g,-L),-1.0,1.0));
  float kk = 3.14159265/max(uSpread,0.05);
  float lit  = step(angA,0.5*uSpread)*cos(angA*kk);
  float lit2 = step(angB,0.5*uSpread)*cos(angB*kk);
  glass += vec3(1.0)*rim*(lit*uRimInt + lit2*uBackLight);

  float mask = smoothstep(fwidth(d), -fwidth(d), d);

  // Soft drop shadow outside the shape.
  vec3 bg = scene(p);
  float sh = exp(-max(sdf(q-uShadowOff),0.0)/max(uShadowRad,0.001)*2.0)*uShadow;
  bg *= 1.0 - sh;

  O = vec4(mix(bg, glass, mask), 1.0);
}`;

// ---- GL plumbing -------------------------------------------------------
function sh(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw gl.getShaderInfoLog(s);return s;}
const prog=gl.createProgram();
gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs));
gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs));
gl.linkProgram(prog);
if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw gl.getProgramInfoLog(prog);
gl.useProgram(prog);
const buf=gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER,buf);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
function mkProg(fsrc){const p=gl.createProgram();
  gl.attachShader(p,sh(gl.VERTEX_SHADER,vs));
  gl.attachShader(p,sh(gl.FRAGMENT_SHADER,fsrc));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw gl.getProgramInfoLog(p);
  return p;}
const pCover=mkProg(COVER_FS), pBlur=mkProg(BLUR_FS);
const fboTex=[gl.createTexture(),gl.createTexture()];
const fbos=[gl.createFramebuffer(),gl.createFramebuffer()];
let fboW=0,fboH=0;
function ensureFBOs(){
  const w=Math.max(1,canvas.width>>1),h=Math.max(1,canvas.height>>1);
  if(w===fboW&&h===fboH)return;
  fboW=w;fboH=h;
  for(let i=0;i<2;i++){
    gl.bindTexture(gl.TEXTURE_2D,fboTex[i]);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbos[i]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,fboTex[i],0);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
}
const U2=(p,n)=>gl.getUniformLocation(p,n);
const locB={res:U2(pBlur,'uRes'),dir:U2(pBlur,'uDir'),sig:U2(pBlur,'uSigma'),t:U2(pBlur,'t')};
const locC={res:U2(pCover,'uRes'),uvS:U2(pCover,'uUvScale'),uvO:U2(pCover,'uUvOff'),t:U2(pCover,'t')};

const U=n=>gl.getUniformLocation(prog,n);
const loc={res:U('uRes'),time:U('uTime'),mouse:U('uMouse'),bg:U('uBg'),uvS:U('uUvScale'),
  uvO:U('uUvOff'),maxLod:U('uMaxLod'),size:U('uSize'),aspect:U('uAspect'),exp:U('uExp'),
  band:U('uBand'),refract:U('uRefract'),ca:U('uCA'),light:U('uLightAngle'),
  rimInt:U('uRimInt'),rimWidth:U('uRimWidth'),backLight:U('uBackLight'),
  brighten:U('uBrighten'),tintAmt:U('uTintAmt'),tint:U('uTint'),shadow:U('uShadow'),
  spread:U('uSpread'),curv:U('uCurv'),shOff:U('uShadowOff'),shRad:U('uShadowRad'),blur:U('uBlur'),mode:U('uShapeMode'),rect:U('uRect'),bgB:U('uBgBlur')};

// ---- wallpapers ---------------------------------------------------------
const WALLS=[
  '11-Big-Sur-Day','11-Big-Sur-Night','11-Big-Sur-Color-Day','11-Big-Sur-Color-Night',
  '12-Monterey-Light','12-Monterey-Dark','13-Ventura-Light','13-Ventura-Dark',
  '14-Sonoma-Light','14-Sonoma-Dark','14-Sonoma-Horizon',
  '15-Sequoia-Light','15-Sequoia-Dark','15-Sequoia-Sunrise',
  '26-Tahoe-Light','26-Tahoe-Dark','26-Tahoe-Beach-Day','26-Tahoe-Beach-Dusk',
  '27-Golden-Gate'];
let wallIdx=14, imgAspect=1.6;
const bgTex=gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D,bgTex);
gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,
              new Uint8Array([10,12,20,255]));
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
function loadWall(i){
  const img=new Image();
  img.onload=()=>{ imgAspect=img.width/img.height;
    gl.bindTexture(gl.TEXTURE_2D,bgTex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);
    gl.generateMipmap(gl.TEXTURE_2D); };
  img.src=`wallpapers/${WALLS[i]}.jpg`;
}

// ---- params ---------------------------------------------------------------
const PT=1/900;   // 1pt ≈ 1/900 canvas height in shader units
const DEFAULTS={
  size:0.20,aspect:1.0,exp:4.0,band:0.12,refract:0.09,ca:0.06,
  light:135,rimInt:0.55,rimWidth:140,backLight:0.15,brighten:1.08,
  tintAmt:0.0,tint:'#9cc4ff',shadow:0.35,follow:0.14,blur:0.35,
  spread:180,curv:1.0,shOffX:0.014,shOffY:-0.014,shRad:0.11,
  gauss:14,rectW:0.30,rectH:0.18,rectR:0.04,shapeMode:0
};
// Recovered QuartzCore values: height=20pt band, refraction≈30pt, curvature=1,
// highlight angle=π/2 spread=π amount=0.5, shadow r=10 off={0,-10}.
const MACOS={
  band:20*PT,refract:30*PT,curv:1.0,ca:0.03,
  light:90,spread:180,rimInt:0.5,backLight:0.5,rimWidth:220,
  brighten:1.0,tintAmt:0.0,blur:0.55,
  shadow:0.6,shOffX:0,shOffY:-10*PT,shRad:20*PT
};
const state=Object.assign({},DEFAULTS);

const SCHEMA=[
  ['Shape'],
  ['size',   'Size',              0.05,0.5, 0.005],
  ['aspect', 'Aspect ratio',      0.4, 2.5, 0.01],
  ['exp',    'Squircle exponent', 2,   10,  0.05],
  ['Refraction'],
  ['refract','Refraction',        0,   0.25,0.001],
  ['band',   'Lens band width',   0.02,0.35,0.005],
  ['ca',     'Chromatic aberration',0, 0.3, 0.005],
  ['curv',   'Edge curvature',    0,   1,   0.01],
  ['blur',   'Gaussian amount',    0,   1,   0.01],
  ['gauss',  'Gaussian radius',  0,   60,  0.5],
  ['rectW',  'Rect width',        0.05,0.9, 0.005],
  ['rectH',  'Rect height',       0.05,0.9, 0.005],
  ['rectR',  'Corner radius',     0,   0.45,0.005],
  ['Light'],
  ['light',  'Light angle (deg)', 0,   360, 1],
  ['rimInt', 'Rim intensity',     0,   1.5, 0.01],
  ['rimWidth','Rim sharpness',    20,  400, 1],
  ['spread', 'Highlight spread (deg)',20,360,1],
  ['backLight','Back light',      0,   1.0, 0.01],
  ['Body'],
  ['brighten','Brightness',       0.6, 1.6, 0.01],
  ['tintAmt','Tint amount',       0,   1,   0.01],
  ['tint',   'Tint color',        'color'],
  ['shadow', 'Drop shadow',       0,   0.9, 0.01],
  ['shOffX', 'Shadow offset X',   -0.06,0.06,0.001],
  ['shOffY', 'Shadow offset Y',   -0.06,0.06,0.001],
  ['shRad',  'Shadow radius',     0.005,0.25,0.001],
  ['Motion'],
  ['follow', 'Follow speed',      0.02,1.0, 0.01],
];
const body=document.getElementById('pb');
const controls={};
const fmt=(v,st)=>Number(v).toFixed(st>=1?0:st>=0.1?1:st>=0.01?2:3);
for(const item of SCHEMA){
  if(item.length===1){const g=document.createElement('div');g.className='group';g.textContent=item[0];body.appendChild(g);continue;}
  const[k,label,a,b,c]=item;
  const row=document.createElement('div');row.className='row';
  const top=document.createElement('div');top.className='top';
  const nm=document.createElement('span');nm.textContent=label;
  const val=document.createElement('span');val.className='val';
  top.append(nm,val);row.appendChild(top);
  const input=document.createElement('input');
  if(a==='color'){input.type='color';input.value=state[k];
    input.oninput=()=>{state[k]=input.value;};}
  else{input.type='range';input.min=a;input.max=b;input.step=c;input.value=state[k];
    val.textContent=fmt(state[k],c);
    input.oninput=()=>{state[k]=+input.value;val.textContent=fmt(state[k],c);};}
  row.appendChild(input);body.appendChild(row);
  controls[k]={input,val,step:c,isColor:a==='color'};
}
const btns=document.createElement('div');btns.className='btns';
function applyState(o){Object.assign(state,o);for(const k in controls){const c=controls[k];c.input.value=state[k];if(!c.isColor)c.val.textContent=fmt(state[k],c.step);}}
const reset=document.createElement('button');reset.textContent='Reset';
reset.onclick=()=>applyState(DEFAULTS);
const mac=document.createElement('button');mac.textContent='macOS';
mac.onclick=()=>applyState(MACOS);
const copy=document.createElement('button');copy.textContent='Copy JSON';
copy.onclick=()=>{if(navigator.clipboard)navigator.clipboard.writeText(JSON.stringify(state,null,2)).catch(()=>{});
  copy.textContent='Copied';setTimeout(()=>copy.textContent='Copy JSON',1000);};
btns.append(reset,mac,copy);body.appendChild(btns);

const btns2=document.createElement('div');btns2.className='btns';
const wall=document.createElement('button');
const wallName=()=>WALLS[wallIdx].replace(/^\d+-/,'').replace(/-/g,' ');
wall.textContent='Wallpaper: '+wallName();
wall.onclick=()=>{wallIdx=(wallIdx+1)%WALLS.length;wall.textContent='Wallpaper: '+wallName();loadWall(wallIdx);};
const shapeB=document.createElement('button');
shapeB.textContent='Shape: squircle';
shapeB.onclick=()=>{state.shapeMode=state.shapeMode?0:1;shapeB.textContent='Shape: '+(state.shapeMode?'rounded rect':'squircle');shapeB.classList.toggle('on',!!state.shapeMode);};
btns2.append(wall,shapeB);body.appendChild(btns2);

document.getElementById('ph').onclick=()=>document.getElementById('panel').classList.toggle('collapsed');
addEventListener('keydown',e=>{if(e.key==='h'||e.key==='H'){const p=document.getElementById('panel');p.style.display=p.style.display==='none'?'':'none';}});

const hexToRgb=h=>{const n=parseInt(h.slice(1),16);return[(n>>16&255)/255,(n>>8&255)/255,(n&255)/255];};

// pointer tracking in shader space
let target={x:0,y:0},mouse={x:0,y:0};
const toShader=(cx,cy)=>{
  const w=canvas.width,h=canvas.height;
  const x=cx*(w/canvas.clientWidth),y=cy*(h/canvas.clientHeight);
  return{x:(x-0.5*w)/h,y:((h-y)-0.5*h)/h};
};
canvas.addEventListener('pointermove',e=>{target=toShader(e.clientX,e.clientY);});
canvas.addEventListener('pointerdown',e=>{target=toShader(e.clientX,e.clientY);});

function resize(){
  const dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.floor(canvas.clientWidth*dpr);
  canvas.height=Math.floor(canvas.clientHeight*dpr);
  gl.viewport(0,0,canvas.width,canvas.height);
}
addEventListener('resize',resize);resize();

function uvMap(){
  // cover-fit: crop whichever axis overflows
  const ca=canvas.width/canvas.height;
  if(ca>imgAspect){ // canvas wider: vertical crop
    const sy=imgAspect/ca; return{sx:1,sy,ox:0,oy:(1-sy)/2};
  }
  const sx=ca/imgAspect; return{sx,sy:1,ox:(1-sx)/2,oy:0};
}

const start=performance.now();let last=start;
function frame(now){
  const dt=Math.min((now-last)/1000,0.05);last=now;
  const k=1-Math.pow(1-state.follow,dt*60);
  mouse.x+=(target.x-mouse.x)*k;mouse.y+=(target.y-mouse.y)*k;
  const u=uvMap();
  // ---- gaussian blur passes (half res) ----
  ensureFBOs();
  gl.useProgram(pCover);
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbos[0]);
  gl.viewport(0,0,fboW,fboH);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,bgTex);
  gl.uniform1i(locC.t,0);
  gl.uniform2f(locC.res,fboW,fboH);
  gl.uniform2f(locC.uvS,u.sx,u.sy);gl.uniform2f(locC.uvO,u.ox,u.oy);
  gl.drawArrays(gl.TRIANGLES,0,3);
  const sigmaPx = Math.max(state.gauss,0.001) * (fboH/canvas.height);
  gl.useProgram(pBlur);
  gl.uniform1i(locB.t,0);
  gl.uniform2f(locB.res,fboW,fboH);
  gl.uniform1f(locB.sig,Math.max(sigmaPx,0.5));
  gl.uniform2f(locB.dir,1/fboW,0);
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbos[1]);
  gl.bindTexture(gl.TEXTURE_2D,fboTex[0]);
  gl.drawArrays(gl.TRIANGLES,0,3);
  gl.uniform2f(locB.dir,0,1/fboH);
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbos[0]);
  gl.bindTexture(gl.TEXTURE_2D,fboTex[1]);
  gl.drawArrays(gl.TRIANGLES,0,3);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.viewport(0,0,canvas.width,canvas.height);
  gl.useProgram(prog);
  gl.uniform2f(loc.res,canvas.width,canvas.height);
  gl.uniform1f(loc.time,(now-start)/1000);
  gl.uniform2f(loc.mouse,mouse.x,mouse.y);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,bgTex);
  gl.uniform1i(loc.bg,0);
  gl.uniform2f(loc.uvS,u.sx,u.sy);gl.uniform2f(loc.uvO,u.ox,u.oy);
  gl.uniform1f(loc.maxLod,8);
  gl.uniform1f(loc.size,state.size);gl.uniform1f(loc.aspect,state.aspect);
  gl.uniform1f(loc.exp,state.exp);gl.uniform1f(loc.band,state.band);
  gl.uniform1f(loc.refract,state.refract);gl.uniform1f(loc.ca,state.ca);
  gl.uniform1f(loc.light,state.light*Math.PI/180);
  gl.uniform1f(loc.rimInt,state.rimInt);gl.uniform1f(loc.rimWidth,state.rimWidth);
  gl.uniform1f(loc.backLight,state.backLight);gl.uniform1f(loc.brighten,state.brighten);
  gl.uniform1f(loc.tintAmt,state.tintAmt);gl.uniform3fv(loc.tint,hexToRgb(state.tint));
  gl.uniform1f(loc.shadow,state.shadow);
  gl.uniform1f(loc.spread,state.spread*Math.PI/180);gl.uniform1f(loc.curv,state.curv);
  gl.uniform2f(loc.shOff,state.shOffX,state.shOffY);gl.uniform1f(loc.shRad,state.shRad);
  gl.uniform1f(loc.blur,state.blur);
  gl.uniform1f(loc.mode,state.shapeMode);
  gl.uniform3f(loc.rect,state.rectW,state.rectH,state.rectR);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,fboTex[0]);
  gl.uniform1i(loc.bgB,1);
  gl.drawArrays(gl.TRIANGLES,0,3);
  requestAnimationFrame(frame);
}
loadWall(wallIdx);
requestAnimationFrame(frame);
})();
