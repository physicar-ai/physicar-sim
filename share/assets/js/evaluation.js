// Evaluation runner — /sim ▶
//
// 공리 계약 (WB evaluation.json v1):
//   관측  sim.state = { time, pose, objects, lights, run }  (전지적 3인칭 — 센서 없음)
//   개입  sim.teleport / sim.moveObject / sim.setLight / (run start·stop 은 러너 몫)
//   판정  sim.result(v) / sim.finish(v?) — 시간초과(sim time)=실격은 러너가 강제
// 불변식: 정지성(워치독)·전체성(finished|timeout|script_error 중 하나로 종결)·
//         단일성(verdict 1회)·폐쇄성(Worker 샌드박스, sim.* 외 경로 차단)
//
// 데이터 경로: pose·sim time = gz 웹소켓(자체 Topic 구독, 렌더 지터버퍼와 무관한
// 원본 샘플), lights·run = SSE(자체 EventSource, event: state/run). 관측이 도착할
// 때마다 evaluate 1회 (고정 주기 없음, 밀리면 최신으로 건너뜀).
(function () {
  'use strict';
  var API = '/sim/api';
  var VEHICLE_NAMES = ['physicar', 'racecar'];

  // ── 상태 ──
  var evalDoc = null;      // 현재 월드의 evaluation.json ({version, config, script})
  var availWorld = null;   // evalDoc 을 조회한 월드
  var simRunning = false;
  var run = null;          // 진행 중 평가 세션 (null = 없음)
  var robot = null;        // 이 sim 의 로봇 세대 — config.robot 불일치면 ▶ 자체를 숨김
  fetch(API + '/vehicle').then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (d) { robot = (d && d.generation) || 'physicar'; updateBtn(); })
    .catch(function () { robot = 'physicar'; updateBtn(); });

  // ── SSE (자체 연결) — 신호등·run 이벤트·월드 전환 감지 ──
  var lights = {};         // name -> 'red'|'green'|'yellow'
  var runProc = { running: false, exit_code: null };
  var es = new EventSource(API + '/events');
  es.addEventListener('state', function (ev) {
    var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    simRunning = !!d.running;
    var lt = {};
    (d.lights || []).forEach(function (l) {
      lt[l.name] = (l.yellow_left !== undefined && l.yellow_left > 0) ? 'yellow' : l.state;
    });
    lights = lt;
    if (d.current !== availWorld) { refreshAvail(d.current); }
    if (run && d.current !== run.world) { abort('script_error', 'World changed during evaluation'); }
    if (run && !d.running) { abort('script_error', 'Simulator stopped during evaluation'); }
    updateBtn();
  });
  es.addEventListener('run', function (ev) {
    var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.phase === 'start') { runProc = { running: true, exit_code: null }; }
    if (d.phase === 'exit') { runProc = { running: false, exit_code: d.exit_code }; }
    if (d.phase === 'log' && run) { pushLog(d.stream, d.line); }
  });

  // ── 오디오 관측 — 뷰어(gzweb)가 이미 /audio/events 를 구독·재생하며 상태를
  // _audioChannels(id→채널)에 유지한다. 중복 구독 대신 그 상태를 읽는다 —
  // 이벤트 장부가 아니라 "실제로 소리가 나는 중인가"가 기준이 된다.
  function audioPlaying() {
    var out = [], ch = window._audioChannels || {};
    for (var k in ch) {
      if (!ch.hasOwnProperty(k)) { continue; }
      var e = ch[k];
      var active = e.media
        ? (!e.media.paused && !e.media.ended)
        : ((e.sources && e.sources.length > 0) || (e.queue && e.queue.length > 0));
      if (!active) { continue; }
      // 파일 재생은 url 로 "무엇을" 재생 중인지 식별 가능, TTS/실시간은 pcm
      var item = { id: k, kind: e.media ? 'file' : 'pcm' };
      if (e.media && e.media.src) { item.url = e.media.src; }
      out.push(item);
    }
    return out;
  }

  function refreshAvail(world) {
    availWorld = world;
    evalDoc = null;
    updateBtn();
    if (!world) { return; }
    fetch(API + '/evaluation')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (availWorld === world) { evalDoc = d; updateBtn(); } })
      .catch(function () {});
  }

  // ── UI: ▶ 버튼 (respawn 옆) + 시작 카드 + 진행 HUD + 결과 카드 ──
  var css = '#eval-btn:disabled{opacity:.4}'
    + '.eval-card{position:absolute;top:56px;left:50%;transform:translateX(-50%);z-index:60;'
    + 'background:rgba(20,20,32,.94);color:#eee;border:1px solid #444;border-radius:8px;'
    + 'padding:14px 16px;min-width:280px;max-width:min(440px,92vw);font:13px/1.5 sans-serif}'
    + '.eval-card h4{margin:0 0 6px;font-size:14px}'
    + '.eval-card .ec-desc{color:#bbb;margin-bottom:8px}'
    + '.eval-card input{width:100%;box-sizing:border-box;background:#111;color:#eee;'
    + 'border:1px solid #555;border-radius:4px;padding:5px 7px;font:12px monospace}'
    + '.eval-card .ec-row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}'
    + '.eval-card button{background:#2a2a44;color:#eee;border:1px solid #555;border-radius:4px;'
    + 'padding:5px 14px;cursor:pointer}.eval-card button.primary{background:#4a3f8f}'
    + '.eval-hud{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:55;'
    + 'background:rgba(20,20,32,.88);color:#fff;border-radius:8px;padding:6px 16px;'
    + 'text-align:center;font:12px sans-serif;pointer-events:auto}'
    + '.eval-hud .eh-value{font:700 20px/1.2 monospace}'
    + '.eval-hud .eh-sub{color:#aaa}'
    + '.eval-log{max-height:60px;overflow:hidden;color:#8a8;text-align:left;'
    + 'font:10px/1.4 monospace;white-space:pre-wrap;word-break:break-all}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var btn = document.createElement('button');
  btn.id = 'eval-btn';
  btn.title = 'Evaluation';
  // Racing flag glyph — text glyph like the toolbar's other icons (gear,
  // respawn arrow), so it inherits the shared chip styling in gzweb.css
  btn.innerHTML = '<span class="eval-icon">&#x2691;</span>';
  btn.disabled = true;
  btn.addEventListener('click', openStartCard);
  function mountBtn() {
    var slot = document.getElementById('toolbar-left');
    if (slot) { slot.appendChild(btn); }
    else { setTimeout(mountBtn, 500); }
  }
  mountBtn();

  function updateBtn() {
    // 평가가 있고, 이 sim 의 로봇 세대와 맞을 때만 노출 (불일치 = 버튼 자체 없음)
    var cfgRobot = evalDoc && evalDoc.config && evalDoc.config.robot;
    var ok = !!evalDoc && (!cfgRobot || robot === null || cfgRobot === robot);
    btn.style.display = ok ? '' : 'none';
    btn.disabled = !ok || !simRunning || !!run;
  }

  var card = null;
  function closeCard() { if (card) { card.remove(); card = null; } }
  function openStartCard() {
    if (!evalDoc || run) { return; }
    closeCard();
    var cfg = evalDoc.config || {};
    card = document.createElement('div');
    card.className = 'eval-card';
    card.innerHTML = '<h4>Evaluation</h4>'
      + '<div class="ec-desc"></div>'
      + '<label style="font-size:11px;color:#999">Run command</label>'
      + '<input id="ec-cmd" spellcheck="false">'
      + '<div class="ec-row"><button id="ec-cancel">Cancel</button>'
      + '<button id="ec-start" class="primary">Start</button></div>';
    card.querySelector('.ec-desc').textContent = cfg.description || '';
    card.querySelector('#ec-cmd').value = cfg.run_command || 'python3 /home/physicar/physicar_ws/run.py';
    card.querySelector('#ec-cancel').addEventListener('click', closeCard);
    card.querySelector('#ec-start').addEventListener('click', function () {
      var cmd = card.querySelector('#ec-cmd').value.trim();
      closeCard();
      start(cmd);
    });
    document.body.appendChild(card);
  }

  var hud = null;
  function showHud() {
    if (hud) { hud.remove(); }
    hud = document.createElement('div');
    hud.className = 'eval-hud';
    hud.innerHTML = '<div class="eh-value">--</div><div class="eh-sub"></div>'
      + '<div class="eval-log"></div>'
      + '<button style="margin-top:4px;background:#5a2a2a;color:#eee;border:1px solid #855;'
      + 'border-radius:4px;padding:2px 10px;cursor:pointer">Stop</button>';
    hud.querySelector('button').addEventListener('click', function () {
      abort('stopped');
    });
    document.body.appendChild(hud);
  }
  function hudValue(v) {
    if (hud) { hud.querySelector('.eh-value').textContent = (v === null || v === undefined) ? '--' : (+v).toFixed(2); }
  }
  function hudSub(t) { if (hud) { hud.querySelector('.eh-sub').textContent = t; } }
  var logLines = [];
  function pushLog(stream, line) {
    logLines.push((stream === 'stderr' ? '! ' : '') + line);
    logLines = logLines.slice(-4);
    if (hud) { hud.querySelector('.eval-log').textContent = logLines.join('\n'); }
  }
  function showResult(outcome, value, reason) {
    if (hud) { hud.remove(); hud = null; }
    closeCard();
    card = document.createElement('div');
    card.className = 'eval-card';
    var head = outcome === 'finished' ? '✓ Finished'
      : outcome === 'timeout' ? '✕ Time limit exceeded (disqualified)'
      : outcome === 'stopped' ? 'Stopped'
      : outcome === 'unsupported' ? '✕ Robot not supported'
      : '⚠ Script error';
    card.innerHTML = '<h4></h4><div class="ec-desc"></div>'
      + '<div class="eh-value" style="font:700 22px monospace"></div>'
      + '<div class="ec-row"><button class="primary">Close</button></div>';
    card.querySelector('h4').textContent = head;
    card.querySelector('.ec-desc').textContent = reason || '';
    card.querySelector('.eh-value').textContent =
      (outcome === 'finished' && value !== null && value !== undefined) ? (+value).toFixed(2) : '';
    card.querySelector('button').addEventListener('click', closeCard);
    document.body.appendChild(card);
  }

  // ── Worker 하네스 — 교사 스크립트 앞에 붙는 샌드박스·sim 구현 ──
  // 폐쇄성: 밖으로 나가는 전역 제거. 관측은 obs 메시지로만, 개입은 action 으로만.
  // ── Worker 하네스 — 샌드박스 + 공리만. 정리(offTrack 등)는 스크립트가 자체 구현 ──
  // 관측: sim.state / sim.config / sim.track / sim.origins
  // 개입: teleport / moveObject / setLight / overlay   판정: result / finish
  var HARNESS = [
    'self.fetch=undefined;self.XMLHttpRequest=undefined;self.importScripts=undefined;',
    'self.WebSocket=undefined;self.EventSource=undefined;',
    'function __post(m){self.postMessage(m);}',
    'var sim={state:{time:null,pose:null,objects:{},lights:{},run:{},audio:{playing:[]}},',
    ' config:{},track:null,origins:{},',
    ' result:function(v){__post({t:"result",value:+v});},',
    ' finish:function(v){__post({t:"finish",value:(v===undefined?undefined:+v)});},',
    ' teleport:function(p){__post({t:"action",name:"teleport",args:p});},',
    ' moveObject:function(n,p){__post({t:"action",name:"moveObject",args:{name:n,pose:p||{}}});},',
    ' setLight:function(n,s){__post({t:"action",name:"setLight",args:{name:n,state:s}});},',
    ' overlay:function(tx){__post({t:"action",name:"overlay",args:{text:String(tx).slice(0,300)}});}',
    '};',
    'self.onmessage=function(e){var m=e.data;try{',
    ' if(m.t==="boot"){sim.config=m.config;sim.track=m.route;sim.origins=m.origins;__post({t:"ack"});}',
    ' else if(m.t==="initialize"){',
    '  if(typeof initialize==="function"){initialize(sim);}',
    '  __post({t:"phase",phase:"initialized"});}',
    ' else if(m.t==="obs"){sim.state=m.o;evaluate(sim);__post({t:"ack"});}',
    '}catch(err){__post({t:"error",message:String(err&&err.message||err)});}};',
    ''
  ].join('\n');

  // ── 세션 ──
  function start(cmd) {
    if (run || !evalDoc) { return; }
    var cfg = evalDoc.config || {};
    var world = availWorld;
    run = { world: world, cmd: cmd, worker: null, t0: null, simTime: null,
            lastPose: null, lastPoseTime: null, speed: 0, poses: {}, value: null,
            ackPending: false, pendingObs: null, lastAck: Date.now(), done: false };
    logLines = [];
    showHud();
    hudSub((cfg.description || '') + ' — initializing');
    updateBtn();

    Promise.all([
      fetch(API + '/world').then(function (r) {
        if (!r.ok) { throw new Error('world info unavailable'); }
        return r.json();
      }),
      fetch(API + '/vehicle').then(function (r) { return r.ok ? r.json() : {}; })
    ]).then(function (res) {
      var wd = res[0];
      // 로봇 정체성 — 결과에 각인. config.robot 불일치는 버튼 숨김이 1차 방어,
      // 여기는 벨트 (숨김 전 클릭 등 레이스 대비)
      run.robot = (res[1] && res[1].generation) || 'physicar';
      if (cfg.robot && cfg.robot !== run.robot) {
        var re = new Error('This evaluation is for ' + cfg.robot + ' — current robot: ' + run.robot);
        re.unsupported = true;
        throw re;
      }
      if (!wd.track || !wd.track.route || !wd.track.route.waypoints) {
        throw new Error('world has no route');
      }
      run.route = wd.track.route;
      var origins = {};
      Object.keys(wd.objects || {}).forEach(function (n) {
        var o = wd.objects[n];
        if (o && o.movable && o.origin) { origins[n] = o.origin; }
      });
      // Worker 부팅 (하네스 + 교사 스크립트)
      var blob = new Blob([HARNESS + '\n' + evalDoc.script], { type: 'text/javascript' });
      var w = new Worker(URL.createObjectURL(blob));
      run.worker = w;
      w.onerror = function (e) { abort('script_error', e.message || 'worker error'); };
      w.onmessage = onWorkerMsg;
      w.postMessage({ t: 'boot', config: cfg, route: run.route, origins: origins });
      // 러너 기본 초기화 — 물체 원위치 + 차량을 출발선에 (respawn 없이)
      var resets = Object.keys(origins).map(function (n) {
        var o = origins[n];
        return post('/models/' + encodeURIComponent(n) + '/pose', { x: o.x, y: o.y, yaw: o.yaw });
      });
      var wp = run.route.waypoints;
      var yaw0 = Math.atan2(wp[1][1] - wp[0][1], wp[1][0] - wp[0][0]);
      // 출발선(웨이포인트 0)보다 뒤에 배치 — 선 위에서 시작하면 첫 통과 감지가
      // 지터에 따라 "즉시 시작/미감지"로 갈리는 비결정 버그가 생긴다. 뒤에서
      // 출발해 차량 중심이 선을 넘는 순간이 곧 타이머 시작(통과 감지)이 된다.
      var BACK = 0.35;   // m — 차체(~0.2m)가 선에 걸치지 않는 여유
      resets.push(post('/pose', { x: wp[0][0] - Math.cos(yaw0) * BACK,
                                  y: wp[0][1] - Math.sin(yaw0) * BACK, yaw: yaw0 }));
      return Promise.all(resets);
    }).then(function () {
      if (!run) { return; }
      run.worker.postMessage({ t: 'initialize' });   // 교사 initialize → phase 응답에서 계속
    }).catch(function (e) {
      abort(e && e.unsupported ? 'unsupported' : 'script_error', (e && e.message) || 'start failed');
    });
  }

  function onWorkerMsg(e) {
    if (!run || run.done) { return; }
    var m = e.data;
    run.lastAck = Date.now();
    if (m.t === 'phase' && m.phase === 'initialized') {
      hudSub('starting...');
      post('/evaluation/run', { command: run.cmd || undefined }).then(function () {
        beginObservation();
      }).catch(function (err) {
        abort('script_error', 'run command failed: ' + ((err && err.message) || err));
      });
    } else if (m.t === 'ack') {
      run.ackPending = false;
      if (run.pendingObs) { sendObs(run.pendingObs); run.pendingObs = null; }
    } else if (m.t === 'result') {
      if (isFinite(m.value)) { run.value = m.value; hudValue(m.value); }
    } else if (m.t === 'finish') {
      settle('finished', (m.value !== undefined && isFinite(m.value)) ? m.value : run.value);
    } else if (m.t === 'error') {
      abort('script_error', m.message);
    } else if (m.t === 'action') {
      doAction(m.name, m.args);
    }
  }

  var actionCount = 0, actionWin = Date.now();
  function doAction(name, args) {
    var now = Date.now();
    if (now - actionWin > 1000) { actionWin = now; actionCount = 0; }
    if (++actionCount > 10) { return; }   // 개입 rate cap — 폭주 스크립트 방어
    if (name === 'teleport') { post('/pose', { x: args.x, y: args.y, yaw: args.yaw }); }
    else if (name === 'moveObject') {
      post('/models/' + encodeURIComponent(args.name) + '/pose', args.pose);
    } else if (name === 'setLight') {
      post('/traffic_lights/' + encodeURIComponent(args.name), { state: args.state });
    } else if (name === 'overlay') { post('/overlay', { text: args.text, ttl: 10 }); }
  }

  // gz.js Topic 은 unsubscribe 가 없다 — (월드·토픽)당 1회만 구독하고 캐시.
  // 콜백은 전역 run 세션을 게이트하므로 세션이 끝나면 자연히 무시된다.
  var _topics = {};
  function subscribeOnce(name, messageType, callback) {
    if (_topics[name]) { return; }
    _topics[name] = new Topic({ gz: gz, name: name, messageType: messageType, callback: callback });
  }

  function beginObservation() {
    if (!run || run.done) { return; }
    hudSub(((evalDoc.config || {}).description || ''));
    // gz 웹소켓 원본 구독 — 렌더 파이프라인과 독립 (지연 재생 안 탐)
    if (typeof Topic !== 'function' || !window.gz || !gz.socket || gz.socket.readyState !== 1) {
      abort('script_error', 'sim connection unavailable');
      return;
    }
    subscribeOnce('/world/' + run.world + '/stats', 'gz.msgs.WorldStatistics',
      function (msg) {
        if (!run || run.done) { return; }
        var t = (msg.sim_time ? (+msg.sim_time.sec || 0) + (+msg.sim_time.nsec || 0) / 1e9 : null);
        if (t === null) { return; }
        run.simTime = t;
        if (run.t0 === null) { run.t0 = t; }
        // 시간초과 = 실격 (sim time 기준 — 러너가 강제, 스크립트와 무관)
        var limit = (evalDoc.config || {}).time_limit_s || 180;
        if (t - run.t0 > limit) { settle('timeout', run.value); }
      });
    subscribeOnce('/world/' + run.world + '/dynamic_pose/info', 'gz.msgs.Pose_V',
      function (msg) {
        if (!run || run.done) { return; }
        for (var i = 0; i < (msg.pose || []).length; i++) {
          var p = msg.pose[i];
          var yaw = 0;
          if (p.orientation) {
            var q = p.orientation;
            yaw = Math.atan2(2 * ((q.w || 0) * (q.z || 0) + (q.x || 0) * (q.y || 0)),
                             1 - 2 * ((q.y || 0) * (q.y || 0) + (q.z || 0) * (q.z || 0)));
          }
          run.poses[p.name] = { x: p.position ? +p.position.x || 0 : 0,
                                y: p.position ? +p.position.y || 0 : 0,
                                z: p.position ? +p.position.z || 0 : 0, yaw: yaw };
        }
        assembleObs();
      });
    // 워치독 — evaluate 가 예산 내에 돌아오지 않으면(무한루프 포함) 강제 종료
    run.watchdog = setInterval(function () {
      if (!run || run.done) { return; }
      if (run.ackPending && Date.now() - run.lastAck > 2000) {
        abort('script_error', 'evaluate() did not return (2s budget)');
      }
    }, 500);
  }

  function assembleObs() {
    var vp = null;
    for (var i = 0; i < VEHICLE_NAMES.length && !vp; i++) { vp = run.poses[VEHICLE_NAMES[i]]; }
    if (!vp || run.simTime === null) { return; }
    // speed — sim 시간축 미분 (paused 면 dt=0 → 유지)
    if (run.lastPose && run.lastPoseTime !== null && run.simTime > run.lastPoseTime) {
      var d = Math.hypot(vp.x - run.lastPose.x, vp.y - run.lastPose.y);
      run.speed = d / (run.simTime - run.lastPoseTime);
    }
    run.lastPose = vp; run.lastPoseTime = run.simTime;
    var objects = {};
    Object.keys(run.poses).forEach(function (n) {
      if (VEHICLE_NAMES.indexOf(n) < 0) { objects[n] = run.poses[n]; }
    });
    var obs = { time: run.simTime,
                pose: { x: vp.x, y: vp.y, z: vp.z, yaw: vp.yaw, speed: run.speed },
                objects: objects, lights: lights, run: runProc,
                audio: { playing: audioPlaying() } };
    if (run.ackPending) { run.pendingObs = obs; return; }   // 밀리면 최신으로 대체
    sendObs(obs);
  }
  function sendObs(obs) {
    run.ackPending = true;
    run.worker.postMessage({ t: 'obs', o: obs });
  }

  // ── 종결 (전체성·단일성) ──
  function cleanup() {
    if (run.watchdog) { clearInterval(run.watchdog); }
    if (run.worker) { try { run.worker.terminate(); } catch (e) {} }
    fetch(API + '/evaluation/stop', { method: 'POST' }).catch(function () {});
    run.done = true;
    run = null;
    updateBtn();
  }
  function settle(outcome, value) {
    if (!run || run.done) { return; }
    var v = value;
    cleanup();
    showResult(outcome, v);
  }
  function abort(outcome, reason) {
    if (!run || run.done) { return; }
    cleanup();
    if (outcome === 'stopped') { if (hud) { hud.remove(); hud = null; } closeCard(); }
    else { showResult(outcome, null, reason); }
  }

  function post(path, body) {
    return fetch(API + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}) })
      .then(function (r) {
        if (!r.ok) { return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d.error || ('HTTP ' + r.status)); }); }
        return r.json().catch(function () { return {}; });
      });
  }
})();
