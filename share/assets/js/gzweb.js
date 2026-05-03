// =====================================================================
// Gazebo Web Viewer - Main JavaScript
// =====================================================================

var wsProtocol = (location.protocol === "https:") ? "wss://" : "ws://";
var wsUrl;
if (location.pathname.startsWith("/gz")) {
  wsUrl = wsProtocol + location.host + "/gz/ws";
} else {
  wsUrl = "ws://" + location.hostname + ":9002";
}
var gz = null;
var reconnectTimer = null;
var connected = false;

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
    var st = document.getElementById("status");
    st.title = "Connected (RTF: --)";
    document.getElementById("status-text").innerHTML = "<span class=\"connected\">\u25cf<span class=\"bar-label\"> RTF: --</span></span>";
    document.getElementById("status-menu").textContent = "RTF: --";
    // Sync world list on every (re)connect
    loadWorlds();
  });
  
  gz.on("close", function() {
    if (connected) { connected = false; clearScene(); }
    var st = document.getElementById("status");
    st.title = "Waiting for Gazebo...";
    document.getElementById("status-text").innerHTML = "<span class=\"disconnected\">\u25cf<span class=\"bar-label\"> Waiting for Gazebo...</span></span>";
    document.getElementById("status-menu").textContent = "Waiting for Gazebo...";
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
            if (e && e !== scene.modelManipulator.object && e.parent !== scene.modelManipulator.object) {
              scene.updatePose(e, p.position, p.orientation);
            } else if (!e && !knownModels[p.name] && p.name !== currentWorld) {
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
      
      var _prevSim = 0, _prevReal = 0, _rtf = 0;
      new Topic({ gz: gz, name: "/clock", messageType: "gz.msgs.Clock",
        callback: function(msg) {
          var st = msg.sim.sec + msg.sim.nsec * 1e-9;
          var rt = msg.real.sec + msg.real.nsec * 1e-9;
          var ds = st - _prevSim, dr = rt - _prevReal;
          _prevSim = st; _prevReal = rt;
          if (dr > 0.01) {
            var r = ds / dr;
            _rtf = _rtf > 0 ? _rtf * 0.9 + r * 0.1 : r;
            var val = _rtf.toFixed(2);
            var st = document.getElementById("status");
            st.title = "Connected (RTF: " + val + ")";
            document.getElementById("status-text").innerHTML = "<span class=\"connected\">\u25cf<span class=\"bar-label\"> RTF: " + val + "</span></span>";
            document.getElementById("status-menu").textContent = "RTF: " + val;
          }
        }
      });
    }
  });
}

function scheduleReconnect() {
  if (!reconnectTimer) reconnectTimer = setTimeout(connect, 3000);
}

// =====================================================================
// Scene Initialization
// =====================================================================

function init() {
  scene.grid.visible = true;
  
  // Remove any default lights added by GZ3D.Scene
  var toRemove = [];
  scene.scene.traverse(function(obj) {
    if (obj.isLight) toRemove.push(obj);
  });
  toRemove.forEach(function(l) { scene.scene.remove(l); });
  console.log('[Init] Removed', toRemove.length, 'default lights');
  
  // Fix grid z position (gz3d.js sets 0.05, we want 0)
  scene.grid.position.z = 0;
  
  // Lights will be added from scene message in handleScene()
  
  // Create audio visual indicator
  _createAudioRing();
  
  var el = document.getElementById("container");
  el.appendChild(scene.renderer.domElement);
  scene.setSize(el.clientWidth, el.clientHeight);
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
  fetch("/gz/api/worlds").then(function(r){return r.json()}).then(function(data) {
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
    // Import World at bottom of dropdown
    var importLink = document.createElement("a");
    importLink.className = "import-link";
    importLink.textContent = "+ Import World";
    importLink.onclick = function() { closeDropdown(); openUpload(); };
    menu.appendChild(importLink);
    setControlsEnabled(true);
  }).catch(function() { setTimeout(function(){ loadWorlds(); }, 3000); });
}

function deleteWorld(name) {
  if (!confirm("Delete world \"" + name + "\"? This cannot be undone.")) return;
  setControlsEnabled(false);
  fetch("/gz/api/worlds/" + name, { method: "DELETE" })
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

// Drag & drop
var dropZone = null;
window.addEventListener("load", function() {
  dropZone = document.getElementById("drop-zone");
  var area = document.getElementById("upload-area");
  ["dragenter", "dragover"].forEach(function(e) {
    area.addEventListener(e, function(ev) { ev.preventDefault(); area.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(function(e) {
    area.addEventListener(e, function(ev) { ev.preventDefault(); area.classList.remove("dragover"); });
  });
  area.addEventListener("drop", function(ev) {
    var files = ev.dataTransfer.files;
    if (files.length > 0) handleFile(files[0]);
  });
});

function handleFile(file) {
  if (!file) return;
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
      fetch("/gz/api/upload/cancel", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({upload_id: uploadId})
      }).catch(function() {});
    }
  }
  
  // Initialize upload
  fetch("/gz/api/upload/init", {
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
            fetch("/gz/api/upload/chunk", {
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
    return fetch("/gz/api/upload/complete", {
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
  document.getElementById("status").innerHTML = '<span class="switching">\u25cf Switching world...</span>';
  fetch("/gz/api/switch", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({world: worldFile})
  }).then(function() {
    var attempts = 0;
    var poll = setInterval(function() {
      attempts++;
      fetch("/gz/api/status").then(function(r){return r.json()}).then(function(d) {
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
      if (entry.sources.length > 0 || entry.queue.length > 0) {
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
        var entry = _audioChannels[k];
        entry.gainNode.gain.value = entry.volume * _distanceVolumeFactor;
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
  toggleAutoFollow(afEl.checked);
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

function toggleGrid(on) {
  scene.grid.visible = on;
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
// Self-managed spherical camera for auto-follow (bypass OrbitControls entirely)
var _af = {
  theta: Math.PI,  // camera behind (-Y), so screen X = world X, screen up ≈ world Y
  phi: 0.9,        // ~50deg from vertical
  radius: 1.8,     // closer to target
  dragging: false,
  lastX: 0,
  lastY: 0
};

function toggleSettings() {
  var menu = document.getElementById("settings-menu");
  menu.classList.toggle("open");
  document.getElementById("status-menu").classList.remove("open");
}

function toggleStatusMenu(e) {
  if (!document.body.classList.contains("narrow")) return;
  e.stopPropagation();
  var menu = document.getElementById("status-menu");
  menu.classList.toggle("open");
  document.getElementById("settings-menu").classList.remove("open");
}

function _afMouseDown(e) {
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

function toggleAutoFollow(on) {
  _autoFollow = on;
  var el = document.getElementById("container");
  if (on) {
    // Compute initial spherical coords from current camera
    var obj = scene.getByName('physicar');
    if (obj) {
      var pos = new THREE.Vector3();
      obj.getWorldPosition(pos);
      var offset = scene.camera.position.clone().sub(pos);
      _af.radius = offset.length();
      _af.radiusTarget = _af.radius;
      _af.theta = Math.atan2(offset.x, offset.y);
      _af.phi = Math.atan2(Math.sqrt(offset.x * offset.x + offset.y * offset.y), offset.z);
    }
    // Disable OrbitControls completely
    scene.controls.enabled = false;
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
  var obj = scene.getByName('physicar');
  if (!obj) return;
  var target = new THREE.Vector3();
  obj.getWorldPosition(target);
  // Smooth zoom interpolation
  if (typeof _af.radiusTarget !== 'undefined') {
    _af.radius += (_af.radiusTarget - _af.radius) * 0.15;
    if (Math.abs(_af.radius - _af.radiusTarget) < 0.001) _af.radius = _af.radiusTarget;
  }
  // Spherical to Cartesian offset (z-up)
  var sp = Math.sin(_af.phi);
  var x = _af.radius * sp * Math.sin(_af.theta);
  var y = _af.radius * sp * Math.cos(_af.theta);
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
  var status = document.getElementById("status");
  if (status && !status.contains(e.target)) {
    document.getElementById("status-menu").classList.remove("open");
  }
});

function animate() {
  requestAnimationFrame(animate);
  _updateAutoFollow();
  _updateAxes();
  _updateLidar();
  _updatePose();
  scene.render();
  _updateDistanceVolume();
  _updateAudioRing();
}

// =====================================================================
// Audio Streaming — plays /audio ROS2 topic via webserver SSE
// Mirrors real-kit audio_node.py:
//   - Per-channel Queue + drain (like audio_node.py's Queue + playback_loop)
//   - PCM chunks queued, only small window scheduled ahead (backpressure)
//   - stop: clear queue + stop scheduled sources (like queue.clear + aplay.kill)
//   - Different channels play independently (mix)
// =====================================================================

var _audioCtx = null;
// { chName: { gainNode, queue[], sources[], pcmNext, volume, drainTimer } }
var _audioChannels = {};
var _audioReady = false;
var _audioRetry = 1000;
var _audioEs = null;
var _audioPending = [];
var _PCM_SCHED_AHEAD = 0.5; // schedule up to 500ms ahead (like aplay buffer)

function _initAudioCtx() {
  if (_audioReady) return;
  _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  _audioReady = true;
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
  var es = new EventSource("/state/audio");
  _audioEs = es;
  _audioRetry = 1000;

  es.onopen = function() { _audioRetry = 1000; console.log('[Audio] SSE connected'); };
  es.onmessage = function(e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch(err) { return; }

    if (msg.stop_all) { stopAllAudio(); return; }

    var ch = msg.channel || "default";

    if (msg.stop) { stopAudioChannel(ch); return; }

    // volume-only (no data)
    if (!msg.data && msg.volume > 0) {
      if (_audioReady) {
        var entry = _getChannel(ch);
        entry.volume = Math.max(0, Math.min(1, msg.volume));
        entry.gainNode.gain.value = entry.volume * _distanceVolumeFactor;
      }
      return;
    }
    if (!msg.data) return;

    if (!_audioReady) {
      _audioPending.push(msg);
      if (_audioPending.length > 10) _audioPending.shift();
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

// === Channel management (mirrors AudioChannel class) ===

function _getChannel(name) {
  if (!name) name = "default";
  var entry = _audioChannels[name];
  if (!entry) {
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
    _audioChannels[name] = entry;
  }
  return entry;
}

function _b64ToUint8(b64) {
  var raw = atob(b64);
  var buf = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

function _pcmToFloat32(buf, bits) {
  var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  var bps = bits / 8;
  var count = Math.floor(buf.length / bps);
  var out = new Float32Array(count);
  for (var i = 0; i < count; i++) {
    if (bits === 8)       out[i] = (view.getUint8(i * bps) - 128) / 128.0;
    else if (bits === 16) out[i] = view.getInt16(i * bps, true) / 32768.0;
    else if (bits === 24) {
      var s = view.getUint8(i*3) | (view.getUint8(i*3+1) << 8) | (view.getInt8(i*3+2) << 16);
      out[i] = s / 8388608.0;
    }
    else if (bits === 32) out[i] = view.getInt32(i * bps, true) / 2147483648.0;
  }
  return out;
}

// === Message handler (mirrors audio_callback) ===

function _handleAudioMsg(msg) {
  var ch = msg.channel || "default";
  var entry = _getChannel(ch);

  // volume (mirrors channel.set_volume)
  if (msg.volume > 0) {
    entry.volume = Math.max(0, Math.min(1, msg.volume));
    entry.gainNode.gain.value = entry.volume * _distanceVolumeFactor;
  }

  var buf = _b64ToUint8(msg.data);
  var fmt = (msg.format || "").toLowerCase();

  if (fmt && fmt !== "pcm") {
    // Encoded audio: stop channel, decode, play (mirrors _play_encoded)
    stopAudioChannel(ch);
    entry = _getChannel(ch);
    _audioCtx.decodeAudioData(buf.buffer.slice(0), function(decoded) {
      var src = _audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(entry.gainNode);
      src.start(0);
      entry.sources.push(src);
      src.onended = function() {
        var idx = entry.sources.indexOf(src);
        if (idx >= 0) entry.sources.splice(idx, 1);
      };
      console.log('[Audio] encoded ch=' + ch, 'dur=' + decoded.duration.toFixed(2) + 's');
    }, function(err) {
      console.error('[Audio] decode error ch=' + ch, err);
    });
  } else {
    // PCM: enqueue, then drain (mirrors channel.enqueue + playback_loop)
    entry.queue.push({
      data: buf,
      sample_rate: msg.sample_rate || 16000,
      channels: msg.channels || 1,
      bits: msg.bits || 16
    });
    _drainChannel(ch);
  }
}

// === Drain loop (mirrors playback_loop + _write_pcm) ===
// Schedules PCM chunks from queue, keeping ≤ _PCM_SCHED_AHEAD seconds buffered.
// Like aplay: consumes at real-time rate, queue absorbs burst arrivals.

function _drainChannel(chName) {
  var entry = _audioChannels[chName];
  if (!entry) return;

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
    var bits = item.bits;
    var bps = bits / 8;
    var samples = _pcmToFloat32(item.data, bits);
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

    // When this source finishes, try to drain more (like playback_loop iteration)
    (function(cn) {
      src.onended = function() {
        var ent = _audioChannels[cn];
        if (ent) {
          var idx = ent.sources.indexOf(src);
          if (idx >= 0) ent.sources.splice(idx, 1);
          _drainChannel(cn);
        }
      };
    })(chName);
  }

  // If queue still has items, schedule next drain when headroom opens
  if (entry.queue.length > 0) {
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    var waitMs = Math.max(20, (entry.pcmNext - now - _PCM_SCHED_AHEAD * 0.5) * 1000);
    entry.drainTimer = setTimeout(function() {
      entry.drainTimer = null;
      _drainChannel(chName);
    }, waitMs);
  }
}

// === Stop (mirrors AudioChannel.stop: clear queue + kill aplay) ===

function stopAudioChannel(name) {
  if (!name) name = "default";
  var entry = _audioChannels[name];
  if (!entry) return;

  // Clear queue (like pcm_queue.clear)
  entry.queue = [];

  // Cancel pending drain
  if (entry.drainTimer) { clearTimeout(entry.drainTimer); entry.drainTimer = null; }

  // Stop all scheduled sources (like aplay.terminate)
  for (var i = 0; i < entry.sources.length; i++) {
    try { entry.sources[i].stop(); } catch(e) {}
  }
  entry.sources = [];
  entry.pcmNext = 0;

  console.log('[Audio] STOP ch=' + name);
}

function stopAllAudio() {
  console.log('[Audio] STOP ALL');
  for (var k in _audioChannels) {
    if (_audioChannels.hasOwnProperty(k)) stopAudioChannel(k);
  }
}

// =====================================================================
// Model Creation
// =====================================================================

function createModelFromMsg(model) {
  var obj = new THREE.Object3D(); obj.name = model.name; obj.userData.id = model.id;
  if (model.pose) scene.setPose(obj, model.pose.position, model.pose.orientation);
  for (var j = 0; j < model.link.length; ++j) {
    var link = model.link[j], lo = new THREE.Object3D(); lo.name = link.name; lo.userData.id = link.id;
    if (link.pose) scene.setPose(lo, link.pose.position, link.pose.orientation);
    obj.add(lo);
    for (var k = 0; k < link.visual.length; ++k) {
      var v = createVisualFromMsg(link.visual[k]); if (v && !v.parent) lo.add(v);
    }
  }
  if (model.joint) obj.joint = model.joint;
  return obj;
}

function createVisualFromMsg(visual) {
  if (!visual.geometry) return;
  var vo = new THREE.Object3D(); vo.name = visual.name;
  if (visual.pose) scene.setPose(vo, visual.pose.position, visual.pose.orientation);
  createGeom(visual.geometry, visual.material, vo); return vo;
}

function parseMaterial(m) {
  if (!m) return null; var a,d,s;
  if (m.ambient) a=[m.ambient.r,m.ambient.g,m.ambient.b,m.ambient.a];
  if (m.diffuse) d=[m.diffuse.r,m.diffuse.g,m.diffuse.b,m.diffuse.a];
  if (m.specular) s=[m.specular.r,m.specular.g,m.specular.b,m.specular.a];
  return {ambient:a,diffuse:d,specular:s};
}

var colladaLoader = new THREE.ColladaLoader();

function createGeom(g, material, parent) {
  var obj, mat = parseMaterial(material);
  if (g.mesh) {
    var uri = g.mesh.filename || "";
    var mi = uri.indexOf('meshes/');
    var mpath = mi >= 0 ? uri.substring(mi + 7) : uri.split('/').pop();
    if (mpath) {
      var isPhysicar = mpath.indexOf('physicar/') === 0 && mpath.indexOf('Base.') < 0;
      colladaLoader.load("/gz/meshes/" + mpath, function(collada) {
        var m = collada.scene;
        if (g.mesh.scale) m.scale.set(g.mesh.scale.x, g.mesh.scale.y, g.mesh.scale.z);
        if (isPhysicar) {
          m.traverse(function(child) {
            if (child instanceof THREE.Mesh && child.geometry) {
              var edges = new THREE.EdgesGeometry(child.geometry, 20);
              var c = child.material && child.material.color;
              var lc = (c && c.r < 0.2 && c.g < 0.2 && c.b < 0.2) ? 0x555555 : 0x222222;
              child.add(new THREE.LineSegments(edges,
                new THREE.LineBasicMaterial({color: lc})));
            }
          });
        } else {
          // Non-physicar models: make matte (remove specular shine)
          m.traverse(function(child) {
            if (child instanceof THREE.Mesh && child.material) {
              if (child.material.specular) {
                child.material.specular.setRGB(0, 0, 0);
              }
              if (child.material.shininess !== undefined) {
                child.material.shininess = 0;
              }
            }
          });
        }
        parent.add(m);
      }, null, function(err) {
        var fb = scene.createBox(0.03, 0.03, 0.03);
        parent.add(fb);
      });
    }
    return;
  }
  if (g.box) obj = scene.createBox(g.box.size.x, g.box.size.y, g.box.size.z);
  else if (g.cylinder) obj = scene.createCylinder(g.cylinder.radius, g.cylinder.length);
  else if (g.sphere) obj = scene.createSphere(g.sphere.radius);
  else if (g.plane) obj = scene.createPlane(g.plane.normal.x, g.plane.normal.y, g.plane.normal.z, g.plane.size.x, g.plane.size.y);
  if (obj) { if (mat) scene.setMaterial(obj, mat); obj.updateMatrix(); parent.add(obj); }
}

// =====================================================================
// Box Obstacle Tool — panel-based spawn, move, rotate, delete
// =====================================================================

var _boxPanelOpen = false;
var _boxSelected = null;     // name of selected obstacle
var _boxDragging = false;
var _boxRotating = false;
var _boxDragPending = false;
var _boxNames = {};          // name -> {x, y, yaw}
var _boxHighlight = null;    // wireframe highlight
var _boxPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
var _boxRaycaster = new THREE.Raycaster();
var _boxMouse = new THREE.Vector2();
var _boxDragOffset = new THREE.Vector3();
var _boxDragStartX = 0;
var _boxDragStartY = 0;
var _boxRotateStartX = 0;
var _boxRotateStartYaw = 0;
var _boxLastPatch = 0;
var _boxTrackBounds = null;  // {minX, maxX, minY, maxY}
var _boxPlacing = false;     // placement mode active?
var _boxPreviewCircle = null;
var _boxPreviewRect = null;
var _boxPreviewOutline = null;
var _BOX_MARGIN = 0.2;
var _BOX_W = 0.362;          // footprint width
var _BOX_D = 0.242;          // footprint depth

// ── UI creation ──────────────────────────────────────────────────────

function _createBoxUI() {
  var btn = document.createElement('div');
  btn.id = 'box-tool-btn';
  btn.title = 'Box Obstacles';
  btn.innerHTML = '&#x1f4e6;';
  btn.onclick = function(e) { e.stopPropagation(); toggleBoxPanel(); };
  document.body.appendChild(btn);

  var panel = document.createElement('div');
  panel.id = 'box-panel';
  panel.innerHTML =
    '<div class="box-panel-header">' +
    '<span>Obstacles</span>' +
    '<button id="box-add-btn">+ Add Box</button>' +
    '</div>' +
    '<div id="box-list"></div>';
  document.body.appendChild(panel);

  document.getElementById('box-add-btn').onclick = function(e) {
    e.stopPropagation();
    if (_boxPlacing) _cancelBoxPlacement(); else _startBoxPlacement();
  };
}

function toggleBoxPanel() {
  _boxPanelOpen = !_boxPanelOpen;
  document.getElementById('box-tool-btn').classList.toggle('active', _boxPanelOpen);
  document.getElementById('box-panel').classList.toggle('open', _boxPanelOpen);
  if (_boxPanelOpen) {
    _fetchTrackBounds();
    _refreshBoxList();
  } else {
    _cancelBoxPlacement();
    _deselectBox();
  }
}

// ── Track bounds ─────────────────────────────────────────────────────

function _fetchTrackBounds() {
  fetch('/gz/api/track_bounds')
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.minX !== undefined) _boxTrackBounds = d; })
    .catch(function() {});
}

function _clampToTrack(x, y) {
  if (!_boxTrackBounds) return {x: x, y: y};
  var b = _boxTrackBounds;
  return {
    x: Math.max(b.minX + _BOX_MARGIN, Math.min(b.maxX - _BOX_MARGIN, x)),
    y: Math.max(b.minY + _BOX_MARGIN, Math.min(b.maxY - _BOX_MARGIN, y))
  };
}

function _isInTrack(x, y) {
  if (!_boxTrackBounds) return true;
  var b = _boxTrackBounds;
  return x >= b.minX + _BOX_MARGIN && x <= b.maxX - _BOX_MARGIN &&
         y >= b.minY + _BOX_MARGIN && y <= b.maxY - _BOX_MARGIN;
}

// ── Obstacle list ────────────────────────────────────────────────────

function _refreshBoxList() {
  fetch('/gz/api/obstacles')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _boxNames = {};
      var list = document.getElementById('box-list');
      if (!list) return;
      list.innerHTML = '';
      var obs = d.obstacles || {};
      var keys = Object.keys(obs).sort();
      for (var i = 0; i < keys.length; i++) {
        var name = keys[i];
        _boxNames[name] = {x: obs[name].x, y: obs[name].y, yaw: obs[name].yaw || 0};
        _appendBoxRow(name, _boxNames[name]);
      }
    }).catch(function() {});
}

function _appendBoxRow(name, info) {
  var list = document.getElementById('box-list');
  if (!list) return;
  var row = document.createElement('div');
  row.className = 'box-row' + (_boxSelected === name ? ' selected' : '');
  row.dataset.name = name;
  row.onclick = function(e) { if (e.target.tagName !== 'INPUT') _selectBox(name); };

  var label = document.createElement('span');
  label.className = 'box-name';
  label.textContent = name;
  row.appendChild(label);

  row.appendChild(_makeCoordInput('X', info.x.toFixed(2), function(v) {
    var nv = parseFloat(v); if (isNaN(nv)) return;
    _boxNames[name].x = nv; _patchAndUpdate(name);
  }));
  row.appendChild(_makeCoordInput('Y', info.y.toFixed(2), function(v) {
    var nv = parseFloat(v); if (isNaN(nv)) return;
    _boxNames[name].y = nv; _patchAndUpdate(name);
  }));
  row.appendChild(_makeCoordInput('\u00b0', (info.yaw * 180 / Math.PI).toFixed(0), function(v) {
    var nv = parseFloat(v); if (isNaN(nv)) return;
    _boxNames[name].yaw = nv * Math.PI / 180; _patchAndUpdate(name);
  }));

  var del = document.createElement('span');
  del.className = 'box-del';
  del.innerHTML = '&times;';
  del.title = 'Delete ' + name;
  del.onclick = function(e) { e.stopPropagation(); _deleteObstacle(name); };
  row.appendChild(del);

  list.appendChild(row);
}

function _makeCoordInput(lbl, value, onChange) {
  var wrap = document.createElement('label');
  wrap.className = 'box-coord';
  var sp = document.createElement('span');
  sp.textContent = lbl;
  wrap.appendChild(sp);
  var inp = document.createElement('input');
  inp.type = 'number';
  inp.step = lbl === '\u00b0' ? '1' : '0.01';
  inp.value = value;
  inp.onchange = function() { onChange(inp.value); };
  inp.onkeydown = function(e) { e.stopPropagation(); };
  wrap.appendChild(inp);
  return wrap;
}

function _patchAndUpdate(name) {
  var info = _boxNames[name];
  if (!info) return;
  var clamped = _clampToTrack(info.x, info.y);
  info.x = clamped.x; info.y = clamped.y;
  var obj = scene.getByName(name);
  if (obj) {
    obj.position.x = info.x;
    obj.position.y = info.y;
    obj.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), info.yaw);
  }
  _updateBoxHighlight();
  _patchObstacle(name, info.x, info.y, info.yaw);
}

function _updateBoxRow(name, x, y, yaw) {
  if (_boxNames[name]) { _boxNames[name].x = x; _boxNames[name].y = y; _boxNames[name].yaw = yaw; }
  var row = document.querySelector('.box-row[data-name="' + name + '"]');
  if (!row) return;
  var inputs = row.querySelectorAll('input');
  if (inputs[0]) inputs[0].value = x.toFixed(2);
  if (inputs[1]) inputs[1].value = y.toFixed(2);
  if (inputs[2]) inputs[2].value = (yaw * 180 / Math.PI).toFixed(0);
}

// ── Placement mode ───────────────────────────────────────────────────

function _startBoxPlacement() {
  _boxPlacing = true;
  _deselectBox();
  document.getElementById('box-add-btn').classList.add('placing');
  document.getElementById('box-add-btn').textContent = 'Cancel';

  // Create preview meshes (once, reuse)
  if (!_boxPreviewCircle) {
    var cg = new THREE.CircleGeometry(0.18, 32);
    var cm = new THREE.MeshBasicMaterial({color: 0x888888, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false});
    _boxPreviewCircle = new THREE.Mesh(cg, cm);
    _boxPreviewCircle.renderOrder = 990;
    _boxPreviewCircle.position.z = 0.005;
    scene.scene.add(_boxPreviewCircle);
  }
  _boxPreviewCircle.visible = false;

  if (!_boxPreviewRect) {
    var rg = new THREE.PlaneGeometry(_BOX_W, _BOX_D);
    var rm = new THREE.MeshBasicMaterial({color: 0x4ade80, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthTest: false});
    _boxPreviewRect = new THREE.Mesh(rg, rm);
    _boxPreviewRect.renderOrder = 991;
    _boxPreviewRect.position.z = 0.006;
    scene.scene.add(_boxPreviewRect);
  }
  _boxPreviewRect.visible = false;

  if (!_boxPreviewOutline) {
    var og = new THREE.EdgesGeometry(new THREE.PlaneGeometry(_BOX_W, _BOX_D));
    var om = new THREE.LineBasicMaterial({color: 0x4ade80, transparent: true, opacity: 0.8, depthTest: false});
    _boxPreviewOutline = new THREE.LineSegments(og, om);
    _boxPreviewOutline.renderOrder = 992;
    _boxPreviewOutline.position.z = 0.007;
    scene.scene.add(_boxPreviewOutline);
  }
  _boxPreviewOutline.visible = false;

  scene.renderer.domElement.style.cursor = 'crosshair';
}

function _cancelBoxPlacement() {
  if (!_boxPlacing) return;
  _boxPlacing = false;
  var btn = document.getElementById('box-add-btn');
  if (btn) { btn.classList.remove('placing'); btn.textContent = '+ Add Box'; }
  if (_boxPreviewCircle) _boxPreviewCircle.visible = false;
  if (_boxPreviewRect) _boxPreviewRect.visible = false;
  if (_boxPreviewOutline) _boxPreviewOutline.visible = false;
  scene.renderer.domElement.style.cursor = '';
}

function _updatePlacementPreview(event) {
  var hit = _groundIntersect(event);
  if (!hit) {
    if (_boxPreviewCircle) _boxPreviewCircle.visible = false;
    if (_boxPreviewRect) _boxPreviewRect.visible = false;
    if (_boxPreviewOutline) _boxPreviewOutline.visible = false;
    return;
  }
  var inBounds = _isInTrack(hit.x, hit.y);
  var pos = _clampToTrack(hit.x, hit.y);
  var color = inBounds ? 0x4ade80 : 0xf87171;

  if (_boxPreviewCircle) {
    _boxPreviewCircle.position.x = hit.x;
    _boxPreviewCircle.position.y = hit.y;
    _boxPreviewCircle.visible = true;
  }
  if (_boxPreviewRect) {
    _boxPreviewRect.position.x = pos.x;
    _boxPreviewRect.position.y = pos.y;
    _boxPreviewRect.material.color.setHex(color);
    _boxPreviewRect.visible = true;
  }
  if (_boxPreviewOutline) {
    _boxPreviewOutline.position.x = pos.x;
    _boxPreviewOutline.position.y = pos.y;
    _boxPreviewOutline.material.color.setHex(color);
    _boxPreviewOutline.visible = true;
  }
}

// ── Selection & highlight ────────────────────────────────────────────

function _selectBox(name) {
  _deselectBox();
  _boxSelected = name;
  _updateBoxHighlight();
  var rows = document.querySelectorAll('.box-row');
  for (var i = 0; i < rows.length; i++)
    rows[i].classList.toggle('selected', rows[i].dataset.name === name);
}

function _deselectBox() {
  _boxSelected = null;
  if (_boxHighlight) {
    scene.scene.remove(_boxHighlight);
    _boxHighlight.geometry.dispose();
    _boxHighlight.material.dispose();
    _boxHighlight = null;
  }
  var rows = document.querySelectorAll('.box-row');
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove('selected');
}

function _updateBoxHighlight() {
  if (_boxHighlight) {
    scene.scene.remove(_boxHighlight);
    _boxHighlight.geometry.dispose();
    _boxHighlight.material.dispose();
    _boxHighlight = null;
  }
  if (!_boxSelected) return;
  var obj = scene.getByName(_boxSelected);
  if (!obj) return;
  var bbox = new THREE.Box3().setFromObject(obj);
  var size = bbox.getSize(new THREE.Vector3());
  var center = bbox.getCenter(new THREE.Vector3());
  var geom = new THREE.BoxGeometry(size.x * 1.05, size.y * 1.05, size.z * 1.05);
  var edges = new THREE.EdgesGeometry(geom);
  _boxHighlight = new THREE.LineSegments(edges,
    new THREE.LineBasicMaterial({color: 0x00ff88, linewidth: 2, depthTest: false, transparent: true, opacity: 0.8}));
  _boxHighlight.renderOrder = 999;
  _boxHighlight.position.copy(center);
  scene.scene.add(_boxHighlight);
}

// ── Raycasting ───────────────────────────────────────────────────────

function _groundIntersect(event) {
  var rect = scene.renderer.domElement.getBoundingClientRect();
  _boxMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  _boxMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  _boxRaycaster.setFromCamera(_boxMouse, scene.camera);
  var hit = new THREE.Vector3();
  return _boxRaycaster.ray.intersectPlane(_boxPlane, hit) ? hit : null;
}

function _findBoxAtMouse(event) {
  var rect = scene.renderer.domElement.getBoundingClientRect();
  _boxMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  _boxMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  _boxRaycaster.setFromCamera(_boxMouse, scene.camera);
  var targets = [];
  for (var name in _boxNames) {
    var obj = scene.getByName(name);
    if (obj) obj.traverse(function(child) {
      if (child.isMesh) { child._boxObstacleName = name; targets.push(child); }
    });
  }
  if (targets.length === 0) return null;
  var hits = _boxRaycaster.intersectObjects(targets, false);
  return hits.length > 0 ? hits[0].object._boxObstacleName : null;
}

// ── Mouse & keyboard handlers ────────────────────────────────────────

function _boxOnMouseDown(event) {
  if (!_boxPanelOpen) return;
  if (event.target !== scene.renderer.domElement) return;

  // Placement mode
  if (_boxPlacing) {
    if (event.button === 0) {
      var hit = _groundIntersect(event);
      if (hit) {
        var pos = _clampToTrack(hit.x, hit.y);
        _spawnBoxAtPosition(pos.x, pos.y);
        _cancelBoxPlacement();
      }
      event.preventDefault(); event.stopPropagation();
    } else if (event.button === 2) {
      _cancelBoxPlacement();
      event.preventDefault(); event.stopPropagation();
    }
    return;
  }

  // Normal mode — select / drag / rotate
  if (event.button === 0) {
    var found = _findBoxAtMouse(event);
    if (found) {
      _selectBox(found);
      _boxDragPending = true;
      _boxDragStartX = event.clientX;
      _boxDragStartY = event.clientY;
      var hit = _groundIntersect(event);
      var obj = scene.getByName(found);
      if (hit && obj) {
        var pos = new THREE.Vector3();
        obj.getWorldPosition(pos);
        _boxDragOffset.copy(pos).sub(hit);
      }
      event.preventDefault(); event.stopPropagation();
    } else {
      _deselectBox();
    }
  } else if (event.button === 2 && _boxSelected) {
    var found = _findBoxAtMouse(event);
    if (found === _boxSelected) {
      _boxRotating = true;
      _boxRotateStartX = event.clientX;
      var obj = scene.getByName(found);
      if (obj) {
        var euler = new THREE.Euler().setFromQuaternion(obj.quaternion, 'ZYX');
        _boxRotateStartYaw = euler.z;
      }
      event.preventDefault(); event.stopPropagation();
    }
  }
}

function _boxOnMouseMove(event) {
  if (!_boxPanelOpen) return;

  if (_boxPlacing) { _updatePlacementPreview(event); return; }

  // Start drag after threshold
  if (_boxDragPending && _boxSelected) {
    if (Math.abs(event.clientX - _boxDragStartX) + Math.abs(event.clientY - _boxDragStartY) > 4) {
      _boxDragging = true;
      _boxDragPending = false;
      if (!_autoFollow) scene.controls.enabled = false;
    }
  }

  if (_boxDragging && _boxSelected) {
    var hit = _groundIntersect(event);
    if (hit) {
      var pos = _clampToTrack(hit.x + _boxDragOffset.x, hit.y + _boxDragOffset.y);
      var obj = scene.getByName(_boxSelected);
      if (obj) { obj.position.x = pos.x; obj.position.y = pos.y; }
      _updateBoxHighlight();
      var now = Date.now();
      if (now - _boxLastPatch > 200) {
        _boxLastPatch = now;
        _patchObstacle(_boxSelected, pos.x, pos.y, null);
      }
    }
    event.preventDefault(); event.stopPropagation();
  }

  if (_boxRotating && _boxSelected) {
    var dx = event.clientX - _boxRotateStartX;
    var yaw = _boxRotateStartYaw + dx * 0.01;
    var obj = scene.getByName(_boxSelected);
    if (obj) obj.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
    _updateBoxHighlight();
    event.preventDefault(); event.stopPropagation();
  }
}

function _boxOnMouseUp(event) {
  if (!_boxPanelOpen) return;

  if (_boxDragPending) { _boxDragPending = false; return; }

  if (_boxDragging && _boxSelected) {
    var obj = scene.getByName(_boxSelected);
    if (obj) {
      var euler = new THREE.Euler().setFromQuaternion(obj.quaternion, 'ZYX');
      var pos = _clampToTrack(obj.position.x, obj.position.y);
      _patchObstacle(_boxSelected, pos.x, pos.y, euler.z);
      _updateBoxRow(_boxSelected, pos.x, pos.y, euler.z);
    }
    _boxDragging = false;
    if (!_autoFollow) scene.controls.enabled = true;
  }

  if (_boxRotating && _boxSelected) {
    var obj = scene.getByName(_boxSelected);
    if (obj) {
      var euler = new THREE.Euler().setFromQuaternion(obj.quaternion, 'ZYX');
      _patchObstacle(_boxSelected, obj.position.x, obj.position.y, euler.z);
      _updateBoxRow(_boxSelected, obj.position.x, obj.position.y, euler.z);
    }
    _boxRotating = false;
    if (!_autoFollow) scene.controls.enabled = true;
  }
}

function _boxOnKeyDown(event) {
  if (!_boxPanelOpen) return;
  if (event.key === 'Escape') {
    if (_boxPlacing) { _cancelBoxPlacement(); event.preventDefault(); }
    else if (_boxSelected) { _deselectBox(); event.preventDefault(); }
    return;
  }
  if (!_boxSelected) return;
  if ((event.key === 'Delete' || event.key === 'Backspace') && event.target.tagName !== 'INPUT') {
    _deleteObstacle(_boxSelected);
    _deselectBox();
    event.preventDefault();
  }
}

function _boxOnContextMenu(event) {
  if (_boxPanelOpen && (_boxPlacing || _boxRotating)) event.preventDefault();
}

// ── API calls ────────────────────────────────────────────────────────

function _spawnBoxAtPosition(x, y) {
  fetch('/gz/api/obstacle', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({x: x, y: y, yaw: 0})
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) {
      _boxNames[d.name] = {x: x, y: y, yaw: 0};
      _appendBoxRow(d.name, _boxNames[d.name]);
      setTimeout(function() { _selectBox(d.name); }, 1000);
    }
  }).catch(function(e) { console.error('[Box] spawn error:', e); });
}

function _deleteObstacle(name) {
  fetch('/gz/api/obstacle/' + name, {method: 'DELETE'})
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        delete _boxNames[name];
        var row = document.querySelector('.box-row[data-name="' + name + '"]');
        if (row) row.remove();
        if (_boxSelected === name) _deselectBox();
      }
    }).catch(function(e) { console.error('[Box] delete error:', e); });
}

function _patchObstacle(name, x, y, yaw) {
  var body = {x: x, y: y};
  if (yaw !== null && yaw !== undefined) body.yaw = yaw;
  fetch('/gz/api/obstacle/' + name, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  }).catch(function(e) { console.error('[Box] patch error:', e); });
}

// ── Init ─────────────────────────────────────────────────────────────

window.addEventListener('load', function() {
  _createBoxUI();
  var el = document.getElementById('container');
  el.addEventListener('mousedown', _boxOnMouseDown, true);
  el.addEventListener('mousemove', _boxOnMouseMove, true);
  el.addEventListener('mouseup', _boxOnMouseUp, true);
  el.addEventListener('contextmenu', _boxOnContextMenu, true);
  document.addEventListener('keydown', _boxOnKeyDown);
});


