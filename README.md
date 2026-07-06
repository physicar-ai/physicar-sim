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
| `GET` | `/sim/api/route` | Track waypoints (route) |
| `GET` | `/sim/api/track_bounds` | Track bounds (bounding box) |
| `GET` | `/sim/api/obstacles` | World obstacles (boxes) query |
| `GET` | `/sim/api/worlds` | World list (includes the current world) |
| `POST` | `/sim/api/respawn` | Reload the world to reset all objects to their start state |
| `POST` | `/sim/api/switch` | Switch world (`{"world": "<name>.world"}`) |

## License

Copyright 2026 **AICASTLE Inc.** "PhysiCar" is a trademark of AICASTLE Inc.

| Component | License |
|-----------|---------|
| `physicar-sim` (this project) | GPL-3.0 |
| gzweb, Three.js, Lodash, Gazebo example models | see [NOTICE](NOTICE) |

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for full terms and third-party attributions.
