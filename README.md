# Liquid Glass playground

The real macOS 26 "Liquid Glass" material shaders, recovered from
`QuartzCore.framework/.../default.metallib` (`glass_background_lpf` +
`glass_foreground_lpf`), ported to GLSL ES 3.00 and running in WebGL2.

- The shape follows your cursor with eased motion ("Follow speed" slider)
- Analytic SDF in two modes — squircle (exponent/aspect/size) or rounded rect
  (width/height/corner radius) — with band-local refraction, per-channel
  chromatic aberration, a real separable gaussian-blur pass on the backdrop
  (amount + radius sliders), directional rim highlight + counter light, and a
  soft drop shadow
- "macOS" button applies the values recovered from QuartzCore
  (20 pt refraction band, curvature=1, highlight angle π/2 / spread π /
  amount 0.5, shadow r=10 off={0,-10}); "Reset" restores playground defaults
- "Wallpaper" cycles Apple defaults (Big Sur → Golden Gate), courtesy of
  [512pixels' archive](https://512pixels.net/projects/default-mac-wallpapers-in-5k/)
- "Copy JSON" exports the current params; H hides the panel

Static site — open `index.html` or serve the directory. Built by Devin
from dyld-cache RE; see the QuartzCore_shaders.ll provenance notes in the
original research session.
