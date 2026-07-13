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

# Protected worlds/models that cannot be deleted or overwritten
PROTECTED_NAMES = {"physicar_base", "physicar", "sun",
                   "box_obstacle", "physicar_box_obstacle", "physicar_ball", "physicar_cone"}
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

def _get_vehicle_pose(world):
    """Query current vehicle pose in world coordinates from Gazebo."""
    import math
    try:
        r = _run_gz_cmd("gz", "topic", "-e", "-t",
                        f"/world/{world}/dynamic_pose/info", "-n", "1", timeout=3)
        if r.returncode != 0 or not r.stdout:
            return None
    except Exception:
        return None
    for block in re.split(r'(?=^pose \{)', r.stdout, flags=re.MULTILINE):
        if not re.search(r'name:\s*"physicar"', block):
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
    """Load route waypoints from npy file."""
    try:
        import numpy as np
        npy = os.path.join(SHARE_DIR, "routes", world + ".npy")
        if not os.path.isfile(npy):
            return None
        d = np.load(npy)
        return [[round(float(r[0]), 6), round(float(r[1]), 6)] for r in d]
    except Exception:
        return None

def _get_dynamic_poses(world):
    """Return {name: {x, y, z, yaw}} for every entity in dynamic_pose/info."""
    import math
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
        size = None
        sz = m.find("./link/collision/geometry/box/size")
        if sz is not None and sz.text:
            sp = sz.text.split()
            if len(sp) >= 3:
                size = {"x": float(sp[0]), "y": float(sp[1]), "z": float(sp[2])}
        origin = {"x": round(ox, 6), "y": round(oy, 6), "z": round(oz, 6), "yaw": round(oyaw, 6)}
        items.append({
            "name": name,
            "static": is_static,
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
_lights = {}            # name -> {"x", "y", "yaw", "state", "builtin"}
_lights_world = None    # world the registry belongs to
_light_counter = 0

# 스크린 패널 위치 계약 — 전부 파라메트릭 (정적 모델 없음):
# ① 월드 정의 신호등(Custom World Builder) = 자기기술 — 모델의 `screen` visual
#    (pose/size)을 읽어 화면 크기·기울기에 맞는 패널을 생성·스폰한다.
# ② 런타임 배치 신호등(+ Light 버튼) = 같은 수식으로 스탠드 SDF를 생성해 스폰
#    (기본 기기 0.18×0.32m 16:9, 15° 기울기 — 에디터 기본값과 동일).
_SCREEN_HIDDEN_Z = -1.0     # OFF: 지하
_LIGHT_W = 0.18             # 기본 기기 가로 (에디터 LIGHT_DEFAULT와 동일)
_LIGHT_ASPECT = 16.0 / 9.0
_LIGHT_TILT_DEG = 15.0

def _light_geom(W=_LIGHT_W, tilt_deg=_LIGHT_TILT_DEG):
    """파라메트릭 신호등 기하 — 에디터 Wb3dWorld.lightParts와 동일 수식.
    반환: 스탠드 부품 좌표 + 콜리전 + 패널 계약(px/pz/pitch/w/h)."""
    H = W * _LIGHT_ASPECT
    tilt = math.radians(tilt_deg)
    T, sT, lamp_l = 0.008, 0.003, 0.0015
    inset = 0.04 * W
    s_w, s_h = W - 2 * inset, H - 2 * inset
    lamp_r, lamp_off = min(s_w * 0.98, s_h * 0.41) / 2, s_h / 4
    st, ct = math.sin(tilt), math.cos(tilt)
    ax, az = -st, ct          # 기기 세로축 (아래→위)
    fx, fz = ct, st           # 정면 노멀
    bcx, bcz = 0.0, ct * H / 2 + st * T / 2
    sc_off = T / 2 + sT / 2 - 0.0005
    scx, scz = bcx + fx * sc_off, bcz + fz * sc_off
    lamp_f = sT / 2 - lamp_l / 2 + 0.0002  # 화면과 동일 평면
    panel_off = sT / 2 + 0.001 + 0.0015    # 화면 앞 1mm + 패널 bg/2
    return {
        "W": W, "H": H, "tilt": tilt, "T": T, "sT": sT,
        "sW": round(s_w, 5), "sH": round(s_h, 5),
        "lamp_r": round(lamp_r, 5), "lamp_l": lamp_l,
        "body": (round(bcx, 4), round(bcz, 4)),
        "screen": (round(scx, 4), round(scz, 4)),
        "lamp_red": (round(scx + ax * lamp_off + fx * lamp_f, 4), round(scz + az * lamp_off + fz * lamp_f, 4)),
        "lamp_green": (round(scx - ax * lamp_off + fx * lamp_f, 4), round(scz - az * lamp_off + fz * lamp_f, 4)),
        "coll": (round(st * H + ct * T, 4), round(W, 4), round(ct * H + st * T, 4)),
        "panel": {"px": round(scx + fx * panel_off, 6), "pz": round(scz + fz * panel_off, 6),
                  "pitch": round(-tilt, 6), "w": round(s_w, 5), "h": round(s_h, 5)},
    }

def _light_stand_sdf(g):
    """런타임 신호등 스탠드 SDF — wb-export _wbGenerateLightModel과 동일 외형
    (몸체/화면/램프: 빨강 꺼짐 + 초록 켜짐 발광, 콜리전 = 기울인 슬래브 AABB)."""
    t4 = lambda v: f"{v:.4f}"
    pitch = -g["tilt"]
    lamp_rpy = f"0 {math.pi / 2 + pitch:.4f} 0"
    return f"""<?xml version="1.0"?>
<sdf version="1.7">
<model name="runtime_light">
  <static>true</static>
  <link name="light">
    <collision name="collision">
      <pose>0 0 {t4(g["coll"][2] / 2)} 0 0 0</pose>
      <geometry><box><size>{g["coll"][0]} {g["coll"][1]} {g["coll"][2]}</size></box></geometry>
    </collision>
    <visual name="body">
      <pose>{t4(g["body"][0])} 0 {t4(g["body"][1])} 0 {pitch:.4f} 0</pose>
      <geometry><box><size>{g["T"]} {t4(g["W"])} {t4(g["H"])}</size></box></geometry>
      <material><ambient>0.110 0.110 0.133 1</ambient><diffuse>0.110 0.110 0.133 1</diffuse></material>
    </visual>
    <visual name="screen">
      <pose>{t4(g["screen"][0])} 0 {t4(g["screen"][1])} 0 {pitch:.4f} 0</pose>
      <geometry><box><size>{g["sT"]} {g["sW"]} {g["sH"]}</size></box></geometry>
      <material><ambient>0 0 0 1</ambient><diffuse>0 0 0 1</diffuse></material>
    </visual>
    <visual name="lamp_red">
      <pose>{t4(g["lamp_red"][0])} 0 {t4(g["lamp_red"][1])} {lamp_rpy}</pose>
      <geometry><cylinder><radius>{g["lamp_r"]}</radius><length>{g["lamp_l"]}</length></cylinder></geometry>
      <material><ambient>0.07 0 0 1</ambient><diffuse>0.07 0 0 1</diffuse></material>
    </visual>
    <visual name="lamp_green">
      <pose>{t4(g["lamp_green"][0])} 0 {t4(g["lamp_green"][1])} {lamp_rpy}</pose>
      <geometry><cylinder><radius>{g["lamp_r"]}</radius><length>{g["lamp_l"]}</length></cylinder></geometry>
      <material><ambient>0 1 0 1</ambient><diffuse>0 1 0 1</diffuse><emissive>0 0.5 0 1</emissive></material>
    </visual>
  </link>
</model>
</sdf>
"""

_PANEL_SDF_DIR = "/tmp/physicar_light_panels"

def _sig_pitch(sig):
    pn = sig.get("panel") or _light_geom()["panel"]
    return pn["pitch"]

def _panel_sdf_path(name, color, pn):
    """Write a screen-panel SDF sized to the light's screen; return its path.
    remote-traffic-light 앱 화면과 동일: 다크 배경 + 위 빨강/아래 초록,
    램프 지름 = min(화면 가로×0.98, 세로×0.41), 중심 = ±화면높이/4 (노랑은 중앙 단독)
    (Non-static + gravity off — 포즈가 스트리밍되어 뷰어에 상태가 보인다)."""
    os.makedirs(_PANEL_SDF_DIR, exist_ok=True)
    w, h = pn["w"], pn["h"]
    # 지름 = min(가로×0.98, 세로×0.41) — 원격 신호등 앱과 동일
    lamp_r = round(min(w * 0.98, h * 0.41) / 2, 5)
    off = round(h / 4, 5)
    lamp_x = 0.001  # 화면 배경과 사실상 동일 평면 (실물 디스플레이는 평평)
    _on = "<ambient>{c} 1</ambient><diffuse>{c} 1</diffuse><emissive>{e} 1</emissive>"
    _off = "<ambient>{c} 1</ambient><diffuse>{c} 1</diffuse>"
    def _lamp(nm, z, mat, x=None):
        return f"""
    <visual name="{nm}">
      <pose>{lamp_x if x is None else x} 0 {z} 0 1.5708 0</pose>
      <geometry><cylinder><radius>{lamp_r}</radius><length>0.0015</length></cylinder></geometry>
      <material>{mat}</material>
    </visual>"""
    if color == "yellow":
        # 노랑 경유 화면: 어두운 빨강/초록 위에 밝은 노랑 (0.4mm 앞 — 앱과 동일)
        lamps = (_lamp("lamp_red", off, _off.format(c="0.07 0 0"))
                 + _lamp("lamp_green", -off, _off.format(c="0 0.07 0"))
                 + _lamp("lamp_yellow", 0, _on.format(c="1 0.8 0", e="0.5 0.4 0"), x=lamp_x + 0.0004))
    elif color == "red":
        lamps = (_lamp("lamp_red", off, _on.format(c="1 0 0", e="0.5 0 0"))
                 + _lamp("lamp_green", -off, _off.format(c="0 0.07 0")))
    else:  # green
        lamps = (_lamp("lamp_red", off, _off.format(c="0.07 0 0"))
                 + _lamp("lamp_green", -off, _on.format(c="0 1 0", e="0 0.5 0")))
    sdf = f"""<?xml version="1.0"?>
<sdf version="1.7">
<model name="light_panel_{color}">
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
    <visual name="screen_bg">
      <geometry><box><size>0.003 {w} {h}</size></box></geometry>
      <material><ambient>0 0 0 1</ambient><diffuse>0 0 0 1</diffuse></material>
    </visual>{lamps}
  </link>
</model>
</sdf>
"""
    path = os.path.join(_PANEL_SDF_DIR, f"{name}_{color}.sdf")
    with open(path, "w") as f:
        f.write(sdf)
    return path

def _pose_fields(x, y, z, yaw, pitch=0.0):
    """Protobuf text for a gz.msgs.Pose (yaw ⊗ pitch)."""
    sy, cy = math.sin(yaw / 2), math.cos(yaw / 2)
    sp, cp = math.sin(pitch / 2), math.cos(pitch / 2)
    # q = qz(yaw) ⊗ qy(pitch)
    qx, qy, qz, qw = -sy * sp, cy * sp, cp * sy, cy * cp
    return (f'position: {{x: {x:.6f}, y: {y:.6f}, z: {z:.6f}}}, '
            f'orientation: {{x: {qx:.6f}, y: {qy:.6f}, z: {qz:.6f}, w: {qw:.6f}}}')

def _screen_world_pose(sig, color):
    """World position of a screen panel given light pose and on/off state."""
    if sig["state"] == color:
        pn = sig.get("panel") or _light_geom()["panel"]
        wx = sig["x"] + math.cos(sig["yaw"]) * pn["px"]
        wy = sig["y"] + math.sin(sig["yaw"]) * pn["px"]
        return wx, wy, pn["pz"]
    return sig["x"], sig["y"], _SCREEN_HIDDEN_Z

def _light_set_pose(world, name, x, y, z, yaw, pitch=0.0):
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/set_pose",
                        "--reqtype", "gz.msgs.Pose",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "3000",
                        "--req", f'name: "{name}", {_pose_fields(x, y, z, yaw, pitch)}')
        return r.returncode == 0 and "true" in r.stdout
    except Exception:
        return False

def _apply_light_state(world, name, sig):
    """Move both screen panels to match sig['state']."""
    ok = True
    for color in LIGHT_STATES:
        wx, wy, wz = _screen_world_pose(sig, color)
        ok = _light_set_pose(world, f"{name}_{color}", wx, wy, wz,
                              sig["yaw"], _sig_pitch(sig)) and ok
    return ok

def _spawn_light_screens(world, name, sig):
    """Spawn both screen panels for one light (stand may be runtime or world-defined)."""
    ok = True
    pn = sig.get("panel") or _light_geom()["panel"]
    for color in LIGHT_STATES:
        wx, wy, wz = _screen_world_pose(sig, color)
        src = f'sdf_filename: "{_panel_sdf_path(name, color, pn)}"' 
        try:
            r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/create",
                            "--reqtype", "gz.msgs.EntityFactory",
                            "--reptype", "gz.msgs.Boolean",
                            "--timeout", "5000",
                            "--req", f'{src}, '
                                     f'name: "{name}_{color}", '
                                     f'pose: {{{_pose_fields(wx, wy, wz, sig["yaw"], _sig_pitch(sig))}}}')
            if r.returncode != 0 or "true" not in r.stdout:
                logging.error("light screen spawn failed: %s_%s", name, color)
                ok = False
        except Exception as e:
            logging.error("light screen spawn error: %s_%s (%s)", name, color, e)
            ok = False
    return ok

def _spawn_light(world, name, sig):
    """Spawn a parametric stand + both screen panels for one runtime-placed light."""
    ok = True
    g = _light_geom()
    sig["panel"] = g["panel"]  # 패널 배치 계약 — 월드 신호등과 동일 경로
    os.makedirs(_PANEL_SDF_DIR, exist_ok=True)
    stand_path = os.path.join(_PANEL_SDF_DIR, f"{name}_stand.sdf")
    with open(stand_path, "w") as f:
        f.write(_light_stand_sdf(g))
    try:
        r = _run_gz_cmd("gz", "service", "-s", f"/world/{world}/create",
                        "--reqtype", "gz.msgs.EntityFactory",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "5000",
                        "--req", f'sdf_filename: "{stand_path}", '
                                 f'name: "{name}", '
                                 f'pose: {{{_pose_fields(sig["x"], sig["y"], 0.0, sig["yaw"])}}}')
        if r.returncode != 0 or "true" not in r.stdout:
            logging.error("light spawn failed: %s", name)
            ok = False
    except Exception as e:
        logging.error("light spawn error: %s (%s)", name, e)
        ok = False
    return _spawn_light_screens(world, name, sig) and ok

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
        _lights[name] = sig
    if not _apply_light_state(world, name, sig):
        return False, sig, "state change failed"
    if via_yellow:
        t = threading.Timer(YELLOW_S, _finish_yellow, args=(world, name, target))
        t.daemon = True
        _yellow_timers[name] = t
        t.start()
    return True, sig, None

def _finish_yellow(world, name, target):
    with _lock:
        _yellow_timers.pop(name, None)
        sig = _lights.get(name)
        if sig is None or sig["state"] != "yellow":
            return
        sig = dict(sig, state=target)
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
        # 자기기술 계약: `screen` visual의 pose(기울기 포함)/size에서 패널 배치 유도
        panel = None
        for v in sig_link.findall("visual"):
            if v.get("name") != "screen":
                continue
            try:
                vp = [float(t) for t in (v.findtext("pose") or "0 0 0 0 0 0").split()]
                sz = [float(t) for t in (v.findtext(".//box/size") or "0.003 0.069 0.147").split()]
                tilt = -vp[4]                      # screen pose pitch = -tilt
                foff = sz[0] / 2 + 0.001 + 0.0015  # 화면 앞 1mm + 패널 bg 두께/2
                panel = {
                    "px": round(vp[0] + math.cos(tilt) * foff, 6),
                    "pz": round(vp[2] + math.sin(tilt) * foff, 6),
                    "pitch": round(vp[4], 6),
                    "w": round(sz[1], 5), "h": round(sz[2], 5),
                }
            except Exception:
                panel = None
            break
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
        logging.info("world light registered: %s", name)
        _spawn_light_screens(world, name, sig)

def _remove_light(world, name):
    """Remove pole/housing + lamps of one light from the world."""
    for ename in (name, f"{name}_red", f"{name}_green"):
        try:
            _run_gz_cmd("gz", "service", "-s", f"/world/{world}/remove",
                        "--reqtype", "gz.msgs.Entity",
                        "--reptype", "gz.msgs.Boolean",
                        "--timeout", "3000",
                        "--req", f'name: "{ename}", type: MODEL')
        except Exception:
            pass

def _restore_lights(world):
    """Re-spawn runtime-placed lights after a world (re)start.

    builtin(월드 정의) 신호등은 _scan_world_lights가 처리한다.
    노랑 경유 중 재시작이면 타이머가 소실되므로 목적 상태(red)로 정리.
    """
    with _lock:
        for _n, _s in list(_lights.items()):
            if _s.get("state") == "yellow":
                _lights[_n] = dict(_s, state="red")
    with _lock:
        sigs = {n: s for n, s in _lights.items() if not s.get("builtin")}
    for name, sig in sigs.items():
        logging.info("restoring light %s", name)
        _spawn_light(world, name, sig)

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
                    _scan_world_lights(wname)
                    _restore_lights(wname)
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
                        wfile = (world or "physicar_base") + ".world"
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
        elif self.path == "/obstacles":
            with _lock:
                world = _current_world
            if not world:
                self._json(404, {"error": "no world running"})
                return
            items = _get_builtin_obstacles(world)
            if items is None:
                self._json(404, {"error": "world file not found"})
                return
            self._json(200, {"world": world, "obstacles": items})
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
            waypoints = _get_route(world)
            if waypoints is not None:
                self._json(200, {"world": world, "waypoints": waypoints})
            else:
                self._json(404, {"error": "route not available"})
        elif self.path == "/traffic_lights":
            with _lock:
                world = _current_world
                items = [{"name": n, **s} for n, s in sorted(_lights.items())]
            self._json(200, {"world": world, "lights": items})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        global _sim_proc, _current_world, _launch_proc, _fail_count, _light_counter
        if self.path == "/respawn":
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
                _sim_proc = None
                _launch_proc = None
                _current_world = None
            self._json(200, {"ok": True})
        elif self.path == "/traffic_lights":
            with _lock:
                world = _current_world
                switching = _switching
            if not world or switching:
                self._json(409, {"error": "world not ready"})
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            try:
                x = float(body.get("x"))
                y = float(body.get("y"))
                yaw = float(body.get("yaw", 0.0))
            except (TypeError, ValueError):
                self._json(400, {"error": "x and y must be numbers"})
                return
            if not (-100 <= x <= 100 and -100 <= y <= 100):
                self._json(400, {"error": "position out of range"})
                return
            state = body.get("state", "green")
            if state not in LIGHT_STATES:
                self._json(400, {"error": f"state must be one of {list(LIGHT_STATES)}"})
                return
            with _lock:
                if len(_lights) >= 20:
                    self._json(409, {"error": "too many lights (max 20)"})
                    return
                _light_counter += 1
                name = f"light_{_light_counter}"
                while name in _lights:
                    _light_counter += 1
                    name = f"light_{_light_counter}"
                sig = {"x": round(x, 6), "y": round(y, 6),
                       "yaw": round(yaw, 6), "state": state}
                _lights[name] = sig
            if not _spawn_light(world, name, sig):
                with _lock:
                    _lights.pop(name, None)
                _remove_light(world, name)
                self._json(500, {"error": "spawn failed"})
                return
            logging.info("light placed: %s at (%.2f, %.2f)", name, x, y)
            self._json(200, {"ok": True, "light": {"name": name, **sig}})
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
        m = re.match(r'^/traffic_lights/([\w]+)$', self.path)
        if m:
            name = m.group(1)
            with _lock:
                world = _current_world
                sig = _lights.get(name)
                if sig and sig.get("builtin"):
                    sig = "builtin"
                else:
                    sig = _lights.pop(name, None)
            if sig == "builtin":
                self._json(403, {"error": "world-defined light cannot be deleted"})
                return
            if not world or sig is None:
                self._json(404, {"error": "light not found"})
                return
            _remove_light(world, name)
            logging.info("light removed: %s", name)
            self._json(200, {"ok": True, "deleted": name})
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
