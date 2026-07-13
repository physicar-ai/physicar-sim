/*
 * gz-scene.js — Gazebo 씬/모델 메시지 → three.js 오브젝트 변환의 단일 소스.
 *
 * physicar-sim 웹 뷰어와 physicar.ai Custom World Builder 뷰포트가 이 파일을
 * 공유한다. 원본은 여기(physicar-sim)이고, 사이트 쪽 사본은
 * physicar-ai-site/docs/assets/javascripts/gz-scene.js 이다 (사본 수정 금지).
 * "빌더에서 보이는 것 = sim 뷰어가 그리는 것"을 코드 수준에서 보장하는 장치.
 *
 * three.js 버전 중립: r86(sim의 gz3d.js 번들)과 r12x(사이트) 모두에서 동작.
 * 지오메트리/머티리얼/포즈 시맨틱은 GZ3D.Scene(r86)의 동작을 그대로 옮겼다.
 */
var GzScene = (function() {
  'use strict';

  function create(opts) {
    var THREE = opts.THREE;
    var meshUrl = opts.meshUrl;   // (uri) -> collada URL, falsy면 해당 mesh 스킵
    var loadMesh = opts.loadMesh; // (url, onLoad(Object3D), onError)
    var isPhysicarMesh = opts.isPhysicarMesh || function() { return false; };

    var simpleMat = new THREE.MeshPhongMaterial({ color: 0xffffff });
    var textureLoader = new THREE.TextureLoader();

    function setPose(obj, position, orientation) {
      obj.position.x = position.x;
      obj.position.y = position.y;
      obj.position.z = position.z;
      obj.quaternion.w = orientation.w;
      obj.quaternion.x = orientation.x;
      obj.quaternion.y = orientation.y;
      obj.quaternion.z = orientation.z;
    }

    function createBox(width, height, depth) {
      var geometry = new THREE.BoxGeometry(width, height, depth, 1, 1, 1);
      // 레거시 UV 보정(GZ3D): 텍스처가 가제보와 같은 방향으로 감기게 일부 면 UV 회전.
      // r86 Geometry에만 존재하는 faceVertexUvs 경로 — r12x(BufferGeometry)에서는
      // 프리미티브 박스에 texture를 입히는 경로 자체가 없어 생략해도 동작 동일.
      if (geometry.faceVertexUvs) {
        geometry.dynamic = true;
        var faceUVFixA = [1, 4, 5];
        var faceUVFixB = [0];
        for (var i = 0; i < faceUVFixA.length; ++i) {
          var idx = faceUVFixA[i] * 2;
          var uva = geometry.faceVertexUvs[0][idx][0];
          geometry.faceVertexUvs[0][idx][0] = geometry.faceVertexUvs[0][idx][1];
          geometry.faceVertexUvs[0][idx][1] = geometry.faceVertexUvs[0][idx + 1][1];
          geometry.faceVertexUvs[0][idx][2] = uva;
          geometry.faceVertexUvs[0][idx + 1][0] = geometry.faceVertexUvs[0][idx + 1][1];
          geometry.faceVertexUvs[0][idx + 1][1] = geometry.faceVertexUvs[0][idx + 1][2];
          geometry.faceVertexUvs[0][idx + 1][2] = geometry.faceVertexUvs[0][idx][2];
        }
        for (var ii = 0; ii < faceUVFixB.length; ++ii) {
          var idxB = faceUVFixB[ii] * 2;
          var uvc = geometry.faceVertexUvs[0][idxB][0];
          geometry.faceVertexUvs[0][idxB][0] = geometry.faceVertexUvs[0][idxB][2];
          geometry.faceVertexUvs[0][idxB][1] = uvc;
          geometry.faceVertexUvs[0][idxB][2] = geometry.faceVertexUvs[0][idxB + 1][1];
          geometry.faceVertexUvs[0][idxB + 1][2] = geometry.faceVertexUvs[0][idxB][2];
          geometry.faceVertexUvs[0][idxB + 1][1] = geometry.faceVertexUvs[0][idxB + 1][0];
          geometry.faceVertexUvs[0][idxB + 1][0] = geometry.faceVertexUvs[0][idxB][1];
        }
        geometry.uvsNeedUpdate = true;
      }
      var mesh = new THREE.Mesh(geometry, simpleMat);
      mesh.castShadow = true;
      return mesh;
    }

    function createCylinder(radius, length) {
      var geometry = new THREE.CylinderGeometry(radius, radius, length, 32, 1, false);
      var mesh = new THREE.Mesh(geometry, simpleMat);
      mesh.rotation.x = Math.PI * 0.5; // three 실린더는 Y축 → 가제보 Z축 정렬
      return mesh;
    }

    function createSphere(radius) {
      var geometry = new THREE.SphereGeometry(radius, 32, 32);
      return new THREE.Mesh(geometry, simpleMat);
    }

    function createPlane(normalX, normalY, normalZ, width, height) {
      var geometry = new THREE.PlaneGeometry(width, height, 1, 1);
      var mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial());
      // three 평면 기본 법선 +Z → 요청 법선으로 회전 (지면 (0,0,1)이면 항등)
      var normal = new THREE.Vector3(normalX, normalY, normalZ).normalize();
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      mesh.name = 'plane';
      mesh.receiveShadow = true;
      return mesh;
    }

    function parseMaterial(m) {
      if (!m) { return null; }
      var a, d, s;
      if (m.ambient) { a = [m.ambient.r, m.ambient.g, m.ambient.b, m.ambient.a]; }
      if (m.diffuse) { d = [m.diffuse.r, m.diffuse.g, m.diffuse.b, m.diffuse.a]; }
      if (m.specular) { s = [m.specular.r, m.specular.g, m.specular.b, m.specular.a]; }
      var e;
      if (m.emissive) { e = [m.emissive.r, m.emissive.g, m.emissive.b, m.emissive.a]; }
      return { ambient: a, diffuse: d, specular: s, emissive: e };
    }

    function setMaterial(obj, material) {
      if (!obj || !material) { return; }
      obj.material = new THREE.MeshPhongMaterial();
      var ambient = material.ambient;
      var diffuse = material.diffuse;
      if (diffuse) {
        // three가 phong에서 ambient를 없앤 것을 GZ3D와 동일하게 근사: 0.4a + 0.6d
        var dc = [diffuse[0], diffuse[1], diffuse[2]];
        if (ambient) {
          dc[0] = ambient[0] * 0.4 + diffuse[0] * 0.6;
          dc[1] = ambient[1] * 0.4 + diffuse[1] * 0.6;
          dc[2] = ambient[2] * 0.4 + diffuse[2] * 0.6;
        }
        obj.material.color.setRGB(dc[0], dc[1], dc[2]);
      }
      var specular = material.specular;
      if (specular) {
        obj.material.specular.setRGB(specular[0], specular[1], specular[2]);
      }
      var emissive = material.emissive;
      if (emissive) { // 발광(신호등 램프 등) — 조명과 무관하게 밝게
        obj.material.emissive.setRGB(emissive[0], emissive[1], emissive[2]);
      }
      var opacity = material.opacity;
      if (opacity && opacity < 1) {
        obj.material.transparent = true;
        obj.material.opacity = opacity;
      }
      if (material.texture) {
        var texture = textureLoader.load(material.texture);
        if (material.scale) {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.x = 1.0 / material.scale[0];
          texture.repeat.y = 1.0 / material.scale[1];
        }
        obj.material.map = texture;
      }
    }

    function createGeom(g, material, parent) {
      var obj, mat = parseMaterial(material);
      if (g.mesh) {
        var uri = g.mesh.filename || '';
        var url = meshUrl(uri);
        if (url) {
          loadMesh(url, function(m) {
            if (g.mesh.scale) { m.scale.set(g.mesh.scale.x, g.mesh.scale.y, g.mesh.scale.z); }
            if (isPhysicarMesh(uri)) {
              // physicar 차량: 윤곽선 오버레이
              m.traverse(function(child) {
                if (child instanceof THREE.Mesh && child.geometry) {
                  var edges = new THREE.EdgesGeometry(child.geometry, 20);
                  var c = child.material && child.material.color;
                  var lc = (c && c.r < 0.2 && c.g < 0.2 && c.b < 0.2) ? 0x555555 : 0x222222;
                  child.add(new THREE.LineSegments(edges,
                    new THREE.LineBasicMaterial({ color: lc })));
                }
              });
            } else {
              // 그 외 모델: 매트 처리 (스펙큘러 광 제거)
              m.traverse(function(child) {
                if (child instanceof THREE.Mesh && child.material) {
                  if (child.material.specular) { child.material.specular.setRGB(0, 0, 0); }
                  if (child.material.shininess !== undefined) { child.material.shininess = 0; }
                }
              });
            }
            parent.add(m);
          }, function() {
            parent.add(createBox(0.03, 0.03, 0.03)); // 로드 실패 폴백
          });
        }
        return;
      }
      if (g.box) { obj = createBox(g.box.size.x, g.box.size.y, g.box.size.z); }
      else if (g.cylinder) { obj = createCylinder(g.cylinder.radius, g.cylinder.length); }
      else if (g.sphere) { obj = createSphere(g.sphere.radius); }
      else if (g.plane) { obj = createPlane(g.plane.normal.x, g.plane.normal.y, g.plane.normal.z, g.plane.size.x, g.plane.size.y); }
      if (obj) {
        if (mat) { setMaterial(obj, mat); }
        obj.updateMatrix();
        parent.add(obj);
      }
    }

    function createVisualFromMsg(visual) {
      if (!visual.geometry) { return; }
      var vo = new THREE.Object3D();
      vo.name = visual.name;
      if (visual.pose) { setPose(vo, visual.pose.position, visual.pose.orientation); }
      createGeom(visual.geometry, visual.material, vo);
      return vo;
    }

    function createModelFromMsg(model) {
      var obj = new THREE.Object3D();
      obj.name = model.name;
      obj.userData.id = model.id;
      if (model.pose) { setPose(obj, model.pose.position, model.pose.orientation); }
      for (var j = 0; j < model.link.length; ++j) {
        var link = model.link[j], lo = new THREE.Object3D();
        lo.name = link.name;
        lo.userData.id = link.id;
        if (link.pose) { setPose(lo, link.pose.position, link.pose.orientation); }
        obj.add(lo);
        for (var k = 0; k < link.visual.length; ++k) {
          var v = createVisualFromMsg(link.visual[k]);
          if (v && !v.parent) { lo.add(v); }
        }
      }
      if (model.joint) { obj.joint = model.joint; }
      return obj;
    }

    return {
      setPose: setPose,
      createBox: createBox,
      createCylinder: createCylinder,
      createSphere: createSphere,
      createPlane: createPlane,
      parseMaterial: parseMaterial,
      setMaterial: setMaterial,
      createGeom: createGeom,
      createVisualFromMsg: createVisualFromMsg,
      createModelFromMsg: createModelFromMsg
    };
  }

  return { create: create };
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = GzScene; }
