# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 AICASTLE Inc.

import re, os, json, subprocess, glob, http.server, threading, time, signal, tarfile, tempfile, shutil, io, logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [sim_api] %(levelname)s %(message)s',
    datefmt='%H:%M:%S'
)

SIM_DIR = os.path.dirname(os.path.abspath(__file__))
SHARE_DIR = os.path.join(SIM_DIR, "share")
WORLDS_DIR = os.path.join(SHARE_DIR, "worlds")
DEFAULT_WORLD = "physicar_base.world"

# Protected worlds/models that cannot be deleted or overwritten
PROTECTED_NAMES = {"physicar_base", "physicar", "sun"}
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

def _start_launch():
    """Start gz-launch websocket server. Returns True if started successfully."""
    global _launch_proc
    # Kill any orphan gz-launch first to avoid port 9002 conflict
    subprocess.run(["pkill", "-9", "-f", "gz-launch"], timeout=5, capture_output=True)
    time.sleep(0.5)
    env = _gz_env()
    _launch_proc = subprocess.Popen(
        ["gz", "launch", WEBSOCKET_LAUNCH],
        env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True
    )
    logging.info("gz-launch started (PID %d)", _launch_proc.pid)
    # Verify it didn't crash immediately (e.g. port in use)
    time.sleep(1.0)
    if _launch_proc.poll() is not None:
        logging.error("gz-launch crashed on startup (exit %s)", _launch_proc.returncode)
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

# ─── Obstacle management ──────────────────────────────────────────────
_obstacle_lock = threading.Lock()
_obstacle_counter = 0  # monotonic counter for unique names
_obstacles = {}  # name -> {x, y, z, yaw}

OBSTACLE_MODEL = "physicar_box_obstacle"
OBSTACLE_Z = 0.125  # half of box height (mesh Z range: -0.121 to +0.121)

def _yaw_to_quat(yaw):
    """Convert yaw (radians) to gz.msgs quaternion string."""
    import math
    sz = math.sin(yaw / 2)
    cz = math.cos(yaw / 2)
    return f"x: 0, y: 0, z: {sz}, w: {cz}"

def _spawn_obstacle(name, x, y, yaw=0.0):
    """Spawn an obstacle in the current world."""
    with _lock:
        world = _current_world
    if not world:
        return False, "no world running"
    quat = _yaw_to_quat(yaw)
    pose = f'position: {{x: {x}, y: {y}, z: {OBSTACLE_Z}}}, orientation: {{{quat}}}'
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/create",
                        "--reqtype", "gz.msgs.EntityFactory",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "5000",
                        "--req", f'sdf_filename: "model://{OBSTACLE_MODEL}", pose: {{{pose}}}, name: "{name}"')
        if r.returncode != 0:
            return False, r.stderr.strip() or "gz create failed"
        with _obstacle_lock:
            _obstacles[name] = {"x": x, "y": y, "z": OBSTACLE_Z, "yaw": yaw}
        return True, None
    except Exception as e:
        return False, str(e)

def _remove_obstacle(name):
    """Remove an obstacle from the current world."""
    with _lock:
        world = _current_world
    if not world:
        return False, "no world running"
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/remove",
                        "--reqtype", "gz.msgs.Entity",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "5000",
                        "--req", f'name: "{name}", type: MODEL')
        if r.returncode != 0:
            return False, r.stderr.strip() or "gz remove failed"
        with _obstacle_lock:
            _obstacles.pop(name, None)
        return True, None
    except Exception as e:
        return False, str(e)

def _move_obstacle(name, x, y, yaw=None):
    """Move/rotate an obstacle by removing and re-spawning it."""
    with _obstacle_lock:
        info = _obstacles.get(name)
    if not info:
        return False, "obstacle not found"
    if yaw is None:
        yaw = info["yaw"]
    ok, err = _remove_obstacle(name)
    if not ok:
        return False, err
    import time as _t
    _t.sleep(0.3)
    return _spawn_obstacle(name, x, y, yaw)

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
    global _sim_proc, _current_world, _switching, _switching_since
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

        # Kill existing
        _kill_all_gz()
        with _lock:
            _current_world = None
        # Clear obstacles when world changes
        with _obstacle_lock:
            _obstacles.clear()

        # Start new gz sim
        env = _gz_env()
        proc = subprocess.Popen(
            ["gz", "sim", "-s", "--headless-rendering", path],
            env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True
        )
        logging.info("gz sim started (PID %d)", proc.pid)

        with _lock:
            _sim_proc = proc
            _current_world = os.path.splitext(world_file)[0]

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
                                "--req", f'sdf_filename: "model://physicar", pose: {{{pose}}}, name: "physicar"')
                    # Verify sim is still alive before starting websocket
                    if proc.poll() is not None:
                        logging.error("gz sim died after spawn (exit %s)", proc.returncode)
                        return
                    logging.info("physicar spawned, starting gz-launch")
                    _start_launch()
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

def _watchdog():
    """Monitor gz sim + gz-launch. Restart on crash with backoff."""
    global _switching
    logging.info("watchdog started")
    global _fail_count
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
            wfile = (world or "physicar_base") + ".world"
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
        if self.path == "/worlds":
            worlds = sorted(glob.glob(os.path.join(WORLDS_DIR, "*.world")))
            items = []
            for w in worlds:
                name = os.path.splitext(os.path.basename(w))[0]
                items.append({"name": name, "file": os.path.basename(w), "deletable": name not in PROTECTED_NAMES})
            # Protected (built-in) worlds first, then alphabetical
            items.sort(key=lambda x: (x["deletable"], x["name"]))
            with _lock:
                current = _current_world
            self._json(200, {"worlds": items, "current": current})
        elif self.path == "/status":
            with _lock:
                proc = _sim_proc
                launch = _launch_proc
                current = _current_world
                switching = _switching
            sim_ok = proc is not None and proc.poll() is None
            ws_ok = launch is not None and launch.poll() is None
            self._json(200, {
                "running": sim_ok,
                "websocket": ws_ok,
                "current": current,
                "switching": switching
            })
        elif self.path == "/obstacles":
            with _obstacle_lock:
                obs = dict(_obstacles)
            self._json(200, {"obstacles": obs})
        elif self.path == "/track_bounds":
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
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/obstacle":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            x = float(body.get("x", 0))
            y = float(body.get("y", 0))
            yaw = float(body.get("yaw", 0))
            global _obstacle_counter
            with _obstacle_lock:
                _obstacle_counter += 1
                name = f"box_{_obstacle_counter}"
            ok, err = _spawn_obstacle(name, x, y, yaw)
            if ok:
                self._json(200, {"ok": True, "name": name})
            else:
                self._json(500, {"error": err})
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
            global _fail_count
            _fail_count = 0
            threading.Thread(target=start_sim, args=(world_file,), daemon=True).start()
            self._json(200, {"ok": True, "world": world_file})
        elif self.path == "/upload":
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
                if os.path.isfile(os.path.join(WORLDS_DIR, f"{world_name}.world")):
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
            try:
                ok, err, world_name = _validate_tar(tmp_path)
                if not ok:
                    self._json(400, {"error": err})
                    return
                if world_name in PROTECTED_NAMES:
                    self._json(403, {"error": f"cannot overwrite protected world: {world_name}"})
                    return
                if os.path.isfile(os.path.join(WORLDS_DIR, f"{world_name}.world")):
                    _delete_world_files(world_name)
                _extract_world(tmp_path, world_name)
                logging.info("upload complete: %s -> %s", upload_id, world_name)
                self._json(200, {"ok": True, "world": world_name})
            finally:
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
        elif self.path == "/stop":
            _kill_all_gz()
            with _lock:
                global _sim_proc, _current_world, _launch_proc
                _sim_proc = None
                _launch_proc = None
                _current_world = None
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        m_obs = re.match(r'^/obstacle/([\w]+)$', self.path)
        if m_obs:
            name = m_obs.group(1)
            ok, err = _remove_obstacle(name)
            if ok:
                self._json(200, {"ok": True, "removed": name})
            else:
                self._json(500, {"error": err})
            return
        m = re.match(r'^/worlds/([\w]+)$', self.path)
        if m:
            world_name = m.group(1)
            if world_name in PROTECTED_NAMES:
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

    def do_PATCH(self):
        m_obs = re.match(r'^/obstacle/([\w]+)$', self.path)
        if m_obs:
            name = m_obs.group(1)
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            x = float(body.get("x", 0))
            y = float(body.get("y", 0))
            yaw = body.get("yaw")
            if yaw is not None:
                yaw = float(yaw)
            ok, err = _move_obstacle(name, x, y, yaw)
            if ok:
                self._json(200, {"ok": True, "name": name})
            else:
                self._json(500, {"error": err})
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
    threading.Thread(target=_watchdog, daemon=True).start()
    http.server.HTTPServer.allow_reuse_address = True
    server = http.server.HTTPServer(("127.0.0.1", 9003), Handler)
    logging.info("listening on :9003")
    server.serve_forever()
