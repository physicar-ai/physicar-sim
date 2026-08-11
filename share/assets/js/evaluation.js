// Evaluation runner — /sim ▶
//
// 공리 계약 (WB evaluation.json v1):
//   관측  sim.state = { time, pose, objects, lights, run }  (전지적 3인칭 — 센서 없음)
//   개입  sim.teleport / sim.moveObject / sim.setLight / sim.overlay — 러너가
//         sim_api 로 릴레이하며, 포즈 API 는 적용 확인 후 응답 (완료 보장)
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

  // Run ownership id — sent with the SSE connection AND /evaluation/run.
  // The server binds the run to this SSE stream: the moment the stream dies
  // (tab closed mid-evaluation) the orphaned student process is killed
  // server-side. No polling, no heartbeat — the stream itself is the signal.
  var CID = 'w' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // ── Terminal mode — run the command in a REAL VSCode terminal ──
  // Preferred when embedded under the extension (app.html relays these
  // messages up to it): the user watches the logs where they always run
  // their code, and shell integration reports the exit code back. Falls
  // back to the sim server's background spawn (SSE-owned) when there is
  // no extension / no shell integration / a plain browser tab.
  var _evalAckWait = null;
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'physicar-eval-ack') {
      if (_evalAckWait) { _evalAckWait(true); _evalAckWait = null; }
    } else if (m.type === 'physicar-eval-unavailable') {
      if (_evalAckWait) { _evalAckWait(false); _evalAckWait = null; }
    } else if (m.type === 'physicar-eval-busy') {
      if (_evalAckWait) { _evalAckWait('busy'); _evalAckWait = null; }
    } else if (m.type === 'physicar-eval-exit') {
      if (!run || !run.terminalMode) { return; }
      runProc = { running: false, exit_code: m.code };
      // Same fail-fast contract as the server-spawn exit event: an error
      // exit can never finish the lap. Clean exit (0/null) keeps observing.
      if (m.code !== null && m.code !== undefined && m.code !== 0) {
        abort('script_error', 'Run command exited with code ' + m.code +
              ' (see the Evaluation terminal)');
      }
    }
  });
  function requestTerminalRun(cmd) {
    return new Promise(function (resolve) {
      if (window.parent === window) { resolve(false); return; }   // plain tab
      var done = false;
      var to = setTimeout(function () {
        if (!done) { done = true; _evalAckWait = null; resolve(false); }
      }, 1500);
      _evalAckWait = function (ok) {
        if (!done) { done = true; clearTimeout(to); resolve(ok); }
      };
      try { window.parent.postMessage({ type: 'physicar-eval-run', command: cmd }, '*'); }
      catch (e) { clearTimeout(to); done = true; _evalAckWait = null; resolve(false); }
    });
  }

  // ── SSE (자체 연결) — 신호등·run 이벤트·월드 전환 감지 ──
  var lights = {};         // name -> 'red'|'green'|'yellow'
  var runProc = { running: false, exit_code: null };
  var es = new EventSource(API + '/events?cid=' + CID);
  es.addEventListener('state', function (ev) {
    var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    simRunning = !!d.running;
    var lt = {};
    (d.lights || []).forEach(function (l) {
      lt[l.name] = (l.yellow_left !== undefined && l.yellow_left > 0) ? 'yellow' : l.state;
    });
    lights = lt;
    // World replacement in progress (switch OR same-world reload — both pass
    // through the server's switching flag): the edited run command belongs to
    // the world instance that is going away, so fall back to the evaluation's
    // default. A pose-only Reset never sets this flag and keeps the override.
    if (d.switching) {
      _cmdOverride = null;
      // A start card left open would resurrect the stale command on Start —
      // close it (result cards have no #ec-cmd and stay).
      if (card && card.querySelector('#ec-cmd')) { closeCard(); }
    }
    if (d.current !== availWorld) { refreshAvail(d.current); }
    if (run && d.current !== run.world) { abort('script_error', 'World changed during evaluation'); }
    if (run && !d.running) { abort('script_error', 'Simulator stopped during evaluation'); }
    updateBtn();
  });
  es.addEventListener('run', function (ev) {
    var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.phase === 'start') { runProc = { running: true, exit_code: null }; }
    if (d.phase === 'exit') {
      runProc = { running: false, exit_code: d.exit_code };
      // An error exit (missing file, crash, non-zero code) can never finish
      // the lap — fail the evaluation right away instead of idling with the
      // HUD until the time limit. A clean exit (0) keeps observing: the car
      // may still be rolling across the finish line. (A Stop-button kill
      // clears `run` before this event lands, so it stays a no-op there.
      // Terminal-mode runs get their exit from the extension instead.)
      if (run && !run.terminalMode && d.exit_code !== null && d.exit_code !== 0) {
        abort('script_error', 'Run command exited with code ' + d.exit_code);
      }
    }
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
      .catch(function () {
        // Network failure (server mid-restart 등) — availWorld 를 비워두면
        // 다음 SSE state 틱이 world 불일치로 재조회를 트리거한다. 이게 없으면
        // 한 번의 실패로 evalDoc 이 영영 null — 평가 버튼이 조용히 사라진다.
        if (availWorld === world) { availWorld = null; }
      });
  }

  // ── UI: ▶ 버튼 (respawn 옆) + 시작 카드 + 진행 HUD + 결과 카드 ──
  // Bottom-anchored: the run HUD and the cards must not cover the road
  // ahead (the camera looks forward/up) — the lower edge is the least
  // intrusive spot. Sits above #gz-toast's transient zone.
  var css = '#eval-btn:disabled{opacity:.4}'
    + '.eval-card{position:absolute;bottom:56px;left:50%;transform:translateX(-50%);z-index:60;'
    + 'background:rgba(20,20,32,.94);color:#eee;border:1px solid #444;border-radius:8px;'
    + 'padding:14px 16px;min-width:min(480px,90vw);max-width:min(680px,92vw);font:13px/1.5 sans-serif}'
    + '.eval-card h4{margin:0 0 6px;font-size:14px}'
    + '.eval-card .ec-desc{color:#bbb;margin-bottom:8px;font-size:11px;white-space:pre-wrap}'
    + '.eval-card textarea{width:100%;box-sizing:border-box;background:#111;color:#eee;'
    + 'border:1px solid #555;border-radius:4px;padding:5px 7px;font:11px/1.3 monospace;'
    + 'resize:vertical;min-height:44px;white-space:pre-wrap;word-break:break-all}'
    + '.eval-card .ec-row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}'
    + '.eval-card button{background:#2a2a44;color:#eee;border:1px solid #555;border-radius:4px;'
    + 'padding:5px 14px;cursor:pointer}.eval-card button.primary{background:#4a3f8f}'
    + '.eval-hud{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);z-index:55;'
    + 'background:rgba(20,20,32,.88);color:#fff;border-radius:8px;padding:6px 20px;'
    + 'min-width:min(560px,90vw);max-width:92vw;box-sizing:border-box;'
    + 'text-align:center;font:12px sans-serif;pointer-events:auto}'
    + '.eval-hud .eh-value{font:700 20px/1.2 monospace}'
    + '.eval-hud .eh-sub{color:#aaa;font-family:monospace;font-size:10px;word-break:break-all}'
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
  var _cmdOverride = null;   // edited run command — page lifetime, cleared on world switch/reload
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
      + '<textarea id="ec-cmd" rows="2" spellcheck="false"></textarea>'
      + '<div class="ec-row"><button id="ec-cancel">Cancel</button>'
      + '<button id="ec-start" class="primary">Start</button></div>';
    card.querySelector('.ec-desc').textContent = cfg.description || '';
    // Run command: the evaluation's default first; an edited value sticks for
    // THIS page load only (plain variable — a fresh /sim starts clean again).
    card.querySelector('#ec-cmd').value =
      _cmdOverride || cfg.run_command || 'cd /home/physicar/physicar_ws/ && python3 -u run.py';
    card.querySelector('#ec-cancel').addEventListener('click', closeCard);
    card.querySelector('#ec-start').addEventListener('click', function () {
      var cmd = card.querySelector('#ec-cmd').value.trim();
      _cmdOverride = cmd;
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
    // Keep a deeper tail than the HUD shows — the failure result card
    // replays it so error tracebacks stay readable after the HUD is gone.
    logLines = logLines.slice(-12);
    if (hud) { hud.querySelector('.eval-log').textContent = logLines.slice(-4).join('\n'); }
  }
  function showResult(outcome, value, reason) {
    if (hud) { hud.remove(); hud = null; }
    closeCard();
    card = document.createElement('div');
    card.className = 'eval-card';
    var failed = outcome !== 'finished' && outcome !== 'stopped';
    var head = outcome === 'finished' ? '✓ Finished'
      : outcome === 'timeout' ? '✕ Time limit exceeded (disqualified)'
      : outcome === 'stopped' ? 'Stopped'
      : outcome === 'unsupported' ? '✕ Robot not supported'
      : '⚠ Script error';
    card.innerHTML = '<h4></h4><div class="ec-desc"></div>'
      + '<div class="ec-log" style="display:none;color:#e88;font:10px/1.4 monospace;'
      + 'white-space:pre-wrap;word-break:break-all;max-height:110px;overflow-y:auto;'
      + 'background:#111;border:1px solid #533;border-radius:4px;padding:5px 7px;margin-top:6px"></div>'
      + '<div class="eh-value" style="font:700 22px monospace"></div>'
      + '<div class="ec-row"><button class="primary">Close</button></div>';
    card.querySelector('h4').textContent = head;
    if (failed) { card.querySelector('h4').style.color = '#f87171'; }
    card.querySelector('.ec-desc').textContent = reason || '';
    // Failure: the HUD (and its log tail) is gone by now — carry the last
    // process output into the card so the actual error text stays readable.
    if (failed && logLines.length) {
      var lg = card.querySelector('.ec-log');
      lg.textContent = logLines.join('\n');
      lg.style.display = '';
    }
    card.querySelector('.eh-value').textContent =
      (outcome === 'finished' && value !== null && value !== undefined) ? (+value).toFixed(2) : '';
    card.querySelector('button').addEventListener('click', closeCard);
    document.body.appendChild(card);
  }

  // ── Worker 하네스 — 교사 스크립트 앞에 붙는 프렐류드 ──
  // 관측: sim.state / sim.config / sim.track / sim.origins (obs 메시지 푸시)
  // 개입: teleport / moveObject / setLight / overlay (러너가 sim_api 릴레이)
  // 판정: result / finish   정리(offTrack 등)는 스크립트가 자체 구현
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
    // Default prep — used ONLY when the script defines no initialize():
    // everything to its origin — obstacles to their published origins, the
    // car to its spawn point (waypoint 0, facing the route). Anything more
    // opinionated (e.g. a lap timer parking the car BEHIND the start line)
    // is rule-specific and belongs in the individual evaluation script.
    'function __defaultInit(s){',
    ' for(var n in s.origins){s.moveObject(n,s.origins[n]);}',
    ' var wp=s.track.waypoints;',
    ' var yaw=Math.atan2(wp[1][1]-wp[0][1],wp[1][0]-wp[0][0]);',
    ' s.teleport({x:wp[0][0],y:wp[0][1],yaw:yaw});',
    '}',
    'self.onmessage=function(e){var m=e.data;try{',
    ' if(m.t==="boot"){sim.config=m.config;sim.track=m.route;sim.origins=m.origins;__post({t:"ack"});}',
    ' else if(m.t==="initialize"){',
    // The script's initialize() is the SOLE pre-start preparation when it
    // exists. Sync or async — the runner proceeds only after its promise
    // settles (its actions are then drained by the barrier).
    '  Promise.resolve((typeof initialize==="function"?initialize:__defaultInit)(sim))',
    '   .then(function(){__post({t:"phase",phase:"initialized"});})',
    '   .catch(function(err){__post({t:"error",message:String(err&&err.message||err)});});}',
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
            ackPending: false, pendingObs: null, lastAck: Date.now(), done: false,
            observing: false };
    logLines = [];
    pendingActs.length = 0;
    showHud();
    // HUD shows the run command (its output streams in right below) — the
    // rule description already had its moment on the start card.
    // HUD stays minimal: the big value + Stop. Short phase text only while
    // preparing (cleared once observation starts); the command and its
    // output live in the Evaluation terminal.
    hudSub('initializing...');
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
      // 시작 전 준비는 전부 스크립트 initialize()의 몫이다 — 러너는 아무것도
      // 몰래 하지 않는다. 스크립트가 initialize 를 정의하지 않았을 때만 워커
      // 프렐류드의 기본 준비(__defaultInit: 물체 원위치 + 차량 출발선 뒤)가 돈다.
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
      // Barrier: drain initialize()'s relayed actions. The pose endpoints
      // respond only after gz confirms the pose landed (completion semantics
      // live in the API), so resolved acks mean the car and the objects are
      // physically in place — no settle guessing needed.
      var acts = pendingActs.slice();
      pendingActs.length = 0;
      Promise.all(acts).then(function () {
        if (!run || run.done) { return; }
        return requestTerminalRun(run.cmd).then(function (ok) {
          if (!run || run.done) { return; }
          if (ok === 'busy') { throw new Error('already running (Evaluation terminal)'); }
          if (ok) {
            run.terminalMode = true;
            beginObservation();
            return;
          }
          // cid binds the run to OUR SSE stream — the server rejects this with
          // "already running" only when another live browser owns a run, and
          // supersedes orphaned/ownerless ones by itself.
          return post('/evaluation/run', { command: run.cmd || undefined, cid: CID }).then(function () {
            beginObservation();
          });
        });
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
  // In-flight action POSTs — the initialized barrier drains this so the run
  // never starts while initialize()'s teleports are still traveling. The
  // pose endpoints confirm application before responding, so a resolved
  // entry means the entity is physically in place.
  var pendingActs = [];
  function doAction(name, args) {
    var now = Date.now();
    if (now - actionWin > 1000) { actionWin = now; actionCount = 0; }
    if (++actionCount > 10) { return; }   // 개입 rate cap — 폭주 스크립트 방어
    var p = null;
    if (name === 'teleport') { p = post('/pose', { x: args.x, y: args.y, yaw: args.yaw }); }
    else if (name === 'moveObject') {
      p = post('/models/' + encodeURIComponent(args.name) + '/pose', args.pose);
    } else if (name === 'setLight') {
      p = post('/traffic_lights/' + encodeURIComponent(args.name), { state: args.state });
    } else if (name === 'overlay') { p = post('/overlay', { text: args.text, ttl: 10 }); }
    // Track only pre-observation actions (initialize phase) — the barrier is
    // the sole consumer; mid-run actions are covered by script-side latches.
    if (p && run && !run.observing) { pendingActs.push(p.catch(function () {})); }
  }

  // gz.js Topic 은 unsubscribe 가 없다 — (월드·토픽)당 1회만 구독하고 캐시.
  // 콜백은 전역 run 세션을 게이트하므로 세션이 끝나면 자연히 무시된다.
  var _topics = {};
  function subscribeOnce(name, messageType, callback) {
    // Cache per topic AND per gz connection: a respawn/world switch replaces
    // the gz websocket with a NEW instance, and a subscription made on the
    // old (dead) socket never delivers again. Without the instance check the
    // stale cache silently starved the evaluation of observations — the lap
    // timer never started after any respawn. (Topic has no unsubscribe; the
    // dead socket's entry is simply abandoned.)
    var cur = _topics[name];
    if (cur && cur.gzInstance === window.gz) { return; }
    _topics[name] = {
      gzInstance: window.gz,
      topic: new Topic({ gz: gz, name: name, messageType: messageType, callback: callback })
    };
  }

  function beginObservation() {
    if (!run || run.done) { return; }
    run.observing = true;
    hudSub('');
    // gz 웹소켓 원본 구독 — 렌더 파이프라인과 독립 (지연 재생 안 탐)
    if (typeof Topic !== 'function' || !window.gz || !gz.socket || gz.socket.readyState !== 1) {
      abort('script_error', 'sim connection unavailable');
      return;
    }
    // NOTE: subscribeOnce caches the Topic (and THIS callback closure) per
    // world FOREVER. On the second+ evaluation of a page the subscription is
    // already live, so without the run.observing gate the observation flow
    // would start the moment `run` exists — evaluate() would tick DURING
    // initialize(), snapshot the PRE-reset object poses as the baseline and
    // then "restore" everything back to the stale spots, undoing initialize.
    subscribeOnce('/world/' + run.world + '/stats', 'gz.msgs.WorldStatistics',
      function (msg) {
        if (!run || run.done || !run.observing) { return; }
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
        if (!run || run.done || !run.observing) { return; }
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
    if (run.terminalMode) {
      try { window.parent.postMessage({ type: 'physicar-eval-stop' }, '*'); } catch (e) {}
    }
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
