// =====================================================================
// Gazebo Web Viewer - Main JavaScript
// =====================================================================

// 앱(/app) 임베드 시 상단 툴바(Respawn/월드/Import)는 래퍼 패널 헤더가 대신 제공
try {
  if (window.parent !== window) { document.documentElement.classList.add("embedded"); }
} catch (e) { document.documentElement.classList.add("embedded"); }

var wsProtocol = (location.protocol === "https:") ? "wss://" : "ws://";
var wsUrl;
if (location.pathname.startsWith("/sim")) {
  wsUrl = wsProtocol + location.host + "/sim/ws";
} else {
  wsUrl = "ws://" + location.hostname + ":9002";
}
var gz = null;
var reconnectTimer = null;
var connected = false;

// =====================================================================
// Toast Notification
// =====================================================================
var _toastTimer = null;
function _showToast(msg, duration) {
  duration = duration || 3000;
  var el = document.getElementById('gz-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gz-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { el.classList.remove('show'); }, duration);
}

// =====================================================================
// Audio Unlock Overlay
// =====================================================================
var _audioUnlocked = false;
function _checkAudioOverlay() {
  if (_audioUnlocked) return;
  // Show overlay if audio data is pending but not yet unlocked
  if (_audioPending && _audioPending.length > 0 && !_audioReady) {
    var el = document.getElementById('audio-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'audio-overlay';
      el.innerHTML = '<div class="audio-overlay-content">🔊 Audio is playing<br><span>Click anywhere to unmute</span></div>';
      el.onclick = function() {
        _onUserGesture();
        el.classList.remove('show');
        _audioUnlocked = true;
      };
      document.body.appendChild(el);
    }
    el.classList.add('show');
  }
}
// Check periodically until unlocked
var _audioOverlayCheck = setInterval(function() {
  if (_audioReady || _audioUnlocked) {
    _audioUnlocked = true;
    var el = document.getElementById('audio-overlay');
    if (el) el.classList.remove('show');
    clearInterval(_audioOverlayCheck);
    return;
  }
  _checkAudioOverlay();
}, 500);

// =====================================================================
// Status Overlay — free text pushed by user scripts (POST /sim/api/overlay)
// =====================================================================
var _statusOverlayLast = '';
function _applyOverlayText(text) {
  text = text || '';
  if (text === _statusOverlayLast) return;
  _statusOverlayLast = text;
  var el = document.getElementById('status-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'status-overlay';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle('show', !!text);
}
// 오버레이·밝기는 SSE(/sim/api/events) 푸시로 받는다 — HTTP 폴링 금지.
// (모든 요청이 게이트웨이 Worker 를 지나므로 폴링은 유저 규모에서 비용 직격)
// 첫 스냅샷이 접속 즉시 오므로 초기값도 이걸로 충분하고, 끊기면 브라우저가 자동 재연결.
(function _startPcEvents() {
  var es;
  try { es = new EventSource('/sim/api/events'); } catch (e) { return; }
  es.onmessage = function (ev) {
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (typeof d.overlay === 'string') { _applyOverlayText(d.overlay); }
    if (typeof d.brightness === 'number') { _applyRemoteBrightness(d.brightness); }
    if (Array.isArray(d.lights)) { _applyLightsSnapshot(d.lights); }
  };
})();

// =====================================================================
// Scene Management
// =====================================================================

const shaders = new GZ3D.Shaders();
var scene = new GZ3D.Scene(shaders);

// Gradient sky dome — replaces flat gray clear color with a vertical gradient.
(function setGradientSky() {
  if (!scene.scene) return;
  var skyVS = [
    'varying vec3 vWorldPos;',
    'void main() {',
    '  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');
  var skyFS = [
    'uniform vec3 topColor;',
    'uniform vec3 horizonColor;',
    'uniform vec3 bottomColor;',
    'varying vec3 vWorldPos;',
    'void main() {',
    '  float h = normalize(vWorldPos).z;', // gz uses Z-up
    '  vec3 col;',
    '  if (h >= 0.0) {',
    '    col = mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.6));',
    '  } else {',
    '    col = mix(horizonColor, bottomColor, pow(clamp(-h, 0.0, 1.0), 0.5));',
    '  }',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');
  var skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor:     { value: new THREE.Color(0x4a8fdc) },
      horizonColor: { value: new THREE.Color(0xc9deff) },
      bottomColor:  { value: new THREE.Color(0x9aa6b2) },
    },
    vertexShader: skyVS,
    fragmentShader: skyFS,
    side: THREE.BackSide,
    depthWrite: false,
  });
  var skyGeo = new THREE.SphereGeometry(500, 32, 16);
  var skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = 'GRADIENT_SKY';
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1000;
  scene.scene.add(skyMesh);
  // Make the camera follow the dome so it appears infinite.
  var origRender = scene.render.bind(scene);
  scene.render = function() {
    if (scene.camera) skyMesh.position.copy(scene.camera.position);
    origRender();
  };
})();

function clearScene() {
  if (!scene.scene) return;
  var toRemove = [];
  scene.scene.traverse(function(obj) {
    if (obj.userData && obj.userData.id !== undefined) toRemove.push(obj);
    if (obj instanceof THREE.Light) toRemove.push(obj);
  });
  for (var i = 0; i < toRemove.length; i++) {
    if (toRemove[i].parent) toRemove[i].parent.remove(toRemove[i]);
  }
  // Remove TF axes from scene
  for (var k in _axesHelpers) {
    if (_axesHelpers[k].parent) _axesHelpers[k].parent.remove(_axesHelpers[k]);
  }
  _axesHelpers = {};
  // Remove LiDAR overlays from scene
  if (_lidarPoints) {
    scene.scene.remove(_lidarPoints);
    _lidarPoints.geometry.dispose();
    _lidarPoints.material.dispose();
  }
  _lidarPoints = null;
  if (_lidarLines) {
    scene.scene.remove(_lidarLines);
    _lidarLines.geometry.dispose();
    _lidarLines.material.dispose();
  }
  _lidarLines = null;
}

// =====================================================================
// WebSocket Connection
// =====================================================================

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { gz = new Gazebo({ url: wsUrl, key: "gzweb" }); } catch(e) { scheduleReconnect(); return; }
  
  gz.on("connection", function() {
    connected = true;
    reconnectDelay = 3000;  // backoff reset on successful connect
    var rb = document.getElementById("respawn-btn");
    rb.disabled = false;
    // 리스폰/전환 완료 — 예전엔 페이지 리로드가 busy 스피너를 치웠지만,
    // 제자리 재접속 방식에서는 여기가 완료 지점이다
    rb.classList.remove("busy");
    // Sync world list on every (re)connect
    loadWorlds();
    _refreshWorldPub();   // 월드 전환 = WS 재연결 — CDN 매핑도 함께 갱신
    _refreshLights();
    _loadGridBounds();
  });
  
  gz.on("close", function() {
    if (connected) { connected = false; clearScene(); }
    document.getElementById("respawn-btn").disabled = true;
    scheduleReconnect();
  });
  
  gz.on("error", function() { scheduleReconnect(); });
  
  gz.on("worlds", function(_worlds) {
    var currentWorld = _worlds[0];
    var knownModels = {};
    var _lightsSetup = false;
    
    function handleScene(_sceneInfo) {
      // Setup lights from scene message (once)
      if (!_lightsSetup) {
        _lightsSetup = true;
        console.log('[Scene] Setting up lights from scene message');
        console.log('[Scene] ambient:', _sceneInfo.ambient);
        console.log('[Scene] lights:', _sceneInfo.light);
        
        // Ambient from scene (r,g,b are 0-1)
        // Update gz3d.js default ambient and re-add (clearScene removes all lights)
        if (_sceneInfo.ambient) {
          var a = _sceneInfo.ambient;
          // Scale down to match OGRE2 camera rendering (material ambient ~0.2)
          var s = 0.75;
          scene.ambient.color.setRGB(a.r * s, a.g * s, a.b * s);
          scene.scene.add(scene.ambient);
          console.log('[Scene] Updated ambient:', a.r * s, a.g * s, a.b * s);
        }
        
        // Lights from scene
        if (_sceneInfo.light) {
          for (var li = 0; li < _sceneInfo.light.length; li++) {
            var l = _sceneInfo.light[li];
            var col = new THREE.Color(l.diffuse.r, l.diffuse.g, l.diffuse.b);
            var light;
            // gz.msgs.Light.LightType: 0=POINT, 1=SPOT, 2=DIRECTIONAL
            if (l.type === 0) {
              light = new THREE.PointLight(col, l.intensity || 1.0, l.range || 100);
              if (l.pose && l.pose.position) {
                light.position.set(l.pose.position.x, l.pose.position.y, l.pose.position.z);
              }
            } else if (l.type === 1) {
              light = new THREE.SpotLight(col, l.intensity || 1.0);
              if (l.pose && l.pose.position) {
                light.position.set(l.pose.position.x, l.pose.position.y, l.pose.position.z);
              }
            } else if (l.type === 2) {
              light = new THREE.DirectionalLight(col, l.intensity || 1.0);
              if (l.direction) {
                light.position.set(-l.direction.x * 10, -l.direction.y * 10, -l.direction.z * 10);
              }
            }
            if (light) {
              scene.scene.add(light);
              console.log('[Scene] Added light:', l.name, 'type='+l.type, 'diffuse='+l.diffuse.r+','+l.diffuse.g+','+l.diffuse.b);
            }
          }
        }
        
        // Lights inside models (e.g., sun model has directional light in link)
        if (_sceneInfo.model) {
          console.log('[Scene] Checking', _sceneInfo.model.length, 'models for lights');
          for (var mi = 0; mi < _sceneInfo.model.length; mi++) {
            var model = _sceneInfo.model[mi];
            console.log('[Scene] Model:', model.name, 'links:', model.link ? model.link.length : 'none');
            if (model.link) {
              for (var li = 0; li < model.link.length; li++) {
                var link = model.link[li];
                if (link.light) {
                  for (var lti = 0; lti < link.light.length; lti++) {
                    var l = link.light[lti];
                    var col = new THREE.Color(l.diffuse.r, l.diffuse.g, l.diffuse.b);
                    var light;
                    // gz.msgs.Light.LightType: 0=POINT, 1=SPOT, 2=DIRECTIONAL
                    if (l.type === 0) {
                      light = new THREE.PointLight(col, l.intensity || 1.0, l.range || 100);
                      var pos = model.pose ? model.pose.position : {x:0,y:0,z:0};
                      light.position.set(pos.x, pos.y, pos.z);
                    } else if (l.type === 1) {
                      light = new THREE.SpotLight(col, l.intensity || 1.0);
                      var pos = model.pose ? model.pose.position : {x:0,y:0,z:0};
                      light.position.set(pos.x, pos.y, pos.z);
                    } else if (l.type === 2) {
                      // Directional light - use intensity from scene message
                      light = new THREE.DirectionalLight(col, l.intensity || 1.0);
                      if (l.direction) {
                        light.position.set(-l.direction.x, -l.direction.y, -l.direction.z).normalize().multiplyScalar(15);
                      }
                    }
                    if (light) {
                      scene.scene.add(light);
                      console.log('[Scene] Added model light:', model.name + '/' + link.name + '/' + l.name, 'type='+l.type, 'diffuse='+l.diffuse.r+','+l.diffuse.g+','+l.diffuse.b);
                    }
                  }
                }
              }
            }
          }
        }
        
        // Fallback: if no lights were added from scene, add default lighting
        var lightCount = 0;
        scene.scene.traverse(function(obj) { if (obj.isLight) lightCount++; });
        if (lightCount === 0) {
          console.log('[Scene] No lights from scene, adding fallback lighting');
          scene.scene.add(new THREE.AmbientLight(0x404040, 1.0));
          var defSun = new THREE.DirectionalLight(0xffffff, 0.6);
          defSun.position.set(5, -5, 10);
          scene.scene.add(defSun);
        }
      }
      
      for (var i = 0; i < _sceneInfo.model.length; ++i) {
        var m = _sceneInfo.model[i];
        // The in-world sky dome exists for the robot camera only; the viewer
        // renders its own shader gradient dome (same colors).
        if (m.name === 'physicar_sky') continue;
        if (!knownModels[m.name]) {
          knownModels[m.name] = true;
          var modelObj = createModelFromMsg(m);
          scene.add(modelObj);
        }
      }
    }
    
    function handleSceneWithRetry(_sceneInfo) {
      handleScene(_sceneInfo);
      // Keep asking while the scene comes back empty — a world can take 15s+
      // to boot after a switch, far longer than any fixed retry budget. The
      // old 5x2s cap gave up and left the viewer as an empty sky until a
      // manual page reload. Every world has models eventually (sun at
      // least), so this loop always terminates.
      if (_sceneInfo.model.length === 0) {
        setTimeout(function() {
          if (connected && gz && gz.socket && gz.socket.readyState === 1) {
            gz.socket.send(buildMsg(["scene", currentWorld, "", ""]));
          }
        }, 3000);
      }
    }
    
    gz.on("scene", handleSceneWithRetry);
    
    if (_worlds.length > 0) {
      gz.socket.send(buildMsg(["scene", currentWorld, "", ""]));
      var sceneRefreshPending = false;
      
      new Topic({ gz: gz, name: "/world/"+_worlds[0]+"/dynamic_pose/info",
        messageType: "gz.msgs.Pose_V",
        callback: function(msg) {
          var needRefresh = false;
          // One restamped tick per message — packets bursting in after a
          // page/network stall get their real spacing back (see _stampPoseTick)
          var st = _stampPoseTick();
          for (var j = 0; j < msg.pose.length; ++j) {
            var p = msg.pose[j];
            var e = scene.getByName(p.name);
            if (e) {
              // Buffer the timestamped pose; _applyPoseLerp() plays the
              // stream back _POSE_DELAY_MS in the past with linear
              // interpolation between packets (constant velocity, no jumps).
              _pushPoseSample(p.name, p.position || {}, p.orientation || {}, st);
            } else if (!knownModels[p.name] && p.name !== currentWorld) {
              needRefresh = true;
            }
          }
          if (needRefresh && !sceneRefreshPending) {
            sceneRefreshPending = true;
            setTimeout(function() {
              if (connected && gz && gz.socket && gz.socket.readyState === 1) {
                gz.socket.send(buildMsg(["scene", currentWorld, "", ""]));
              }
              sceneRefreshPending = false;
            }, 500);
          }
        }
      });
    }
  });
}

// Reconnect backoff: 3s doubling to 30s — flat retries hammer the tunnel
// proxy (billable per request) when the sim stays down.
var reconnectDelay = 3000;
function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }
}

// =====================================================================
// Mouse-controls hint
// =====================================================================

// Shown on every page load. Dismissed by any click, the X, or a 10 s
// timeout.
function _initMouseHint() {
  var el = document.getElementById("mouse-hint");
  if (!el) return;
  var timer = null;
  function dismiss() {
    if (timer) { clearTimeout(timer); timer = null; }
    el.classList.remove("show");
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
  }
  el.addEventListener("click", dismiss);
  setTimeout(function () { el.classList.add("show"); }, 300);
  timer = setTimeout(dismiss, 10000);
}

// =====================================================================
// Scene Initialization
// =====================================================================

function init() {
  if (!scene.scene || !scene.renderer) {
    var el = document.getElementById("container");
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#aaa;font-size:16px;text-align:center;padding:20px">' +
      '<div><p style="font-size:20px;margin-bottom:12px">WebGL Unavailable</p>' +
      '<p style="font-size:13px;color:#666">Could not create WebGL context.<br>Try closing other 3D tabs or refresh the page.</p></div></div>';
    return;
  }
  // GZ3D 기본 그리드는 원점 중심(전 사분면) — 월드는 1사분면(0,0)~(W,H) 기준이라
  // 사용하지 않는다 (World Builder와 동일한 1사분면 그리드를 대신 그림).
  scene.grid.visible = false;
  scene.grid.raycast = function() {};

  // Remove any default lights added by GZ3D.Scene
  var toRemove = [];
  scene.scene.traverse(function(obj) {
    if (obj.isLight) toRemove.push(obj);
  });
  toRemove.forEach(function(l) { scene.scene.remove(l); });
  console.log('[Init] Removed', toRemove.length, 'default lights');
  
  // Lights will be added from scene message in handleScene()
  
  // Create audio visual indicator
  _createAudioRing();
  
  var el = document.getElementById("container");
  el.appendChild(scene.renderer.domElement);
  scene.setSize(el.clientWidth, el.clientHeight);
  _initInteract(el);
  var cam = scene.camera;
  // near/far 1:100,000 은 깊이 정밀도를 파괴해 mm 겹층(필드/도로/라인)이
  // z-fighting 으로 회색 아스팔트·배경색을 배어나오게 한다 → 상식 범위로.
  cam.near = 0.2; cam.far = 2000; cam.updateProjectionMatrix();
  scene.scene.fog = null;

  // Ground-stack separation WITHOUT polygonOffset. The old offset pass made
  // fragments vanish wholesale on Windows/ANGLE at oblique angles (offset
  // scales with the on-screen depth slope). Instead, physically lift the
  // track's decal layers apart: sort the thin flat track meshes by their
  // baked z and give each layer a real 0.5mm step via mesh.position.z.
  // Sub-mm gaps in the exports (road 0.1mm over field, lines 0.03mm over
  // road) are below depth precision at a distance and shimmer otherwise.
  // Track meshes sit at the world origin with identity transforms; anything
  // positioned elsewhere (vehicle, cones, handles) is left alone.
  function applyDecalLift() {
    try {
      var flats = [];
      var wp = new THREE.Vector3();
      scene.scene.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.material || Array.isArray(o.material)) return;
        if (o.renderOrder > 900) return;                      // UI overlays
        var g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        var bb = g.boundingBox;
        if (!bb) return;
        var h = bb.max.z - bb.min.z;
        var area = (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y);
        if (h >= 0.01 || area < 0.05) return;
        if (bb.min.z < -0.1 || bb.min.z > 0.05) return;
        o.getWorldPosition(wp);
        wp.z -= o.position.z;                                 // ignore our own lift
        if (Math.abs(wp.x) > 0.01 || Math.abs(wp.y) > 0.01 || Math.abs(wp.z) > 0.01) return;
        flats.push({ o: o, z: bb.min.z, area: area });
      });
      if (flats.length < 2) return;
      flats.sort(function (a, b) { return (a.z - b.z) || (b.area - a.area); });
      var base = flats[0].z;
      flats.forEach(function (f, i) {
        var lift = (base + i * 0.0005) - f.z;
        if (Math.abs(f.o.position.z - lift) > 1e-6) f.o.position.z = lift;
      });
    } catch (e) { /* 방어적 — 뷰어 본연 동작엔 영향 금지 */ }
  }

  // Max anisotropic filtering on every texture. At oblique view angles the
  // GPU falls back to deep mip levels; with anisotropy=1 (three.js default)
  // the ground textures smear into a gray mush — grass turned gray-white,
  // road decals shredded, the start line bled into a wide white band.
  function applyTextureAniso() {
    try {
      var max = scene.renderer.capabilities.getMaxAnisotropy();
      scene.scene.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) {
          if (m.map && m.map.anisotropy !== max) {
            m.map.anisotropy = max;
            m.map.needsUpdate = true;
          }
        });
      });
    } catch (e) { /* 방어적 */ }
  }
  // 로드에 실패한 텍스처(image undefined) 정리 — 방치하면 렌더러가 매 프레임
  // "Texture marked for update but image is undefined" 를 찍어 콘솔을 플러딩한다.
  // 15초의 로딩 유예 후에도 이미지가 없으면 맵을 떼고 단색으로 렌더.
  function _dropDeadTextures() {
    var now = Date.now();
    scene.scene.traverse(function(o) {
      if (!o.material) { return; }
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function(m) {
        if (!m.map) { return; }
        if (m.map.image) { m.map.__pcFirstSeen = 0; return; }
        if (!m.map.__pcFirstSeen) { m.map.__pcFirstSeen = now; return; }
        if (now - m.map.__pcFirstSeen > 15000) {
          m.map = null;
          m.needsUpdate = true;
        }
      });
    });
  }
  function _groundUpkeep() { applyDecalLift(); applyTextureAniso(); applyViewerBrightness(); _dropDeadTextures(); }
  setTimeout(_groundUpkeep, 3000);
  setInterval(_groundUpkeep, 5000);
  cam.position.x = 0; cam.position.y = -1.2; cam.position.z = 0.6;
  cam.up.set(0, 0, 1);
  cam.lookAt(new THREE.Vector3(0, 0, 0.1));
  animate();

  // ── F12 diagnostics (window.pcDebug / pcHide / pcShow, Alt+click probe) ──
  // The gray-floor reports could never be reproduced on our side; these
  // helpers let the affected browser tell us what IT is actually rendering.
  (function () {
    function _objName(o) {
      var n = o.name, p = o.parent;
      while (!n && p) { n = p.name; p = p.parent; }
      return n || "?";
    }
    window.pcDebug = function () {
      var gl = scene.renderer.getContext();
      var cam = scene.camera;
      var flats = [];
      scene.scene.traverse(function (o) {
        if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
        var g = o.geometry;
        if (!g) return;
        if (!g.boundingBox) g.computeBoundingBox();
        var bb = g.boundingBox;
        if (!bb) return;
        if (bb.max.z - bb.min.z < 0.01 && bb.min.z > -0.1 && bb.min.z < 0.05) {
          var m = o.material;
          flats.push(_objName(o) + " z=" + bb.min.z.toFixed(4)
            + " lift=" + o.position.z.toFixed(4) + " dw=" + m.depthWrite
            + " ro=" + o.renderOrder
            + " aniso=" + (m.map ? m.map.anisotropy : "-"));
        }
      });
      var d = {
        DEPTH_BITS: gl.getParameter(gl.DEPTH_BITS),
        contextLost: gl.isContextLost(),
        dpr: window.devicePixelRatio,
        cam: { pos: cam.position.toArray().map(function (v) { return +v.toFixed(3); }),
               near: cam.near, far: cam.far, fov: cam.fov, aspect: +cam.aspect.toFixed(3) },
        renderer: scene.renderer.info.render,
        meshes: (function () { var n = 0; scene.scene.traverse(function (o) { if (o.isMesh) n++; }); return n; })(),
        flats: flats,
      };
      console.log("[pcDebug]", JSON.stringify(d, null, 1));
      return d;
    };
    window.pcHide = function (name) {
      var n = 0;
      scene.scene.traverse(function (o) { if (_objName(o) === name && o.isMesh) { o.visible = false; n++; } });
      console.log("[pcHide]", name, n, "meshes hidden");
      return n;
    };
    window.pcShow = function (name) {
      var n = 0;
      scene.scene.traverse(function (o) { if (_objName(o) === name && o.isMesh) { o.visible = true; n++; } });
      console.log("[pcShow]", name, n, "meshes shown");
      return n;
    };
    el.addEventListener("pointerdown", function (e) {
      if (!e.altKey) return;
      var r = el.getBoundingClientRect();
      var ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1,
                                  -((e.clientY - r.top) / r.height) * 2 + 1);
      var ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, scene.camera);
      var hits = ray.intersectObjects(scene.scene.children, true)
        .filter(function (h) { return h.object.visible; }).slice(0, 6)
        .map(function (h) {
          var m = h.object.material && (Array.isArray(h.object.material) ? h.object.material[0] : h.object.material);
          return _objName(h.object) + "@" + h.distance.toFixed(2)
            + (m ? " [" + m.type + " dw=" + m.depthWrite + "]" : "");
        });
      console.log("[pcPick]", hits.join("  |  ") || "(nothing)");
    });
    var _lastPose = "";
    setInterval(function () {
      var c = scene.camera;
      var p = c.position.toArray().map(function (v) { return +v.toFixed(2); }).join(",")
        + "|" + c.quaternion.toArray().map(function (v) { return +v.toFixed(3); }).join(",");
      if (p !== _lastPose) { _lastPose = p; console.log("[pcCam]", p); }
    }, 2000);
  })();

  // Toolbar is one width-agnostic style — no narrow/wide mode switch.
  window.addEventListener("resize", function() { scene.setSize(el.clientWidth, el.clientHeight); });
  // Apply saved settings then connect
  _applySettings();
  connect();
  _initMouseHint();
}

// =====================================================================
// World Selector Controls
// =====================================================================

var worldsData = [];
var currentWorld = null;
var _controlsEnabled = false;

function setControlsEnabled(enabled) {
  _controlsEnabled = enabled;
  var chip = document.getElementById("world-chip");
  if (enabled) { chip.classList.remove("disabled"); } else { chip.classList.add("disabled"); }
}

function openWorldModal() {
  if (!_controlsEnabled) return;
  document.getElementById("world-modal-overlay").classList.add("open");
  document.getElementById("world-modal").classList.add("open");
}

function closeWorldModal() {
  document.getElementById("world-modal-overlay").classList.remove("open");
  document.getElementById("world-modal").classList.remove("open");
  renderWorldLists();   // collapse any pending inline delete confirm
}

function _wmStatus(msg, cls) {
  var el = document.getElementById("wm-status");
  el.textContent = msg || "";
  el.className = cls || "";
}

function renderWorldLists() {
  var official = document.getElementById("wm-official");
  var custom = document.getElementById("wm-custom");
  official.innerHTML = "";
  custom.innerHTML = "";
  worldsData.forEach(function(w) {
    var row = document.createElement("div");
    var isCurrent = w.name === currentWorld;
    row.className = "wm-row" + (isCurrent ? " active" : "");
    var label = document.createElement("span");
    label.className = "wm-name";
    label.textContent = (isCurrent ? "\u2713 " : "") + (w.display || w.name);
    row.appendChild(label);
    var idText = w.world_id ? w.world_id.slice(0, 8) : w.name;
    if (w.display && w.display !== w.name || w.world_id) {
      var idTag = document.createElement("span");
      idTag.className = "wm-idtag";
      idTag.textContent = idText;
      idTag.title = w.world_id || w.name;
      row.appendChild(idTag);
    }
    row.onclick = function() { if (!isCurrent) switchWorld(w.file); };
    if (w.deletable) {
      var del = document.createElement("span");
      del.className = "wm-del";
      del.innerHTML = "&#x1f5d1;";
      del.title = "Delete " + w.name;
      // No window.confirm — it is silently dropped inside webviews. The row
      // swaps to an inline Delete?/Cancel pair instead.
      del.onclick = function(e) {
        e.stopPropagation();
        row.onclick = null;
        del.remove();
        var c = document.createElement("span");
        c.className = "wm-confirm";
        c.innerHTML = "Delete?";
        var yes = document.createElement("button");
        yes.className = "wm-yes"; yes.textContent = "\u2713";
        yes.onclick = function(e2) { e2.stopPropagation(); deleteWorld(w.name); };
        var no = document.createElement("button");
        no.className = "wm-no"; no.textContent = "\u2715";
        no.onclick = function(e2) { e2.stopPropagation(); renderWorldLists(); };
        c.appendChild(yes); c.appendChild(no);
        row.appendChild(c);
      };
      row.appendChild(del);
    }
    var isCustom = w.official !== undefined ? !w.official : w.name.indexOf("custom_") === 0;
    (isCustom ? custom : official).appendChild(row);
  });
  if (!custom.children.length) {
    var empty = document.createElement("div");
    empty.className = "wm-empty";
    empty.textContent = "No custom worlds installed yet.";
    custom.appendChild(empty);
  }
}

function loadWorlds(selectWorld) {
  setControlsEnabled(false);
  fetch("/sim/api/worlds").then(function(r){return r.json()}).then(function(data) {
    worldsData = data.worlds;
    currentWorld = selectWorld || data.current;
    var curRow = null;
    for (var i = 0; i < worldsData.length; i++) {
      if (worldsData[i].name === currentWorld) { curRow = worldsData[i]; break; }
    }
    document.getElementById("world-chip").textContent =
      (curRow && (curRow.display || curRow.name)) || currentWorld || "...";
    renderWorldLists();
    setControlsEnabled(true);
  }).catch(function() { setTimeout(function(){ loadWorlds(); }, 3000); });
}

function deleteWorld(name) {
  setControlsEnabled(false);
  _wmStatus("Deleting " + name + "...", "");
  fetch("/sim/api/worlds/" + name, { method: "DELETE" })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        var wasCurrent = name === currentWorld;
        _wmStatus("Deleted " + name + ".", "success");
        loadWorlds();
        // Deleting the running world makes the server boot the default one —
        // reload so the viewer follows it.
        if (wasCurrent) setTimeout(function() { location.reload(); }, 3000);
      } else {
        _wmStatus(d.error || "Delete failed", "error");
        setControlsEnabled(true);
      }
    }).catch(function() { _wmStatus("Delete failed", "error"); setControlsEnabled(true); });
}

function switchWorld(worldFile) {
  setControlsEnabled(false);
  _prefetchSwitchTarget(worldFile);   // gz 재시작(수 초)과 다운로드를 겹친다
  var targetWorld = worldFile.replace(/\.world$/, "");
  var row = null;
  for (var i = 0; i < (worldsData || []).length; i++) {
    if (worldsData[i].file === worldFile) { row = worldsData[i]; break; }
  }
  document.getElementById("world-chip").textContent =
    (row && (row.display || row.name)) || targetWorld;
  closeWorldModal();
  document.getElementById("respawn-btn").disabled = true;
  fetch("/sim/api/switch", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    // 배포 월드는 world_id 로 스위치 (파일명은 내장 월드용)
    body: JSON.stringify(row && row.world_id ? {world_id: row.world_id} : {world: worldFile})
  }).then(function() {
    var attempts = 0;
    var poll = setInterval(function() {
      attempts++;
      fetch("/sim/api/status").then(function(r){return r.json()}).then(function(d) {
        if (d.running && d.websocket && d.current === targetWorld) {
          // 페이지 리로드 없이 제자리 재접속 — 예전의 "2초 대기 + 풀 리로드"는
          // 부트스트랩을 전부 다시 밟느라 전환이 카메라보다 수 초 늦었고,
          // switch 시점 프리페치(메모리)도 페이지와 함께 사라졌다. 씬은 ws
          // 재연결로 새로 그려진다 (connection 핸들러가 월드 목록·CDN 매핑
          // 갱신). 재시작 직후 소켓은 간혹 행에 걸리므로, 접속이 붙을 때까지
          // 매 틱 재시도한다 (백오프 수십 초에 맡기지 않는다).
          if (connected) { clearInterval(poll); return; }
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          reconnectDelay = 500;
          connect();
        } else if (attempts > 60) {
          clearInterval(poll);
          location.reload();   // 최후 수단 — 전환이 완전히 꼬였을 때만
        }
      }).catch(function() {});
    }, 1000);
  }).catch(function() {
    setControlsEnabled(true);
    document.getElementById("respawn-btn").classList.remove("busy");
  });
}

// ── Scene brightness: one server-side factor, applied instantly ──
// The viewer scales its lights; the webserver scales the camera frames.
// (The gz sensor scene ignores runtime light changes, and a world restart
// per change was terrible UX — no scene reload happens here.)
var _brightFactor = 1.0;
var _brightPostTimer = null;
function applyViewerBrightness() {
  // A CSS brightness() filter on the render canvas — the exact same linear
  // pixel scaling the webserver applies to the camera frames, so the viewer
  // and the robot camera match by construction (sky included). Light-
  // intensity scaling was tried first and dimmed far less than the camera.
  try {
    scene.renderer.domElement.style.filter =
      (Math.abs(_brightFactor - 1) < 0.01) ? "" : ("brightness(" + _brightFactor + ")");
  } catch (e) { /* defensive */ }
}
function setBrightness(v) {
  _brightFactor = Math.min(2, Math.max(0.2, +v));
  document.getElementById("brightness-val").textContent = _brightFactor.toFixed(1);
  applyViewerBrightness();          // instant locally
  clearTimeout(_brightPostTimer);   // debounce server writes while dragging
  _brightPostTimer = setTimeout(function () {
    fetch("/sim/api/brightness", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: _brightFactor }) }).catch(function () {});
  }, 250);
}
function _applyRemoteBrightness(v) {
  if (!v) { return; }
  var slider = document.getElementById("brightness-slider");
  if (document.activeElement === slider) { return; }   // don't fight a drag
  if (Math.abs(v - _brightFactor) > 0.01) {
    _brightFactor = +v;
    slider.value = v;
    document.getElementById("brightness-val").textContent = (+v).toFixed(1);
  }
  applyViewerBrightness();
}

setTimeout(loadWorlds, 500);
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape") closeWorldModal();
});

// =====================================================================
// Object Manipulation (World Builder 상호작용 계약 — gz-interact.js 공유 모듈)
//  + Traffic Light Control Panel (신호등 클릭 → 우측 제어 패널)
// =====================================================================
var gzInteract = null;
var _lightsCache = {};   // name -> {state, builtin, x, y, yaw}
var _poseHold = {};      // name -> ms timestamp — 커밋 직후 스트림 포즈 반영 억제
var _poseLerp = {};      // name -> ring of timestamped stream poses (playout buffer)
var _POSE_DELAY_MS = 100;  // render this far in the past, linearly interpolating
                           // between the two bracketing packets. Constant-velocity
                           // playback masks the packet rate completely; exponential
                           // chasing (tried first) ripples at the packet frequency.

// Jitter-buffer restamp for pose packets. When the page or the network
// stalls (browser jank, tunnel hiccup), the packets buffered during the
// stall all ARRIVE within a few milliseconds. Stamping them with their
// arrival time would compress hundreds of ms of motion into a ~0 ms
// timeline span — playback then interpolates across near-identical
// timestamps, whipping back and forth between neighboring samples (the
// "left-right twitch" seen after every freeze). Normal-cadence packets
// keep their arrival time (the original, proven-smooth path); only burst
// members are re-spaced — spread FORWARD at ~3x the stream rate so the
// playback glides once, briskly and smoothly, through the backlog.
var _poseTick = { p: 50, last: 0, t: 0 };
function _stampPoseTick() {
  var now = performance.now();
  var gap = now - _poseTick.last;
  _poseTick.last = now;
  var t;
  if (gap > 15) {
    // Normal cadence: trust the arrival clock — identical to the original
    // behavior, which renders smoothly. Learn the stream period from these
    // gaps only (burst gaps of ~0 ms must not drag the estimate down).
    if (gap < 150) { _poseTick.p += (gap - _poseTick.p) * 0.05; }
    // max() only unwinds a just-finished burst spread that overshot "now":
    // stamps then advance 8 ms per packet until real time catches up.
    t = Math.max(now, _poseTick.t + 8);
  } else {
    // Burst member — packets released together after a page/network stall.
    // Spread them FORWARD at ~3x the stream rate: playback glides briskly
    // and smoothly through the backlog instead of whipping through a
    // zero-width timeline. Capped so an extreme stall cannot push stamps
    // far into the future.
    t = Math.min(_poseTick.t + Math.max(5, _poseTick.p / 3), now + 400);
  }
  _poseTick.t = t;
  return t;
}

function _pushPoseSample(name, pos, ori, stamp) {
  var q = new THREE.Quaternion(ori.x || 0, ori.y || 0, ori.z || 0,
                               ori.w !== undefined ? ori.w : 1);
  var s = { t: stamp !== undefined ? stamp : performance.now(),
            x: pos.x || 0, y: pos.y || 0, z: pos.z || 0, q: q };
  var buf = _poseLerp[name];
  if (!buf) { _poseLerp[name] = [s]; return; }
  var last = buf[buf.length - 1];
  if (s.t <= last.t) { s.t = last.t + 0.1; }   // keep per-name monotonicity
  var dx = s.x - last.x, dy = s.y - last.y, dz = s.z - last.z;
  if (dx * dx + dy * dy + dz * dz > 4) buf.length = 0;  // teleport: snap, don't glide
  buf.push(s);
  if (buf.length > 30) buf.shift();   // ~1.2 s at the usual stream rate
}

function _applyPoseLerp() {
  var rt = performance.now() - _POSE_DELAY_MS;
  for (var name in _poseLerp) {
    var buf = _poseLerp[name];
    if (!buf.length) { delete _poseLerp[name]; continue; }
    var e = scene.getByName(name);
    if (!e) { delete _poseLerp[name]; continue; }
    if (e === scene.modelManipulator.object || e.parent === scene.modelManipulator.object) continue;
    if (gzInteract && gzInteract.isManipulating(name)) continue;
    if (_poseHold[name] && _poseHold[name] > Date.now()) continue;
    // Find the two samples bracketing the playback time.
    var a = buf[0], b = null;
    for (var i = 0; i < buf.length; i++) {
      if (buf[i].t <= rt) { a = buf[i]; b = buf[i + 1] || null; }
      else { if (buf[i] !== a) b = buf[i]; break; }
    }
    var np, nq;
    if (b && b.t > a.t && rt >= a.t) {
      var f = Math.min(1, (rt - a.t) / (b.t - a.t));
      np = { x: a.x + (b.x - a.x) * f,
             y: a.y + (b.y - a.y) * f,
             z: a.z + (b.z - a.z) * f };
      nq = a.q.clone().slerp(b.q, f);
    } else {
      var s = (rt < a.t) ? a : buf[buf.length - 1];
      np = { x: s.x, y: s.y, z: s.z };
      nq = s.q;
    }
    scene.updatePose(e, np, { x: nq.x, y: nq.y, z: nq.z, w: nq.w });
    // Light-state overlays park deep underground when off — hide them there
    // entirely (they peek out below field edges otherwise)
    var om = name.match(/^(.+)_(yellow|red|gcover)$/);
    if (om && _lightsCache[om[1]]) { e.visible = np.z > -0.5; }
    // Drop samples that can no longer be needed (keep one before rt).
    while (buf.length > 2 && buf[1].t <= rt) buf.shift();
  }
}
var _selLight = null;

// SSE 스냅샷의 신호등 상태 반영 — 주기 폴링(/traffic_lights) 대체. 상태가
// 바뀔 때만 서버가 푸시한다. 노랑 경유 중에는 서버가 준 잔여시간에 맞춰
// 전환 직후 1회만 정밀 확인한다 (루프 아님 — SSE 틱(1s)보다 빨리 맞추는 용도).
var _yellowFlipTimer = null;
function _applyLightsSnapshot(list) {
  _lightsCache = {};
  list.forEach(function(l) { _lightsCache[l.name] = l; });
  _applyLightVisuals();
  if (_selLight) { _renderLightPanel(); }
  if (_yellowFlipTimer) { clearTimeout(_yellowFlipTimer); _yellowFlipTimer = null; }
  var wait = null;
  list.forEach(function(l) {
    if (l.state === 'yellow' && typeof l.yellow_left === 'number') {
      var w = Math.max(150, l.yellow_left * 1000 + 150);
      wait = (wait === null) ? w : Math.min(wait, w);
    }
  });
  if (wait !== null) { _yellowFlipTimer = setTimeout(function() { _refreshLights(); }, wait); }
}

function _refreshLights(cb) {
  fetch("/sim/api/traffic_lights")
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _lightsCache = {};
      (d.lights || []).forEach(function(l) { _lightsCache[l.name] = l; });
      _applyLightVisuals();
      if (_selLight) { _renderLightPanel(); }
      if (cb) { cb(); }
    })
    .catch(function() { if (cb) { cb(); } });
}

// ── 램프 색 계약 (sim_api._LAMP_COLORS와 쌍) — 상태 변경은 재질 색 교체일 뿐,
//    램프 메시는 월드 로드 때 이미 씬에 있으므로 즉시 반영된다 ──
var LAMP_COLORS = {
  // 노랑은 서버가 오버레이 모델(<name>_yellow, 포즈 스트리밍)로 표시 — 클라 칠하기 없음
  red:    { lamp_red: ['#ff0000', '#800000'], lamp_green: ['#001200', null] },
  yellow: { lamp_red: ['#120000', null], lamp_green: ['#001200', null] },
  green:  { lamp_red: ['#120000', null], lamp_green: ['#00ff00', '#008000'] }
};

function _applyLightVisuals() {
  Object.keys(_lightsCache).forEach(function(name) {
    var l = _lightsCache[name];
    var model = scene.getByName(name);
    var colors = LAMP_COLORS[(l || {}).state];
    if (model && colors) {
      model.traverse(function(o) {
        var c = colors[o.name];
        if (!c) { return; }
        o.traverse(function(m) {
          if (m.material && m.material.color) {
            m.material.color.set(c[0]);
            if (m.material.emissive) { m.material.emissive.set(c[1] || '#000000'); }
          }
        });
      });
    }
    _placeLightOverlays(name, l);
  });
}

// 오버레이 즉시 배치 — gz 포즈 스트림은 ~1초 늦게 도착하므로, 상태를 안 순간
// 클라이언트가 디스크를 직접 옮긴다 (램프 색칠과 같은 틱 → 패널과 완전 동기).
// 잠시 _poseHold로 스트림을 무시하고, 이후 스트림이 같은 포즈를 보내와도
// 시각 변화는 없다. 앵커(px/pz)는 /traffic_lights 응답의 panel 데이터.
function _placeLightOverlays(name, l) {
  var pn = l && l.panel;
  if (!pn) { return; }
  var states = { yellow: l.state === 'yellow', red: l.state === 'red', gcover: l.state !== 'green' };
  var anchors = { yellow: { px: pn.px, pz: pn.pz }, red: pn.red, gcover: pn.green };
  Object.keys(states).forEach(function(suffix) {
    var a = anchors[suffix];
    var o = scene.getByName(name + '_' + suffix);
    if (!a || !o) { return; }
    var on = states[suffix];
    var wx = on ? l.x + Math.cos(l.yaw) * a.px : l.x;
    var wy = on ? l.y + Math.sin(l.yaw) * a.px : l.y;
    var wz = on ? a.pz : -50;
    var key = wx.toFixed(4) + '|' + wy.toFixed(4) + '|' + wz.toFixed(4);
    if (o.userData.pcOverlayKey === key) { return; }   // unchanged — leave stream alone
    o.userData.pcOverlayKey = key;
    var sy = Math.sin(l.yaw / 2), cy = Math.cos(l.yaw / 2);
    var sp = Math.sin((pn.pitch || 0) / 2), cp = Math.cos((pn.pitch || 0) / 2);
    o.position.set(wx, wy, wz);
    o.quaternion.set(-sy * sp, cy * sp, cp * sy, cy * cp);  // qz(yaw) ⊗ qy(pitch)
    o.visible = wz > -0.5;
    delete _poseLerp[name + '_' + suffix];
    _poseHold[name + '_' + suffix] = Date.now() + 2000;
  });
}


// 픽킹 대상 판별 — 최상위 모델의 link(자식) 이름 마커로 종류 결정
// (Custom World Builder 계약: object/wall/light — 'signal'은 구 마커)
function _resolveTarget(top, leaf) {
  var name = top.name;
  if (!name || name === 'plane' || name === 'grid' || name === 'racetrack' ||
      name === 'sun' || name === 'GRADIENT_SKY' || name === 'physicar_sky' || name === 'boundingBox' ||
      name === currentWorld) {
    return null;
  }
  // 상태 오버레이(런타임 모델: yellow/red/gcover 디스크) 클릭 → 본체 신호등으로
  // 승격 — 디스크가 독립 오브젝트로 선택/드래그되면 안 된다
  var ym = name.match(/^(.+)_(yellow|red|gcover)$/);
  if (ym && _lightsCache[ym[1]]) {
    var stand = scene.getByName(ym[1]);
    return stand ? _lightTarget(stand, ym[1]) : null;
  }
  var marker = null;
  for (var i = 0; i < top.children.length; i++) {
    var n = top.children[i].name;
    if (n === 'wall' || n === 'light' || n === 'signal' || n === 'object') { marker = n; break; }
  }
  if (marker === 'wall') { return null; }        // 벽은 이동 불가 (WB와 동일)
  if (marker === 'light' || marker === 'signal' || _lightsCache[name]) {
    return _lightTarget(top, name);              // 단일 강체 — 램프는 링크 visual
  }
  if (name === 'physicar') { return { obj: top, name: name, kind: 'vehicle' }; }
  return { obj: top, name: name, kind: 'object' };
}

// 신호등 선택 대상: 상태 오버레이 디스크들을 attachments로 실어 드래그/회전
// 중에 본체와 강체로 함께 움직이게 한다 (안 실으면 옛 자리에 붕 떠서 남는다)
function _lightTarget(stand, name) {
  var att = [];
  ['yellow', 'red', 'gcover'].forEach(function(sfx) {
    var o = scene.getByName(name + '_' + sfx);
    if (o) { att.push(o); }
  });
  return { obj: stand, name: name, kind: 'light', attachments: att };
}

function _onSelect(sel) {
  if (sel.kind === 'light') {
    _showLightPanel(sel.name);
  } else {
    _hideLightPanel();
  }
}

function _onDeselect() {
  _hideLightPanel();
}

// 조작 확정 — 놓는 순간 pose API 호출 (WB commitManipulation의 sim 구현)
function _commitPose(sel, pose) {
  var names = [sel.name].concat((sel.attachments || []).map(function(o) { return o.name; }));
  names.forEach(function(n) { _poseHold[n] = Date.now() + 3000; });
  function release() { names.forEach(function(n) { delete _poseHold[n]; }); }
  var url, body;
  if (sel.kind === 'vehicle') {
    url = "/sim/api/pose";
    body = { x: pose.x, y: pose.y, yaw: pose.yaw };
  } else {
    // z는 보내지 않는다 — 서버가 지면 안착 높이를 계산 (넘어진 물체를
    // 드래그하면 세워지므로, 누운 상태의 z를 보내면 뜨거나 파묻힌다)
    url = "/sim/api/models/" + sel.name + "/pose";
    body = { x: pose.x, y: pose.y, yaw: pose.yaw };
  }
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    release(); // 서버 적용 완료 — 다음 스트림 프레임부터 실제 포즈 반영
    if (!d.ok) {
      _showToast(d.error || "Move failed");
    } else if (sel.kind === 'light') {
      // 오버레이 디스크를 서버 확정 포즈로 즉시 재배치 (폴링까지 안 기다림)
      _refreshLights();
    }
  })
  .catch(function() { release(); _showToast("Move failed"); });
}

function _initInteract(container) {
  gzInteract = GzInteract.create({
    THREE: THREE,
    scene: scene,
    container: container,
    resolveTarget: _resolveTarget,
    onSelect: _onSelect,
    onDeselect: _onDeselect,
    onCommit: _commitPose
  });
}

// ── 신호등 제어 패널 (우측) ──
function _showLightPanel(name) {
  _selLight = name;
  _renderLightPanel();
  document.getElementById("light-panel").classList.add("show");
  _refreshLights();
}

function _hideLightPanel() {
  _selLight = null;
  document.getElementById("light-panel").classList.remove("show");
}

function _renderLightPanel() {
  if (!_selLight) { return; }
  var st = (_lightsCache[_selLight] || {}).state || "";
  document.getElementById("lp-name").textContent = _selLight;
  document.getElementById("lp-lights").className = "lp-lights " + st;
}

function setLightState(name, state) {
  if (!name) { return; }
  var cur = (_lightsCache[name] || {}).state;
  if (cur === state || cur === "yellow") { return; } // 켜진 불/노랑 경유 중 클릭 무시
  fetch("/sim/api/traffic_lights/" + name, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({state: state})
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (!d.ok) { _showToast(d.error || "State change failed"); }
    _refreshLights();
  })
  .catch(function() { _showToast("State change failed"); });
}

// =====================================================================
// Distance-based Audio Volume
// =====================================================================
var _distanceVolumeEnabled = true;
var _distanceVolumeMax = 10.0;  // max distance (volume = 0 beyond this)
var _distanceVolumeMin = 0.2;   // min distance (volume = 1 within this)
var _distanceVolumeFactor = 1.0; // current multiplier

// =====================================================================
// Audio Visual Indicator (floor ring)
// =====================================================================
var _audioRing = null;
var _audioRingScale = 0;
var _audioRingOpacity = 0;
var _audioPlaying = false;

function _createAudioRing() {
  var geometry = new THREE.RingGeometry(0.15, 0.18, 32);
  var material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0
  });
  _audioRing = new THREE.Mesh(geometry, material);
  // XY plane = floor in Gazebo z-up coords (no rotation needed)
  _audioRing.position.z = 0.01; // slightly above ground
  _audioRing.visible = false;
  scene.scene.add(_audioRing);
}

function _updateAudioRing() {
  if (!_audioRing) return;
  
  var physicarObj = scene.getByName('physicar');
  if (!physicarObj) {
    _audioRing.visible = false;
    return;
  }
  
  // Check if any channel is playing
  var isPlaying = false;
  for (var k in _audioChannels) {
    if (_audioChannels.hasOwnProperty(k)) {
      var entry = _audioChannels[k];
      var active = entry.media
        ? (!entry.media.paused && !entry.media.ended)
        : (entry.sources.length > 0 || entry.queue.length > 0);
      if (active) {
        isPlaying = true;
        break;
      }
    }
  }
  
  if (isPlaying) {
    _audioPlaying = true;
    // Expand ring slowly
    _audioRingScale += 0.015;
    if (_audioRingScale > 1.0) _audioRingScale = 0.2;
    _audioRingOpacity = 0.25 * (1.0 - _audioRingScale) / 0.8;
  } else {
    _audioPlaying = false;
    _audioRingOpacity *= 0.95;
    if (_audioRingOpacity < 0.01) {
      _audioRing.visible = false;
      return;
    }
  }
  
  // Position at physicar
  var pos = new THREE.Vector3();
  physicarObj.getWorldPosition(pos);
  _audioRing.position.x = pos.x;
  _audioRing.position.y = pos.y;
  
  // Apply scale and opacity
  var s = 0.5 + _audioRingScale * 1.5;
  _audioRing.scale.set(s, s, 1);
  _audioRing.material.opacity = _audioRingOpacity;
  _audioRing.visible = true;
}

function _updateDistanceVolume() {
  if (!_distanceVolumeEnabled || !_audioReady) return;
  
  // Find physicar model
  var physicarObj = scene.getByName('physicar');
  if (!physicarObj) return;
  
  // Get world position of physicar
  var physicarPos = new THREE.Vector3();
  physicarObj.getWorldPosition(physicarPos);
  
  // Get camera position
  var camPos = scene.camera.position;
  
  // Calculate distance
  var dist = camPos.distanceTo(physicarPos);
  
  // Calculate volume factor (1 at min, 0 at max, linear falloff)
  var factor;
  if (dist <= _distanceVolumeMin) {
    factor = 1.0;
  } else if (dist >= _distanceVolumeMax) {
    factor = 0.0;
  } else {
    factor = 1.0 - (dist - _distanceVolumeMin) / (_distanceVolumeMax - _distanceVolumeMin);
  }
  
  // Apply to all channels (multiply with channel's base volume)
  if (Math.abs(factor - _distanceVolumeFactor) > 0.01) {
    _distanceVolumeFactor = factor;
    for (var k in _audioChannels) {
      if (_audioChannels.hasOwnProperty(k)) {
        _applyEntryVolume(_audioChannels[k]);
      }
    }
  }
}

// =====================================================================
// Settings
// =====================================================================

var _settingsDefaults = { autoFollow: true, grid: false, axes: false, lidar: false, pose: false };

function saveSettings() {
  try {
    localStorage.setItem('gz_settings', JSON.stringify({
      autoFollow: document.getElementById('chk-autofollow').checked,
      grid: document.getElementById('chk-grid').checked,
      axes: document.getElementById('chk-axes').checked,
      lidar: document.getElementById('chk-lidar').checked,
      pose: document.getElementById('chk-pose').checked
    }));
  } catch(e) {}
}

function _applySettings() {
  var s = _settingsDefaults;
  try {
    var saved = localStorage.getItem('gz_settings');
    if (saved) s = JSON.parse(saved);
  } catch(e) {}
  // Auto Follow
  var afEl = document.getElementById('chk-autofollow');
  afEl.checked = s.autoFollow !== undefined ? s.autoFollow : _settingsDefaults.autoFollow;
  toggleAutoFollow(afEl.checked, true);
  // Grid
  var gridEl = document.getElementById('chk-grid');
  gridEl.checked = s.grid !== undefined ? s.grid : _settingsDefaults.grid;
  toggleGrid(gridEl.checked);
  // Axes
  var axEl = document.getElementById('chk-axes');
  axEl.checked = s.axes !== undefined ? s.axes : _settingsDefaults.axes;
  toggleAxes(axEl.checked);
  // LiDAR
  var liEl = document.getElementById('chk-lidar');
  liEl.checked = s.lidar !== undefined ? s.lidar : _settingsDefaults.lidar;
  toggleLidar(liEl.checked);
  // Pose
  var poEl = document.getElementById('chk-pose');
  poEl.checked = s.pose !== undefined ? s.pose : _settingsDefaults.pose;
  togglePose(poEl.checked);
}

// ── First-quadrant grid: the world only exists in (0,0)~(W,H) — no negative
// quadrants are drawn (same style as World Builder rebuildGrid: 1 m spacing,
// gray, z 0.0015). Sized from the current track bounds (/sim/api/bounds),
// rounded up to whole meters.
var _quadGrid = null;
var _gridOn = false;
var _gridW = 10, _gridH = 10;

function _rebuildQuadGrid() {
  if (_quadGrid) { scene.scene.remove(_quadGrid); }
  _quadGrid = new THREE.Group();
  var g = new THREE.Geometry();
  for (var x = 0; x <= _gridW + 1e-6; x += 1.0) {
    g.vertices.push(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, _gridH, 0));
  }
  for (var y = 0; y <= _gridH + 1e-6; y += 1.0) {
    g.vertices.push(new THREE.Vector3(0, y, 0), new THREE.Vector3(_gridW, y, 0));
  }
  var l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.6 }));
  l.raycast = function() {}; // r86 Line threshold(1m)가 픽킹을 가로채지 않게
  _quadGrid.add(l);
  _quadGrid.position.z = 0.0015;
  _quadGrid.visible = _gridOn;
  scene.scene.add(_quadGrid);
}

function _loadGridBounds() {
  fetch("/sim/api/bounds")
    .then(function(r) { return r.json(); })
    .then(function(b) {
      if (typeof b.maxX !== "number" || typeof b.maxY !== "number") { return; }
      _gridW = Math.max(1, Math.min(50, Math.ceil(b.maxX)));
      _gridH = Math.max(1, Math.min(50, Math.ceil(b.maxY)));
      _rebuildQuadGrid();
    })
    .catch(function() { /* bounds 없음 — 기본 크기 유지 */ });
}

function toggleGrid(on) {
  _gridOn = on;
  if (!_quadGrid) { _rebuildQuadGrid(); }
  _quadGrid.visible = on;
}

// =====================================================================
// TF Axes (XYZ ArrowHelpers on physicar)
// =====================================================================
var _axesGroup = null;
var _axesEnabled = false;
var _axesHelpers = {}; // link name -> THREE.Group

var _tfLinks = [
  'base_footprint',
  'camera_pan_link',
  'camera_tilt_link',
  'front_left_wheel_link',
  'front_right_wheel_link',
  'rear_left_wheel_link',
  'rear_right_wheel_link'
];

function toggleAxes(on) {
  _axesEnabled = on;
  for (var k in _axesHelpers) _axesHelpers[k].visible = on;
}

function _makeAxesHelper(size) {
  var g = new THREE.Group();
  var headLen = size * 0.2, headW = size * 0.06;
  var shaftR = size * 0.035;
  var colors = [0xff4444, 0x44ff44, 0x4488ff];
  var dirs = [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)];
  for (var i = 0; i < 3; i++) {
    var mat = new THREE.MeshBasicMaterial({ color: colors[i], depthTest: false, transparent: true, opacity: 0.5 });
    var shaftLen = size - headLen;
    var shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 6), mat);
    shaft.renderOrder = 998;
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirs[i]);
    shaft.position.copy(dirs[i]).multiplyScalar(shaftLen * 0.5);
    g.add(shaft);
    var cone = new THREE.Mesh(new THREE.ConeGeometry(headW, headLen, 6), mat);
    cone.renderOrder = 998;
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dirs[i]);
    cone.position.copy(dirs[i]).multiplyScalar(shaftLen + headLen * 0.5);
    g.add(cone);
  }
  return g;
}

function _updateAxes() {
  if (!_axesEnabled || !connected) return;
  var model = scene.getByName('physicar');
  if (!model) return;
  model.updateMatrixWorld(true);

  for (var i = 0; i < _tfLinks.length; i++) {
    var name = _tfLinks[i];
    var link = null;
    model.traverse(function(child) { if (child.name === name) link = child; });
    if (!link) continue;

    if (!_axesHelpers[name]) {
      var size = (name === 'base_footprint') ? 0.25 : 0.07;
      var helper = _makeAxesHelper(size);
      helper.visible = _axesEnabled;
      scene.scene.add(helper);
      _axesHelpers[name] = helper;
    }
    var h = _axesHelpers[name];
    var pos = new THREE.Vector3();
    link.getWorldPosition(pos);
    h.position.copy(pos);
    var quat = new THREE.Quaternion();
    link.getWorldQuaternion(quat);
    h.quaternion.copy(quat);
  }
}

// =====================================================================
// Pose Info Panel
// =====================================================================
var _poseEnabled = false;

function togglePose(on) {
  _poseEnabled = on;
  var panel = document.getElementById('pose-panel');
  if (on) panel.classList.add('show');
  else panel.classList.remove('show');
}

function _updatePose() {
  if (!_poseEnabled || !connected) return;
  var obj = scene.getByName('physicar');
  if (!obj) return;
  var pos = new THREE.Vector3();
  obj.getWorldPosition(pos);
  var quat = new THREE.Quaternion();
  obj.getWorldQuaternion(quat);
  var euler = new THREE.Euler().setFromQuaternion(quat, 'ZYX');
  var r2d = 180 / Math.PI;

  // Extract joint angles from links
  var panAngle = '--', tiltAngle = '--', steerAngle = '--';
  var _linkAngle = function(linkName) {
    var link = null;
    obj.traverse(function(c) { if (c.name === linkName) link = c; });
    if (!link) return null;
    var e = new THREE.Euler().setFromQuaternion(link.quaternion, 'ZYX');
    return e;
  };
  var panE = _linkAngle('camera_pan_link');
  if (panE) panAngle = (panE.z * r2d).toFixed(1);
  var tiltE = _linkAngle('camera_tilt_link');
  if (tiltE) tiltAngle = (-tiltE.y * r2d).toFixed(1);
  var steerE = _linkAngle('front_left_steering_link');
  if (steerE) steerAngle = (steerE.z * r2d).toFixed(1);

  var panel = document.getElementById('pose-panel');
  panel.innerHTML =
    '<span class="pose-label">Pos</span> ' +
    '<span class="pose-x">X ' + pos.x.toFixed(2) + '</span> ' +
    '<span class="pose-y">Y ' + pos.y.toFixed(2) + '</span> ' +
    '<span class="pose-z">Z ' + pos.z.toFixed(2) + '</span><br>' +
    '<span class="pose-label">Rot</span> ' +
    '<span class="pose-x">R ' + (euler.x * r2d).toFixed(1) + '\u00b0</span> ' +
    '<span class="pose-y">P ' + (euler.y * r2d).toFixed(1) + '\u00b0</span> ' +
    '<span class="pose-z">Y ' + (euler.z * r2d).toFixed(1) + '\u00b0</span><br>' +
    '<span class="pose-label">Cam</span> ' +
    'Pan <span class="pose-z">' + panAngle + '\u00b0</span> ' +
    'Tilt <span class="pose-y">' + tiltAngle + '\u00b0</span><br>' +
    '<span class="pose-label">Str</span> ' +
    '<span class="pose-z">' + steerAngle + '\u00b0</span>';
}

// =====================================================================
// LiDAR Visualization (client-side raycasting)
// =====================================================================
var _lidarEnabled = false;
var _lidarPoints = null; // THREE.Points
var _lidarRaycaster = new THREE.Raycaster();
var _lidarAngleStep = 0.5 * Math.PI / 180; // 0.5 degree
var _lidarSamples = Math.round(2 * Math.PI / _lidarAngleStep); // 720
var _lidarMinRange = 0.15;
var _lidarMaxRange = 16;
var _lidarLocalOffset = new THREE.Vector3(-0.027, 0, 0.183); // lidar pos relative to base_footprint
var _lidarFrameSkip = 0;
var _lidarLines = null; // THREE.LineSegments for beams

function toggleLidar(on) {
  _lidarEnabled = on;
  if (_lidarPoints) _lidarPoints.visible = on;
  if (_lidarLines) _lidarLines.visible = on;
}

function _updateLidar() {
  if (!_lidarEnabled || !connected) return;
  // Throttle: update every 3 frames (~20Hz at 60fps)
  _lidarFrameSkip = (_lidarFrameSkip + 1) % 3;
  if (_lidarFrameSkip !== 0 && _lidarPoints) return;

  var model = scene.getByName('physicar');
  if (!model) return;

  // Get lidar world position & rotation
  var modelPos = new THREE.Vector3();
  model.getWorldPosition(modelPos);
  var modelQuat = new THREE.Quaternion();
  model.getWorldQuaternion(modelQuat);

  var lidarPos = _lidarLocalOffset.clone().applyQuaternion(modelQuat).add(modelPos);

  // Collect meshes to raycast against (exclude physicar model itself)
  var targets = [];
  scene.scene.traverse(function(obj) {
    if (obj.isMesh && !_isChildOf(obj, model)) targets.push(obj);
  });
  if (targets.length === 0) return;

  // Cast rays
  var hitPositions = [];
  var lineVerts = [];
  var dir = new THREE.Vector3();
  for (var i = 0; i < _lidarSamples; i++) {
    var angle = i * _lidarAngleStep;
    dir.set(Math.cos(angle), Math.sin(angle), 0).applyQuaternion(modelQuat);
    _lidarRaycaster.set(lidarPos, dir);
    _lidarRaycaster.near = _lidarMinRange;
    _lidarRaycaster.far = _lidarMaxRange;
    var hits = _lidarRaycaster.intersectObjects(targets, false);
    if (hits.length > 0) {
      var hp = hits[0].point;
      hitPositions.push(hp.x, hp.y, hp.z);
      // Beam line: lidar origin → hit point
      lineVerts.push(lidarPos.x, lidarPos.y, lidarPos.z, hp.x, hp.y, hp.z);
    }
  }

  // Cleanup old
  if (_lidarPoints) {
    scene.scene.remove(_lidarPoints);
    _lidarPoints.geometry.dispose();
    _lidarPoints.material.dispose();
    _lidarPoints = null;
  }
  if (_lidarLines) {
    scene.scene.remove(_lidarLines);
    _lidarLines.geometry.dispose();
    _lidarLines.material.dispose();
    _lidarLines = null;
  }

  if (hitPositions.length > 0) {
    // Hit points
    var geom = new THREE.BufferGeometry();
    geom.addAttribute('position', new THREE.Float32BufferAttribute(hitPositions, 3));
    var mat = new THREE.PointsMaterial({ color: 0xff3333, size: 0.02, depthTest: false, transparent: true, opacity: 0.8 });
    _lidarPoints = new THREE.Points(geom, mat);
    _lidarPoints.renderOrder = 997;
    scene.scene.add(_lidarPoints);

    // Beam lines
    var lineGeom = new THREE.BufferGeometry();
    lineGeom.addAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
    var lineMat = new THREE.LineBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.15, depthTest: false });
    _lidarLines = new THREE.LineSegments(lineGeom, lineMat);
    _lidarLines.renderOrder = 996;
    scene.scene.add(_lidarLines);
  }
}

function _isChildOf(obj, parent) {
  var p = obj.parent;
  while (p) { if (p === parent) return true; p = p.parent; }
  return false;
}

var _autoFollow = false;
// Self-managed spherical camera for auto-follow (bypass OrbitControls entirely).
// theta is measured RELATIVE to the vehicle heading (chase cam): the viewing
// angle stays fixed with respect to the car, not the world axes.
var _af = {
  theta: -Math.PI / 2,  // relative angle around the car; -PI/2 = directly behind (drag to adjust)
  phi: 0.9,        // ~50deg from vertical
  radius: 1.8,     // closer to target
  yaw: null,       // smoothed vehicle heading the offset is anchored to
  dragging: false,
  lastX: 0,
  lastY: 0
};

function _getVehicleYaw(obj) {
  var q = new THREE.Quaternion();
  obj.getWorldQuaternion(q);
  // z-up yaw from quaternion
  return Math.atan2(2 * (q.w * q.z + q.x * q.y),
                    1 - 2 * (q.y * q.y + q.z * q.z));
}

function toggleSettings() {
  var menu = document.getElementById("settings-menu");
  menu.classList.toggle("open");
}

function doRespawn() {
  var btn = document.getElementById('respawn-btn');
  if (btn.disabled || btn.classList.contains('busy')) return;
  if (!currentWorld) { _showToast('No track loaded', 4000); return; }
  btn.classList.add('busy');
  // Re-select the current track: reloads the whole world so all built-in
  // objects (vehicle, obstacles, etc.) return to their original positions.
  switchWorld(currentWorld + '.world');
}

function _afMouseDown(e) {
  if (e.button === 2) {
    _showToast('Panning is not supported in Auto Follow mode.');
    document.getElementById("settings-menu").classList.add("open");
    return;
  }
  if (e.button !== 0) return; // left click only
  _af.dragging = true;
  _af.lastX = e.clientX;
  _af.lastY = e.clientY;
  e.preventDefault();
}
function _afMouseMove(e) {
  if (!_af.dragging) return;
  var dx = e.clientX - _af.lastX;
  var dy = e.clientY - _af.lastY;
  _af.lastX = e.clientX;
  _af.lastY = e.clientY;
  _af.theta += dx * 0.005;
  _af.phi = Math.max(0.15, Math.min(Math.PI - 0.15, _af.phi - dy * 0.005));
  e.preventDefault();
}
function _afMouseUp(e) {
  _af.dragging = false;
}
function _afWheel(e) {
  var factor = 1 + Math.min(Math.abs(e.deltaY), 200) * 0.001;
  _af.radiusTarget = Math.max(0.5, Math.min(30, (typeof _af.radiusTarget !== 'undefined' ? _af.radiusTarget : _af.radius) * (e.deltaY > 0 ? factor : 1 / factor)));
  e.preventDefault();
}
function _afContextMenu(e) { e.preventDefault(); }

function toggleAutoFollow(on, initial) {
  _autoFollow = on;
  var el = document.getElementById("container");
  if (on) {
    // Page load: always start with the chase view from behind the car
    // (theta -PI/2 = directly behind, adopting the heading on first update).
    // Only a mid-session re-toggle inherits the current camera angle below,
    // so switching follow back on never makes the view jump.
    var obj = initial ? null : scene.getByName('physicar');
    if (obj) {
      var pos = new THREE.Vector3();
      obj.getWorldPosition(pos);
      var offset = scene.camera.position.clone().sub(pos);
      _af.radius = offset.length();
      _af.radiusTarget = _af.radius;
      // Store the angle relative to the current heading so the view doesn't
      // jump when follow mode engages (world angle = theta - yaw).
      _af.yaw = _getVehicleYaw(obj);
      _af.theta = Math.atan2(offset.x, offset.y) + _af.yaw;
      _af.phi = Math.atan2(Math.sqrt(offset.x * offset.x + offset.y * offset.y), offset.z);
    }
    // Disable OrbitControls completely.
    // NOTE: scene.render() force-sets controls.enabled = true every frame, so
    // the enabled flag alone is not enough — OrbitControls' own wheel/drag
    // handlers would still fire and fight the auto-follow camera (zoom shook
    // when the cursor was off the vehicle). The noRotate/noZoom/noPan flags are
    // honored by those handlers independently of enabled and are NOT touched by
    // render(), so they reliably suppress OrbitControls input in this mode.
    scene.controls.enabled = false;
    scene.controls.noRotate = true;
    scene.controls.noZoom = true;
    scene.controls.noPan = true;
    // Override scene pointer handler
    if (!scene._origOnPointerDown) {
      scene._origOnPointerDown = scene.onPointerDown.bind(scene);
    }
    scene.onPointerDown = function(e) { e.preventDefault(); };
    // Attach own mouse handlers
    el.addEventListener('mousedown', _afMouseDown);
    el.addEventListener('mousemove', _afMouseMove);
    el.addEventListener('mouseup', _afMouseUp);
    el.addEventListener('wheel', _afWheel, {passive: false});
    el.addEventListener('contextmenu', _afContextMenu);
  } else {
    // Re-enable OrbitControls
    scene.controls.enabled = true;
    scene.controls.noRotate = false;
    scene.controls.noZoom = false;
    scene.controls.noPan = false;
    if (scene._origOnPointerDown) {
      scene.onPointerDown = scene._origOnPointerDown;
    }
    // Remove own mouse handlers
    el.removeEventListener('mousedown', _afMouseDown);
    el.removeEventListener('mousemove', _afMouseMove);
    el.removeEventListener('mouseup', _afMouseUp);
    el.removeEventListener('wheel', _afWheel);
    el.removeEventListener('contextmenu', _afContextMenu);
  }
}

var _afLastMs = 0;
function _updateAutoFollow() {
  if (!_autoFollow) return;
  if (gzInteract && gzInteract.isManipulating('physicar')) return;
  var obj = scene.getByName('physicar');
  if (!obj) return;
  var target = new THREE.Vector3();
  obj.getWorldPosition(target);
  // TIME-based smoothing factors. Per-frame constants (the original 0.08 /
  // 0.15) made the smoothing lag proportional to frame time — when the
  // browser hitches, rAF intervals fluctuate and the heading lag breathes
  // with them, visibly rocking the camera around the car during a steady
  // turn. With k = 1 - exp(-dt/tau) the lag is a constant angle for a given
  // yaw rate no matter the frame rate: the chase view stays rigid.
  var nowMs = performance.now();
  var dt = _afLastMs ? Math.min((nowMs - _afLastMs) / 1000, 0.5) : 0.016;
  _afLastMs = nowMs;
  var kYaw = 1 - Math.exp(-dt / 0.15);
  var kZoom = 1 - Math.exp(-dt / 0.11);
  // Smooth zoom interpolation
  if (typeof _af.radiusTarget !== 'undefined') {
    _af.radius += (_af.radiusTarget - _af.radius) * kZoom;
    if (Math.abs(_af.radius - _af.radiusTarget) < 0.001) _af.radius = _af.radiusTarget;
  }
  // Track the vehicle heading with smoothing (shortest angular path) so the
  // camera swings behind the car through turns instead of staying at a fixed
  // world angle, without jittering on every pose update.
  var vyaw = _getVehicleYaw(obj);
  if (_af.yaw === null) _af.yaw = vyaw;
  var dyaw = Math.atan2(Math.sin(vyaw - _af.yaw), Math.cos(vyaw - _af.yaw));
  _af.yaw += dyaw * kYaw;
  var th = _af.theta - _af.yaw;
  // Spherical to Cartesian offset (z-up)
  var sp = Math.sin(_af.phi);
  var x = _af.radius * sp * Math.sin(th);
  var y = _af.radius * sp * Math.cos(th);
  var z = _af.radius * Math.cos(_af.phi);
  scene.camera.position.set(target.x + x, target.y + y, target.z + z);
  scene.camera.up.set(0, 0, 1);
  scene.camera.lookAt(target);
}

// Close settings menu when clicking outside
document.addEventListener("click", function(e) {
  var settings = document.getElementById("settings");
  if (settings && !settings.contains(e.target)) {
    document.getElementById("settings-menu").classList.remove("open");
  }
});

function animate() {
  requestAnimationFrame(animate);
  _applyPoseLerp();
  _updateAutoFollow();
  if (gzInteract && gzInteract.selected()) gzInteract.update();
  _updateAxes();
  _updateLidar();
  _updatePose();
  scene.render();
  _updateDistanceVolume();
  _updateAudioRing();
}

// =====================================================================
// Audio — browser playback backend for the webserver /audio API (SIM).
// Subscribes to GET /audio/events (SSE) and executes commands:
//   {type:"play", id, url, volume, loop}   → HTMLAudioElement
//   {type:"pcm",  id, data(b64 s16le), sample_rate, channels, volume}
//                                          → Web Audio scheduler (jitter buffer)
//   {type:"volume", id, volume} / {type:"stop", id} / {type:"stop_all"}
//   {type:"ended", id}                     → cleanup
// _audioChannels entries are keyed by item id, two shapes:
//   media: { media: HTMLAudioElement, volume }
//   pcm:   { gainNode, queue[], sources[], pcmNext, volume, drainTimer }
// =====================================================================

var _audioCtx = null;
var _audioChannels = {};
var _audioReady = false;
var _audioRetry = 1000;
var _audioEs = null;
var _audioPending = [];
var _PCM_SCHED_AHEAD = 0.5; // schedule up to 500ms ahead (jitter buffer)

function _initAudioCtx() {
  if (_audioReady) return;
  _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  _audioReady = true; // set BEFORE draining so handlers don't re-queue
  while (_audioPending.length > 0) _handleAudioMsg(_audioPending.shift());
}

function _onUserGesture() {
  _initAudioCtx();
  if (_audioCtx && _audioCtx.state === "suspended") _audioCtx.resume();
}
document.addEventListener("click", _onUserGesture);
document.addEventListener("keydown", _onUserGesture);

function startAudioStream() {
  if (_audioEs) { try { _audioEs.close(); } catch(e) {} }
  var es = new EventSource("/audio/events");
  _audioEs = es;

  es.onopen = function() { _audioRetry = 1000; console.log('[Audio] SSE connected'); };
  es.onmessage = function(e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch(err) { return; }
    if (!msg.type) return;

    // Control messages don't need an unlocked AudioContext
    if (msg.type === "stop_all") {
      _audioPending = [];
      stopAllAudio();
      return;
    }
    if (msg.type === "stop" || msg.type === "ended") {
      _audioPending = _audioPending.filter(function(m) { return m.id !== msg.id; });
      stopAudioChannel(msg.id);
      return;
    }
    if (msg.type === "volume") { _setChannelVolume(msg.id, msg.volume); return; }
    if (msg.type !== "play" && msg.type !== "pcm") return;

    if (!_audioReady) {
      // Autoplay policy: queue until the first user gesture (overlay prompts)
      _audioPending.push(msg);
      if (_audioPending.length > 100) _audioPending.shift();
      return;
    }
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    _handleAudioMsg(msg);
  };
  es.onerror = function() {
    console.warn('[Audio] SSE error, reconnecting...');
    es.close(); _audioEs = null;
    var delay = Math.min(_audioRetry, 30000);
    _audioRetry = Math.min(_audioRetry * 2, 30000);
    setTimeout(startAudioStream, delay);
  };
}
startAudioStream();

// === Command dispatch ===

function _handleAudioMsg(msg) {
  if (msg.type === "play") _playMedia(msg);
  else if (msg.type === "pcm") _playPcm(msg);
}

// === Media playback (url / path / data items) ===

function _playMedia(msg) {
  stopAudioChannel(msg.id); // same-id replay restarts from the top
  var audio = new Audio(msg.url);
  audio.loop = !!msg.loop;
  var entry = { media: audio, volume: (msg.volume == null ? 1.0 : msg.volume) };
  _audioChannels[msg.id] = entry;
  _applyEntryVolume(entry);
  function cleanup() {
    if (_audioChannels[msg.id] && _audioChannels[msg.id].media === audio) {
      delete _audioChannels[msg.id];
    }
  }
  audio.onloadedmetadata = function() {
    var d = audio.duration;
    // report the duration — the server can't probe remote media itself, and
    // without it a finished URL item would replay on the next SSE subscribe
    if (isFinite(d) && d > 0) {
      fetch('/audio/duration', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: msg.id, duration: d })
      }).catch(function() {});
    }
    // resume mid-song on SSE replay (server sends the elapsed offset). A song
    // already past its end (a non-loop URL item the server couldn't measure)
    // is not replayed.
    if (msg.offset > 0 && isFinite(d)) {
      var off = audio.loop ? (msg.offset % d) : msg.offset;
      if (off < d) { try { audio.currentTime = off; } catch (e) { /* ignore */ } }
      else { audio.pause(); cleanup(); }
    }
  };
  audio.onended = function() {
    cleanup();
    // natural end — notify the server so the stored play command is cleared,
    // otherwise the finished song replays on the next SSE subscribe (URL items
    // rely on this since the server never learned their length)
    if (!audio.loop) {
      fetch('/audio/stop', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: msg.id })
      }).catch(function() {});
    }
  };
  audio.onerror = function() {
    console.error('[Audio] media error id=' + msg.id + ' url=' + msg.url);
    cleanup();
  };
  audio.play().catch(function(err) {
    console.warn('[Audio] play blocked/failed id=' + msg.id, err);
    cleanup();
  });
  console.log('[Audio] play id=' + msg.id + ' url=' + msg.url);
}

// === PCM16 stream (WS /audio/stream relayed as pcm events) ===

function _getPcmChannel(id) {
  var entry = _audioChannels[id];
  if (!entry || !entry.gainNode) {
    var gn = _audioCtx.createGain();
    gn.connect(_audioCtx.destination);
    entry = {
      gainNode: gn,
      queue: [],       // PCM chunks waiting to be scheduled
      sources: [],     // currently scheduled BufferSources
      pcmNext: 0,      // next schedule time
      volume: 1.0,
      drainTimer: null
    };
    _audioChannels[id] = entry;
  }
  return entry;
}

function _playPcm(msg) {
  if (!msg.data) return;
  var entry = _getPcmChannel(msg.id);
  if (msg.volume != null) {
    entry.volume = Math.max(0, Math.min(1, msg.volume));
    _applyEntryVolume(entry);
  }
  entry.queue.push({
    data: _b64ToUint8(msg.data),
    sample_rate: msg.sample_rate || 24000,
    channels: msg.channels || 1
  });
  _drainChannel(msg.id);
}

function _b64ToUint8(b64) {
  var raw = atob(b64);
  var buf = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

function _pcm16ToFloat32(buf) {
  var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  var count = Math.floor(buf.length / 2);
  var out = new Float32Array(count);
  for (var i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768.0;
  return out;
}

// === Drain loop ===
// Schedules PCM chunks from queue, keeping ≤ _PCM_SCHED_AHEAD seconds
// buffered — consumes at real-time rate, queue absorbs burst arrivals.

function _drainChannel(id) {
  var entry = _audioChannels[id];
  if (!entry || !entry.gainNode) return;

  var now = _audioCtx.currentTime;

  // Remove finished sources
  entry.sources = entry.sources.filter(function(src) {
    return src._endTime > now;
  });

  // Schedule chunks while we have headroom
  while (entry.queue.length > 0) {
    var ahead = entry.pcmNext - now;
    if (ahead > _PCM_SCHED_AHEAD) break; // enough buffered, wait

    var item = entry.queue.shift();
    var sr = item.sample_rate;
    var nch = item.channels;
    var samples = _pcm16ToFloat32(item.data);
    var samplesPerCh = Math.floor(samples.length / nch);
    if (samplesPerCh <= 0) continue;

    var abuf = _audioCtx.createBuffer(nch, samplesPerCh, sr);
    for (var c = 0; c < nch; c++) {
      var cd = abuf.getChannelData(c);
      for (var s = 0; s < samplesPerCh; s++) {
        cd[s] = samples[s * nch + c];
      }
    }

    var startAt;
    if (entry.pcmNext > now + 0.005) {
      startAt = entry.pcmNext;
    } else {
      startAt = now + 0.01;
    }

    var src = _audioCtx.createBufferSource();
    src.buffer = abuf;
    src.connect(entry.gainNode);
    src.start(startAt);

    var duration = samplesPerCh / sr;
    entry.pcmNext = startAt + duration;
    src._endTime = startAt + duration;
    entry.sources.push(src);

    // When this source finishes, try to drain more
    src.onended = function() {
      var ent = _audioChannels[id];
      if (ent && ent.sources) {
        var idx = ent.sources.indexOf(src);
        if (idx >= 0) ent.sources.splice(idx, 1);
        _drainChannel(id);
      }
    };
  }

  // If queue still has items, schedule next drain when headroom opens
  if (entry.queue.length > 0) {
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    var waitMs = Math.max(20, (entry.pcmNext - now - _PCM_SCHED_AHEAD * 0.5) * 1000);
    entry.drainTimer = setTimeout(function() {
      entry.drainTimer = null;
      _drainChannel(id);
    }, waitMs);
  }
}

// === Volume ===

function _applyEntryVolume(entry) {
  var v = Math.max(0, Math.min(1, entry.volume * _distanceVolumeFactor));
  if (entry.media) entry.media.volume = v;
  else if (entry.gainNode) entry.gainNode.gain.value = v;
}

function _setChannelVolume(id, volume) {
  var entry = _audioChannels[id];
  if (!entry || volume == null) return;
  entry.volume = Math.max(0, Math.min(1, volume));
  _applyEntryVolume(entry);
}

// === Stop ===

function stopAudioChannel(id) {
  var entry = _audioChannels[id];
  if (!entry) return;
  if (entry.media) {
    try { entry.media.pause(); entry.media.src = ""; } catch(e) {}
  } else {
    entry.queue = [];
    if (entry.drainTimer) { clearTimeout(entry.drainTimer); entry.drainTimer = null; }
    for (var i = 0; i < entry.sources.length; i++) {
      try { entry.sources[i].stop(); } catch(e) {}
    }
    entry.sources = [];
    entry.pcmNext = 0;
  }
  delete _audioChannels[id];
  console.log('[Audio] stop id=' + id);
}

function stopAllAudio() {
  for (var k in _audioChannels) {
    if (_audioChannels.hasOwnProperty(k)) stopAudioChannel(k);
  }
}

// =====================================================================
// Model Creation — 공유 모듈 gz-scene.js가 단일 소스
// (Custom World Builder 뷰포트와 동일한 코드로 그린다. 시맨틱 수정은
//  반드시 gz-scene.js에서 할 것 — 사이트 쪽 사본과 동기화 필요)
// =====================================================================


// Ground planes arrive as a handful of GIANT triangles (a world-size quad).
// Some Windows GPU/driver stacks (ANGLE/D3D) drop such triangles wholesale at
// oblique camera angles — the field/grass vanished along a straight line
// while the finely-tessellated road kept rendering. Rebuilding those planes
// as a ~1m grid (UVs preserved via the plane's affine map) makes them behave
// like every other mesh. World-builder fields are always full rectangles.
function _tessellateGiantGround(root) {
  // A subdivided plane needs a real depth gap below its neighbours (its
  // per-triangle interpolation jitters where one giant triangle was exact),
  // so the BOTTOM layer gets lowered by 1mm — but only when nothing else
  // sits underneath it.
  var flatZs = [];
  root.traverse(function (o) {
    if (!o.isMesh || !o.geometry) return;
    var g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    var bb = g.boundingBox;
    if (!bb) return;
    if (bb.max.z - bb.min.z < 0.01) flatZs.push(bb.min.z);
  });
  root.traverse(function (o) {
    if (!o.isMesh || !o.geometry || !o.material || Array.isArray(o.material)) return;
    var g = o.geometry;
    var isBuf = !!g.attributes;
    var triCount = isBuf
      ? ((g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3)
      : (g.faces ? g.faces.length : 999);
    if (triCount > 8 || triCount < 1) return;
    if (!g.boundingBox) g.computeBoundingBox();
    var bb = g.boundingBox;
    if (!bb) return;
    var w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y, t = bb.max.z - bb.min.z;
    if (t > 0.01 || w * h < 4) return;
    var hasLayerBelow = flatZs.some(function (z) {
      return z < bb.min.z - 1e-6 && z > bb.min.z - 0.002;
    });
    try {
      // three corner vertices + uvs define the plane's affine UV mapping
      var v = [], uv = [];
      if (isBuf) {
        var pa = g.attributes.position, ua = g.attributes.uv;
        if (!ua) return;
        var idx = g.index ? [g.index.getX(0), g.index.getX(1), g.index.getX(2)] : [0, 1, 2];
        for (var i = 0; i < 3; i++) {
          v.push([pa.getX(idx[i]), pa.getY(idx[i])]);
          uv.push([ua.getX(idx[i]), ua.getY(idx[i])]);
        }
      } else {
        if (!g.faces || !g.faces.length || !g.faceVertexUvs
            || !g.faceVertexUvs[0] || !g.faceVertexUvs[0][0]) return;
        var f = g.faces[0], fu = g.faceVertexUvs[0][0];
        [f.a, f.b, f.c].forEach(function (vi, k) {
          v.push([g.vertices[vi].x, g.vertices[vi].y]);
          uv.push([fu[k].x, fu[k].y]);
        });
      }
      var e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1]];
      var e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1]];
      var det = e1[0] * e2[1] - e1[1] * e2[0];
      if (Math.abs(det) < 1e-9) return;
      var uvAt = function (x, y) {
        var dx = x - v[0][0], dy = y - v[0][1];
        var a = (dx * e2[1] - dy * e2[0]) / det;
        var b = (e1[0] * dy - e1[1] * dx) / det;
        return [uv[0][0] + a * (uv[1][0] - uv[0][0]) + b * (uv[2][0] - uv[0][0]),
                uv[0][1] + a * (uv[1][1] - uv[0][1]) + b * (uv[2][1] - uv[0][1])];
      };
      var z = (bb.min.z + bb.max.z) / 2 - (hasLayerBelow ? 0 : 0.001);
      var nx = Math.max(4, Math.min(40, Math.ceil(w)));
      var ny = Math.max(4, Math.min(40, Math.ceil(h)));
      var pos = [], uvs = [], norm = [], index = [];
      for (var iy = 0; iy <= ny; iy++) {
        for (var ix = 0; ix <= nx; ix++) {
          var x = bb.min.x + (w * ix) / nx, y = bb.min.y + (h * iy) / ny;
          pos.push(x, y, z);
          norm.push(0, 0, 1);
          var q = uvAt(x, y);
          uvs.push(q[0], q[1]);
        }
      }
      for (var jy = 0; jy < ny; jy++) {
        for (var jx = 0; jx < nx; jx++) {
          var a0 = jy * (nx + 1) + jx, b0 = a0 + 1, c0 = a0 + nx + 1, d0 = c0 + 1;
          index.push(a0, b0, d0, a0, d0, c0);
        }
      }
      var ng = new THREE.BufferGeometry();
      ng.setIndex(index);
      ng.addAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      ng.addAttribute("normal", new THREE.Float32BufferAttribute(norm, 3));
      ng.addAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      o.geometry = ng;
    } catch (e) { /* leave the original geometry untouched */ }
  });
}

// ── Published-world CDN — 배포 월드의 메시/텍스처는 worlds.physicar.ai 에서 직접 ──
// (EC2 egress 캡 우회 + 반 전체 엣지 캐시 공유). worldpub 미도착/불일치 시엔
// 로컬(/sim/meshes) 폴백이라 항상 안전하다. DAE 내부 텍스처는 상대경로라 함께 CF 로 간다.
THREE.ImageLoader.prototype.crossOrigin = 'anonymous';
THREE.TextureLoader.prototype.crossOrigin = 'anonymous';
var _pubWorld = null;    // { world, base } — 현재 월드가 배포본일 때만
var _simAssets = null;   // 공식 자산 CDN base — complete.json 확인 후에만
var _simAssetsTag = null;
var _cdnBase = 'https://worlds.physicar.ai';   // 전환 프리페치가 meta.json 조회에 사용
function _refreshWorldPub() {
  fetch('/sim/api/worldpub').then(function(r) { return r.json(); })
    .then(function(d) {
      var cdn = (d && d.cdn) || 'https://worlds.physicar.ai';
      _cdnBase = cdn;
      _pubWorld = (d && d.world && d.world_id && d.rev)
        ? { world: d.world, base: cdn + '/worlds/' + d.world_id + '/' + d.rev + '/' }
        : null;
      var tag = d && d.assets_rev;
      if (!tag) { _simAssets = null; _simAssetsTag = null; return; }
      if (tag === _simAssetsTag) { return; }
      _simAssetsTag = tag;
      var base = cdn + '/sim-assets/' + tag + '/';
      // 커밋 포인트 확인 — 이 태그가 R2 에 실제 업로드됐을 때만 CDN 사용 (아니면 로컬)
      fetch(base + 'complete.json')
        .then(function(r) { _simAssets = r.ok ? base : null; })
        .catch(function() { _simAssets = null; });
    }).catch(function() { _pubWorld = null; _simAssets = null; _simAssetsTag = null; });
}
_refreshWorldPub();

function _meshPath(uri) {
  var mi = uri.indexOf('meshes/');
  return mi >= 0 ? uri.substring(mi + 7) : uri.split('/').pop();
}

// ── dae 파싱 큐 ────────────────────────────────────────────────────────────
// ColladaLoader 는 다운로드 완료 콜백 안에서 "동기" 파싱을 한다 — 월드 전환
// 직후 수십 개 dae 가 거의 동시에 도착하면 파싱이 연달아 실행되는 동안 메인
// 스레드가 얼어 아무것도 렌더되지 않는다. 파싱을 한 파일씩, 사이사이 한
// 프레임을 양보하며 돌리면 모델이 도착한 순서대로 하나씩 화면에 나타난다.
var _parseQ = [];
var _parsePumping = false;
function _pumpParse() {
  var job = _parseQ.shift();
  if (!job) { _parsePumping = false; return; }
  try { job(); } catch (e) { console.error('mesh parse failed:', e); }
  requestAnimationFrame(function() { setTimeout(_pumpParse, 0); });
}
function _enqueueParse(job) {
  _parseQ.push(job);
  if (!_parsePumping) { _parsePumping = true; setTimeout(_pumpParse, 0); }
}

// ── 전환 대상 월드 선(先)다운로드 ──────────────────────────────────────────
// switch 는 gz 재시작(수 초)을 동반한다 — 그 죽은 시간에 대상 월드의 dae 를
// 미리 받아 "메모리"에 들고 있으면, 씬이 도착했을 때 지오메트리가 즉시 뜬다
// (카메라와 거의 동시). 텍스처는 원래대로 늦게 입혀진다. 파일 목록은 배포
// 매니페스트(meta.json) — 배포본이 아닌 월드(공식/레거시 tar)는 스킵.
var _prefetched = {};   // URL -> Promise<string(dae text)>
function _prefetchSwitchTarget(worldFile) {
  _prefetched = {};   // 한 번에 한 월드만 보관
  try {
    var row = null;
    for (var i = 0; i < (worldsData || []).length; i++) {
      if (worldsData[i].file === worldFile) { row = worldsData[i]; break; }
    }
    if (!row || !row.world_id) { return; }
    fetch(_cdnBase + '/worlds/' + row.world_id + '/meta.json')
      .then(function(r) { return r.json(); })
      .then(function(meta) {
        if (!meta || !meta.rev || !meta.files) { return; }
        var base = _cdnBase + '/worlds/' + row.world_id + '/' + meta.rev + '/';
        meta.files.forEach(function(p) {
          if (typeof p !== 'string' || p.indexOf('meshes/') !== 0) { return; }
          if (!/\.dae$/i.test(p)) { return; }   // 지오메트리만 — 텍스처는 늦어도 됨
          var url = base + p;
          _prefetched[url] = fetch(url).then(function(r) {
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            return r.text();
          });
          _prefetched[url].catch(function() { delete _prefetched[url]; });
        });
      })
      .catch(function() {});
  } catch (e) { /* prefetch is best-effort */ }
}

var gzScene = GzScene.create({
  THREE: THREE,
  meshUrl: function(uri) {
    var p = _meshPath(uri);
    if (!p) { return null; }
    if (_pubWorld && p.indexOf(_pubWorld.world + '/') === 0) {
      return _pubWorld.base + 'meshes/' + p;
    }
    if (_simAssets && p.indexOf('custom_') !== 0) {
      return _simAssets + 'meshes/' + p;   // official 월드·차량·빌트인 모델
    }
    return "/sim/meshes/" + p;
  },
  loadMesh: function(url, onLoad, onError) {
    // 배포 월드 CDN 실패(배포 삭제 등) 대비 — 설치본은 로컬에 있으므로 sim 서버로 폴백
    var localUrl = (_pubWorld && url.indexOf(_pubWorld.base + 'meshes/') === 0)
      ? '/sim/meshes/' + url.slice((_pubWorld.base + 'meshes/').length) : null;
    // 다운로드(fetch, 병렬·프리페치 재사용)와 파싱(_enqueueParse, 직렬)을 분리
    (_prefetched[url] || fetch(url)
      .then(function(r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status + ': ' + url); }
        return r.text();
      }))
      .then(function(text) { return { text: text, src: url }; })
      .catch(function(e) {
        if (!localUrl) { throw e; }
        return fetch(localUrl).then(function(r) {
          if (!r.ok) { throw new Error('HTTP ' + r.status + ': ' + localUrl); }
          return r.text().then(function(t) { return { text: t, src: localUrl }; });
        });
      })
      .then(function(res) {
        var text = res.text;
        var src = res.src;
        // 공용 트랙 텍스처(../world_builder/textures/*)는 월드 rev 업로드에 없다
        // (설치 계약 — sim 내장 공용 디렉토리 참조). CDN DAE 를 파싱할 땐 이 참조를
        // 같은 호스트의 공용 자산 경로(sim-assets, 전 월드 캐시 공유)로 재작성한다.
        // r86 ColladaLoader 는 init_from 을 baseUrl 에 무조건 이어붙이므로 절대 URL 은
        // 못 쓴다 — ../ 등반 상대경로(worlds/<id>/<rev>/meshes/<track>/ = 5단계)로 붙이고
        // 최종 정규화는 브라우저 fetch 가 한다. sim-assets 미가용 코너에선 재작성하지
        // 않는다 (404 → _dropDeadTextures 가 단색 강등).
        if (_pubWorld && src.indexOf(_pubWorld.base) === 0 && _simAssets) {
          var simPath = _simAssets.replace(/^https?:\/\/[^/]+/, '');
          text = text.split('../world_builder/')
            .join('../../../../..' + simPath + 'meshes/world_builder/');
        }
        _enqueueParse(function() {
          // FRESH loader per file — THREE's ColladaLoader is not reentrant
          // (parse state lives on the instance, and world-builder daes reuse
          // library IDs like "Field"/"StartLine"). With a shared instance,
          // overlapping loads graft one world's geometry into the other's.
          new THREE.ColladaLoader().parse(text, function(collada) {
            _tessellateGiantGround(collada.scene);
            onLoad(collada.scene);
          }, src);
        });
      })
      .catch(function(e) { if (onError) { onError(e); } });
  },
  isPhysicarMesh: function(uri) {
    var p = _meshPath(uri);
    return p.indexOf('physicar/') === 0 && p.indexOf('Base.') < 0;
  }
});

function createModelFromMsg(model) { return gzScene.createModelFromMsg(model); }


