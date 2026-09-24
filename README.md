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
(slices plus a scanned root), cinnamon bark, star anise, cardamom and cloves.
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

## Credits

Photographed assets are from [Poly Haven](https://polyhaven.com) (CC0, free
for any use): the `brown_photostudio_02` HDR used for reflections, the
`dark_wood` table texture and the `food_ginger_01` scan. They live in
`public/assets/`. Everything else is generated in code.
