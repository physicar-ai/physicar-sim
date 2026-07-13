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

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sim/api/status` | Simulator runtime status |
| `GET` | `/sim/api/pose` | Vehicle pose (world absolute coordinates) |
| `POST` | `/sim/api/pose` | Teleport the vehicle (`{"x": 1.0, "y": 2.0, "yaw": 0.0}` — omitted fields keep their current value; the pose is normalized upright at ground level, so this also rights a flipped car) |
| `GET` | `/sim/api/route` | Track waypoints (route) |
| `GET` | `/sim/api/track_bounds` | Track bounds (bounding box) |
| `GET` | `/sim/api/obstacles` | World models query (name, `type`: object/wall/light, static, movable, origin/current pose, size) |
| `POST` | `/sim/api/models/<name>/pose` | Move/rotate a world object (`{"x": 1.0, "y": 2.0, "z": 0.1, "yaw": 0.0}` — omitted fields keep their current value; rotation is yaw-only. Works for World Builder objects and traffic lights; walls and the track itself are rejected) |
| `GET` | `/sim/api/worlds` | World list (includes the current world) |
| `POST` | `/sim/api/respawn` | Reload the world to reset all objects to their start state |
| `POST` | `/sim/api/switch` | Switch world (`{"world": "<name>.world"}`) |
| `GET` | `/sim/api/traffic_lights` | List the world's traffic lights and their states |
| `POST` | `/sim/api/traffic_lights/<name>` | Change a light state (`{"state": "red"}` or `{"state": "green"}` — green→red passes through 3 s of yellow, during which commands are rejected with 409) |

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
