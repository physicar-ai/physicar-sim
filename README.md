# PhysiCar Simulation

[![Gazebo Harmonic](https://img.shields.io/badge/Gazebo-Harmonic-orange)](https://gazebosim.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue)](LICENSE)

<p align="center">
  <img src="logo.png" alt="logo" width="480" style="max-width: 100%;">
</p>

The Gazebo Harmonic based simulation environment for **PhysiCar AI**, a Physical AI education platform.

The source is installed at `/opt/physicar/src/physicar-sim`.

### 🌐 Official site: [https://physicar.ai](https://physicar.ai)

## Simulation API

An HTTP API for track management and vehicle state queries is served under the `/sim/api/` path.
Sections are ordered by how often you will reach for them: basic health first, then the
vehicle and world you drive against, the things you can change, and finally monitoring,
evaluation and world management.

### Status & Time

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/status` | Simulator runtime status |
| `GET` | `/sim/api/clock` | Sim time / real time / RTF / paused |

### Vehicle

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/pose` | Vehicle pose (world absolute coordinates) |
| `POST` | `/sim/api/pose` | Teleport the vehicle (`{"x": 1.0, "y": 2.0, "yaw": 0.0}` — omitted fields keep their current value; the pose is normalized upright at ground level, so this also rights a flipped car) |

### World & Objects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/world` | One-call snapshot of the current world's immutable definition: identity (`world_id`/`rev`/display name), track geometry (`route` centerline+boundaries, `bounds`), object catalog (type/static/movable/origin/size), and whether it has an evaluation |
| `GET` | `/sim/api/route` | Track centerline waypoints, plus inner/outer boundary lines when available |
| `GET` | `/sim/api/bounds` | Track bounds (bounding box) |
| `GET` | `/sim/api/objects` | World models query (name, `type`: object/wall/light, static, movable, origin/current pose, size) |
| `POST` | `/sim/api/models/<name>/pose` | Move/rotate a world object (`{"x": 1.0, "y": 2.0, "z": 0.1, "yaw": 0.0}` — omitted fields keep their current value; rotation is yaw-only. Works for World Builder objects and traffic lights; walls and the track itself are rejected) |

### Traffic Lights

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/traffic_lights` | List the world's traffic lights and their states |
| `POST` | `/sim/api/traffic_lights/<name>` | Change a light state (`{"state": "red"}` or `{"state": "green"}` — green→red passes through 3 s of yellow, during which commands are rejected with 409) |

### Reset

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sim/api/reset` | Put every movable object, traffic light and the vehicle back at its start pose — instant, pose-only, no world reload. The go-to reset between training episodes |
| `POST` | `/sim/api/respawn` | Reload the whole world (~6 s) — the heavyweight reset, for when the world misbehaves |

### Display

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/brightness` | Scene brightness factor (`{"value": 1.0}`) |
| `POST` | `/sim/api/brightness` | Set scene brightness (`{"value": 0.2..2.0}`, 1.0 = default). Applied instantly at the display layer — the 3D viewer and the robot camera frames darken/brighten by the same factor (no world restart). One shared server-side value: every open viewer stays in sync. Persists across world switches and restarts |
| `GET` | `/sim/api/overlay` | Current on-screen status text (`{"text": ...}`) |
| `POST` | `/sim/api/overlay` | Show status text on the `/sim` screen (`{"text": "...", "ttl": 10}` — text ≤300 chars, ttl 1–3600 s; expires by itself, e.g. training progress) |

### Monitoring

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/state` | One-call snapshot of everything that changes in real time: world/running/switching, sim `time`/`paused`/`rtf`, vehicle pose, object poses, traffic lights, overlay, brightness, and the evaluation run state |
| `GET` | `/sim/api/events` | SSE stream of **named events**. `event: state` — full status snapshot pushed on change (sim status, overlay, brightness, traffic lights with `yellow_left`); `event: run` — student-process events during an evaluation (`{"phase": "start"\|"log"\|"exit", ...}`). Consumers subscribe via `addEventListener` and MUST ignore unknown event names; new kinds are always added as new names, never as new snapshot keys |

### Evaluation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/evaluation` | The current world's evaluation document (`evaluation.json` published from the World Builder: `{version, config, script}`), 404 when the world has none |
| `POST` | `/sim/api/evaluation/run` | Launch the student's code for an evaluation (`{"command"?, "time_limit_s"?}` — defaults come from the world's evaluation config). Output streams to `event: run` on `/sim/api/events`; a wall-clock backstop kills the process if the browser runner disappears |
| `POST` | `/sim/api/evaluation/stop` | Stop the student's process (idempotent) |

### Worlds

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/worlds` | World list (includes the current world). Each item carries `name`, `file`, `display` (the published name, or the official world's display name — e.g. `physicar_base` → "PhysiCar Base"), `world_id` (32-hex publish id, `null` for built-ins whose internal name acts as their id), `official`, `evaluation` (whether it carries an evaluation), and `deletable` |
| `POST` | `/sim/api/switch` | Switch world (`{"world": "<name>.world"}` or `{"world_id": "<32-hex id>"}` — the id form resolves an installed published world and returns 404 when it is not installed) |
| `GET` | `/sim/api/worldpub` | Current world's publish coordinates (`world_id`/`rev` when it is an installed published world) plus the official-asset CDN revision (`assets_rev`, set only on a clean tagged checkout) and the CDN base URL — the viewer uses this to load meshes/textures from the worlds CDN |
| `POST` | `/sim/api/worlds/install` | Install a published world from the worlds CDN (`{"world_id": "<32-hex id>"}`). The server downloads the world's manifest and files directly from the CDN (no browser relay), installs it under the `custom_` convention, and skips the download when the same `rev` is already installed (`"cached": true`) |

The web viewer supports World Builder-style direct manipulation: click an object to
select it (white box), drag to move it, and drag the blue dot handle to rotate it.
The change is applied through the pose API when you release. Clicking a traffic
light opens its control panel (RED/GREEN) on the right side. The vehicle can be
moved the same way — its pose is normalized upright, and since odometry
(lidar + IMU) cannot observe a teleport, use **Respawn** afterwards if you need a
clean odometry state.

Traffic lights come from the world itself: Custom World Builder tracks may include
light models (`<link name="light">` marker — the legacy `signal` marker is still
recognized). They are detected on world load and controlled via the panel or the
API above. Default state is `green`; states survive a respawn of the same world.
Runtime light placement was removed — place lights in the World Builder instead.

## License

Copyright 2026 **AICASTLE Inc.** "PhysiCar" is a trademark of AICASTLE Inc.

| Component | License |
|-----------|---------|
| `physicar-sim` (this project) | GPL-3.0 |
| gzweb, Three.js, Lodash, Gazebo example models | see [NOTICE](NOTICE) |

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for full terms and third-party attributions.
