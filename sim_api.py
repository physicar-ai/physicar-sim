# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 AICASTLE Inc.

import re, os, json, math, subprocess, glob, http.server, threading, time, signal, tempfile, shutil, logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [sim_api] %(levelname)s %(message)s',
    datefmt='%H:%M:%S'
)

SIM_DIR = os.path.dirname(os.path.abspath(__file__))
SHARE_DIR = os.path.join(SIM_DIR, "share")

def _nearest_tag():
    """콘텐츠 자산(차량·월드 메시/텍스처) CDN 리비전 = 가장 가까운 태그.
    DEV·더티 여부와 무관 — 시뮬레이터 콘텐츠는 개발 대상이 아니라 항상 CDN.
    (코드성 정적 파일은 STATIC_REV 의 엄격 조건을 따로 탄다)
    태그가 없으면 None → 로컬 폴백. 미업로드 태그는 뷰어의 complete.json 게이트가 거른다."""
    try:
        out = subprocess.run(["git", "-C", SIM_DIR, "describe", "--tags", "--abbrev=0"],
                             capture_output=True, text=True, timeout=5)
        tag = out.stdout.strip()
        if out.returncode == 0 and re.match(r'^v[0-9][\w.\-]*$', tag):
            return tag
    except Exception:
        pass
    return None

def _detect_static_rev():
    """코드성 정적 파일(뷰어 JS/CSS — index.html 로더) CDN 리비전.
    DEV 모드·태그 밖·더티 트리는 None → 로컬 서빙 (개발 중 수정이 그대로 보여야 한다)."""
    if os.environ.get("DEV") == "true":
        return None
    try:
        out = subprocess.run(["git", "-C", SIM_DIR, "describe", "--tags",
                              "--exact-match", "--dirty=-dirty"],
                             capture_output=True, text=True, timeout=5)
        tag = out.stdout.strip()
        if out.returncode == 0 and re.match(r'^v[0-9][\w.\-]*$', tag) and not tag.endswith("-dirty"):
            return tag
    except Exception:
        pass
    return None

ASSETS_REV = _nearest_tag()
STATIC_REV = _detect_static_rev()
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
        os.path.join(WORLDS_DIR, f"{world_name}.pcpub.json"),
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


# ── Published world install (worlds.physicar.ai) ─────────────────────
# WB Publish 가 R2 에 올린 월드를 EC2 가 직접 내려받아 설치한다 (인바운드는
# 무료·egress 캡 무관). 로컬 배치는 tar 임포트와 동일한 custom_* 관례 —
# 원본이 R2 에 있으므로 로컬은 캐시이며, rev 가 같으면 재다운로드를 건너뛴다.
WORLDS_CDN = os.environ.get("PHYSICAR_WORLDS_URL", "https://worlds.physicar.ai")
_INSTALL_SUBDIRS = ("worlds/", "meshes/", "models/", "routes/", "track_iconography/")

class _InstallError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code

def _pub_sidecar_path(world_name):
    return os.path.join(WORLDS_DIR, f"{world_name}.pcpub.json")

def _pub_sidecar(world_name):
    try:
        with open(_pub_sidecar_path(world_name)) as f:
            return json.load(f)
    except Exception:
        return None

def _safe_install_path(p):
    """매니페스트 경로 검증 — share/ 하위 화이트리스트 디렉토리만, 탈출 불가."""
    if not isinstance(p, str) or len(p) > 200:
        return None
    if not any(p.startswith(d) for d in _INSTALL_SUBDIRS):
        return None
    for seg in p.split("/"):
        if not seg or seg in (".", "..") or seg.startswith("."):
            return None
        if not re.match(r'^[A-Za-z0-9._\-]+$', seg):
            return None
    return p

def _install_published_world(world_id):
    import urllib.request
    with urllib.request.urlopen(f"{WORLDS_CDN}/worlds/{world_id}/meta.json", timeout=8) as r:
        meta = json.loads(r.read())
    rev = str(meta.get("rev", ""))
    display = str(meta.get("name", "")) or world_id[:8]
    files = meta.get("files") or []
    if not re.match(r'^[0-9a-z]{8,24}$', rev) or not isinstance(files, list) or not files:
        raise _InstallError(502, "invalid world metadata")

    world_files = [f for f in files if isinstance(f, str)
                   and f.startswith("worlds/") and f.endswith(".world")]
    if len(world_files) != 1:
        raise _InstallError(502, "metadata must contain exactly one worlds/*.world")
    world_name = world_files[0][len("worlds/"):-len(".world")]
    if not world_name.startswith("custom_") or not re.match(r'^[\w]+$', world_name):
        raise _InstallError(502, "world name must be custom_*")
    if world_name in PROTECTED_NAMES:
        raise _InstallError(400, "protected world name")

    prev = _pub_sidecar(world_name)
    if prev and prev.get("rev") == rev and os.path.isfile(os.path.join(WORLDS_DIR, f"{world_name}.world")):
        return {"ok": True, "world": f"{world_name}.world", "name": display, "cached": True}

    paths = []
    for p in files:
        if p == "project.json":
            continue  # 소스 파일 — 설치 대상 아님
        sp = _safe_install_path(p)
        if sp is None:
            # 모르는 디렉토리/확장자는 조용히 스킵 — 새 매니페스트와의 전방 호환
            logging.info("install: skipping non-installable path %s", str(p)[:80])
            continue
        paths.append(sp)
    if not paths:
        raise _InstallError(502, "empty manifest")

    # 임시 디렉토리(같은 파일시스템)로 전부 받은 뒤 이동 — 부분 설치 방지
    tmp = tempfile.mkdtemp(prefix=".pcworld_", dir=SHARE_DIR)
    try:
        for p in paths:
            dst = os.path.join(tmp, p)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with urllib.request.urlopen(f"{WORLDS_CDN}/worlds/{world_id}/{rev}/{p}", timeout=30) as r, \
                 open(dst, "wb") as f:
                shutil.copyfileobj(r, f, 1024 * 256)
        _delete_world_files(world_name)
        for p in paths:
            dst = os.path.join(SHARE_DIR, p)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.replace(os.path.join(tmp, p), dst)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    _ensure_sky_dome(f"{world_name}.world")
    _normalize_textures(world_name)
    size = meta.get("size")
    if not (isinstance(size, list) and len(size) == 2
            and all(isinstance(v, (int, float)) for v in size)):
        size = None
    with open(_pub_sidecar_path(world_name), "w") as f:
        json.dump({"world_id": world_id, "rev": rev, "name": display, "size": size}, f)
    logging.info("installed published world %s rev %s as %s", world_id, rev, world_name)
    return {"ok": True, "world": f"{world_name}.world", "name": display, "cached": False}

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
    from gz.msgs10.entity_pb2 import Entity as _PbEntity
    from gz.msgs10.entity_factory_pb2 import EntityFactory as _PbEntityFactory
    from gz.msgs10.empty_pb2 import Empty as _PbEmpty
    from gz.msgs10.scene_pb2 import Scene as _PbScene
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
        "z": round(float(pz.group(1)), 6), "yaw": round(yaw, 6),
        # full orientation — needed to respawn state-variant models of a
        # toppled traffic light in exactly its current attitude
        "q": (round(qx, 6), round(qy, 6), round(qz, 6), round(qw, 6))}


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

# 상태 표시 계약 — 상태별 모델 통째 교체 (2026-08-08 재설계):
# gz 센서 씬(차량 카메라)은 런타임 재질 변경(visual_config)과 조명 변경을 전부
# 무시한다 (실측). 확실히 존중하는 연산은 "엔티티 생성/삭제"와 "포즈"뿐이다.
# 그래서 상태 변경 = 램프 색을 SDF에 구워 넣은 모델 변형으로 신호등을 통째
# 교체한다 (remove+create, in-process 노드라 ms 단위):
#   green  — 월드 원본 그대로 (익스포트가 초록 점등으로 구워져 있음)
#   red    — lamp_red 밝음 / lamp_green 어두움 재질로 패치한 변형
#   yellow — 양쪽 어두움 + 패널 중앙에 lamp_yellow visual 추가한 변형
# 램프가 몸체 링크의 visual이므로 차량이 밀거나 넘어뜨려도 절대 분리되지
# 않는다 (별도 오버레이 모델 추종 방식은 폐지 — 근본적으로 불안정했다).
# 넘어진 채 상태를 바꾸면 실시간 포즈 캐시의 전체 쿼터니언으로 그 자세 그대로
# 재스폰한다. 웹 뷰어는 상태를 REST로 읽어 three.js 재질을 직접 칠한다.
_LAMP_COLORS = {
    # state -> {visual: (ambient/diffuse rgb, emissive rgb|None)} — 변형 SDF 재질
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
_YELLOW_LAMP = ("1 0.8 0", "0.5 0.4 0")   # lamp_yellow visual 재질 (yellow 변형 전용)

# visual_config 는 스코프드 네임을 받지 않는다 (UserCommands VisualCommand:
# ① msg.id(엔티티 ID) ② parent_name(링크 Name 전역 검색) + name(visual 평이름)).
# 링크명이 전부 "light"라 신호등 2개 이상이면 ②는 모호 → scene/info에서 visual
# 엔티티 ID를 수집해 ID로 지정한다 (월드 로드마다 ID가 바뀌므로 매번 재수집).
# ── 상태별 모델 변형 (SDF에 램프 색 bake) ─────────────────────────────────
_light_model_src = {}   # name -> 월드 파일의 <model> XML (green 점등 원본)
_LIGHT_SDF_DIR = "/tmp/physicar_light_states"

def _light_variant_sdf(name, state):
    """상태별 신호등 SDF 생성 — 원본 모델의 lamp visual 재질을 교체하고,
    yellow는 패널 중앙에 lamp_yellow visual을 추가한다. 생성 비용이 ms라
    캐시 없이 매번 새로 쓴다 (월드 재업로드에도 항상 최신)."""
    import xml.etree.ElementTree as ET
    import copy as _copy
    src = _light_model_src.get(name)
    if not src:
        return None
    try:
        model = ET.fromstring(src)
        # 월드 배치 pose 제거 — 스폰 pose는 EntityFactory가 지정한다
        pe = model.find("pose")
        if pe is not None:
            model.remove(pe)
        link = next((lk for lk in model.findall("link")
                     if lk.get("name") in ("light", "signal")), None)
        if link is None:
            return None

        def set_mat(vis, rgb, emissive):
            m = vis.find("material")
            if m is None:
                m = ET.SubElement(vis, "material")
            for tag in ("ambient", "diffuse"):
                el = m.find(tag)
                if el is None:
                    el = ET.SubElement(m, tag)
                el.text = f"{rgb} 1"
            el = m.find("emissive")
            if el is None:
                el = ET.SubElement(m, "emissive")
            el.text = f"{emissive or '0 0 0'} 1"

        vis_by_name = {v.get("name"): v for v in link.findall("visual")}
        for lamp, (rgb, emissive) in _LAMP_COLORS[state].items():
            if lamp in vis_by_name:
                set_mat(vis_by_name[lamp], rgb, emissive)
        if state == "yellow" and "lamp_green" in vis_by_name:
            with _lock:
                pn = (_lights.get(name) or {}).get("panel")
            yv = _copy.deepcopy(vis_by_name["lamp_green"])
            yv.set("name", "lamp_yellow")
            pose_el = yv.find("pose")
            if pn and pose_el is not None and pose_el.text:
                parts = pose_el.text.split()
                if len(parts) >= 6:
                    parts[0] = str(pn["px"])
                    parts[2] = str(pn["pz"])
                    pose_el.text = " ".join(parts)
            set_mat(yv, _YELLOW_LAMP[0], _YELLOW_LAMP[1])
            link.append(yv)

        os.makedirs(_LIGHT_SDF_DIR, exist_ok=True)
        path = os.path.join(_LIGHT_SDF_DIR, f"{name}_{state}.sdf")
        sdf = ET.Element("sdf", {"version": "1.7"})
        sdf.append(model)
        ET.ElementTree(sdf).write(path)
        return path
    except Exception:
        logging.exception("light variant sdf failed: %s %s", name, state)
        return None

def _remove_entity(world, name):
    if _gz_node is not None:
        try:
            e = _PbEntity()
            e.name = name
            e.type = _PbEntity.MODEL
            rep = _gz_request(f"/world/{world}/remove", e, _PbEntity, _PbBoolean)
            if rep is not None:
                return bool(rep.data)
        except Exception:
            pass
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/remove",
                        "--reqtype", "gz.msgs.Entity",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "3000",
                        "--req", f'name: "{name}", type: MODEL')
        return r.returncode == 0 and "true" in r.stdout
    except Exception:
        return False

def _create_entity(world, sdf_path, name, x, y, z, q):
    if _gz_node is not None:
        try:
            f = _PbEntityFactory()
            f.sdf_filename = sdf_path
            f.name = name
            f.pose.position.x, f.pose.position.y, f.pose.position.z = x, y, z
            (f.pose.orientation.x, f.pose.orientation.y,
             f.pose.orientation.z, f.pose.orientation.w) = q
            rep = _gz_request(f"/world/{world}/create", f, _PbEntityFactory, _PbBoolean)
            if rep is not None:
                return bool(rep.data)
        except Exception:
            pass
    try:
        req = (f'sdf_filename: "{sdf_path}", name: "{name}", pose: {{'
               f'position: {{x: {x:.6f}, y: {y:.6f}, z: {z:.6f}}}, '
               f'orientation: {{x: {q[0]:.6f}, y: {q[1]:.6f}, z: {q[2]:.6f}, w: {q[3]:.6f}}}}}')
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/create",
                        "--reqtype", "gz.msgs.EntityFactory",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "5000", "--req", req)
        return r.returncode == 0 and "true" in r.stdout
    except Exception:
        return False

def _entity_exists(world, name):
    """scene/info에서 모델 존재 확인 — 유저 커맨드(remove/create)는 응답 true가
    '큐에 들어감'일 뿐이라, 실제 반영 여부는 이걸로 확인해야 한다."""
    if _gz_node is not None:
        try:
            rep = _gz_request(f"/world/{world}/scene/info", _PbEmpty(),
                              _PbEmpty, _PbScene, 3000)
            if rep is not None:
                return any(m.name == name for m in rep.model)
        except Exception:
            pass
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/scene/info",
                        "--reqtype", "gz.msgs.Empty", "--reptype", "gz.msgs.Scene",
                        "--timeout", "3000", "--req", "")
        return f'name: "{name}"' in (r.stdout or "")
    except Exception:
        return False

def _apply_light_state(world, name, sig):
    """상태 적용 = 램프 색이 구워진 변형 모델로 통째 교체 (remove+create).
    램프가 몸체 링크의 visual이라 물리로 밀리든 넘어지든 분리 불가능.
    현재 실포즈(전체 쿼터니언)를 그대로 이어받아 재스폰한다.
    remove가 실제로 반영되기 전에 같은 이름으로 create하면 조용히 버려지므로
    (큐잉 true ≠ 실행 성공), 반영을 확인하고 나서 생성한다."""
    path = _light_variant_sdf(name, sig["state"])
    if not path:
        return False
    with _gz_cache_lock:
        p = _gz_poses.get(name)
    if p and p.get("q"):
        x, y, z, q = p["x"], p["y"], p["z"], p["q"]
    else:
        sy, cy = math.sin(sig["yaw"] / 2), math.cos(sig["yaw"] / 2)
        x, y, z, q = sig["x"], sig["y"], 0.0, (0.0, 0.0, sy, cy)
    _remove_entity(world, name)
    for _ in range(20):                      # 삭제 반영 대기 (보통 1스텝, ≤1s)
        if not _entity_exists(world, name):
            break
        time.sleep(0.05)
    for attempt in range(3):
        _create_entity(world, path, name, x, y, z, q)
        for _ in range(10):                  # 생성 반영 확인 (≤0.5s)
            if _entity_exists(world, name):
                return True
            time.sleep(0.05)
    logging.warning("light state swap failed: %s -> %s", name, sig["state"])
    return False

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
    """신호등 텔레포트 — set_pose(z=0·yaw-only = 재기립). 램프는 몸체 visual이라
    자동으로 함께 움직인다. 노랑 경유 중에도 이동 허용."""
    with _lock:
        sig = _lights.get(name)
        if sig is None:
            return False, None, "light not found"
        sig = dict(sig, x=round(x, 6), y=round(y, 6), yaw=round(yaw, 6))
        _lights[name] = sig
    ok = _set_entity_pose(world, name, x, y, 0.0, yaw)
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
    """등록 포즈 동기화 — 차량이 신호등을 밀면 물리가 모델을 옮기므로, 실좌표
    (dynamic_pose 캐시)를 sig에 반영해 /traffic_lights 응답과 상태 교체 시의
    재스폰 위치를 최신으로 유지한다. 램프는 몸체 visual이라 시각적 추종은
    필요 없다 (틱 비용은 dict 비교 µs 수준)."""
    while True:
        time.sleep(0.2)
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
        # 자기기술 계약: screen visual의 pose(pitch=-tilt)/size → yellow 변형의
        # lamp_yellow visual 배치 (지름 = min(가로×0.98, 세로×0.41) — 앱과 동일)
        panel = None
        for v in sig_link.findall("visual"):
            if v.get("name") != "screen" or panel is not None:
                continue
            try:
                vp = [float(t) for t in (v.findtext("pose") or "0 0 0 0 0 0").split()]
                sz = [float(t) for t in (v.findtext(".//box/size") or "0.003 0.166 0.295").split()]
                tilt = -vp[4]
                foff = sz[0] / 2 + 0.0015 / 2 + 0.0004  # 화면 앞 0.4mm
                panel = {
                    "px": round(vp[0] + math.cos(tilt) * foff, 6),
                    "pz": round(vp[2] + math.sin(tilt) * foff, 6),
                    "pitch": round(vp[4], 6),
                    "lamp_r": round(min(sz[1] * 0.98, sz[2] * 0.41) / 2, 5),
                }
            except Exception:
                panel = None
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
        # 상태 변형 SDF의 원본 — green 점등으로 구워진 월드 정의 그대로
        _light_model_src[name] = ET.tostring(m, encoding="unicode")
        logging.info("world light registered: %s", name)
        # 익스포트 SDF는 초록 점등으로 구워져 있음 — 보존 상태가 다르면 모델 교체
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
        elif self.path == "/worldpub":
            # 현재 월드의 배포 좌표 — 뷰어가 커스텀 월드 시각 파일을 CF(worlds.physicar.ai)
            # 에서 직접 받게 한다 (EC2 10Mbps egress 캡 우회, 엣지 캐시 공유)
            with _lock:
                world = _current_world
            pub = _pub_sidecar(world) if world else None
            self._json(200, {"world": world,
                             "world_id": (pub or {}).get("world_id"),
                             "rev": (pub or {}).get("rev"),
                             "assets_rev": ASSETS_REV,
                             "static_rev": STATIC_REV,
                             "cdn": WORLDS_CDN})
        elif self.path == "/worlds":
            worlds = sorted(glob.glob(os.path.join(WORLDS_DIR, "*.world")))
            items = []
            for w in worlds:
                name = os.path.splitext(os.path.basename(w))[0]
                # Only imported worlds (custom_ prefix) are deletable; everything
                # else ships with the sim and counts as official.
                pub = _pub_sidecar(name)
                custom = name.startswith("custom_")
                items.append({"name": name, "file": os.path.basename(w),
                              "display": (pub or {}).get("name") or name,
                              "world_id": (pub or {}).get("world_id"),
                              "size": (pub or {}).get("size"),
                              "official": not custom,
                              "deletable": custom and name not in PROTECTED_NAMES})
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
                        lights = []
                        now_t = time.time()
                        for n, s in sorted(_lights.items()):
                            ld = {"name": n, **s}
                            u = ld.pop("yellow_until", None)
                            if u is not None:
                                # 잔여초(0.1s 단위) — 노랑 경유 중엔 매 틱 값이
                                # 달라져 스냅샷이 계속 푸시된다 (클라 타이밍 유지)
                                ld["yellow_left"] = round(max(0.0, u - now_t), 1)
                            lights.append(ld)
                        snap = {
                            "running": _sim_proc is not None and _sim_proc.poll() is None,
                            "websocket": _launch_proc is not None and _launch_proc.poll() is None,
                            "current": _current_world,
                            "switching": _switching,
                            # 뷰어가 폴링하지 않도록 여기서 푸시 (변경 시에만 전송됨)
                            "overlay": _overlay_text if time.monotonic() < _overlay_expiry else "",
                            "brightness": _brightness,
                            # 신호등 상태 — 마지막 남은 클라 폴링(/traffic_lights 주기
                            # 조회)을 없애기 위해 스냅샷에 포함 (변경 시에만 전송)
                            "lights": lights,
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
            wid = str(body.get("world_id", ""))
            if not world_file and re.match(r'^[0-9a-f]{32}$', wid):
                # world_id 기반 스위치 — 설치된 배포 월드의 사이드카에서 해석
                for sc in glob.glob(os.path.join(WORLDS_DIR, "*.pcpub.json")):
                    try:
                        with open(sc) as f:
                            if json.load(f).get("world_id") == wid:
                                world_file = os.path.basename(sc)[:-len(".pcpub.json")] + ".world"
                                break
                    except Exception:
                        pass
                if not world_file:
                    self._json(404, {"error": "world not installed"})
                    return
            if not re.match(r'^[\w]+\.world$', world_file):
                self._json(400, {"error": "invalid world file name"})
                return
            if not os.path.isfile(os.path.join(WORLDS_DIR, world_file)):
                self._json(404, {"error": "world not found"})
                return
            _fail_count = 0
            threading.Thread(target=start_sim, args=(world_file,), daemon=True).start()
            self._json(200, {"ok": True, "world": world_file})
        elif self.path == "/worlds/install":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            world_id = str(body.get("world_id", ""))
            if not re.match(r'^[0-9a-f]{32}$', world_id):
                self._json(400, {"error": "invalid world_id"})
                return
            try:
                self._json(200, _install_published_world(world_id))
            except _InstallError as e:
                self._json(e.code, {"error": str(e)})
            except Exception:
                logging.exception("world install failed: %s", world_id)
                self._json(502, {"error": "install failed (network or archive error)"})
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
