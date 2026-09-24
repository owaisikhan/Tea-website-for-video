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

`media/kinari-reel.mp4` is a 1080x1920 video of the site on a laptop with the
caption "Client: I don't want a basic website / Me: How's this?". The frame
layout lives at `/reel`. To re-record it after changes (needs Playwright and
ffmpeg):

```bash
npm run build && npx next start -p 3100
npm run record:reel
```
