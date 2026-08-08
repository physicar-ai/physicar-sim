# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 AICASTLE Inc.

import re, os, json, math, subprocess, glob, http.server, threading, time, signal, tarfile, tempfile, shutil, io, logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [sim_api] %(levelname)s %(message)s',
    datefmt='%H:%M:%S'
)

SIM_DIR = os.path.dirname(os.path.abspath(__file__))
SHARE_DIR = os.path.join(SIM_DIR, "share")
WORLDS_DIR = os.path.join(SHARE_DIR, "worlds")
DEFAULT_WORLD = "physicar_base.world"
# Last successfully started world, persisted across restarts/reboots
LAST_WORLD_FILE = "/opt/physicar/userdata/last_world"

# ── Vehicle profile (generation seam) ───────────────────────────────────
# The cloud injects PHYSICAR_GENERATION at workspace boot (defaults to gen 1).
# share/vehicles/<gen>.json is the single source of the vehicle identity
# (model name, lidar spec, mesh prefix) — the viewer reads the same profile
# via GET /api/vehicle, so neither side hardcodes the vehicle.
GENERATION = os.environ.get("PHYSICAR_GENERATION", "physicar")
_DEFAULT_VEHICLE = {
    "generation": "physicar",
    "model_name": "physicar",
    "lidar": {"samples": 720, "min_range": 0.15, "max_range": 16.0, "offset": [-0.027, 0.0, 0.183]},
    "mesh_prefix": "physicar/",
    "mesh_exclude": "Base.",
}

def _load_vehicle(gen):
    try:
        with open(os.path.join(SHARE_DIR, "vehicles", f"{gen}.json")) as f:
            v = {**_DEFAULT_VEHICLE, **json.load(f)}
            v["generation"] = gen
            return v
    except Exception:
        if gen != _DEFAULT_VEHICLE["generation"]:
            logging.warning("vehicle profile for '%s' missing/invalid — using physicar defaults", gen)
        return dict(_DEFAULT_VEHICLE)

VEHICLE = _load_vehicle(GENERATION)
VEHICLE_NAME = VEHICLE["model_name"]

# Protected worlds/models that cannot be deleted or overwritten
PROTECTED_NAMES = {"physicar_base", "physicar", "sun", "physicar_sky",
                   "box_obstacle", "physicar_box_obstacle", "physicar_ball", "physicar_cone",
                   VEHICLE_NAME}
MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50MB
CHUNK_SIZE = 10 * 1024 * 1024  # 10MB chunks for Codespaces proxy limit
UPLOAD_TIMEOUT = 600  # 10 minutes

# Chunked upload sessions: upload_id -> {path, filename, size, received, last_activity}
_upload_sessions = {}
_upload_lock = threading.Lock()

def _cleanup_stale_uploads():
    """Remove upload sessions older than UPLOAD_TIMEOUT."""
    now = time.time()
    with _upload_lock:
        stale = [uid for uid, s in _upload_sessions.items() if now - s["last_activity"] > UPLOAD_TIMEOUT]
        for uid in stale:
            try:
                os.unlink(_upload_sessions[uid]["path"])
            except Exception:
                pass
            del _upload_sessions[uid]
            logging.info("cleaned up stale upload: %s", uid)

def _validate_world_name(name):
    """Validate world name: starts with letter, alphanumeric + underscores."""
    return bool(re.match(r'^[A-Za-z][A-Za-z0-9_]{0,63}$', name))

def _load_boot_world():
    """World to boot with: the last used one if it still exists, else the default."""
    try:
        with open(LAST_WORLD_FILE) as fp:
            name = fp.read().strip()
        if _validate_world_name(name) and os.path.isfile(os.path.join(WORLDS_DIR, name + ".world")):
            return name + ".world"
    except Exception:
        pass
    return DEFAULT_WORLD

def _save_last_world(world_file):
    try:
        with open(LAST_WORLD_FILE, "w") as fp:
            fp.write(os.path.splitext(world_file)[0])
    except Exception as e:
        logging.warning("could not persist last world: %s", e)

def _validate_tar(tar_path):
    """Validate uploaded tar.gz. Discovers world name from worlds/*.world.
    Returns (ok, error_message, world_name)."""
    try:
        with tarfile.open(tar_path, 'r:gz') as tf:
            names = tf.getnames()
            # Security: no absolute paths or path traversal
            for n in names:
                if n.startswith('/') or '..' in n:
                    return False, f"unsafe path: {n}", None

            # Discover world name from worlds/*.world (must be exactly one)
            world_files = [n for n in names
                           if n.startswith("worlds/") and n.endswith(".world")
                           and n.count("/") == 1]
            if len(world_files) == 0:
                return False, "no worlds/*.world found in archive", None
            if len(world_files) > 1:
                return False, "multiple .world files found", None

            world_file = world_files[0]
            world_name = os.path.splitext(os.path.basename(world_file))[0]

            if not _validate_world_name(world_name):
                return False, f"invalid world name: {world_name}", None

            # Required: models/{world_name}/ with model.config and *.sdf
            model_config = f"models/{world_name}/model.config"
            has_config = model_config in names
            has_sdf = any(n.startswith(f"models/{world_name}/")
                         and n.endswith(".sdf") for n in names)

            # Required: meshes/{world_name}/ with at least one file
            has_mesh = any(n.startswith(f"meshes/{world_name}/")
                          and not n.endswith("/") for n in names)

            errors = []
            if not has_config:
                errors.append(f"missing {model_config}")
            if not has_sdf:
                errors.append(f"missing models/{world_name}/*.sdf")
            if not has_mesh:
                errors.append(f"missing meshes/{world_name}/ files")
            if errors:
                return False, "; ".join(errors), None

            # Optional: routes/ — if present, must be routes/{world_name}.npy only
            route_files = [n for n in names
                           if n.startswith("routes/") and not n.endswith("/")
                           and n != "routes/"]
            if route_files:
                expected = f"routes/{world_name}.npy"
                bad = [f for f in route_files if f != expected]
                if bad:
                    return False, f"route file must be {expected}, got: {bad}", None
                npy_f = tf.extractfile(expected)
                if npy_f:
                    try:
                        import numpy as np
                        arr = np.load(io.BytesIO(npy_f.read()))
                        if arr.ndim != 2 or arr.shape[0] < 2 or arr.shape[1] < 2:
                            return False, f"route must be 2D array (>=2x2), got {arr.shape}", None
                    except Exception as e:
                        return False, f"invalid route npy: {e}", None

            # Optional: track_iconography/ — if present, must be {world_name}.png only
            icon_files = [n for n in names
                          if n.startswith("track_iconography/") and not n.endswith("/")
                          and n != "track_iconography/"]
            if icon_files:
                expected = f"track_iconography/{world_name}.png"
                bad = [f for f in icon_files if f != expected]
                if bad:
                    return False, f"icon must be {expected}, got: {bad}", None

            # Validate <world name="..."> matches world_name
            wf = tf.extractfile(world_file)
            if wf:
                wdata = wf.read().decode("utf-8", errors="replace")
                m = re.search(r'<world\s+name="([^"]+)"', wdata)
                if not m:
                    return False, 'world file missing <world name="...">', None
                if m.group(1) != world_name:
                    return False, (f'SDF world name "{m.group(1)}" does not match '
                                   f'file name "{world_name}"'), None

            return True, None, world_name
    except tarfile.TarError as e:
        return False, f"invalid tar.gz: {e}", None

SKY_DOME_INCLUDE = """  <include>
    <uri>model://models/physicar_sky</uri>
    <pose>0 0 0 0 0 0</pose>
    <name>physicar_sky</name>
  </include>
"""

PHYSICS_BLOCK = """  <physics name="default_physics" type="ode">
    <max_step_size>0.005</max_step_size>
    <real_time_update_rate>200</real_time_update_rate>
  </physics>
"""

def _ensure_sky_dome(world_file):
    """Normalize a world file in place (idempotent).

    - Gradient sky dome: the robot camera is rendered by headless ogre2,
      which draws no <sky/> — without the dome model the camera sees only
      the flat <background> color while the viewer shows its gradient sky.
    - Physics block: worlds ported from AWS carry none and would run at the
      Gazebo default 1000 Hz — 5x the physics CPU of physicar worlds.
    """
    try:
        path = os.path.join(WORLDS_DIR, world_file)
        with open(path) as fp:
            src = fp.read()
        if "</world>" not in src:
            return
        changed = False
        if "models/physicar_sky" not in src:
            src = src.replace("</world>", SKY_DOME_INCLUDE + "</world>", 1)
            changed = True
        if "<physics" not in src:
            src = src.replace("</world>", PHYSICS_BLOCK + "</world>", 1)
            changed = True
        if changed:
            with open(path, "w") as fp:
                fp.write(src)
            logging.info("world defaults ensured for %s", world_file)
    except Exception as e:
        logging.warning("world normalization failed for %s: %s", world_file, e)

def _extract_world(tar_path, world_name):
    """Extract validated tar.gz into share/ directory."""
    with tarfile.open(tar_path, 'r:gz') as tf:
        exact = {f"worlds/{world_name}.world",
                 f"routes/{world_name}.npy",
                 f"track_iconography/{world_name}.png"}
        prefixes = (f"models/{world_name}/", f"meshes/{world_name}/")
        for member in tf.getmembers():
            if member.name in exact or any(member.name.startswith(p) for p in prefixes):
                tf.extract(member, SHARE_DIR)
    _ensure_sky_dome(f"{world_name}.world")
    _normalize_textures(world_name)

def _normalize_textures(world_name):
    """Re-encode image files whose bytes don't match their .png extension.

    World-builder exports store user-uploaded photos verbatim under a .png
    name. Browsers sniff the real format so gzweb renders them, but Ogre2
    picks its codec by extension — a JPEG behind ".png" fails to load and
    the sim camera shows the yellow/black warning texture instead.
    """
    from PIL import Image
    for sub in ("meshes", "models"):
        root = os.path.join(SHARE_DIR, sub, world_name)
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.lower().endswith(".png"):
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    with open(p, "rb") as f:
                        if f.read(8) == b"\x89PNG\r\n\x1a\n":
                            continue
                    img = Image.open(p)
                    img.load()
                    img.save(p, "PNG")
                    logging.info("normalized texture to PNG: %s", p)
                except Exception:
                    logging.exception("texture normalize failed: %s", p)

def _delete_world_files(world_name):
    """Delete all files associated with a world."""
    paths = [
        os.path.join(WORLDS_DIR, f"{world_name}.world"),
        os.path.join(SHARE_DIR, "models", world_name),
        os.path.join(SHARE_DIR, "meshes", world_name),
        os.path.join(SHARE_DIR, "routes", f"{world_name}.npy"),
        os.path.join(SHARE_DIR, "track_iconography", f"{world_name}.png"),
    ]
    for p in paths:
        if os.path.isfile(p):
            os.remove(p)
        elif os.path.isdir(p):
            shutil.rmtree(p)

# Single source of truth for simulation state
_lock = threading.Lock()
_sim_proc = None        # subprocess.Popen of gz sim
_launch_proc = None     # subprocess.Popen of gz-launch
_current_world = None   # e.g. "physicar_base"
_switching = False
_switching_since = 0.0
_SWITCH_TIMEOUT = 90    # seconds — force-reset if switching takes longer
_fail_count = 0         # consecutive watchdog restart failures
_MAX_FAILS = 5          # give up auto-restart after this many
_health_counter = 0     # watchdog health-check cycle counter
_HEALTH_INTERVAL = 2    # check gz-transport every N watchdog ticks (5s × 2 = 10s)
_HEALTH_TIMEOUT = 8     # seconds to wait for gz topic -l response
WEBSOCKET_LAUNCH = os.path.join(SIM_DIR, "websocket.gzlaunch")

def _gz_env():
    """Build environment dict for gz sim (llvmpipe + resource paths)."""
    env = os.environ.copy()
    env["GZ_CONFIG_PATH"] = "/usr/share/gz"
    env["GZ_PARTITION"] = "physicar"
    env["GALLIUM_DRIVER"] = "llvmpipe"
    env["MESA_GL_VERSION_OVERRIDE"] = "3.3"
    models_dir = os.path.join(SHARE_DIR, "models")
    if os.path.isdir(models_dir):
        env["GZ_SIM_RESOURCE_PATH"] = f"{models_dir}:{SHARE_DIR}"
    server_config = os.path.join(SIM_DIR, "server.config")
    if os.path.isfile(server_config):
        env["GZ_SIM_SERVER_CONFIG_PATH"] = server_config
    return env

def _kill_all_gz():
    """Kill gz sim + gz-launch processes (sim_api is sole owner)."""
    global _sim_proc, _launch_proc
    # Terminate tracked processes gracefully first
    for label, proc in [("gz sim", _sim_proc), ("gz-launch", _launch_proc)]:
        if proc and proc.poll() is None:
            logging.info("terminating %s (PID %d)", label, proc.pid)
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                try: proc.wait(timeout=2)
                except Exception: pass
            except Exception:
                pass
    # pkill any orphans (e.g. from supervisord or previous crash)
    subprocess.run(["pkill", "-f", "gz sim -s"], timeout=5, capture_output=True)
    time.sleep(0.3)
    subprocess.run(["pkill", "-9", "-f", "gz sim -s"], timeout=5, capture_output=True)
    subprocess.run(["pkill", "-9", "-f", "gz-launch"], timeout=5, capture_output=True)
    time.sleep(0.5)
    _sim_proc = None
    _launch_proc = None

_launch_lock = threading.Lock()   # the watchdog and post_start both start
                                  # gz-launch — unserialized, their pkills
                                  # kill each other's fresh process

def _start_launch():
    """Start gz-launch websocket server. Returns True if started successfully."""
    global _launch_proc
    with _launch_lock:
        # Kill any orphan gz-launch first to avoid port 9002 conflict
        subprocess.run(["pkill", "-9", "-f", "gz-launch"], timeout=5, capture_output=True)
        time.sleep(0.5)
        env = _gz_env()
        proc = subprocess.Popen(
            ["gz", "launch", WEBSOCKET_LAUNCH],
            env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True
        )
        _launch_proc = proc
        logging.info("gz-launch started (PID %d)", proc.pid)
        # Verify it didn't crash immediately (e.g. port in use). Check through
        # a local reference — a concurrent stop may null the global meanwhile.
        time.sleep(1.0)
        if proc.poll() is not None:
            logging.error("gz-launch crashed on startup (exit %s)", proc.returncode)
            if _launch_proc is proc:
                _launch_proc = None
            return False
        return True

def _get_world_name(world_file):
    """Extract <world name="..."> from SDF."""
    path = os.path.join(WORLDS_DIR, world_file)
    try:
        with open(path) as f:
            m = re.search(r'<world\s+name="([^"]+)"', f.read())
            return m.group(1) if m else None
    except Exception:
        return None

def _spawn_pose(wname):
    """Calculate spawn pose from route npy file."""
    try:
        import numpy as np, math
        npy = os.path.join(SHARE_DIR, "routes", wname + ".npy")
        d = np.load(npy)
        x, y = float(d[0, 0]), float(d[0, 1])
        yaw = math.atan2(d[1, 1] - y, d[1, 0] - x)
        sz, cz = math.sin(yaw / 2), math.cos(yaw / 2)
        return f'position: {{x: {x}, y: {y}, z: 0.05}}, orientation: {{x: 0, y: 0, z: {sz}, w: {cz}}}'
    except Exception:
        return 'position: {z: 0.05}'

def _run_gz_cmd(*args, timeout=5):
    """Run a gz command directly (sim_api runs as physicar already)."""
    env = _gz_env()
    return subprocess.run(
        list(args), env=env, timeout=timeout, capture_output=True, text=True
    )

# ── in-process gz-transport (fast path) ────────────────────────────────────
# The `gz service` CLI spawns a process per call (~340 ms). The in-process
# node answers in <1 ms once discovery is done, which is what makes traffic
# light changes feel instant (a state change chains 3-5 service calls).
# Partition must be set before the node is created.
os.environ.setdefault("GZ_PARTITION", "physicar")
try:
    from gz.transport13 import Node as _GzTNode
    from gz.msgs10.boolean_pb2 import Boolean as _PbBoolean
    from gz.msgs10.pose_pb2 import Pose as _PbPose
    from gz.msgs10.visual_pb2 import Visual as _PbVisual
    _gz_node = _GzTNode()
except Exception:
    _gz_node = None
_gz_node_lock = threading.Lock()

def _gz_request(service, req, req_type, rep_type, timeout_ms=2000):
    """In-process service request; None on failure (caller falls back to CLI)."""
    if _gz_node is None:
        return None
    try:
        with _gz_node_lock:
            ok, rep = _gz_node.request(service, req, req_type, rep_type, timeout_ms)
        return rep if ok else None
    except Exception:
        return None

# ── live gz stream cache (poses + clock) ───────────────────────────────────
# /pose and /objects used to spawn a `gz topic -e -n 1` process per request
# (~160 ms each). Persistent readers stream the topics into memory instead,
# and /clock exposes sim time / RTF from the same stats stream.
_gz_cache_lock = threading.Lock()
_gz_poses = {}          # entity name -> {x, y, z, yaw}
_gz_clock = {}          # {"sim_time", "real_time", "rtf", "paused"}
_gz_cache_world = None
_gz_stats_seen = [0.0]  # monotonic time of the last stats message — a world
                        # reload kills the streams silently, so the manager
                        # re-attaches when this goes stale

_overlay_text = ""      # free status text shown on the /sim screen
_overlay_expiry = 0.0   # monotonic deadline — stale text disappears by
                        # itself when the posting script dies (POST /overlay)


def _parse_pose_block(block):
    nm = re.search(r'name:\s*"([^"]+)"', block)
    px = re.search(r'position\s*\{[^}]*x:\s*([\d.eE+-]+)', block)
    py = re.search(r'position\s*\{[^}]*y:\s*([\d.eE+-]+)', block)
    pz = re.search(r'position\s*\{[^}]*z:\s*([\d.eE+-]+)', block)
    if not (nm and px and py and pz):
        return None, None

    def _q(axis):
        m = re.search(r'orientation\s*\{[^}]*' + axis + r':\s*([\d.eE+-]+)', block)
        return float(m.group(1)) if m else 0.0
    qx, qy, qz, qw = _q('x'), _q('y'), _q('z'), _q('w')
    yaw = math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))
    return nm.group(1), {
        "x": round(float(px.group(1)), 6), "y": round(float(py.group(1)), 6),
        "z": round(float(pz.group(1)), 6), "yaw": round(yaw, 6)}


def _spawn_pose_reader(world):
    proc = subprocess.Popen(
        ["gz", "topic", "-e", "-t", f"/world/{world}/dynamic_pose/info"],
        env=_gz_env(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    def pump():
        buf, depth = [], 0
        for line in proc.stdout:
            buf.append(line)
            depth += line.count("{") - line.count("}")
            if depth <= 0 and buf:
                name, pose = _parse_pose_block("".join(buf))
                buf, depth = [], 0
                if name:
                    with _gz_cache_lock:
                        _gz_poses[name] = pose
    threading.Thread(target=pump, daemon=True).start()
    return proc


def _spawn_stats_reader(world):
    proc = subprocess.Popen(
        ["gz", "topic", "-e", "-t", f"/world/{world}/stats"],
        env=_gz_env(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    def _t(name, text):
        m = re.search(name + r'\s*\{([^}]*)\}', text)
        if not m:
            return None
        sec = re.search(r'(?<!n)sec:\s*(\d+)', m.group(1))     # not "nsec:"
        nsec = re.search(r'nsec:\s*(\d+)', m.group(1))
        return (int(sec.group(1)) if sec else 0) + (int(nsec.group(1)) if nsec else 0) / 1e9

    def pump():
        buf = []
        for line in proc.stdout:
            buf.append(line)
            if "real_time_factor" not in line:
                continue
            text = "".join(buf)
            buf = []
            rtf = re.search(r'real_time_factor:\s*([\d.eE+-]+)', text)
            entry = {
                "sim_time": _t("sim_time", text),
                "real_time": _t("real_time", text),
                "rtf": float(rtf.group(1)) if rtf else None,
                "paused": "paused: true" in text,
            }
            _gz_stats_seen[0] = time.monotonic()
            with _gz_cache_lock:
                _gz_clock.update({k: v for k, v in entry.items() if v is not None or k == "paused"})
    threading.Thread(target=pump, daemon=True).start()
    return proc


def _gz_cache_manager():
    """(Re)attach the stream readers whenever the running world changes."""
    global _gz_cache_world
    procs = []
    while True:
        with _lock:
            world = _current_world
        if (world != _gz_cache_world
                or (world and any(p.poll() is not None for p in procs))
                or (world and procs
                    and time.monotonic() - _gz_stats_seen[0] > 10)):
            for pr in procs:
                try:
                    pr.kill()
                except Exception:
                    pass
            procs = []
            with _gz_cache_lock:
                _gz_poses.clear()
                _gz_clock.clear()
            _gz_cache_world = world
            if world:
                try:
                    procs = [_spawn_pose_reader(world), _spawn_stats_reader(world)]
                    _gz_stats_seen[0] = time.monotonic()
                except Exception:
                    procs = []
        time.sleep(2)


def _get_vehicle_pose(world):
    """Query current vehicle pose in world coordinates from Gazebo."""
    import math
    with _gz_cache_lock:
        p = _gz_poses.get(VEHICLE_NAME)
        if p and _gz_cache_world == world:
            return dict(p)
    try:
        r = _run_gz_cmd("gz", "topic", "-e", "-t",
                        f"/world/{world}/dynamic_pose/info", "-n", "1", timeout=3)
        if r.returncode != 0 or not r.stdout:
            return None
    except Exception:
        return None
    for block in re.split(r'(?=^pose \{)', r.stdout, flags=re.MULTILINE):
        if not re.search(r'name:\s*"%s"' % re.escape(VEHICLE_NAME), block):
            continue
        px = re.search(r'position\s*\{[^}]*x:\s*([\d.eE+-]+)', block)
        py = re.search(r'position\s*\{[^}]*y:\s*([\d.eE+-]+)', block)
        pz = re.search(r'position\s*\{[^}]*z:\s*([\d.eE+-]+)', block)
        ow = re.search(r'orientation\s*\{[^}]*w:\s*([\d.eE+-]+)', block)
        if not (px and py and pz and ow):
            continue
        x, y, z = float(px.group(1)), float(py.group(1)), float(pz.group(1))
        qx = float((re.search(r'orientation\s*\{[^}]*x:\s*([\d.eE+-]+)', block) or type('',(),{'group':lambda s,i:'0'})()).group(1))
        qy = float((re.search(r'orientation\s*\{[^}]*y:\s*([\d.eE+-]+)', block) or type('',(),{'group':lambda s,i:'0'})()).group(1))
        qz = float((re.search(r'orientation\s*\{[^}]*z:\s*([\d.eE+-]+)', block) or type('',(),{'group':lambda s,i:'0'})()).group(1))
        qw = float(ow.group(1))
        yaw = math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))
        return {"x": round(x, 6), "y": round(y, 6), "z": round(z, 6), "yaw": round(yaw, 6)}
    return None

def _get_route(world):
    """Load route waypoints from npy file (center line only)."""
    full = _get_route_full(world)
    return full["waypoints"] if full else None

def _get_route_full(world):
    """Load the full route geometry from the 6-column npy:
    rows are [center_x, center_y, inner_x, inner_y, outer_x, outer_y]."""
    try:
        import numpy as np
        npy = os.path.join(SHARE_DIR, "routes", world + ".npy")
        if not os.path.isfile(npy):
            return None
        d = np.load(npy)
        def line(a, b):
            return [[round(float(r[a]), 6), round(float(r[b]), 6)] for r in d]
        out = {"waypoints": line(0, 1)}
        if d.shape[1] >= 6:
            out["inner"] = line(2, 3)
            out["outer"] = line(4, 5)
        return out
    except Exception:
        return None

def _get_dynamic_poses(world):
    """Return {name: {x, y, z, yaw}} for every entity in dynamic_pose/info."""
    import math
    with _gz_cache_lock:
        if _gz_poses and _gz_cache_world == world:
            return {k: dict(v) for k, v in _gz_poses.items()}
    out = {}
    try:
        r = _run_gz_cmd("gz", "topic", "-e", "-t",
                        f"/world/{world}/dynamic_pose/info", "-n", "1", timeout=3)
        if r.returncode != 0 or not r.stdout:
            return out
    except Exception:
        return out
    for block in re.split(r'(?=^pose \{)', r.stdout, flags=re.MULTILINE):
        nm = re.search(r'name:\s*"([^"]+)"', block)
        if not nm:
            continue
        px = re.search(r'position\s*\{[^}]*x:\s*([\d.eE+-]+)', block)
        py = re.search(r'position\s*\{[^}]*y:\s*([\d.eE+-]+)', block)
        pz = re.search(r'position\s*\{[^}]*z:\s*([\d.eE+-]+)', block)
        if not (px and py and pz):
            continue

        def _q(axis):
            m = re.search(r'orientation\s*\{[^}]*' + axis + r':\s*([\d.eE+-]+)', block)
            return float(m.group(1)) if m else 0.0
        x, y, z = float(px.group(1)), float(py.group(1)), float(pz.group(1))
        qx, qy, qz, qw = _q('x'), _q('y'), _q('z'), _q('w')
        yaw = math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))
        out[nm.group(1)] = {"x": round(x, 6), "y": round(y, 6), "z": round(z, 6), "yaw": round(yaw, 6)}
    return out

def _get_builtin_obstacles(world):
    """List obstacle models defined directly in the world SDF.

    Each entry reports whether it is static, its origin pose (from the SDF),
    its current/live pose (from Gazebo) and its box size when available.
    """
    import xml.etree.ElementTree as ET
    path = os.path.join(WORLDS_DIR, f"{world}.world")
    if not os.path.isfile(path):
        return None
    try:
        root = ET.parse(path).getroot()
    except Exception:
        return None
    world_el = root.find("world")
    if world_el is None:
        return []
    live = _get_dynamic_poses(world)
    items = []
    for m in world_el.findall("model"):
        name = m.get("name")
        if not name:
            continue
        ox = oy = oz = oyaw = 0.0
        pose_el = m.find("pose")
        if pose_el is not None and pose_el.text:
            parts = pose_el.text.split()
            if len(parts) >= 6:
                ox, oy, oz, oyaw = float(parts[0]), float(parts[1]), float(parts[2]), float(parts[5])
        static_el = m.find("static")
        is_static = bool(static_el is not None and static_el.text and static_el.text.strip().lower() == "true")
        # 종류 마커 = link 이름 (Custom World Builder 계약: object/wall/light, 'signal'은 구 마커)
        marker = None
        for lk in m.findall("link"):
            if lk.get("name") in ("object", "wall", "light", "signal"):
                marker = "light" if lk.get("name") == "signal" else lk.get("name")
                break
        size = None
        sz = m.find("./link/collision/geometry/box/size")
        if sz is not None and sz.text:
            sp = sz.text.split()
            if len(sp) >= 3:
                size = {"x": float(sp[0]), "y": float(sp[1]), "z": float(sp[2])}
        origin = {"x": round(ox, 6), "y": round(oy, 6), "z": round(oz, 6), "yaw": round(oyaw, 6)}
        items.append({
            "name": name,
            "type": marker or "model",
            "static": is_static,
            "movable": marker != "wall",
            "origin": origin,
            "current": live.get(name, origin),
            "size": size,
        })
    return items

# ─── Traffic lights ────────────────────────────────────────────────────
# Phone-stand traffic light (Custom World Builder WB_LIGHT_DEFAULT 폰 시절 지오메트리):
# 정적 스탠드 모델 + 스크린 패널 모델 2개(red/green). 패널은 non-static + gravity off
# 라서 set_pose 서비스로 움직이고 웹 클라이언트에는 dynamic_pose/info로 반영된다.
# 상태 표시 = 포즈 스왑: 켜진 패널은 태블릿 앞면, 꺼진 패널은 지하(-1m).
# 신호등 출처 2가지: ① 뷰어/API로 런타임 배치, ② 월드 파일의 <link name="light"> 모델
# (Custom World Builder가 배치 — 스탠드는 월드에 있고 스크린만 여기서 스폰).
LIGHT_STATES = ("red", "yellow", "green")
LIGHT_TARGETS = ("red", "green")  # 명령 가능한 목적 상태 — 노랑은 자동 경유 전용
YELLOW_S = 3.0                    # green→red 전환 시 노랑 지속 시간
_yellow_timers = {}               # name -> threading.Timer
_lights = {}            # name -> {"x", "y", "yaw", "state"} — 월드 정의 신호등만
_lights_world = None    # world the registry belongs to

# 상태 표시 계약 — 오버레이 포즈-스왑 (2026-08-08 개편):
# visual_config 재질 변경은 서비스가 true를 돌려주면서도 서버 센서 씬(차량
# 카메라)에 반영되지 않는다 (실측: scene/info 재질도 불변 — 런타임 조명 무시와
# 같은 계열). 그래서 카메라에 보이는 상태는 전부 "포즈 스트리밍이 되는 non-static
# 오버레이 모델"로 표현한다 (노랑 오버레이와 동일 기법, 실측 검증):
#   <name>_yellow — 밝은 노랑 디스크 (yellow 상태에 패널 중앙)
#   <name>_red    — 밝은 빨강 디스크 (red 상태에 lamp_red 앞)
#   <name>_gcover — 어두운 초록 디스크 (green이 아닐 때 lamp_green을 덮음 —
#                    월드 SDF의 기본 램프가 "초록 점등"으로 구워져 있기 때문)
# 램프 위치/반지름은 월드 SDF의 lamp_red/lamp_green visual에서 읽는다. 이 visual이
# 없는 구 월드는 오버레이를 못 만들므로 visual_config 폴백만 남는다 (카메라 미반영).
# 웹 뷰어는 상태를 REST로 읽어 three.js 재질을 직접 칠한다 (gzweb.js).
# visual_config 호출은 유지한다 — 지금은 무해한 no-op이고, GUI 클라이언트나
# 이후 gz 버전에서 동작하면 기본 램프 색까지 일치시켜 준다.
_LAMP_COLORS = {
    # state -> {visual: (ambient/diffuse rgb, emissive rgb|None)}
    # 노랑은 visual이 아니라 오버레이 모델(<name>_yellow, 포즈-스왑)이 담당 —
    # 앱과 동일하게 어두운 빨강/초록 위에 밝은 노랑이 겹친다.
    "red": {
        "lamp_red": ("1 0 0", "0.5 0 0"),
        "lamp_green": ("0 0.07 0", None),
    },
    "yellow": {
        "lamp_red": ("0.07 0 0", None),
        "lamp_green": ("0 0.07 0", None),
    },
    "green": {
        "lamp_red": ("0.07 0 0", None),
        "lamp_green": ("0 1 0", "0 0.5 0"),
    },
}
_OVERLAY_HIDDEN_Z = -50.0  # 오버레이 OFF 대기 위치 — 필드 가장자리 밖 시점에서도
                           # 안 보이게 깊이 내린다 (뷰어는 지하 오버레이를 아예 숨김)

# visual_config 는 스코프드 네임을 받지 않는다 (UserCommands VisualCommand:
# ① msg.id(엔티티 ID) ② parent_name(링크 Name 전역 검색) + name(visual 평이름)).
# 링크명이 전부 "light"라 신호등 2개 이상이면 ②는 모호 → scene/info에서 visual
# 엔티티 ID를 수집해 ID로 지정한다 (월드 로드마다 ID가 바뀌므로 매번 재수집).
_visual_ids = {}   # (model_name, visual_name) -> entity id — 현재 월드 기준

def _scan_visual_ids(world):
    """scene/info의 model>link>visual 계층에서 visual 엔티티 ID 수집."""
    _visual_ids.clear()
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/scene/info",
                        "--reqtype", "gz.msgs.Empty",
                        "--reptype", "gz.msgs.Scene",
                        "--timeout", "5000", "--req", "")
        if r.returncode != 0 or not r.stdout:
            return
    except Exception:
        return
    # 텍스트 protobuf 파서: 블록 스택 — 관심 프레임(model/link/visual)의 name/id만 수집
    stack = []
    for raw in r.stdout.splitlines():
        line = raw.strip()
        m = re.match(r'^(\w+)\s*\{$', line)
        if m:
            stack.append({"_type": m.group(1)})
            continue
        if line == "}":
            if not stack:
                continue
            fr = stack.pop()
            if fr["_type"] == "visual" and "name" in fr and "id" in fr:
                model = next((f for f in reversed(stack) if f["_type"] == "model"), None)
                if model and "name" in model:
                    _visual_ids[(model["name"], fr["name"])] = fr["id"]
            continue
        m = re.match(r'^name:\s*"([^"]*)"$', line)
        if m and stack:
            stack[-1].setdefault("name", m.group(1))
            continue
        m = re.match(r'^id:\s*(\d+)$', line)
        if m and stack:
            stack[-1].setdefault("id", int(m.group(1)))
    logging.info("visual ids scanned: %d entries", len(_visual_ids))

def _set_visual_material(world, model, visual, rgb, emissive):
    """visual_config 유저 커맨드 — 서비스는 true를 주지만 센서 씬에는 반영되지
    않는다 (실측). 호환용 best-effort로만 호출된다."""
    vid = _visual_ids.get((model, visual))
    if vid is None:
        _scan_visual_ids(world)
        vid = _visual_ids.get((model, visual))
    r_, g_, b_ = [float(t) for t in rgb.split()]
    er, eg, eb = [float(t) for t in (emissive or "0 0 0").split()]
    if _gz_node is not None:
        try:
            v = _PbVisual()
            if vid is not None:
                v.id = vid
            else:
                # 폴백: 링크명 전역 검색 — 신호등이 하나뿐인 월드에서만 정확
                v.name = visual
                v.parent_name = "light"
            m = v.material
            m.ambient.r, m.ambient.g, m.ambient.b, m.ambient.a = r_, g_, b_, 1.0
            m.diffuse.CopyFrom(m.ambient)
            m.emissive.r, m.emissive.g, m.emissive.b, m.emissive.a = er, eg, eb, 1.0
            rep = _gz_request(f"/world/{world}/visual_config", v, _PbVisual, _PbBoolean)
            if rep is not None:
                return bool(rep.data)
        except Exception:
            pass
    if vid is not None:
        sel = f'id: {vid}'
    else:
        sel = f'name: "{visual}", parent_name: "light"'
    mat = (f'ambient: {{r: {r_}, g: {g_}, b: {b_}, a: 1}}, '
           f'diffuse: {{r: {r_}, g: {g_}, b: {b_}, a: 1}}')
    mat += f', emissive: {{r: {er}, g: {eg}, b: {eb}, a: 1}}'
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/visual_config",
                        "--reqtype", "gz.msgs.Visual",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "3000",
                        "--req", f'{sel}, material: {{{mat}}}')
        ok = r.returncode == 0 and "true" in r.stdout
        if not ok:
            logging.warning("visual_config failed: %s/%s (%s)", model, visual, sel)
        return ok
    except Exception as e:
        logging.warning("visual_config error: %s/%s (%s)", model, visual, e)
        return False

# suffix -> (panel anchor key | None=패널 중앙, ambient/diffuse rgb, emissive rgb)
_OVERLAY_SPECS = {
    "yellow": (None, "1 0.8 0", "0.5 0.4 0"),
    "red": ("red", "1 0 0", "0.5 0 0"),
    "gcover": ("green", "0 0.07 0", "0 0 0"),
}

def _overlay_states(state):
    """suffix -> ON? — 기본 램프가 '초록 점등'으로 구워져 있다는 전제의 상태표."""
    return {
        "yellow": state == "yellow",
        "red": state == "red",
        "gcover": state != "green",
    }

def _overlay_anchor(pn, suffix):
    """오버레이의 모델-로컬 앵커 {px, pz, r} — 없으면 None (구 월드)."""
    key = _OVERLAY_SPECS[suffix][0]
    if key is None:
        return {"px": pn["px"], "pz": pn["pz"], "r": pn["lamp_r"]}
    return pn.get(key)

def _overlay_pose_at(sig, anchor, on):
    """오버레이 월드 포즈 — ON: 앵커 위치, OFF: 지하."""
    if not on:
        return sig["x"], sig["y"], _OVERLAY_HIDDEN_Z
    wx = sig["x"] + math.cos(sig["yaw"]) * anchor["px"]
    wy = sig["y"] + math.sin(sig["yaw"]) * anchor["px"]
    return wx, wy, anchor["pz"]

def _apply_light_state(world, name, sig):
    """오버레이 포즈-스왑이 카메라에 보이는 진실. visual_config는 호환용."""
    ok = True
    pn = sig.get("panel")
    if pn:
        on = _overlay_states(sig["state"])
        for suffix in _OVERLAY_SPECS:
            anchor = _overlay_anchor(pn, suffix)
            if not anchor:
                continue
            wx, wy, wz = _overlay_pose_at(sig, anchor, on[suffix])
            ok = _set_entity_pose(world, f"{name}_{suffix}", wx, wy, wz,
                                  sig["yaw"], pn["pitch"]) and ok
    for lamp, (rgb, emissive) in _LAMP_COLORS[sig["state"]].items():
        _set_visual_material(world, name, lamp, rgb, emissive)
    return ok

def _spawn_light_overlays(world, name, sig):
    """상태 오버레이 모델 스폰 (라이트당 최대 3개: yellow/red/gcover, 평상시
    지하 — non-static이라 포즈가 스트리밍되어 뷰어와 서버 카메라 렌더 모두에
    반영된다. 램프 재질은 visual_config로 못 바꾸므로 이 포즈-스왑이 유일하게
    카메라에 보이는 상태 표현이다)."""
    pn = sig.get("panel")
    if not pn:
        return
    os.makedirs(_OVERLAY_SDF_DIR, exist_ok=True)
    on = _overlay_states(sig["state"])
    for suffix, (_key, rgb, emissive) in _OVERLAY_SPECS.items():
        anchor = _overlay_anchor(pn, suffix)
        if not anchor:
            continue   # old worlds without lamp_red/lamp_green visuals
        model = f"{name}_{suffix}"
        path = os.path.join(_OVERLAY_SDF_DIR, f"{model}.sdf")
        with open(path, "w") as f:
            f.write(f"""<?xml version="1.0"?>
<sdf version="1.7">
<model name="{model}">
  <static>false</static>
  <link name="link">
    <gravity>false</gravity>
    <inertial>
      <mass>0.01</mass>
      <inertia>
        <ixx>0.00001</ixx><ixy>0</ixy><ixz>0</ixz>
        <iyy>0.00001</iyy><iyz>0</iyz>
        <izz>0.00001</izz>
      </inertia>
    </inertial>
    <visual name="lamp">
      <pose>0 0 0 0 1.5708 0</pose>
      <geometry><cylinder><radius>{anchor["r"]}</radius><length>0.0015</length></cylinder></geometry>
      <material><ambient>{rgb} 1</ambient><diffuse>{rgb} 1</diffuse><emissive>{emissive} 1</emissive></material>
    </visual>
  </link>
</model>
</sdf>
""")
        wx, wy, wz = _overlay_pose_at(sig, anchor, on[suffix])
        try:
            r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/create",
                            "--reqtype", "gz.msgs.EntityFactory",
                            "--reptype", "gz.msgs.Boolean",
                            "--timeout", "5000",
                            "--req", f'sdf_filename: "{path}", name: "{model}", '
                                     f'pose: {{{_pose_fields(wx, wy, wz, sig["yaw"], pn["pitch"])}}}')
            if r.returncode != 0 or "true" not in r.stdout:
                # 같은 월드 재스캔이면 이미 존재 — 위치만 맞춘다
                _set_entity_pose(world, model, wx, wy, wz, sig["yaw"], pn["pitch"])
        except Exception as e:
            logging.warning("light overlay spawn failed: %s (%s)", model, e)

# ── Scene brightness factor (presentation layer) ───────────────────────────
# The gz sensor render scene ignores runtime light changes (verified: even
# deleting the sun leaves the camera image untouched), and restarting the
# world per change is terrible UX. Instead this factor is applied instantly
# by the consumers: the web viewer scales its lights, and the webserver
# scales the camera frames (shadows are off in these worlds, so pixel
# scaling is visually equivalent to light scaling). Single server-side
# value -> every browser stays in sync. Persisted across restarts.
_BRIGHTNESS_FILE = "/opt/physicar/userdata/sim_brightness.json"
_brightness = 1.0

def _load_brightness():
    global _brightness
    try:
        with open(_BRIGHTNESS_FILE) as f:
            v = float(json.load(f).get("value", 1.0))
        _brightness = min(2.0, max(0.2, v))
    except Exception:
        _brightness = 1.0

def _save_brightness(v):
    global _brightness
    _brightness = min(2.0, max(0.2, float(v)))
    try:
        os.makedirs(os.path.dirname(_BRIGHTNESS_FILE), exist_ok=True)
        with open(_BRIGHTNESS_FILE, "w") as f:
            json.dump({"value": _brightness}, f)
    except Exception:
        logging.exception("brightness save failed")

_load_brightness()

_OVERLAY_SDF_DIR = "/tmp/physicar_light_overlays"

def _pose_fields(x, y, z, yaw, pitch=0.0):
    """Protobuf text for a gz.msgs.Pose (yaw ⊗ pitch)."""
    sy, cy = math.sin(yaw / 2), math.cos(yaw / 2)
    sp, cp = math.sin(pitch / 2), math.cos(pitch / 2)
    # q = qz(yaw) ⊗ qy(pitch)
    qx, qy, qz, qw = -sy * sp, cy * sp, cp * sy, cy * cp
    return (f'position: {{x: {x:.6f}, y: {y:.6f}, z: {z:.6f}}}, '
            f'orientation: {{x: {qx:.6f}, y: {qy:.6f}, z: {qz:.6f}, w: {qw:.6f}}}')

def _set_entity_pose(world, name, x, y, z, yaw, pitch=0.0):
    if _gz_node is not None:
        try:
            p = _PbPose()
            p.name = name
            p.position.x, p.position.y, p.position.z = x, y, z
            sy, cy = math.sin(yaw / 2), math.cos(yaw / 2)
            sp, cp = math.sin(pitch / 2), math.cos(pitch / 2)
            # q = qz(yaw) ⊗ qy(pitch) — same math as _pose_fields
            p.orientation.x, p.orientation.y = -sy * sp, cy * sp
            p.orientation.z, p.orientation.w = cp * sy, cy * cp
            rep = _gz_request(f"/world/{world}/set_pose", p, _PbPose, _PbBoolean)
            if rep is not None:
                return bool(rep.data)
        except Exception:
            pass
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/set_pose",
                        "--reqtype", "gz.msgs.Pose",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "3000",
                        "--req", f'name: "{name}", {_pose_fields(x, y, z, yaw, pitch)}')
        return r.returncode == 0 and "true" in r.stdout
    except Exception:
        return False

def _move_light(world, name, x, y, yaw):
    """신호등 텔레포트 — 스탠드 set_pose(z=0·yaw-only = 재기립) + 노랑 오버레이 동반.
    램프 visual은 링크 소속이라 함께 움직인다. 노랑 경유 중에도 이동 허용."""
    with _lock:
        sig = _lights.get(name)
        if sig is None:
            return False, None, "light not found"
        sig = dict(sig, x=round(x, 6), y=round(y, 6), yaw=round(yaw, 6))
        _lights[name] = sig
    ok = _set_entity_pose(world, name, x, y, 0.0, yaw)
    pn = sig.get("panel")
    if pn:
        on = _overlay_states(sig["state"])
        for suffix in _OVERLAY_SPECS:
            anchor = _overlay_anchor(pn, suffix)
            if not anchor:
                continue
            wx, wy, wz = _overlay_pose_at(sig, anchor, on[suffix])
            _set_entity_pose(world, f"{name}_{suffix}", wx, wy, wz, sig["yaw"], pn["pitch"])
    return ok, sig, (None if ok else "pose change failed")

def _set_light_target(world, name, target):
    """목적 상태 적용. green→red 는 노랑(YELLOW_S초) 자동 경유, 경유 중엔 명령 잠금."""
    with _lock:
        sig = _lights.get(name)
        if sig is None:
            return False, None, "light not found"
        if sig["state"] == "yellow":
            return False, sig, "yellow transition in progress"
        if sig["state"] == target:
            return True, sig, None
        via_yellow = (sig["state"] == "green" and target == "red")
        sig = dict(sig, state="yellow" if via_yellow else target)
        if via_yellow:
            # Clients schedule their next poll right after this deadline so
            # panel/lamp colors flip in step with the 3D overlays.
            sig["yellow_until"] = round(time.time() + YELLOW_S, 3)
        else:
            sig.pop("yellow_until", None)
        _lights[name] = sig
    if not _apply_light_state(world, name, sig):
        return False, sig, "state change failed"
    if via_yellow:
        t = threading.Timer(YELLOW_S, _finish_yellow, args=(world, name, target))
        t.daemon = True
        _yellow_timers[name] = t
        t.start()
    return True, sig, None

def _light_pose_watcher():
    """물리 충돌 추적 — 차량이 신호등을 밀면 물리 엔진이 모델을 옮기지만 등록
    포즈(sig)와 오버레이는 API 경로만 갱신했다. dynamic_pose 캐시의 실좌표와
    sig가 어긋나면 sig를 따라 옮기고 오버레이를 재배치한다 (0.3s 주기, 오버레이
    이동은 in-process 노드라 ms 단위)."""
    while True:
        time.sleep(0.3)
        try:
            with _lock:
                world = _current_world
                switching = _switching
                lights = dict(_lights)
            if not world or switching or not lights:
                continue
            for name, sig in lights.items():
                with _gz_cache_lock:
                    p = _gz_poses.get(name)
                if not p:
                    continue
                d_ang = abs((p["yaw"] - sig["yaw"] + math.pi) % (2 * math.pi) - math.pi)
                if (abs(p["x"] - sig["x"]) < 0.02 and abs(p["y"] - sig["y"]) < 0.02
                        and d_ang < 0.05):
                    continue
                with _lock:
                    cur = _lights.get(name)
                    if cur is None or cur["state"] != sig["state"]:
                        continue   # state changed mid-check — next tick catches up
                    sig = dict(cur, x=round(p["x"], 6), y=round(p["y"], 6),
                               yaw=round(p["yaw"], 6))
                    _lights[name] = sig
                _apply_light_state(world, name, sig)
        except Exception:
            logging.exception("light pose watcher")

def _finish_yellow(world, name, target):
    with _lock:
        _yellow_timers.pop(name, None)
        sig = _lights.get(name)
        if sig is None or sig["state"] != "yellow":
            return
        sig = dict(sig, state=target)
        sig.pop("yellow_until", None)
        _lights[name] = sig
    _apply_light_state(world, name, sig)
    logging.info("light %s: yellow -> %s", name, target)

def _scan_world_lights(world):
    """Register world-defined traffic lights (link 마커 — Custom World Builder 배치).

    스탠드는 월드 파일에 이미 있으므로 스크린 패널만 스폰하면 된다.
    기본 상태는 green (DeepRacer 주행 기본과 동일). 같은 월드 respawn 시
    기존 등록 상태를 유지한다.
    """
    import xml.etree.ElementTree as ET
    path = os.path.join(WORLDS_DIR, f"{world}.world")
    if not os.path.isfile(path):
        return
    try:
        root = ET.parse(path).getroot()
    except Exception:
        return
    world_el = root.find("world")
    if world_el is None:
        return
    seen = set()
    for m in world_el.findall("model"):
        name = m.get("name") or ""
        # 신호등 판별: link 이름이 'light' (Custom World Builder 계약 마커 —
        # 모델명은 사용자 이름이라 이름으로는 구분 불가. 'signal'은 구 마커)
        sig_link = None
        for lk in m.findall("link"):
            if lk.get("name") in ("light", "signal"):  # 'signal' = 구 마커 (기존 월드 호환)
                sig_link = lk
                break
        if sig_link is None:
            continue
        x = y = yaw = 0.0
        pose_el = m.find("pose")
        if pose_el is not None and pose_el.text:
            parts = pose_el.text.split()
            if len(parts) >= 6:
                x, y, yaw = float(parts[0]), float(parts[1]), float(parts[5])
        # 자기기술 계약: screen visual의 pose(pitch=-tilt)/size → 노랑 오버레이 배치
        # (지름 = min(가로×0.98, 세로×0.41) — 앱과 동일, 화면 앞 0.4mm).
        # lamp_red/lamp_green visual의 로컬 pose/반지름 → 빨강/초록커버 오버레이 앵커.
        panel = None
        lamps = {}
        for v in sig_link.findall("visual"):
            nm = v.get("name")
            if nm in ("lamp_red", "lamp_green"):
                try:
                    vp = [float(t) for t in (v.findtext("pose") or "0 0 0 0 0 0").split()]
                    rad = float(v.findtext(".//cylinder/radius") or 0)
                    ln = float(v.findtext(".//cylinder/length") or 0.0015)
                    if rad > 0:
                        lamps[nm] = {"lx": vp[0], "lz": vp[2], "r": round(rad, 5), "len": ln}
                except Exception:
                    pass
                continue
            if nm != "screen" or panel is not None:
                continue
            try:
                vp = [float(t) for t in (v.findtext("pose") or "0 0 0 0 0 0").split()]
                sz = [float(t) for t in (v.findtext(".//box/size") or "0.003 0.166 0.295").split()]
                tilt = -vp[4]
                foff = sz[0] / 2 + 0.0015 / 2 + 0.0004  # 화면 앞 0.4mm + 디스크 절반
                panel = {
                    "px": round(vp[0] + math.cos(tilt) * foff, 6),
                    "pz": round(vp[2] + math.sin(tilt) * foff, 6),
                    "pitch": round(vp[4], 6),
                    "lamp_r": round(min(sz[1] * 0.98, sz[2] * 0.41) / 2, 5),
                }
            except Exception:
                panel = None
        if panel:
            tilt = -panel["pitch"]
            for key, lm in (("red", lamps.get("lamp_red")), ("green", lamps.get("lamp_green"))):
                if not lm:
                    continue
                doff = lm["len"] / 2 + 0.0015 / 2 + 0.0004  # 램프 앞 0.4mm + 디스크 절반
                panel[key] = {
                    "px": round(lm["lx"] + math.cos(tilt) * doff, 6),
                    "pz": round(lm["lz"] + math.sin(tilt) * doff, 6),
                    "r": lm["r"],
                }
            # 노랑 디스크는 패널 중앙에 떠서 램프 커버 디스크들과 세로로 겹친다.
            # 커버는 (기울어진) 패널 면에서 법선으로 ~3mm 떠 있으므로, 노랑을
            # 법선 방향으로 +3mm 더 밀어 겹침 구간에서 항상 커버 앞에 오게 한다.
            # (램프의 로컬 x를 그대로 비교하면 안 된다 — 기울어진 판에서는 낮은
            # 램프일수록 x가 클 뿐, 면에서 떨어져 있는 게 아니다.)
            if "red" in panel or "green" in panel:
                extra = 0.003
                panel["px"] = round(panel["px"] + math.cos(tilt) * extra, 6)
                panel["pz"] = round(panel["pz"] + math.sin(tilt) * extra, 6)
        with _lock:
            existing = _lights.get(name)
            prev_state = existing["state"] if existing else "green"
            if prev_state == "yellow":
                prev_state = "red"  # 경유 중 리로드 — 목적 상태로 정리
            sig = {
                "x": round(x, 6), "y": round(y, 6), "yaw": round(yaw, 6),
                "state": prev_state,
                "builtin": True,
            }
            if panel:
                sig["panel"] = panel
            _lights[name] = sig
        seen.add(name)
        logging.info("world light registered: %s", name)
        _spawn_light_overlays(world, name, sig)
        # 익스포트 SDF는 초록 점등으로 구워져 있음 — 보존 상태가 다르면 색 복원
        if sig["state"] != "green":
            _apply_light_state(world, name, sig)
    # 이전 월드 파일 버전의 잔재 정리 (같은 이름 월드가 교체 업로드된 경우)
    with _lock:
        for stale in [n for n in _lights if n not in seen]:
            _lights.pop(stale, None)

# ─── Track bounds ──────────────────────────────────────────────────────
_track_bounds_cache = {}

def _get_track_bounds(world_name):
    """Get track surface bounds from collision mesh DAE."""
    if world_name in _track_bounds_cache:
        return _track_bounds_cache[world_name]
    sdf_files = glob.glob(os.path.join(SHARE_DIR, "models", world_name, "*.sdf"))
    if not sdf_files:
        return None
    try:
        with open(sdf_files[0]) as f:
            sdf = f.read()
        coll = re.search(r'<collision[^>]*>(.*?)</collision>', sdf, re.DOTALL)
        if not coll:
            return None
        uri = re.search(r'<uri>(?:model://)?(.+?)</uri>', coll.group(1))
        if not uri:
            return None
        mesh_path = os.path.join(SHARE_DIR, uri.group(1))
        if not os.path.isfile(mesh_path):
            return None
        with open(mesh_path) as f:
            dae = f.read()
        pos = re.search(r'<float_array[^>]*positions[^>]*>([^<]+)</float_array>', dae)
        if not pos:
            return None
        vals = [float(v) for v in pos.group(1).split()]
        if len(vals) < 6:
            return None
        xs, ys = vals[0::3], vals[1::3]
        result = {"minX": min(xs), "maxX": max(xs), "minY": min(ys), "maxY": max(ys)}
        _track_bounds_cache[world_name] = result
        return result
    except Exception:
        return None

def start_sim(world_file):
    """Start simulation for given world file. Kills existing sim first."""
    global _sim_proc, _current_world, _switching, _switching_since, _lights_world
    with _lock:
        _switching = True
        _switching_since = time.time()
    logging.info("starting sim: %s", world_file)
    try:
        path = os.path.join(WORLDS_DIR, world_file)
        if not os.path.isfile(path):
            logging.error("world file not found: %s", path)
            with _lock:
                _switching = False
            return False
        wname = _get_world_name(world_file)

        # Traffic lights survive a respawn (same world) but not a world switch
        with _lock:
            if _lights_world != wname:
                _lights.clear()
                _lights_world = wname

        # Kill existing
        _kill_all_gz()
        with _lock:
            _current_world = None

        # Start new gz sim (renice after start for higher CPU priority)
        env = _gz_env()
        proc = subprocess.Popen(
            ["gz", "sim", "-s", "--headless-rendering", path],
            env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True
        )
        # Elevate CPU priority to prevent starvation under load
        try:
            subprocess.run(
                ["sudo", "renice", "-n", "-5", "-p", str(proc.pid)],
                timeout=3, capture_output=True
            )
        except Exception:
            pass
        logging.info("gz sim started (PID %d)", proc.pid)

        with _lock:
            _sim_proc = proc
            _current_world = os.path.splitext(world_file)[0]
        _save_last_world(world_file)

        # Post-start: wait for sim ready → unpause → spawn → start websocket
        if wname:
            def post_start():
                global _switching
                try:
                    ready = False
                    for i in range(120):  # 60 seconds max
                        time.sleep(0.5)
                        if proc.poll() is not None:
                            logging.error("gz sim died during startup (exit %s)", proc.returncode)
                            return
                        try:
                            r = _run_gz_cmd("gz", "topic", "-l", timeout=3)
                            if f"/world/{wname}/clock" in r.stdout:
                                ready = True
                                break
                        except Exception:
                            pass
                    if not ready:
                        logging.error("gz sim not ready after 60s")
                        return
                    logging.info("gz sim ready, unpausing world '%s'", wname)
                    _run_gz_cmd("gz", "service", "-s", f"/world/{wname}/control",
                                "--reqtype", "gz.msgs.WorldControl",
                                "--reptype", "gz.msgs.Boolean",
                                "--timeout", "3000", "--req", "pause: false")
                    pose = _spawn_pose(wname)
                    _run_gz_cmd("gz", "service", "-s", f"/world/{wname}/create",
                                "--reqtype", "gz.msgs.EntityFactory",
                                "--reptype", "gz.msgs.Boolean",
                                "--timeout", "5000",
                                "--req", f'sdf_filename: "model://{VEHICLE_NAME}", pose: {{{pose}}}, name: "{VEHICLE_NAME}"')
                    # Verify sim is still alive before starting websocket
                    if proc.poll() is not None:
                        logging.error("gz sim died after spawn (exit %s)", proc.returncode)
                        return
                    _scan_visual_ids(wname)
                    _scan_world_lights(wname)
                    logging.info("physicar spawned, starting gz-launch")
                    _start_launch()
                    # The ros_gz bridge can come up mid-switch and wedge on the
                    # dead gz instance (process alive, transport silent — no
                    # camera/lidar/drive). Kill it now that the new instance is
                    # fully up; the ROS launch respawns it in ~2 s, giving a
                    # deterministic "gz first, bridge second" attach order.
                    subprocess.run(["pkill", "-f", "ros_gz_bridge/parameter_bridge"],
                                   timeout=5, capture_output=True)
                    logging.info("ros_gz bridge restarted against the new world")
                finally:
                    with _lock:
                        _switching = False
            threading.Thread(target=post_start, daemon=True).start()
        else:
            with _lock:
                _switching = False
        return True
    except Exception as e:
        logging.error("start_sim failed: %s", e)
        with _lock:
            _switching = False
        return False

def _check_gz_transport_health(world):
    """Check if gz-transport is responsive by querying topic list.
    Returns True if healthy, False if unresponsive."""
    try:
        r = subprocess.run(
            ["gz", "topic", "-l"],
            env=_gz_env(), capture_output=True, text=True,
            timeout=_HEALTH_TIMEOUT
        )
        if r.returncode != 0 or not r.stdout.strip():
            return False
        # Verify the world's clock topic exists (proof sim is actually running)
        if world and f"/world/{world}/clock" not in r.stdout:
            return False
        return True
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return False

def _watchdog():
    """Monitor gz sim + gz-launch. Restart on crash or hung state."""
    global _switching, _fail_count, _health_counter
    logging.info("watchdog started")
    while True:
        time.sleep(5)
        try:
            _cleanup_stale_uploads()

            with _lock:
                if _switching:
                    elapsed = time.time() - _switching_since
                    if elapsed > _SWITCH_TIMEOUT:
                        logging.warning("switching timeout (%.0fs), force-resetting", elapsed)
                        _switching = False
                        _fail_count = 0
                    else:
                        continue
                proc = _sim_proc
                launch = _launch_proc
                world = _current_world

            sim_alive = proc is not None and proc.poll() is None
            launch_alive = launch is not None and launch.poll() is None

            if sim_alive and launch_alive:
                # Process alive — but is gz-transport actually responsive?
                _health_counter += 1
                if _health_counter % _HEALTH_INTERVAL == 0:
                    if not _check_gz_transport_health(world):
                        logging.warning(
                            "gz sim (PID %d) alive but gz-transport unresponsive, restarting",
                            proc.pid
                        )
                        wfile = (world + ".world") if world else _load_boot_world()
                        if os.path.isfile(os.path.join(WORLDS_DIR, wfile)):
                            start_sim(wfile)
                        continue
                _fail_count = 0
                continue

            if sim_alive and not launch_alive:
                logging.warning("gz-launch not running, restarting")
                _start_launch()
                continue

            # gz sim is dead — restart immediately, give up after _MAX_FAILS
            if _fail_count >= _MAX_FAILS:
                continue  # stopped — wait for manual /switch

            _fail_count += 1
            wfile = (world + ".world") if world else _load_boot_world()
            if os.path.isfile(os.path.join(WORLDS_DIR, wfile)):
                logging.warning("gz sim not running, restarting %s (%d/%d)", wfile, _fail_count, _MAX_FAILS)
                start_sim(wfile)
        except Exception as e:
            logging.error("watchdog error: %s", e)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/vehicle":
            # Vehicle profile for the viewer — same source the sim spawns from
            self._json(200, VEHICLE)
        elif self.path == "/brightness":
            self._json(200, {"value": _brightness})
        elif self.path == "/worlds":
            worlds = sorted(glob.glob(os.path.join(WORLDS_DIR, "*.world")))
            items = []
            for w in worlds:
                name = os.path.splitext(os.path.basename(w))[0]
                # Only imported worlds (custom_ prefix) are deletable; everything
                # else ships with the sim and counts as official.
                items.append({"name": name, "file": os.path.basename(w),
                              "deletable": name.startswith("custom_") and name not in PROTECTED_NAMES})
            # Protected (built-in) worlds first, then alphabetical
            items.sort(key=lambda x: (x["deletable"], x["name"]))
            with _lock:
                current = _current_world
            self._json(200, {"worlds": items, "current": current})
        elif self.path == "/events":
            # SSE: push a status snapshot whenever it changes, so clients
            # (e.g. the app.physicar world select) need no polling
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")   # no proxy buffering
            self.end_headers()
            last, last_beat = None, time.monotonic()
            try:
                while True:
                    with _lock:
                        snap = {
                            "running": _sim_proc is not None and _sim_proc.poll() is None,
                            "websocket": _launch_proc is not None and _launch_proc.poll() is None,
                            "current": _current_world,
                            "switching": _switching,
                        }
                    if snap != last:
                        self.wfile.write(f"data: {json.dumps(snap)}\n\n".encode())
                        self.wfile.flush()
                        last, last_beat = snap, time.monotonic()
                    elif time.monotonic() - last_beat > 15:
                        self.wfile.write(b": keep-alive\n\n")   # comment ping
                        self.wfile.flush()
                        last_beat = time.monotonic()
                    time.sleep(1)
            except (BrokenPipeError, ConnectionResetError):
                return
        elif self.path == "/status":
            with _lock:
                proc = _sim_proc
                launch = _launch_proc
                current = _current_world
                switching = _switching
            sim_ok = proc is not None and proc.poll() is None
            ws_ok = launch is not None and launch.poll() is None
            # Version key for the viewer's mesh/texture URLs (?v=...): the
            # asset dirs' mtime, so a world re-upload changes every URL and
            # bypasses the browser cache instantly (see gzweb.js).
            version = 0
            for p in (os.path.join(SHARE_DIR, "meshes", current or ""),
                      os.path.join(SHARE_DIR, "models")):
                try:
                    version = max(version, int(os.path.getmtime(p)))
                except OSError:
                    pass
            self._json(200, {
                "running": sim_ok,
                "websocket": ws_ok,
                "current": current,
                "switching": switching,
                "assets_version": version
            })
        elif self.path == "/bounds":
            with _lock:
                world = _current_world
            if not world:
                self._json(404, {"error": "no world running"})
                return
            bounds = _get_track_bounds(world)
            if bounds:
                self._json(200, bounds)
            else:
                self._json(404, {"error": "bounds not available"})
        elif self.path == "/objects":
            with _lock:
                world = _current_world
            if not world:
                self._json(404, {"error": "no world running"})
                return
            items = _get_builtin_obstacles(world)
            if items is None:
                self._json(404, {"error": "world file not found"})
                return
            self._json(200, {"world": world, "objects": items})
        elif self.path == "/clock":
            with _gz_cache_lock:
                c = dict(_gz_clock)
            if c:
                self._json(200, c)
            else:
                self._json(503, {"error": "clock not available yet"})
        elif self.path == "/pose":
            with _lock:
                world = _current_world
            if not world:
                self._json(404, {"error": "no world running"})
                return
            pose = _get_vehicle_pose(world)
            if pose:
                self._json(200, pose)
            else:
                self._json(503, {"error": "pose not available"})
        elif self.path == "/route":
            with _lock:
                world = _current_world
            if not world:
                self._json(404, {"error": "no world running"})
                return
            route = _get_route_full(world)
            if route is not None:
                self._json(200, {"world": world, **route})
            else:
                self._json(404, {"error": "route not available"})
        elif self.path == "/traffic_lights":
            with _lock:
                world = _current_world
                now = time.time()
                items = []
                for n, s in sorted(_lights.items()):
                    d = {"name": n, **s}
                    u = d.pop("yellow_until", None)
                    if u is not None:
                        # remaining seconds, not an absolute time — immune to
                        # client/server clock skew
                        d["yellow_left"] = round(max(0.0, u - now), 3)
                    items.append(d)
            self._json(200, {"world": world, "lights": items})
        elif self.path == "/overlay":
            text = _overlay_text if time.monotonic() < _overlay_expiry else ""
            self._json(200, {"text": text})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        global _sim_proc, _current_world, _launch_proc, _fail_count, \
            _overlay_text, _overlay_expiry
        if self.path == "/overlay":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            _overlay_text = str(body.get("text", ""))[:300]
            try:
                ttl = min(max(float(body.get("ttl", 10)), 1.0), 3600.0)
            except (TypeError, ValueError):
                ttl = 10.0
            _overlay_expiry = time.monotonic() + ttl
            self._json(200, {"ok": True})
        elif self.path == "/brightness":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            try:
                v = float(body.get("value"))
            except (TypeError, ValueError):
                self._json(400, {"error": "value must be a number (0.2-2.0)"})
                return
            if not (0.2 <= v <= 2.0):
                self._json(400, {"error": "value out of range (0.2-2.0)"})
                return
            _save_brightness(v)
            self._json(200, {"ok": True, "value": _brightness})
        elif self.path == "/respawn":
            with _lock:
                world = _current_world
            if not world:
                self._json(404, {"error": "no world running"})
                return
            # Reload the whole world so all objects (vehicle and built-in
            # models) return to their original positions.
            _fail_count = 0
            threading.Thread(target=start_sim, args=(f"{world}.world",), daemon=True).start()
            self._json(200, {"ok": True, "world": f"{world}.world"})
        elif self.path == "/switch":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            world_file = body.get("world", "")
            if not re.match(r'^[\w]+\.world$', world_file):
                self._json(400, {"error": "invalid world file name"})
                return
            if not os.path.isfile(os.path.join(WORLDS_DIR, world_file)):
                self._json(404, {"error": "world not found"})
                return
            _fail_count = 0
            threading.Thread(target=start_sim, args=(world_file,), daemon=True).start()
            self._json(200, {"ok": True, "world": world_file})
        elif self.path.split("?", 1)[0] == "/upload":
            content_type = self.headers.get("Content-Type", "")
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > MAX_UPLOAD_SIZE:
                self._json(413, {"error": f"file too large (max {MAX_UPLOAD_SIZE // 1024 // 1024}MB)"})
                return
            if "multipart/form-data" not in content_type:
                self._json(400, {"error": "expected multipart/form-data"})
                return
            boundary = None
            for part in content_type.split(";"):
                part = part.strip()
                if part.startswith("boundary="):
                    boundary = part[9:].strip('"')
            if not boundary:
                self._json(400, {"error": "missing boundary"})
                return
            raw = self.rfile.read(content_length)
            boundary_bytes = ("--" + boundary).encode()
            parts = raw.split(boundary_bytes)
            file_data = None
            filename = None
            for part in parts:
                if b"Content-Disposition" in part and b"filename=" in part:
                    header_end = part.find(b"\r\n\r\n")
                    if header_end < 0:
                        continue
                    header = part[:header_end].decode("utf-8", errors="replace")
                    fm = re.search(r'filename="([^"]+)"', header)
                    if fm:
                        filename = fm.group(1)
                    file_data = part[header_end + 4:]
                    if file_data.endswith(b"\r\n"):
                        file_data = file_data[:-2]
            if not file_data or not filename:
                self._json(400, {"error": "no file in upload"})
                return
            if not filename.endswith(".tar.gz"):
                self._json(400, {"error": "file must be .tar.gz"})
                return
            with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
                tmp.write(file_data)
                tmp_path = tmp.name
            try:
                ok, err, world_name = _validate_tar(tmp_path)
                if not ok:
                    self._json(400, {"error": err})
                    return
                if world_name in PROTECTED_NAMES:
                    self._json(403, {"error": f"cannot overwrite protected world: {world_name}"})
                    return
                exists = os.path.isfile(os.path.join(WORLDS_DIR, f"{world_name}.world"))
                overwrite = "overwrite=1" in (self.path.split("?", 1) + [""])[1]
                if exists and not overwrite:
                    # Duplicate name: never replace silently. The client asks the
                    # user and re-uploads with ?overwrite=1.
                    self._json(409, {"error": "exists", "world": world_name})
                    return
                if exists:
                    _delete_world_files(world_name)
                _extract_world(tmp_path, world_name)
                self._json(200, {"ok": True, "world": world_name})
            finally:
                os.unlink(tmp_path)
        elif self.path == "/upload/init":
            # Chunked upload: initialize session
            _cleanup_stale_uploads()
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            filename = body.get("filename", "")
            total_size = body.get("size", 0)
            if not filename.endswith(".tar.gz"):
                self._json(400, {"error": "file must be .tar.gz"})
                return
            if total_size > MAX_UPLOAD_SIZE:
                self._json(413, {"error": f"file too large (max {MAX_UPLOAD_SIZE // 1024 // 1024}MB)"})
                return
            import uuid
            upload_id = str(uuid.uuid4())
            tmp = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
            tmp.close()
            with _upload_lock:
                _upload_sessions[upload_id] = {
                    "path": tmp.name,
                    "filename": filename,
                    "size": total_size,
                    "received": 0,
                    "last_activity": time.time()
                }
            logging.info("upload init: %s (%s, %d bytes)", upload_id, filename, total_size)
            self._json(200, {"ok": True, "upload_id": upload_id, "chunk_size": CHUNK_SIZE})
        elif self.path == "/upload/chunk":
            # Chunked upload: receive chunk
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            upload_id = body.get("upload_id", "")
            chunk_index = body.get("chunk_index", 0)
            chunk_data = body.get("data", "")
            with _upload_lock:
                session = _upload_sessions.get(upload_id)
            if not session:
                self._json(404, {"error": "upload session not found"})
                return
            import base64
            try:
                data = base64.b64decode(chunk_data)
            except Exception:
                self._json(400, {"error": "invalid chunk data"})
                return
            with open(session["path"], "r+b" if os.path.exists(session["path"]) else "wb") as f:
                f.seek(chunk_index * CHUNK_SIZE)
                f.write(data)
            with _upload_lock:
                session["received"] += len(data)
                session["last_activity"] = time.time()
            self._json(200, {"ok": True, "received": session["received"]})
        elif self.path == "/upload/complete":
            # Chunked upload: finalize and validate
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            upload_id = body.get("upload_id", "")
            with _upload_lock:
                session = _upload_sessions.get(upload_id)
            if not session:
                self._json(404, {"error": "upload session not found"})
                return
            tmp_path = session["path"]
            keep_session = False
            try:
                ok, err, world_name = _validate_tar(tmp_path)
                if not ok:
                    self._json(400, {"error": err})
                    return
                if world_name in PROTECTED_NAMES:
                    self._json(403, {"error": f"cannot overwrite protected world: {world_name}"})
                    return
                exists = os.path.isfile(os.path.join(WORLDS_DIR, f"{world_name}.world"))
                if exists and not body.get("overwrite"):
                    # Duplicate name: never replace silently. Keep the uploaded
                    # file so the client can confirm and re-complete with
                    # {"overwrite": true} (or /upload/cancel) — no re-upload.
                    keep_session = True
                    with _upload_lock:
                        if upload_id in _upload_sessions:
                            _upload_sessions[upload_id]["last_activity"] = time.time()
                    self._json(409, {"error": "exists", "world": world_name})
                    return
                if exists:
                    _delete_world_files(world_name)
                _extract_world(tmp_path, world_name)
                logging.info("upload complete: %s -> %s", upload_id, world_name)
                self._json(200, {"ok": True, "world": world_name})
            except Exception as e:
                # 예외를 밖으로 흘리면 요청 스레드가 죽어 클라이언트는 원인 없는 502를
                # 받는다 (실사례: share/ 가 root 소유라 PermissionError → 502).
                logging.exception("upload complete failed: %s", upload_id)
                self._json(500, {"error": f"import failed: {type(e).__name__}: {e}"})
            finally:
                if not keep_session:
                    try:
                        os.unlink(tmp_path)
                    except Exception:
                        pass
                    with _upload_lock:
                        if upload_id in _upload_sessions:
                            del _upload_sessions[upload_id]
        elif self.path == "/upload/cancel":
            # Chunked upload: cancel and cleanup
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            upload_id = body.get("upload_id", "")
            with _upload_lock:
                session = _upload_sessions.pop(upload_id, None)
            if session:
                try:
                    os.unlink(session["path"])
                except Exception:
                    pass
                logging.info("upload cancelled: %s", upload_id)
            self._json(200, {"ok": True})
        elif self.path == "/pose":
            # 차량 텔레포트 — 생략된 좌표는 현재 포즈 유지.
            # z=0.05·roll/pitch=0 으로 정규화: 뒤집힌/올라탄 차를 일으켜 세우는 동작 겸용.
            # 주의: odom(라이다 PLICP + IMU EKF)은 텔레포트를 모름 — 추정치에 오프셋이
            # 남을 수 있다. 완전한 초기화가 필요하면 /respawn (odom 스택도 재시작됨).
            with _lock:
                world = _current_world
                switching = _switching
            if not world or switching:
                self._json(409, {"error": "world not ready"})
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            try:
                x = None if body.get("x") is None else float(body.get("x"))
                y = None if body.get("y") is None else float(body.get("y"))
                yaw = None if body.get("yaw") is None else float(body.get("yaw"))
            except (TypeError, ValueError):
                self._json(400, {"error": "x, y, yaw must be numbers"})
                return
            if x is None or y is None or yaw is None:
                cur = _get_vehicle_pose(world)
                if cur is None:
                    self._json(503, {"error": "current pose not available"})
                    return
                x = cur["x"] if x is None else x
                y = cur["y"] if y is None else y
                yaw = cur["yaw"] if yaw is None else yaw
            if not (-100 <= x <= 100 and -100 <= y <= 100):
                self._json(400, {"error": "position out of range"})
                return
            if not _set_entity_pose(world, VEHICLE_NAME, x, y, 0.05, yaw):
                self._json(500, {"error": "pose change failed"})
                return
            logging.info("vehicle teleported to (%.2f, %.2f, yaw %.2f)", x, y, yaw)
            self._json(200, {"ok": True, "pose": {"x": round(x, 6), "y": round(y, 6), "z": 0.05, "yaw": round(yaw, 6)}})
        elif re.match(r'^/models/[\w]+/pose$', self.path):
            # 월드 물체 텔레포트 (Custom World Builder 오브젝트·신호등).
            # 생략된 좌표는 현재 포즈(비정적=실시간, 정적=SDF 원점) 유지. 회전은 yaw만
            # (World Builder와 동일 — 물체는 항상 세워진 자세로 배치된다).
            name = self.path.split("/")[2]
            with _lock:
                world = _current_world
                switching = _switching
                is_light = name in _lights
            if not world or switching:
                self._json(409, {"error": "world not ready"})
                return
            if name in (VEHICLE_NAME, "racetrack", "sun"):
                self._json(403, {"error": "use POST /pose for the vehicle" if name == VEHICLE_NAME
                                 else f"{name} cannot be moved"})
                return
            items = _get_builtin_obstacles(world) or []
            item = next((i for i in items if i["name"] == name), None)
            if item is None and not is_light:
                self._json(404, {"error": "model not found in world"})
                return
            if item is not None and item.get("type") == "wall":
                self._json(403, {"error": "wall cannot be moved"})
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            cur = (item or {}).get("current") or {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0}
            try:
                x = float(body["x"]) if body.get("x") is not None else cur["x"]
                y = float(body["y"]) if body.get("y") is not None else cur["y"]
                yaw = float(body["yaw"]) if body.get("yaw") is not None else cur["yaw"]
                if body.get("z") is not None:
                    z = float(body["z"])
                elif item is not None and not item.get("static") and item.get("size"):
                    # z 생략 + 비정적: 지면 안착 높이 — 포즈는 항상 yaw-only로 세워지므로
                    # 넘어진 물체(누운 z)를 그대로 쓰면 파묻히거나 뜬다. 콜리전 절반 높이로.
                    z = item["size"]["z"] / 2.0 + 0.001
                else:
                    z = cur["z"]
            except (TypeError, ValueError):
                self._json(400, {"error": "x, y, z, yaw must be numbers"})
                return
            if not (-100 <= x <= 100 and -100 <= y <= 100 and -10 <= z <= 100):
                self._json(400, {"error": "position out of range"})
                return
            if is_light:
                ok, sig, err = _move_light(world, name, x, y, yaw)
                if not ok:
                    self._json(404 if err == "light not found" else 500, {"error": err})
                    return
                logging.info("light moved: %s to (%.2f, %.2f, yaw %.2f)", name, x, y, yaw)
                self._json(200, {"ok": True, "model": {"name": name, "x": sig["x"], "y": sig["y"], "z": 0.0, "yaw": sig["yaw"], "type": "light"}})
                return
            if not _set_entity_pose(world, name, x, y, z, yaw):
                self._json(500, {"error": "pose change failed"})
                return
            logging.info("model moved: %s to (%.2f, %.2f, %.2f, yaw %.2f)", name, x, y, z, yaw)
            self._json(200, {"ok": True, "model": {"name": name, "x": round(x, 6), "y": round(y, 6),
                                                   "z": round(z, 6), "yaw": round(yaw, 6),
                                                   "type": item.get("type", "model")}})
        elif self.path == "/stop":
            _kill_all_gz()
            with _lock:
                _sim_proc = None
                _launch_proc = None
                _current_world = None
            self._json(200, {"ok": True})
        elif re.match(r'^/traffic_lights/[\w]+$', self.path):
            name = self.path.rsplit("/", 1)[1]
            with _lock:
                world = _current_world
                sig = _lights.get(name)
            if not world or sig is None:
                self._json(404, {"error": "light not found"})
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            state = body.get("state")
            if state not in LIGHT_TARGETS:
                self._json(400, {"error": f"state must be one of {list(LIGHT_TARGETS)}"})
                return
            ok, sig, err = _set_light_target(world, name, state)
            if err:
                self._json(409 if err == "yellow transition in progress" else 500, {"error": err})
                return
            self._json(200, {"ok": True, "light": {"name": name, **sig}})
        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        m = re.match(r'^/worlds/([\w]+)$', self.path)
        if m:
            world_name = m.group(1)
            if world_name in PROTECTED_NAMES or not world_name.startswith("custom_"):
                self._json(403, {"error": f"cannot delete protected world: {world_name}"})
                return
            if not os.path.isfile(os.path.join(WORLDS_DIR, f"{world_name}.world")):
                self._json(404, {"error": "world not found"})
                return
            with _lock:
                current = _current_world
            if current == world_name:
                start_sim(DEFAULT_WORLD)
                time.sleep(2)
            _delete_world_files(world_name)
            self._json(200, {"ok": True, "deleted": world_name})
        else:
            self._json(404, {"error": "not found"})

if __name__ == "__main__":
    logging.info("sim_api starting, killing stale processes")
    # Cleanup any stale upload temp files from previous runs
    import glob as _glob
    for f in _glob.glob(os.path.join(tempfile.gettempdir(), "tmp*.tar.gz")):
        try:
            mtime = os.path.getmtime(f)
            if time.time() - mtime > UPLOAD_TIMEOUT:
                os.unlink(f)
                logging.info("cleaned up stale temp file: %s", f)
        except Exception:
            pass
    _kill_all_gz()
    # Boot the world immediately instead of waiting for the watchdog's first
    # 5s tick — cuts several seconds off time-to-first-camera-frame.
    threading.Thread(target=start_sim, args=(_load_boot_world(),), daemon=True).start()
    threading.Thread(target=_watchdog, daemon=True).start()
    threading.Thread(target=_gz_cache_manager, daemon=True).start()
    threading.Thread(target=_light_pose_watcher, daemon=True).start()
    # Threaded: long-lived streams (/events) must not block other requests.
    # Shared state is already lock-guarded (_lock, _gz_cache_lock) because
    # background threads mutate it concurrently with handlers anyway.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 9003), Handler)
    logging.info("listening on :9003")
    server.serve_forever()
