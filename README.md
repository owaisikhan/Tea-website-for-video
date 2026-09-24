# Kinari Tea House

A scroll-driven WebGL site for a loose leaf tea brand, built with Next.js 16,
React 19, Tailwind CSS v4 and three.js. There are no image or 3D model files:
every object is generated in code.

As you scroll, a glass teapot fills with leaves from a foil pouch, the water
swirls and turns gold, and the pot pours into a cup:

1. Brewed in gold
2. Nature, unwrapped
3. Into the glass
4. The water stirs
5. A colour of gold
6. Poured, slowly
7. Your moment of calm (with an Order on WhatsApp button)

Glass and tea bend the light behind them (a refraction pass over the opaque
scene), scrolling glides with Lenis, and the camera follows a spline through
one viewpoint per section.

**Ingredients:** rolled and whole tea leaves, marigold petals, mint, ginger
slices, cinnamon bark, star anise, cardamom and cloves.
They spill from the pouch as it lifts away, and their fall is a real physics
simulation run once on load (gravity, air drag, flutter, splash, buoyancy that
fades as they soak, a swirling current, the glass walls), played back by
scroll so scrolling up runs it in reverse. See
`src/components/tea/leafPhysics.ts` and `leafModels.ts`.

**Water:** the surface in the pot and the cup ripples where each ingredient
lands and where the pour hits, churns and bubbles while the tea boils, and
stays level while the pot tilts. The tea itself is coloured by depth like real
liquid, and the pour stream bends the light behind it.

**Music:** continuous generative music made in the browser with Web Audio, no
audio files. A warm pad glides from chord to chord as you move through the
sections, soft glass notes drift over it and grow busier while you scroll, and
a trickle joins during the pour. It starts on the first tap, click or key press
(browsers block sound before that) and the speaker button in the header mutes
it; the choice is remembered. See `src/components/tea/teaSound.ts`.

## Editing

- All copy, the brand name and the WhatsApp number: `src/content/tea.ts`.
  The WhatsApp number is a placeholder; replace it before going live.
- Scroll timing: `src/lib/teaTimeline.ts`.
- The 3D scene: `src/components/tea/teaEngine.ts` and `shaders.ts`.

## Commands

```bash
npm install
npm run dev        # http://localhost:3000
npm run check      # lint + typecheck + build
```

## The Facebook reel

`media/kinari-reel.mp4` is a 1080x1920 video of the site on a laptop, scrolling
in one continuous glide with the site's own music (rendered offline by the page), with the
caption "Client: I don't want a basic website / Me: How's this?". The frame
layout lives at `/reel`. To re-record it after changes (needs Playwright and
ffmpeg):

```bash
npm run build && npx next start -p 3100
npm run record:reel
```

## /kettle: the vgpu experiment

`/kettle` is a separate preview of the teapot built with
[vgpu](https://vgpu.sh) (WebGPU). One WGSL shader,
`src/components/kettle/kettle.wgsl`, ray traces the pot as a smooth distance
field: light bends through the glass and the tea, reflects by Fresnel, and the
tea absorbs colour by depth. Drag to turn it; sliders change the brew, level
and lid. Browsers without WebGPU see a still.

The same shader renders headless in Node, for stills and a turntable video:

```bash
npx vgpu doctor                      # needs a WebGPU adapter; on a machine
                                     # without a GPU: npx vgpu install-software-renderer
node --experimental-strip-types scripts/render-kettle.mts media/kettle
node --experimental-strip-types scripts/render-kettle.mts media/kettle --video
```

## The ray-traced kettle on the main site

On the main page the kettle itself is the vgpu kettle, drawn on a transparent
WebGPU canvas over the three.js one. Each frame, right after three.js renders
(with its own pot hidden), the finished frame is copied into a WebGPU texture
and the kettle shader runs in site mode: it traces the pot in the pot's own
frame (so it lifts and tilts to pour), keeps the tea level in the world, and
reads the leaves and spices inside from that frame, bent through the glass and
tinted by the tea. Colours are passed through three.js's exact ACES tone curve
and its inverse, so nothing shifts behind the glass. The lid is ray traced
while it sits on the pot and drawn by three.js while it is off.

Browsers without WebGPU (and any failure while starting it) keep the WebGL
kettle. `?hybrid=off` forces the WebGL kettle.

To check the composite without a WebGPU browser, render the site's frames and
run the same shader over them with vgpu in Node:

```bash
npm run build && npx next start -p 3100
node --experimental-strip-types scripts/verify-hybrid.mts media/kettle/site
```

## Credits

Photographed assets are from [Poly Haven](https://polyhaven.com) (CC0, free
for any use): the `brown_photostudio_02` HDR used for reflections, and the
`dark_wood` table texture. They live in
`public/assets/`. Everything else is generated in code.
