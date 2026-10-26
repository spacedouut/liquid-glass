# Liquid Glass playground

A WebGL2 take on the macOS 26 Liquid Glass material, over Apple's own wallpapers.

The shape is an analytic rounded rect (or squircle, for continuous corners).
The shader is `glass_background_lpf` and `glass_foreground_lpf` from
QuartzCore's `default.metallib`, transcribed line for line (mip-biased
dispersion taps A/B, spectral knot remap, face/rim color matrices, luma
specular, fade/HDR clamp, then the 7-tap foreground walk), composited
premultiplied like CA does. The only stand-in is the SDF texture, evaluated
analytically. Things that made the first port look bad, now fixed:

- amounts were pre-divided into uv, but the shader adds them to the SDF
  distance (`edgeOffset + d` drives the mip remap). They're in pt now, and
  `gradTransform` does the pt to uv conversion like it does in CA
- the foreground falloff window was inverted (it painted the interior, not
  the rim) and its glow came out as 7x alpha, which blew everything out white
- the CPU-baked SDF had its y gradient flipped relative to the backdrop uvs

The uniforms now come from macOS 26.6 itself: the formulas from
`CA::OGL::GlassBackgroundFilter::render`, and the inputs AppKit sets on a live
`NSGlassEffectView` (regular and clear, light and dark, focused and
unfocused, swept over sizes). "Clear glass" switches
between the two recipes, and the sliders are the real CAFilter inputs. A few
things that turned out different from the old guesses:

- the "knots" are BlurDistance0..3 and the "spectral weights" are the deltas
  between BlurOpacity0..3, so the remap just scales the blur radius by an
  opacity curve. It dips a bit near the edge but never reaches 0, so the rim
  stays blurred
- blur radii are `1.6 x input x backing scale`, in pixels
- no standard glass on macOS 26 creates a `glassForeground` filter, so the
  foreground pass is off by default. When it does run, it reads level 0 of its
  input
- the face/bleed/shadow color matrices are `set_ycc_composite` (luma remap
  into [black, white], saturate, composite under the fill), rebuilt in `ycc()`

- most amounts scale with the glass's short side S in pt. Outer refraction
  is 0.2 S over 0.125 S, `BlurDistance0` is -0.5 S, bleed is 0.35 S with a
  min(0.7 S, 160) blur, and the shadow height is 0.4 S. Under S = 160 the blur
  radius shrinks, the bleed fades out and the shadow gets darker. `qcRecipe()`
  rebuilds all of it, and "Size-driven amounts" reapplies it when you resize
- dark mode changes colors plus the bleed/shadow opacities and `inputClamp`.
  Clear glass is the same in light and dark
- System Settings' "Liquid Glass" option (`NSGlassDiffusionSetting`) only
  deepens the regular-style face matrix: tinted light is black 0.25, sat 2,
  white fill 0.8; tinted dark is white 0.75, sat 2, black fill 0.6. "Tinted"
  toggles it, and it does nothing on clear glass
- `inputClamp` is 1.06961 for regular light, 1.0 for regular dark and 1.375824
  for clear, applied per channel (`ClampPreserveHue` is off)
- the backdrop is captured at 1/4 resolution for regular and 1/2 for clear
  (`CABackdropLayer.scale`), so the mip lod never goes below that level
- an unfocused window gets a flat recipe with no outer refraction, bleed,
  shadow or SDR holding tone. "Window focused" toggles it

AppKit doesn't change the math between any of these, only the inputs.

`css.html` is the same recipe done with CSS and SVG filters, no WebGL: one
`filter: url(#lg)` chain doing blur, `feDisplacementMap` for the refraction
(map baked from the same SDF/`edgeOffset`), the face matrix as
`feColorMatrix`, and the luma-gated bleed as gamma + arithmetic composites.
It gets surprisingly close. What it can't do: a per-pixel mip lod (it blends
two gaussians by a mask instead), the 8-bit displacement map steps a little
at the rim, the vibrant shadow is a plain `box-shadow`, and since browsers
don't take SVG filters in `backdrop-filter`, the glass carries its own copy
of the wallpaper, so it only works over a static background.

All lengths are in points. "macOS" applies the recovered values: displacement
height 20, curvature 1, refraction 30, highlight angle 90° / spread 180° /
amount 0.5, fill 0.5, shadow radius 10 at {0, -10}. "Reset" goes back to the
playground defaults.

Following the cursor uses the spring SwiftUI uses for drags (`.interactiveSpring()`,
response 0.15 s, damping 0.85). Turn "Follow cursor" off to drag the glass
around, or click to drop it somewhere.
H hides the panel, and clicking the title collapses it. "Copy JSON" exports
the current params.

Wallpapers (Big Sur through Golden Gate) are from
[512pixels' archive](https://512pixels.net/projects/default-mac-wallpapers-in-5k/).

Static site: serve the directory, or open https://spacedouut.github.io/liquid-glass/.
