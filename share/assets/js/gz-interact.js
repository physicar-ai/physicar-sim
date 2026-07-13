/* gz-interact.js — 3D 뷰 오브젝트 선택/평행이동/회전 상호작용 공유 모듈.
 *
 * World Builder(world-builder-3d.js)의 상호작용 계약을 그대로 따른다:
 *  - 미선택 오브젝트: 클릭(뗄 때, 이동 ≤4px)으로만 선택 — 누른 채 움직이면 카메라 제스처
 *  - 선택된 오브젝트: 누르는 즉시 지면(XY) 평행이동 드래그
 *  - 회전: 물체 앞쪽의 파란 점 핸들(화면 16px 그랩) 드래그 = 중심 기준 yaw 회전
 *  - 조작 확정은 놓는 순간 — onCommit 콜백 (sim에서는 여기서 pose API를 부른다)
 *  - pointerdown 차단만으로는 부족 — 브라우저가 mousedown/touchstart를 별도 발화하므로
 *    드래그 중에는 그것들도 캡처 단계에서 함께 차단 (GZ3D 궤도 컨트롤 개입 방지)
 *
 * 원본: physicar-sim/share/assets/js/gz-interact.js (gz-scene.js와 동일한 공유 규약 —
 * World Builder가 이 모듈을 채택하면 사이트 쪽 사본을 두고 그대로 동기화한다)
 */
var GzInteract = (function() {
  'use strict';

  function create(opts) {
    var THREE = opts.THREE;
    var scene = opts.scene;        // GZ3D.Scene
    var container = opts.container;
    // opts.resolveTarget(topObj, leafObj) -> {obj, name, kind, attachments?} | null
    // opts.onSelect(sel) / opts.onDeselect() / opts.onCommit(sel, {x,y,z,yaw})
    // opts.onDrag(sel)  — 라이브 드래그 중 (선택)

    var sel = null;          // {obj, name, kind, attachments}
    var bodyDrag = null;     // {dx, dy, base:[{obj,px,py,quat}], moved}
    var ringDrag = null;     // {yawOffset, startYaw, base:[...], moved}
    var clickCandidate = null;

    // ── 회전 점 핸들 — WB rotRing과 동일 지오메트리 (파란 점 + 원형 화살표) ──
    var rotRing = (function() {
      var g = new THREE.Group();
      var dot = new THREE.Mesh(new THREE.CircleGeometry(0.028, 14),
        new THREE.MeshBasicMaterial({ color: 0x1976d2, depthTest: false, transparent: true, opacity: 0.95 }));
      var rim = new THREE.Mesh(new THREE.RingGeometry(0.028, 0.04, 14),
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 }));
      g.add(dot); g.add(rim);
      var arrowMat = new THREE.MeshBasicMaterial({ color: 0x1976d2, depthTest: false, transparent: true, opacity: 0.9 });
      var a0 = 0.55, a1 = 5.55, rIn = 0.05, rOut = 0.062;
      g.add(new THREE.Mesh(new THREE.RingGeometry(rIn, rOut, 28, 1, a0, a1 - a0), arrowMat));
      var rm = (rIn + rOut) / 2;
      var head = new THREE.Geometry();
      var px = Math.cos(a1) * rm, py = Math.sin(a1) * rm;
      var tx = -Math.sin(a1), ty = Math.cos(a1);
      var rx = Math.cos(a1), ry = Math.sin(a1);
      head.vertices.push(
        new THREE.Vector3(px + tx * 0.032, py + ty * 0.032, 0),
        new THREE.Vector3(px + rx * 0.018, py + ry * 0.018, 0),
        new THREE.Vector3(px - rx * 0.018, py - ry * 0.018, 0));
      head.faces.push(new THREE.Face3(0, 1, 2));
      head.computeFaceNormals();
      var headMesh = new THREE.Mesh(head, arrowMat);
      headMesh.material.side = THREE.DoubleSide;
      g.add(headMesh);
      g.name = 'GZ_ROT_HANDLE';
      g.visible = false;
      g.traverse(function(o) { o.renderOrder = 1001; o.raycast = function() {}; });
      scene.scene.add(g);
      return g;
    })();

    function quatToYaw(q) {
      return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
    }

    function _rect() { return scene.renderer.domElement.getBoundingClientRect(); }

    function groundPointFromEvent(e) {
      var rect = _rect();
      var ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1);
      var ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, scene.camera);
      var pt = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), pt) ? pt : null;
    }

    function toScreen(x, y, z) {
      var rect = _rect();
      var v = new THREE.Vector3(x, y, z || 0).project(scene.camera);
      return { x: rect.left + (v.x + 1) / 2 * rect.width,
               y: rect.top + (1 - v.y) / 2 * rect.height };
    }

    // 픽킹: 리프 히트를 최상위 모델로 승격 후 resolveTarget에 위임
    function pickTarget(e) {
      var rect = _rect();
      var ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1);
      var ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, scene.camera);
      var hits;
      try { hits = ray.intersectObjects(scene.scene.children, true); } catch (err) { hits = []; }
      for (var i = 0; i < hits.length; i++) {
        var leaf = hits[i].object;
        if (leaf.name === 'GRADIENT_SKY' || leaf.name === 'boundingBox' || leaf.name === 'grid') { continue; }
        var top = leaf;
        while (top.parent && top.parent !== scene.scene) { top = top.parent; }
        if (top === rotRing || !top.name) { continue; }
        var t = opts.resolveTarget(top, leaf);
        if (t) { return t; }
        // 편집 불가 지오메트리(트랙 등)에 막히면 그 뒤 오브젝트는 못 집는다 —
        // WB pickEditableHit와 동일하게 계속 진행 (더 먼 편집 대상 허용)
      }
      return null;
    }

    // 반경 폴백 — 정확히 메시를 못 맞혀도 근처(지면 기준) 편집 오브젝트를 잡아줌
    function nearestTarget(p, maxDist) {
      var best = null, bestD = maxDist;
      for (var i = 0; i < scene.scene.children.length; i++) {
        var c = scene.scene.children[i];
        if (!c.name || c === rotRing) { continue; }
        var t = opts.resolveTarget(c, c);
        if (!t) { continue; }
        var d = Math.hypot(c.position.x - p.x, c.position.y - p.y);
        if (d < bestD) { bestD = d; best = t; }
      }
      return best;
    }

    // ── 선택 ──
    function select(target) {
      if (sel && sel.obj === target.obj) { return; }
      deselect(true);
      sel = target;
      scene.showBoundingBox(target.obj);
      syncRing();
      if (opts.onSelect) { opts.onSelect(sel); }
    }

    function deselect(silent) {
      if (!sel) { return; }
      scene.hideBoundingBox();
      rotRing.visible = false;
      sel = null;
      if (!silent && opts.onDeselect) { opts.onDeselect(); }
    }

    // 회전 핸들 배치 — 물체 앞(+Y local) 방향, 반경은 footprint 절반 + 22px
    function syncRing() {
      if (!sel) { rotRing.visible = false; return; }
      var obj = sel.obj;
      var yaw = quatToYaw(obj.quaternion);
      var dist = obj.position.distanceTo(scene.camera.position);
      var rect = _rect();
      var wpp = 2 * dist * Math.tan(scene.camera.fov * Math.PI / 360) / (rect.height || 1);
      if (sel.radius === undefined) {
        var box = new THREE.Box3().setFromObject(obj);
        sel.radius = isFinite(box.max.x) ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2 : 0.2;
      }
      var off = sel.radius + Math.max(0.08, 22 * wpp);
      rotRing.position.set(
        obj.position.x - Math.sin(yaw) * off,
        obj.position.y + Math.cos(yaw) * off, 0.03);
      // 멀리서도 핸들이 화면상 일정 크기를 유지 (기준 wpp ≈ 0.0036 = WB 기본 카메라)
      var s = Math.max(1, wpp / 0.0036);
      rotRing.scale.set(s, s, s);
      rotRing.visible = true;
    }

    // 드래그 시작 시 본체+부속(신호등 스크린 패널 등)의 기준 상태 저장
    function snapBase() {
      var list = [sel.obj].concat(sel.attachments || []);
      return list.map(function(o) {
        return { obj: o, px: o.position.x, py: o.position.y, quat: o.quaternion.clone() };
      });
    }

    function applyMove(dx, dy, base) {
      for (var i = 0; i < base.length; i++) {
        base[i].obj.position.x = base[i].px + dx;
        base[i].obj.position.y = base[i].py + dy;
      }
    }

    function applyYaw(deltaYaw, base) {
      var c = base[0]; // 본체 중심 기준 강체 회전
      var cx = c.px, cy = c.py;
      var cos = Math.cos(deltaYaw), sin = Math.sin(deltaYaw);
      var dq = new THREE.Quaternion(0, 0, Math.sin(deltaYaw / 2), Math.cos(deltaYaw / 2));
      for (var i = 0; i < base.length; i++) {
        var b = base[i];
        var rx = b.px - cx, ry = b.py - cy;
        b.obj.position.x = cx + rx * cos - ry * sin;
        b.obj.position.y = cy + rx * sin + ry * cos;
        b.obj.quaternion.copy(dq.clone().multiply(b.quat));
      }
    }

    function setControls(enabled) {
      if (scene.controls) {
        scene.controls.enabled = enabled;
        if (enabled && scene.controls.update) { scene.controls.update(); }
      }
    }

    function commit(fromDrag) {
      var s = sel;
      if (!s) { return; }
      var obj = s.obj;
      var yaw = quatToYaw(obj.quaternion);
      // 선택 박스는 월드 정렬 스냅샷 — 회전 후엔 재계산
      scene.hideBoundingBox();
      scene.showBoundingBox(obj);
      syncRing();
      if (opts.onCommit) {
        opts.onCommit(s, { x: obj.position.x, y: obj.position.y, z: obj.position.z, yaw: yaw });
      }
    }

    // ── 이벤트 (WB와 동일: 캡처 등록, pointer + mousedown/touchstart 이중 차단) ──
    container.addEventListener('pointerdown', function(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') { return; }
      var p = groundPointFromEvent(e);
      // 1) 회전 점 핸들 (화면 16px)
      if (sel && rotRing.visible && p) {
        var rsp = toScreen(rotRing.position.x, rotRing.position.y, rotRing.position.z);
        if (Math.hypot(rsp.x - e.clientX, rsp.y - e.clientY) <= 16) {
          var grabA = Math.atan2(p.y - sel.obj.position.y, p.x - sel.obj.position.x);
          ringDrag = { grabA: grabA, startYaw: quatToYaw(sel.obj.quaternion), base: snapBase(), moved: false };
          setControls(false);
          e.stopPropagation(); e.preventDefault();
          return;
        }
      }
      // 2) 몸체 픽 (정확 히트 → 근접 폴백): 선택된 오브젝트만 즉시 드래그,
      //    미선택이면 클릭(뗄 때, 이동 ≤4px)으로만 선택 — 누른 채 움직이면 카메라
      var target = pickTarget(e);
      if (!target && p) { target = nearestTarget(p, 0.14); }
      if (target && p) {
        if (sel && sel.obj === target.obj) {
          bodyDrag = { dx: sel.obj.position.x - p.x, dy: sel.obj.position.y - p.y,
                       base: snapBase(), moved: false };
          setControls(false);
          e.stopPropagation(); e.preventDefault();
        } else {
          clickCandidate = { kind: 'select', target: target, sx: e.clientX, sy: e.clientY };
        }
        return;
      }
      // 3) 빈 곳/편집 불가: 클릭이면 선택 해제 — 누른 채 움직이면 카메라
      clickCandidate = { kind: 'deselect', sx: e.clientX, sy: e.clientY };
    }, true);

    ['mousedown', 'touchstart'].forEach(function(t) {
      container.addEventListener(t, function(e) {
        if (bodyDrag || ringDrag) { e.stopPropagation(); }
      }, true);
    });

    container.addEventListener('pointermove', function(e) {
      if (clickCandidate && Math.hypot(e.clientX - clickCandidate.sx, e.clientY - clickCandidate.sy) > 4) {
        clickCandidate = null; // 이동 = 카메라 제스처
      }
      if (ringDrag && sel) {
        var rp = groundPointFromEvent(e);
        if (!rp) { return; }
        var a = Math.atan2(rp.y - ringDrag.base[0].py, rp.x - ringDrag.base[0].px);
        applyYaw(a - ringDrag.grabA, ringDrag.base);
        ringDrag.moved = true;
        syncRing();
        if (opts.onDrag) { opts.onDrag(sel); }
        e.stopPropagation();
        return;
      }
      if (bodyDrag && sel) {
        var p = groundPointFromEvent(e);
        if (!p) { return; }
        applyMove(p.x + bodyDrag.dx - bodyDrag.base[0].px, p.y + bodyDrag.dy - bodyDrag.base[0].py, bodyDrag.base);
        bodyDrag.moved = true;
        syncRing();
        if (opts.onDrag) { opts.onDrag(sel); }
        e.stopPropagation();
      }
    }, true);

    function finishDrag(e) {
      if (clickCandidate) {
        var cand = clickCandidate;
        clickCandidate = null;
        var movedPx = (e && e.clientX !== undefined)
          ? Math.hypot(e.clientX - cand.sx, e.clientY - cand.sy) : 0;
        if (movedPx <= 4) {
          if (cand.kind === 'select') { select(cand.target); }
          else if (cand.kind === 'deselect') { deselect(); }
        }
      }
      if (bodyDrag || ringDrag) {
        var moved = (bodyDrag && bodyDrag.moved) || (ringDrag && ringDrag.moved);
        bodyDrag = null;
        ringDrag = null;
        setControls(true);
        if (moved) { commit(true); }
      }
    }
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', function() {
      bodyDrag = null; ringDrag = null; setControls(true);
    }, true);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { deselect(); }
    });

    return {
      selected: function() { return sel; },
      // 드래그/커밋 대상 이름 집합 — 스트림 포즈 반영 억제용
      isManipulating: function(name) {
        if (!sel || (!bodyDrag && !ringDrag)) { return false; }
        if (sel.name === name || sel.obj.name === name) { return true; }
        return (sel.attachments || []).some(function(o) { return o.name === name; });
      },
      deselect: function() { deselect(); },
      selectByName: function(name) {
        var obj = scene.getByName ? scene.getByName(name) : scene.scene.getObjectByName(name);
        if (!obj) { return false; }
        var t = opts.resolveTarget(obj, obj);
        if (!t) { return false; }
        select(t);
        return true;
      },
      update: syncRing, // 매 프레임 — 카메라 이동 시 핸들 위치/크기 유지
    };
  }

  return { create: create };
})();
