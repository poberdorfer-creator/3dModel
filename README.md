# Radial engine — hidden-line viewer

Interactive hidden-line (vector-style) render of the animated radial pneumatic engine GLB, styled with [tactic.studio](https://tactic.studio) light/dark palettes.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Controls

- **Drag** — orbit the model
- **Scroll** — scrub the looped animation (`Take 001`, ~5.9s at half-speed playback)
- **Space** — pause / resume auto-play (while you’re interacting)
- **Idle** — after ~10s with no orbit, scroll, or spacebar, the explosion and a slow assembly turn (360° every 30s) resume together
- **Theme** — toggle dark/light (persists via `localStorage` key `tactic-theme`, same as tactic.studio)

## Asset

The model is served from `public/radial_pneumatic_engine.glb` (copied from your Downloads file). Replace that file to update the mesh/animation.
