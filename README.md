# Liquid Glass playground

A WebGL2 take on the macOS 26 Liquid Glass material, over Apple's own wallpapers.

The shape is an analytic rounded rect (or squircle, for continuous corners).
The edge math comes from QuartzCore's `glass_background_lpf` /
`glass_foreground_lpf` in `default.metallib`:

- refraction: the backdrop is sampled outward along the SDF gradient by the
  circular-cap `edgeOffset` curve (full amount at the rim, zero at depth
  "height"), with per-channel dispersion
- frost: a real separable gaussian on the backdrop, mixed in by "Amount"
- highlight: a directional cone (angle / spread / amount) and the opposite
  fill light
- edge spectrum: the foreground pass's 7-tap walk along the normal
  (R from the outward taps, B from the inward taps)
- drop shadow

That's the default "analytic" shader: same edge math, simpler pipeline.

Flip "QuartzCore port" on for the faithful version: `glass_background_lpf` and
`glass_foreground_lpf` transcribed line for line (mip-biased dispersion taps A/B,
spectral knot remap, face/rim color matrices, luma specular, fade/HDR clamp,
then the 7-tap foreground walk), composited premultiplied like CA does. The
only stand-in is the SDF texture, evaluated analytically. Things that made the
first port look bad, now fixed:

- amounts were pre-divided into uv, but the shader adds them to the SDF
  distance (`edgeOffset + d` drives the mip remap). They're in pt now, and
  `gradTransform` does the pt to uv conversion like it does in CA
- the foreground falloff window was inverted (it painted the interior, not
  the rim) and its glow came out as 7x alpha, which blew everything out white
- the CPU-baked SDF had its y gradient flipped relative to the backdrop uvs

The uniforms now come from macOS 26.6 itself: the formulas from
`CA::OGL::GlassBackgroundFilter::render`, and the inputs AppKit sets on a live
`NSGlassEffectView` (regular and clear, light mode). "Clear glass" switches
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

Still missing: dark-mode values and the HDR clamp limit (left off).

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

Turn "Follow cursor" off to drag the glass around, or click to drop it somewhere.
H hides the panel, and clicking the title collapses it. "Copy JSON" exports
the current params.

Wallpapers (Big Sur through Golden Gate) are from
[512pixels' archive](https://512pixels.net/projects/default-mac-wallpapers-in-5k/).

Static site: serve the directory, or open https://spacedouut.github.io/liquid-glass/.
