# Liquid Glass playground

The real macOS 26 "Liquid Glass" material shaders, recovered from
`QuartzCore.framework/.../default.metallib` (`glass_background_lpf` +
`glass_foreground_lpf`), ported to GLSL ES 3.00 and running in WebGL2.

- Drag the panel to move it, or toggle "Follow cursor"
- Sliders for width/height/corner radius, refraction, blur, rim specular,
  chromatic dispersion, tint, edge glow and opacity
- "Reset to macOS defaults" restores the values pulled live from QuartzCore's
  `+defaultValues` / `GlassBackgroundFilter::render`
- Wallpaper button cycles Apple defaults (Big Sur → Golden Gate), courtesy of
  [512pixels' archive](https://512pixels.net/projects/default-mac-wallpapers-in-5k/)

Static site — open `index.html` or serve the directory. Built by Devin
from dyld-cache RE; see the QuartzCore_shaders.ll provenance notes in the
original research session.
