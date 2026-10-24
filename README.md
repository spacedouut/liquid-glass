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

It's not a byte-for-byte port. Apple renders from an SDF texture with mip-biased
blur and color matrices, and this uses an analytic shape with a gaussian instead.

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
