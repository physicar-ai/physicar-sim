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
    document.getElementById("respawn-btn").disabled = false;
    // Sync world list on every (re)connect
    loadWorlds();
    _refreshLights(_scheduleLightPoll);
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
    
    var sceneRetryCount = 0;
    function handleSceneWithRetry(_sceneInfo) {
      handleScene(_sceneInfo);
      if (_sceneInfo.model.length === 0 && sceneRetryCount < 5) {
        sceneRetryCount++;
        setTimeout(function() {
          if (connected && gz && gz.socket && gz.socket.readyState === 1) {
            gz.socket.send(buildMsg(["scene", currentWorld, "", ""]));
          }
        }, 2000);
      } else {
        sceneRetryCount = 0;
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
          for (var j = 0; j < msg.pose.length; ++j) {
            var p = msg.pose[j];
            var e = scene.getByName(p.name);
            if (e) {
              // Buffer the timestamped pose; _applyPoseLerp() plays the
              // stream back _POSE_DELAY_MS in the past with linear
              // interpolation between packets (constant velocity, no jumps).
              _pushPoseSample(p.name, p.position || {}, p.orientation || {});
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
  cam.near = 0.1; cam.far = 10000; cam.updateProjectionMatrix();
  scene.scene.fog = null;
  cam.position.x = 0; cam.position.y = -1.2; cam.position.z = 0.6;
  cam.up.set(0, 0, 1);
  cam.lookAt(new THREE.Vector3(0, 0, 0.1));
  animate();
  function checkNarrow() {
    document.body.classList.toggle("narrow", window.innerWidth < 600);
  }
  checkNarrow();
  window.addEventListener("resize", function() { scene.setSize(el.clientWidth, el.clientHeight); checkNarrow(); });
  // Apply saved settings then connect
  _applySettings();
  connect();
}

// =====================================================================
// World Selector Controls
// =====================================================================

var worldsData = [];
var currentWorld = null;
var _controlsEnabled = false;

function setControlsEnabled(enabled) {
  _controlsEnabled = enabled;
  var toggle = document.getElementById("dropdown-toggle");
  if (enabled) { toggle.classList.remove("disabled"); } else { toggle.classList.add("disabled"); closeDropdown(); }
  var btns = document.getElementById("world-selector").querySelectorAll("button");
  for (var i = 0; i < btns.length; i++) btns[i].disabled = !enabled;
}

function toggleDropdown() {
  if (!_controlsEnabled) return;
  var menu = document.getElementById("dropdown-menu");
  if (menu.classList.contains("open")) { closeDropdown(); } else { menu.classList.add("open"); }
}

function closeDropdown() { document.getElementById("dropdown-menu").classList.remove("open"); }

function loadWorlds(selectWorld) {
  setControlsEnabled(false);
  fetch("/sim/api/worlds").then(function(r){return r.json()}).then(function(data) {
    worldsData = data.worlds;
    currentWorld = selectWorld || data.current;
    document.getElementById("dropdown-toggle").textContent = currentWorld || "...";
    var menu = document.getElementById("dropdown-menu");
    menu.innerHTML = "";
    data.worlds.forEach(function(w) {
      var row = document.createElement("div");
      row.className = "dropdown-item" + (w.name === currentWorld ? " active" : "");
      var label = document.createElement("span");
      label.textContent = w.name;
      label.style.flex = "1";
      label.onclick = function() { closeDropdown(); switchWorld(w.file); };
      row.appendChild(label);
      if (w.deletable) {
        var del = document.createElement("span");
        del.className = "del-btn";
        del.innerHTML = "&#x1f5d1;";
        del.title = "Delete " + w.name;
        del.onclick = function(e) { e.stopPropagation(); closeDropdown(); deleteWorld(w.name); };
        row.appendChild(del);
      }
      menu.appendChild(row);
    });
    setControlsEnabled(true);
  }).catch(function() { setTimeout(function(){ loadWorlds(); }, 3000); });
}

function deleteWorld(name) {
  if (!confirm("Delete world \"" + name + "\"? This cannot be undone.")) return;
  setControlsEnabled(false);
  fetch("/sim/api/worlds/" + name, { method: "DELETE" })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        loadWorlds();
        setTimeout(function() { location.reload(); }, 3000);
      } else {
        alert(d.error || "Delete failed");
        setControlsEnabled(true);
      }
    }).catch(function() { alert("Delete failed"); setControlsEnabled(true); });
}

function openUpload() {
  document.getElementById("upload-overlay").style.display = "block";
  document.getElementById("upload-area").style.display = "block";
  document.getElementById("upload-status").textContent = "";
  document.getElementById("upload-status").className = "";
}

function closeUpload() {
  document.getElementById("upload-overlay").style.display = "none";
  document.getElementById("upload-area").style.display = "none";
  document.getElementById("file-input").value = "";
}

// Drag & drop — 모달 없이도 화면 어디에나 .tar.gz를 떨어뜨리면 업로드
window.addEventListener("load", function() {
  ["dragenter", "dragover"].forEach(function(e) {
    window.addEventListener(e, function(ev) { ev.preventDefault(); }, false);
  });
  window.addEventListener("drop", function(ev) {
    ev.preventDefault();
    var files = ev.dataTransfer && ev.dataTransfer.files;
    if (files && files.length > 0) handleFile(files[0]);
  }, false);
});

function handleFile(file) {
  if (!file) return;
  openUpload(); // 진행 표시 모달 — 파일이 정해진 뒤에만 뜬다
  var statusEl = document.getElementById("upload-status");
  if (!file.name.endsWith(".tar.gz")) {
    statusEl.textContent = "File must be .tar.gz";
    statusEl.className = "error";
    return;
  }
  statusEl.textContent = "Uploading " + file.name + "...";
  statusEl.className = "";
  
  // Chunked upload for Codespaces proxy limit (10MB)
  var CHUNK_SIZE = 10 * 1024 * 1024;
  var uploadId = null;
  
  function cleanup() {
    if (uploadId) {
      fetch("/sim/api/upload/cancel", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({upload_id: uploadId})
      }).catch(function() {});
    }
  }
  
  // Initialize upload
  fetch("/sim/api/upload/init", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({filename: file.name, size: file.size})
  })
  .then(function(r) { return r.json(); })
  .then(function(init) {
    if (!init.ok) throw new Error(init.error || "Init failed");
    uploadId = init.upload_id;
    
    // Split file into chunks and upload in parallel
    var totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    var promises = [];
    
    for (var i = 0; i < totalChunks; i++) {
      (function(chunkIndex) {
        var start = chunkIndex * CHUNK_SIZE;
        var end = Math.min(start + CHUNK_SIZE, file.size);
        var blob = file.slice(start, end);
        
        var p = new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onload = function() {
            var base64 = btoa(new Uint8Array(reader.result).reduce(function(data, byte) {
              return data + String.fromCharCode(byte);
            }, ''));
            fetch("/sim/api/upload/chunk", {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify({upload_id: uploadId, chunk_index: chunkIndex, data: base64})
            })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (d.ok) {
                var pct = Math.round((chunkIndex + 1) / totalChunks * 100);
                statusEl.textContent = "Uploading " + file.name + "... " + pct + "%";
                resolve();
              } else {
                reject(new Error(d.error || "Chunk upload failed"));
              }
            })
            .catch(reject);
          };
          reader.onerror = reject;
          reader.readAsArrayBuffer(blob);
        });
        promises.push(p);
      })(i);
    }
    
    return Promise.all(promises);
  })
  .then(function() {
    statusEl.textContent = "Processing...";
    return fetch("/sim/api/upload/complete", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({upload_id: uploadId})
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(res) {
    if (res.ok) {
      statusEl.textContent = "World \"" + res.world + "\" uploaded!";
      statusEl.className = "success";
      var uploadedWorld = res.world;
      loadWorlds(uploadedWorld);
      setTimeout(function() { closeUpload(); switchWorld(uploadedWorld + ".world"); }, 1500);
    } else {
      throw new Error(res.error || "Upload failed");
    }
  })
  .catch(function(e) {
    statusEl.textContent = "Upload failed: " + e.message;
    statusEl.className = "error";
    cleanup();
  });
}

function switchWorld(worldFile) {
  setControlsEnabled(false);
  var targetWorld = worldFile.replace(/\.world$/, "");
  document.getElementById("dropdown-toggle").textContent = targetWorld;
  document.getElementById("respawn-btn").disabled = true;
  fetch("/sim/api/switch", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({world: worldFile})
  }).then(function() {
    var attempts = 0;
    var poll = setInterval(function() {
      attempts++;
      fetch("/sim/api/status").then(function(r){return r.json()}).then(function(d) {
        if (d.running && d.current === targetWorld) {
          clearInterval(poll);
          setTimeout(function() { location.reload(); }, 2000);
        } else if (attempts > 60) {
          clearInterval(poll);
          location.reload();
        }
      }).catch(function() {});
    }, 1000);
  }).catch(function() { setControlsEnabled(true); });
}

setTimeout(loadWorlds, 500);
document.addEventListener("click", function(e) {
  if (!e.target.closest(".dropdown")) closeDropdown();
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

function _pushPoseSample(name, pos, ori) {
  var q = new THREE.Quaternion(ori.x || 0, ori.y || 0, ori.z || 0,
                               ori.w !== undefined ? ori.w : 1);
  var s = { t: performance.now(),
            x: pos.x || 0, y: pos.y || 0, z: pos.z || 0, q: q };
  var buf = _poseLerp[name];
  if (!buf) { _poseLerp[name] = [s]; return; }
  var last = buf[buf.length - 1];
  var dx = s.x - last.x, dy = s.y - last.y, dz = s.z - last.z;
  if (dx * dx + dy * dy + dz * dz > 4) buf.length = 0;  // teleport: snap, don't glide
  buf.push(s);
  if (buf.length > 12) buf.shift();
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
    // Drop samples that can no longer be needed (keep one before rt).
    while (buf.length > 2 && buf[1].t <= rt) buf.shift();
  }
}
var _selLight = null;

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
    var model = scene.getByName(name);
    var colors = LAMP_COLORS[(_lightsCache[name] || {}).state];
    if (!model || !colors) { return; }
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
  });
}

// 외부(로봇 코드/API) 상태 변경 반영용 저주파 폴링 — 노랑 경유 중엔 촘촘히.
// 신호등 없는 월드에서는 5초마다 존재 확인만 한다.
var _lightPollTimer = null;
function _scheduleLightPoll() {
  if (_lightPollTimer) { clearTimeout(_lightPollTimer); }
  var names = Object.keys(_lightsCache);
  var delay = 5000;
  if (connected && names.length > 0) {
    var anyYellow = names.some(function(n) { return _lightsCache[n].state === 'yellow'; });
    delay = anyYellow ? 700 : 2500;
  }
  _lightPollTimer = setTimeout(function() { _refreshLights(_scheduleLightPoll); }, delay);
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
  // 노랑 오버레이(런타임 모델) 클릭 → 본체 신호등으로 승격
  var ym = name.match(/^(.+)_yellow$/);
  if (ym && _lightsCache[ym[1]]) {
    var stand = scene.getByName(ym[1]);
    return stand ? { obj: stand, name: ym[1], kind: 'light' } : null;
  }
  var marker = null;
  for (var i = 0; i < top.children.length; i++) {
    var n = top.children[i].name;
    if (n === 'wall' || n === 'light' || n === 'signal' || n === 'object') { marker = n; break; }
  }
  if (marker === 'wall') { return null; }        // 벽은 이동 불가 (WB와 동일)
  if (marker === 'light' || marker === 'signal' || _lightsCache[name]) {
    return { obj: top, name: name, kind: 'light' }; // 단일 강체 — 램프는 링크 visual
  }
  if (name === 'physicar') { return { obj: top, name: name, kind: 'vehicle' }; }
  return { obj: top, name: name, kind: 'object' };
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
  _refreshLights(_scheduleLightPoll);
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
    _refreshLights(_scheduleLightPoll);
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

// ── 1사분면 그리드: 월드는 (0,0)~(W,H)에만 존재 — 음수 사분면 그리지 않음
// (World Builder rebuildGrid와 동일 스타일: 1m 간격, 회색, z 0.0015)
// 크기는 현재 트랙의 bounds(/sim/api/track_bounds)를 미터 단위로 올림해 맞춘다.
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
  fetch("/sim/api/track_bounds")
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

function _updateAutoFollow() {
  if (!_autoFollow) return;
  if (gzInteract && gzInteract.isManipulating('physicar')) return;
  var obj = scene.getByName('physicar');
  if (!obj) return;
  var target = new THREE.Vector3();
  obj.getWorldPosition(target);
  // Smooth zoom interpolation
  if (typeof _af.radiusTarget !== 'undefined') {
    _af.radius += (_af.radiusTarget - _af.radius) * 0.15;
    if (Math.abs(_af.radius - _af.radiusTarget) < 0.001) _af.radius = _af.radiusTarget;
  }
  // Track the vehicle heading with smoothing (shortest angular path) so the
  // camera swings behind the car through turns instead of staying at a fixed
  // world angle, without jittering on every pose update.
  var vyaw = _getVehicleYaw(obj);
  if (_af.yaw === null) _af.yaw = vyaw;
  var dyaw = Math.atan2(Math.sin(vyaw - _af.yaw), Math.cos(vyaw - _af.yaw));
  _af.yaw += dyaw * 0.08;
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
  // SSE 재구독(리스폰=페이지 리로드 등)으로 재전송된 곡은 offset부터 이어 재생.
  // 길이를 넘긴 비루프 곡이면(서버가 duration 을 몰랐던 URL 곡 등) 재생하지 않는다.
  if (msg.offset > 0) {
    audio.addEventListener("loadedmetadata", function() {
      var d = audio.duration;
      if (!isFinite(d)) return;
      var off = audio.loop ? (msg.offset % d) : msg.offset;
      if (off < d) { audio.currentTime = off; }
      else { audio.pause(); cleanup(); }
    });
  }
  audio.onended = function() {
    cleanup();
    // 자연 종료를 서버에 알려 보관된 재생 명령을 지운다 — 안 지우면 다음 SSE
    // 재구독 때 끝난 곡이 다시 나온다 (URL 곡은 서버가 길이를 몰라 이 통지가
    // 유일한 정리 수단).
    if (!msg.loop) {
      try {
        fetch("/audio/stop", { method: "POST", headers: { "Content-Type": "application/json" },
                               body: JSON.stringify({ id: msg.id }) }).catch(function() {});
      } catch (e) { /* ignore */ }
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

var colladaLoader = new THREE.ColladaLoader();

function _meshPath(uri) {
  var mi = uri.indexOf('meshes/');
  return mi >= 0 ? uri.substring(mi + 7) : uri.split('/').pop();
}

var gzScene = GzScene.create({
  THREE: THREE,
  meshUrl: function(uri) {
    var p = _meshPath(uri);
    return p ? "/sim/meshes/" + p : null;
  },
  loadMesh: function(url, onLoad, onError) {
    colladaLoader.load(url, function(collada) { onLoad(collada.scene); }, null, onError);
  },
  isPhysicarMesh: function(uri) {
    var p = _meshPath(uri);
    return p.indexOf('physicar/') === 0 && p.indexOf('Base.') < 0;
  }
});

function createModelFromMsg(model) { return gzScene.createModelFromMsg(model); }


