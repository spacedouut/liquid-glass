// Shader sources — GLSL port of the recovered QuartzCore Liquid Glass shaders.
// Background + foreground entry points share one source via PASS_* defines.

const VERT = `#version 300 es
layout(location=0) in vec2 pos;
out vec2 uv0;  // backdrop uv
out vec2 uv1;  // sdf uv
uniform vec4 panelRect;  // x0,y0,w,h in canvas px
uniform vec2 canvasSize;
uniform vec2 sdfPad;
void main(){
  uv0 = vec2(pos.x, 1.0-pos.y);
  vec2 fragPx = vec2(uv0.x, 1.0-uv0.y) * canvasSize;
  uv1 = (fragPx - panelRect.xy + sdfPad) / (panelRect.zw + 2.0*sdfPad);
  gl_Position = vec4(pos*2.0-1.0, 0.0, 1.0);
}`;

const COPY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D t;
in vec2 uv0; out vec4 o;
void main(){ o = texture(t, uv0); }`;

const GLASS_FRAG = `precision highp float;
layout(std140) uniform GlassBackgroundUniforms {
    vec4  gradTransform;
    float caAmount1, caEdge1;
    float caAmount2, caEdge2;
    float caMixLo, caMixHi;
    float mipLodScale1;
    float mipLodScale3;
    float rimAmount, rimEdge;
    float lensAmount, lensEdge;
    vec2  bleedUV;
    float blurMip;
    float profileScale;
    vec4  mat2r0, mat2r1, mat2r2;
    vec4  mat3r0, mat3r1, mat3r2;
    vec4  tintR0, tintR1, tintR2;
    float tintAmount;
    float tintAlpha;
    float caLumaBias;
    float spec0, spec1, spec2;
    float knot0, knot1, knot2, knot3;
    float rimLo, rimHi;
    float rimStrength;
    float mat2Amount;
    vec2  specScaleBias;
    float lensBase;
    float lensScale;
    float caMixAmount;
    float fadeAmount;
    float fadeLo, fadeHi;
    float hdrClampMax;
    float premulClamp;
    float fadeScale;
    float _f49;
    float chromaEnable;
    float _f51, _f52, _f53;
} uBG;
layout(std140) uniform GlassForegroundUniforms {
    vec4  gradTransform;
    float rimAmount1, rimEdge1, rimBase1;
    float rimAmount2, rimEdge2, rimBase2;
    float dirScaleU, dirScaleV;
    float fadeLo, fadeHi;
    float intensityLo, intensityHi;
    float dirScaleU1, dirScaleV1;
} uFG;
uniform sampler2D srcTex;
uniform sampler2D sdfTex;
uniform float globalAlpha;
in vec2 uv0;
in vec2 uv1;
out vec4 frag;
const float EPS=1e-6, EPSAA=1e-4;
const vec3 LUMA709=vec3(0.2125,0.7154,0.0721);
float edgeOffset(float d,float base,float edge,float amount){
  float s=clamp(edge*-(base+d),0.0,1.0);
  return amount-amount*clamp(sqrt(s*(2.0-s)),0.0,1.0);
}
float mipLod(float t){return max(0.0,log2(t<2.0?t*0.5+1.0:t));}
vec3 unPremul(vec4 c){return c.rgb/max(c.a,EPS);}
vec3 killTiny(vec3 c){return c*step(vec3(EPS),abs(c));}
vec3 matBias3(vec4 r0,vec4 r1,vec4 r2){return vec3(r0.a,r1.a,r2.a);}
float lensProfile(float x){
  float p=clamp(x*0.25+0.5,0.0,1.0);
  float q=p*4.0-2.0,q2=q*q;
  float r=0.002954*q2-0.034454;
  r=r*q2+0.168213; r=r*q2-0.560547; r=r*q+0.5;
  return r;
}
#ifdef PASS_BACKGROUND
void main(){
  vec4 t=texture(sdfTex,uv1);
  float d=t.x;
  float cov=clamp(0.5-d/max(fwidth(d),EPSAA),0.0,1.0)*t.a;
  vec2 resamp=vec2(0);
  if(cov<1.0)
    resamp=vec2(texture(sdfTex,uv1+uBG.bleedUV).x,texture(sdfTex,uv1+uBG.bleedUV).a);
  vec2 grad=mat2(uBG.gradTransform.xy,uBG.gradTransform.zw)*t.yz;
  vec4 tint=vec4(0);
  if(cov<1.0){
    vec2 uvLens=uv0+edgeOffset(d,uBG.lensBase,uBG.lensEdge,uBG.lensAmount)*grad;
    float mag=uBG.lensScale*resamp.y*lensProfile(resamp.x*uBG.profileScale);
    if(mag<6.10352e-05&&cov==0.0)discard;
    if(uBG.tintAmount>EPS){
      vec4 b=textureLod(srcTex,uvLens,mipLod(uBG.blurMip));
      vec3 rgb=killTiny(unPremul(b));
      vec3 t3=mat3(uBG.tintR0.rgb,uBG.tintR1.rgb,uBG.tintR2.rgb)*rgb*uBG.tintAmount
             +matBias3(uBG.tintR0,uBG.tintR1,uBG.tintR2);
      tint=vec4(t3,mix(uBG.tintAlpha,1.0,uBG.tintAmount));
    }else{
      tint=vec4(matBias3(uBG.tintR0,uBG.tintR1,uBG.tintR2),uBG.tintAlpha);
    }
    tint*=mag;
  }
  vec4 mainc=vec4(0);
  if(cov>0.0){
    vec4 smp;
    if(uBG.chromaEnable!=0.0){
      float offA=edgeOffset(d,0.0,uBG.caEdge1,uBG.caAmount1)+d;
      vec3 lo=vec3(uBG.knot0,uBG.knot1,uBG.knot2);
      vec3 hi=vec3(uBG.knot1,uBG.knot2,uBG.knot3);
      vec3 sp=clamp(vec3(offA)*(1.0/(hi-lo))-lo/(hi-lo),0.0,1.0);
      float lumA=(uBG.caLumaBias-dot(sp,vec3(uBG.spec0,uBG.spec1,uBG.spec2)))*uBG.mipLodScale1;
      vec4 smpA=textureLod(srcTex,uv0+edgeOffset(d,0.0,uBG.caEdge1,uBG.caAmount1)*grad,mipLod(lumA));
      smpA=vec4(killTiny(smpA.rgb),smpA.a);
      if(uBG.caMixAmount>0.0){
        float offB=edgeOffset(d,0.0,uBG.caEdge2,uBG.caAmount2)+d;
        vec3 spB=clamp(vec3(offB)*(1.0/(hi-lo))-lo/(hi-lo),0.0,1.0);
        float lumB=(uBG.caLumaBias-dot(spB,vec3(uBG.spec0,uBG.spec1,uBG.spec2)))*uBG.mipLodScale1;
        vec4 smpB=textureLod(srcTex,uv0+edgeOffset(d,0.0,uBG.caEdge2,uBG.caAmount2)*grad,mipLod(lumB));
        smpB=vec4(killTiny(smpB.rgb),smpB.a);
        float kk=uBG.caMixAmount*clamp(d/(uBG.caMixHi-uBG.caMixLo)-uBG.caMixLo/(uBG.caMixHi-uBG.caMixLo),0.0,1.0);
        smp=mix(smpA,smpB,kk);
      }else smp=smpA;
    }else{
      smp=textureLod(srcTex,uv0,mipLod(uBG.mipLodScale1));
    }
    vec3 rgb=unPremul(smp);
    if(uBG.mat2Amount>0.0)
      rgb=mix(rgb,mat3(uBG.mat2r0.rgb,uBG.mat2r1.rgb,uBG.mat2r2.rgb)*rgb
              +matBias3(uBG.mat2r0,uBG.mat2r1,uBG.mat2r2),uBG.mat2Amount);
    vec2 uvRim=uv0+edgeOffset(d,0.0,uBG.rimEdge,uBG.rimAmount)*grad;
    vec4 smpR=textureLod(srcTex,uvRim,mipLod(uBG.mipLodScale3));
    vec3 rgbR=mat3(uBG.mat3r0.rgb,uBG.mat3r1.rgb,uBG.mat3r2.rgb)*killTiny(unPremul(smpR))
             +matBias3(uBG.mat3r0,uBG.mat3r1,uBG.mat3r2);
    float rim=clamp(d/(uBG.rimHi-uBG.rimLo)-uBG.rimLo/(uBG.rimHi-uBG.rimLo),0.0,1.0);
    float lum=clamp(dot(rgb,LUMA709),0.0,1.0);
    float edge=uBG.specScaleBias.x*lum+uBG.specScaleBias.y;
    edge=edge*edge*rim; edge=edge*edge*uBG.rimStrength;
    mainc=vec4(mix(rgb,rgbR,edge),1.0);
  }
  vec4 outc=mix(tint,mainc,cov);
  if(uBG.fadeAmount>0.0){
    float f=uBG.fadeLo>d?1.0:(uBG.fadeHi<d?0.0:1.0-(d-uBG.fadeLo)/(uBG.fadeHi-uBG.fadeLo));
    float sa=clamp(outc.a,0.0,1.0);
    vec3 rgb=uBG.fadeScale*outc.rgb*sa/max(outc.a,EPS);
    outc=mix(outc,vec4(rgb,sa),f*uBG.fadeAmount);
  }
  if(uBG.hdrClampMax>0.0){
    if(uBG.premulClamp>0.0){
      float a=outc.a;
      vec3 up=outc.rgb/max(a,EPS);
      float m=max(max(up.r,up.g),up.b);
      if(m>uBG.hdrClampMax)up*=uBG.hdrClampMax/m;
      outc=vec4(up*a,a);
    }else{
      float a=outc.a;
      outc=vec4(clamp(outc.rgb/max(a,EPS),-0.75,uBG.hdrClampMax)*a,a);
    }
  }
  outc.rgb*=globalAlpha;
  frag=outc;
}
#endif
#ifdef PASS_FOREGROUND
void main(){
  vec4 t=texture(sdfTex,uv1);
  float d=t.x;
  float cov=clamp(0.5-d/max(fwidth(d),EPSAA),0.0,1.0);
  if(t.a<0.001){frag=vec4(0);return;}
  vec2 n=t.yz;
  vec2 dirA=vec2(dot(n,vec2(uFG.dirScaleU1,-uFG.dirScaleV1)),
                 dot(n,vec2(uFG.dirScaleV1,uFG.dirScaleU1)));
  dirA=mat2(uFG.gradTransform.xy,uFG.gradTransform.zw)*dirA;
  vec2 dirB=vec2(dot(n,vec2(uFG.dirScaleU,-uFG.dirScaleV)),
                 dot(n,vec2(uFG.dirScaleV,uFG.dirScaleU)));
  dirB=mat2(uFG.gradTransform.xy,uFG.gradTransform.zw)*dirB;
  vec2 base=uv0+edgeOffset(d,uFG.rimBase1,uFG.rimEdge1,uFG.rimAmount1)*dirA;
  vec2 step=edgeOffset(d,uFG.rimBase2,uFG.rimEdge2,uFG.rimAmount2)*dirB;
  vec4 acc=vec4(0);
  float k=1.0;
  for(int i=0;i<3;i++){
    vec4 s=texture(srcTex,base+k*step);
    vec2 rg=s.rg/max(s.a,EPS);
    acc.x+=rg.x*k; acc.y+=rg.y*(1.0-k); acc.a+=s.a; k-=0.333333;
  }
  k=0.0;
  for(int i=0;i<4;i++){
    vec4 s=texture(srcTex,base-k*step);
    vec2 gb=s.gb/max(s.a,EPS);
    acc.y+=gb.x*(1.0-k); acc.z+=gb.y*k; acc.a+=s.a; k+=0.333333;
  }
  float glow=acc.a*(1.0/7.0)*cov*acc.a*globalAlpha;
  vec3 rgb=acc.rgb*vec3(0.5,0.333333,0.5)*glow;
  float fall=1.0-mix(uFG.intensityLo,uFG.intensityHi,
    clamp(d/(uFG.fadeHi-uFG.fadeLo)-uFG.fadeLo/(uFG.fadeHi-uFG.fadeLo),0.0,1.0));
  frag=vec4(rgb,glow)*fall;
}
#endif`;
