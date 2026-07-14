# Rocket Soccer

A 2-player HTML5 car-soccer game (Rocket League style, top-down 2D) built for Android phones in landscape orientation. Runs in any mobile browser — no install needed.

## Features
- **Real-time online multiplayer** over WebSockets: quick match or private room codes
- **Offline VS Bot** mode with a chasing/positioning AI
- Touch controls: virtual joystick (left half of screen) + boost button with a boost gauge
- Landscape lock via the Screen Orientation API, fullscreen on start, "rotate device" overlay in portrait
- Car/ball/car-car collision physics, boost drain/regen, goal explosions, particles, Web Audio sound effects
- 3-minute matches, kickoff countdowns, scoreboard and timer HUD
- Keyboard fallback (WASD/arrows + Space) for desktop testing

## Run it

```
cd rocket-soccer
npm install
npm start
```

Then on your Android phone (same Wi-Fi as the PC), open:

```
http://<your-PC-LAN-IP>:3000
```

Find your PC's IP with `ipconfig` (IPv4 Address). Two phones on the same network can play each other via **PLAY ONLINE** or a shared **room code**.

To play over the internet, deploy the folder to any Node host (Render, Railway, Fly.io, a VPS). The client auto-connects to the same host it was served from, using `wss://` on HTTPS.

## Architecture
- `index.html` — the entire game client (canvas renderer, physics, input, netcode, menus)
- `server.js` — static file server + WebSocket matchmaker/relay. The first player in a room is the **host**: their browser simulates ball physics and score authoritatively and broadcasts 20 Hz snapshots; the guest sends inputs and predicts their own car locally, smoothing toward host snapshots.

## Controls
- Drag anywhere on the **left half** of the screen to steer (virtual joystick)
- Tap/hold the **BOOST** button (bottom-right) — the ring shows remaining boost
