(function () {
  "use strict";

  const padOuter = document.getElementById('pad-outer');
  const padBall = document.getElementById('pad-ball');
  const loopRow = document.getElementById('loop-row');
  const errorMsg = document.getElementById('error-msg');
  const srcBtn = document.getElementById('src-picker-btn');
  const srcSelect = document.getElementById('src-select');

  let selectedDeviceId = null;
  let permissionUnlocked = false;

  const RADIUS = 140; // #pad-outer の半径（CSSの280pxと合わせる）
  const PAD_COUNT = 6;
  const LONG_PRESS_MS = 700;

  let ready = false;
  let starting = false;
  let audioCtxRaw = null;
  let micStream = null;
  let chainEntry = null;
  let filterNode, driveWet, delayWet, reverbWet;
  let padRecorderMimeType = '';
  const pads = [];

  function getSupportedMimeType() {
    const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
      for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function keepAudioAlive() {
    const tryResume = () => { if (Tone.getContext().state !== 'running') Tone.getContext().resume(); };
    document.addEventListener('visibilitychange', tryResume);
    setInterval(tryResume, 1500);
  }

  function makeWetModule(effectNode, initialWet) {
    const input = new Tone.Gain(1);
    const crossFade = new Tone.CrossFade(initialWet);
    input.connect(crossFade.a);
    input.connect(effectNode);
    effectNode.connect(crossFade.b);
    return { input, output: crossFade, fade: crossFade.fade };
  }

  function buildChain() {
    filterNode = new Tone.Filter({ frequency: 9000, type: 'lowpass', rolloff: -24 });
    const distortion = new Tone.Distortion({ distortion: 0.5 });
    const delay = new Tone.FeedbackDelay({ delayTime: 0.32, feedback: 0.35, maxDelay: 1 });
    const reverb = new Tone.Freeverb({ roomSize: 0.75, dampening: 2500 });

    driveWet = makeWetModule(distortion, 0);
    delayWet = makeWetModule(delay, 0);
    reverbWet = makeWetModule(reverb, 0.5);

    filterNode.connect(driveWet.input);
    driveWet.output.connect(delayWet.input);
    delayWet.output.connect(reverbWet.input);

    const master = new Tone.Volume(0).toDestination();
    reverbWet.output.connect(master);

    return filterNode; // 入力の接続先（マイクとパッド両方がここへ入る）
  }

  function expScale(t, min, max) {
    // t: 0..1 を対数的に min..max へ
    const logMin = Math.log(min), logMax = Math.log(max);
    return Math.exp(logMin + (logMax - logMin) * t);
  }

  function applyBallPosition(nx, ny) {
    // nx, ny: -1..1（円の中心が0,0）
    const x01 = (nx + 1) / 2;
    const y01 = (ny + 1) / 2;
    const dist = Math.min(1, Math.sqrt(nx * nx + ny * ny));

    filterNode.frequency.value = expScale(x01, 200, 9000);

    const wetY = 1 - y01; // 上へ行くほど深くかかる
    delayWet.fade.value = wetY * 0.6;
    reverbWet.fade.value = 0.15 + wetY * 0.75;

    driveWet.fade.value = dist * 0.85;
  }

  // ---- ボールのドラッグ ----
  let dragging = false;
  function ballPointerDown(e) {
    e.stopPropagation();
    if (!ready) { startAudio(); return; }
    dragging = true;
    padBall.classList.add('dragging');
    padBall.setPointerCapture(e.pointerId);
  }
  function ballPointerMove(e) {
    if (!dragging) return;
    const rect = padOuter.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > RADIUS) { dx = (dx / d) * RADIUS; dy = (dy / d) * RADIUS; }
    padBall.style.transform = `translate(${dx - 13}px, ${dy - 13}px)`;
    applyBallPosition(dx / RADIUS, dy / RADIUS);
  }
  function ballPointerUp() {
    dragging = false;
    padBall.classList.remove('dragging');
  }

  padBall.addEventListener('pointerdown', ballPointerDown);
  padBall.addEventListener('pointermove', ballPointerMove);
  window.addEventListener('pointerup', ballPointerUp);
  padOuter.addEventListener('pointerdown', (e) => {
    if (!ready) { startAudio(); return; }
    // 円内どこを押しても、その位置へ玉を飛ばしてドラッグ開始
    const rect = padOuter.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > RADIUS) { dx = (dx / d) * RADIUS; dy = (dy / d) * RADIUS; }
    padBall.style.transform = `translate(${dx - 13}px, ${dy - 13}px)`;
    applyBallPosition(dx / RADIUS, dy / RADIUS);
    dragging = true;
    padBall.classList.add('dragging');
  });

  // ---- パッド ----
  function renderLoopDots() {
    for (let i = 0; i < PAD_COUNT; i++) {
      const pad = { index: i, state: 'empty', recorder: null, chunks: [], player: null };
      pads.push(pad);
      const dot = document.createElement('div');
      dot.className = 'loop-dot';
      dot.id = `loop-dot-${i}`;
      loopRow.appendChild(dot);

      let pressTimer = null;
      let longPressed = false;

      dot.addEventListener('pointerdown', () => {
        if (!ready) { startAudio(); return; }
        longPressed = false;
        pressTimer = setTimeout(() => {
          longPressed = true;
          clearPad(pad, dot);
        }, LONG_PRESS_MS);
      });
      dot.addEventListener('pointerup', () => {
        clearTimeout(pressTimer);
        if (!longPressed && ready) handlePadTap(pad, dot);
      });
      dot.addEventListener('pointerleave', () => clearTimeout(pressTimer));
    }
  }

  function setDotVisual(dot, state) {
    dot.className = 'loop-dot ' + state;
  }

  function handlePadTap(pad, dot) {
    if (pad.state === 'empty') startPadRecording(pad, dot);
    else if (pad.state === 'recording') stopPadRecording(pad);
    else if (pad.state === 'stopped') { pad.player.start(); pad.state = 'playing'; setDotVisual(dot, 'playing'); }
    else if (pad.state === 'playing') { pad.player.stop(); pad.state = 'stopped'; setDotVisual(dot, 'stopped'); }
  }

  function startPadRecording(pad, dot) {
    pad.chunks = [];
    pad.recorder = new MediaRecorder(micStream, padRecorderMimeType ? { mimeType: padRecorderMimeType } : undefined);
    pad.recorder.ondataavailable = e => { if (e.data.size > 0) pad.chunks.push(e.data); };
    pad.recorder.onstop = async () => {
      const blob = new Blob(pad.chunks, { type: pad.recorder.mimeType || padRecorderMimeType || 'audio/webm' });
      try {
        const arrBuf = await blob.arrayBuffer();
        const decoded = await audioCtxRaw.decodeAudioData(arrBuf);
        pad.player = new Tone.Player(decoded).connect(chainEntry);
        pad.player.loop = true;
        pad.state = 'stopped';
        setDotVisual(dot, 'stopped');
      } catch (err) {
        console.error('pad decode failed', err);
        pad.state = 'empty';
        setDotVisual(dot, 'empty');
      }
    };
    pad.recorder.start();
    pad.state = 'recording';
    setDotVisual(dot, 'recording');
  }

  function stopPadRecording(pad) {
    if (pad.recorder && pad.recorder.state !== 'inactive') pad.recorder.stop();
  }

  function clearPad(pad, dot) {
    if (pad.recorder && pad.recorder.state !== 'inactive') { try { pad.recorder.stop(); } catch (e) {} }
    if (pad.player) { try { pad.player.stop(); } catch (e) {} pad.player.dispose(); pad.player = null; }
    pad.state = 'empty';
    setDotVisual(dot, 'empty');
  }

  async function startAudio() {
    if (starting || ready) return;
    starting = true;
    try {
      await Tone.start();
      audioCtxRaw = Tone.getContext().rawContext;
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true
      });
      padRecorderMimeType = getSupportedMimeType();

      chainEntry = buildChain();
      const liveSource = audioCtxRaw.createMediaStreamSource(micStream);
      Tone.connect(liveSource, chainEntry);

      keepAudioAlive();

      ready = true;
      padOuter.classList.add('ready');
      loopRow.classList.add('ready');
      srcBtn.classList.add('ready');
      permissionUnlocked = true;

      checkSilence(liveSource);
    } catch (err) {
      console.error(err);
      errorMsg.style.display = 'block';
      errorMsg.innerText = 'マイクを起動できませんでした';
    } finally {
      starting = false;
    }
  }

  function checkSilence(liveSource) {
    const analyser = audioCtxRaw.createAnalyser();
    analyser.fftSize = 512;
    liveSource.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    setTimeout(() => {
      analyser.getByteTimeDomainData(data);
      let maxDiff = 0;
      for (let i = 0; i < data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(data[i] - 128));
      if (maxDiff < 2) {
        errorMsg.style.display = 'block';
        errorMsg.innerText = '選んだ入力から音が来ていません（他のアプリの出力先がこのデバイスになっているか確認してください）';
      }
    }, 3000);
  }

  renderLoopDots();

  // ---- 入力デバイス選択（マイク以外＝仮想オーディオデバイス等も選べるようにする） ----
  srcBtn.addEventListener('click', async () => {
    try {
      if (!permissionUnlocked) {
        // ラベル（デバイス名）はマイク許可を一度得ないと取得できない仕様のため、先に許可だけ取る
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(t => t.stop());
        permissionUnlocked = true;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      srcSelect.innerHTML = '';
      inputs.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.innerText = d.label || `入力デバイス ${i + 1}`;
        srcSelect.appendChild(opt);
      });
      if (selectedDeviceId) srcSelect.value = selectedDeviceId;
      srcSelect.style.display = 'block';
      srcSelect.focus();
    } catch (err) {
      console.error(err);
    }
  });

  srcSelect.addEventListener('change', async (e) => {
    selectedDeviceId = e.target.value;
    srcSelect.style.display = 'none';
    if (ready) {
      await switchInputDevice(selectedDeviceId);
    } else {
      await startAudio();
    }
  });
  srcSelect.addEventListener('blur', () => { srcSelect.style.display = 'none'; });

  async function switchInputDevice(deviceId) {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      if (micStream) micStream.getTracks().forEach(t => t.stop());
      micStream = newStream;
      const newSource = audioCtxRaw.createMediaStreamSource(micStream);
      Tone.connect(newSource, chainEntry);
    } catch (err) {
      console.error(err);
    }
  }
})();
