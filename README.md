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
| `GET` | `/sim/api/traffic_lights` | List placed traffic lights and their states |
| `POST` | `/sim/api/traffic_lights` | Place a traffic light (`{"x": 1.0, "y": 2.0, "yaw": 0.0, "state": "red"}`) |
| `POST` | `/sim/api/traffic_lights/<name>` | Change a signal state (`{"state": "red"}` or `{"state": "green"}`) |
| `DELETE` | `/sim/api/traffic_lights/<name>` | Remove a traffic light |

Traffic lights can also be placed and controlled from the web viewer (🚦 Signal menu).
They survive a respawn of the same world and are cleared on world switch.

Custom World Builder tracks may include `signal_*` models (tablet-stand signals).
These are detected on world load, appear in the same list/API with `"builtin": true`,
and can be controlled but not deleted. Default state is `green`.

## License

Copyright 2026 **AICASTLE Inc.** "PhysiCar" is a trademark of AICASTLE Inc.

| Component | License |
|-----------|---------|
| `physicar-sim` (this project) | GPL-3.0 |
| gzweb, Three.js, Lodash, Gazebo example models | see [NOTICE](NOTICE) |

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for full terms and third-party attributions.
