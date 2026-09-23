// ==============================================
// 声を聴く（Voice Rig） — ライブボーカル加工＋ループパッド
// マイク → エフェクトチェーン → 出力。パッドの再生も同じチェーンを通る。
// ==============================================

(function () {
  "use strict";

  const startModal = document.getElementById('start-modal');
  const startError = document.getElementById('start-error');
  const app = document.getElementById('main-app');
  const liveDot = document.getElementById('live-dot');

  let audioCtxRaw = null;
  let micStream = null;
  let modules = [];
  let masterVol = null;
  let chainEntry = null;
  let padRecorderMimeType = '';
  let scopeAnalyser = null;
  let spectrumAnalyser = null;
  let muted = false;

  function getSupportedMimeType() {
    const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
      for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  // ブラウザがタブ切り替え等でAudioContextを止めてしまっても自動で復帰させる
  function keepAudioAlive() {
    const tryResume = () => { if (Tone.getContext().state !== 'running') Tone.getContext().resume(); };
    document.addEventListener('visibilitychange', tryResume);
    document.addEventListener('click', tryResume);
    setInterval(tryResume, 1500);
  }

  // ---- wet/bypass ----
  function makeWetModule(effectNode) {
    const input = new Tone.Gain(1);
    const crossFade = new Tone.CrossFade(0.75);
    input.connect(crossFade.a);
    input.connect(effectNode);
    effectNode.connect(crossFade.b);
    return { input, output: crossFade, node: effectNode, fade: crossFade.fade, bypassed: false };
  }
  function setBypass(mod, bypassed, storedWet) {
    mod.bypassed = bypassed;
    mod.fade.value = bypassed ? 0 : storedWet;
  }

  function buildChain() {
    const distortion = new Tone.Distortion({ distortion: 0.35 });
    const crusher = new Tone.BitCrusher({ bits: 8 });
    const filter = new Tone.Filter({ frequency: 4000, type: 'lowpass', rolloff: -24 });
    const pitch = new Tone.PitchShift({ pitch: 0, windowSize: 0.06 });
    const delay = new Tone.FeedbackDelay({ delayTime: 0.28, feedback: 0.32, maxDelay: 2 });
    const reverb = new Tone.Freeverb({ roomSize: 0.6, dampening: 3000 });

    const defs = [
      { key: 'drive', label: 'DRIVE', effect: distortion, wet: 0, params: [
        { key: 'amount', label: 'AMOUNT', min: 0, max: 1, step: 0.01, get: () => distortion.distortion, set: v => distortion.distortion = v, fmt: v => Math.round(v * 100) + '%' }
      ]},
      { key: 'crush', label: 'CRUSH', effect: crusher, wet: 0, params: [
        { key: 'bits', label: 'BITS', min: 1, max: 16, step: 1,
          get: () => (crusher.bits && typeof crusher.bits === 'object') ? crusher.bits.value : crusher.bits,
          set: v => { if (crusher.bits && typeof crusher.bits === 'object') crusher.bits.value = v; else crusher.bits = v; },
          fmt: v => v + '-bit' }
      ]},
      { key: 'filter', label: 'FILTER', effect: filter, wet: 0, params: [
        { key: 'freq', label: 'CUTOFF', min: 80, max: 12000, step: 20, get: () => filter.frequency.value, set: v => filter.frequency.value = v, fmt: v => v >= 1000 ? (v/1000).toFixed(1) + 'k' : Math.round(v) + 'Hz' }
      ], typeToggle: { options: [['lowpass','LP'], ['highpass','HP'], ['bandpass','BP']], get: () => filter.type, set: v => filter.type = v } },
      { key: 'pitch', label: 'PITCH', effect: pitch, wet: 0, params: [
        { key: 'semi', label: 'SEMITONES', min: -12, max: 12, step: 1, get: () => pitch.pitch, set: v => pitch.pitch = v, fmt: v => (v > 0 ? '+' : '') + v }
      ]},
      { key: 'echo', label: 'ECHO', effect: delay, wet: 0.35, params: [
        { key: 'time', label: 'TIME', min: 0.03, max: 1.2, step: 0.01, get: () => delay.delayTime.value, set: v => delay.delayTime.value = v, fmt: v => Math.round(v*1000) + 'ms' },
        { key: 'fb', label: 'FEEDBACK', min: 0, max: 0.92, step: 0.01, get: () => delay.feedback.value, set: v => delay.feedback.value = v, fmt: v => Math.round(v*100) + '%' }
      ], tapTempo: delay },
      { key: 'space', label: 'SPACE', effect: reverb, wet: 0.3, params: [
        { key: 'room', label: 'SIZE', min: 0.1, max: 0.95, step: 0.01, get: () => reverb.roomSize.value, set: v => reverb.roomSize.value = v, fmt: v => Math.round(v*100) + '%' }
      ]}
    ];

    modules = defs.map(d => {
      const wrapped = makeWetModule(d.effect);
      wrapped.def = d;
      wrapped.wetLevel = d.wet;
      wrapped.fade.value = d.wet;
      return wrapped;
    });

    let prev = null;
    modules.forEach(m => { if (prev) prev.output.connect(m.input); prev = m; });

    masterVol = new Tone.Volume(0).toDestination();
    modules[modules.length - 1].output.connect(masterVol);

    // 可視化用のアナライザーは出力の手前からタップする
    scopeAnalyser = new Tone.Analyser('waveform', 1024);
    spectrumAnalyser = new Tone.Analyser('fft', 256);
    masterVol.connect(scopeAnalyser);
    masterVol.connect(spectrumAnalyser);

    return modules[0].input;
  }

  function renderModules() {
    const wrap = document.getElementById('modules');
    modules.forEach(mod => {
      const d = mod.def;
      const box = document.createElement('div');
      box.className = 'module-box';

      const head = document.createElement('div');
      head.className = 'module-box-head';
      head.innerHTML = `<span class="module-name">${d.label}</span>`;
      const sw = document.createElement('div');
      sw.className = 'mini-toggle' + (mod.bypassed ? '' : ' on');
      sw.innerHTML = '<div class="knob"></div>';
      sw.addEventListener('click', () => {
        setBypass(mod, !mod.bypassed, mod.wetLevel);
        sw.classList.toggle('on', !mod.bypassed);
      });
      head.appendChild(sw);
      box.appendChild(head);

      const mixWrap = document.createElement('div');
      mixWrap.className = 'mini-param';
      mixWrap.innerHTML = `<div class="mini-param-row"><span>MIX</span><span class="val" id="mixval-${d.key}">${Math.round(mod.wetLevel*100)}%</span></div>`;
      const mixSlider = document.createElement('input');
      mixSlider.type = 'range'; mixSlider.min = 0; mixSlider.max = 1; mixSlider.step = 0.01; mixSlider.value = mod.wetLevel;
      mixSlider.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        mod.wetLevel = v;
        if (!mod.bypassed) mod.fade.value = v;
        document.getElementById(`mixval-${d.key}`).innerText = Math.round(v * 100) + '%';
      });
      mixWrap.appendChild(mixSlider);
      box.appendChild(mixWrap);

      if (d.typeToggle) {
        const tt = document.createElement('div');
        tt.className = 'type-toggle-row';
        d.typeToggle.options.forEach(([val, lab]) => {
          const b = document.createElement('button');
          b.innerText = lab;
          if (d.typeToggle.get() === val) b.classList.add('active');
          b.addEventListener('click', () => {
            d.typeToggle.set(val);
            tt.querySelectorAll('button').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
          });
          tt.appendChild(b);
        });
        box.appendChild(tt);
      }

      d.params.forEach(p => {
        const pw = document.createElement('div');
        pw.className = 'mini-param';
        const id = `pv-${d.key}-${p.key}`;
        pw.innerHTML = `<div class="mini-param-row"><span>${p.label}</span><span class="val" id="${id}">${p.fmt(p.get())}</span></div>`;
        const s = document.createElement('input');
        s.type = 'range'; s.min = p.min; s.max = p.max; s.step = p.step; s.value = p.get();
        s.dataset.key = p.key;
        s.addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          p.set(v);
          document.getElementById(id).innerText = p.fmt(v);
        });
        pw.appendChild(s);
        box.appendChild(pw);
      });

      if (d.tapTempo) {
        const tapBtn = document.createElement('button');
        tapBtn.className = 'record-btn-boxed tap-btn';
        tapBtn.innerText = 'TAP';
        let taps = [];
        tapBtn.addEventListener('click', () => {
          const now = performance.now();
          taps = taps.filter(t => now - t < 2500);
          taps.push(now);
          if (taps.length >= 2) {
            const intervals = [];
            for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i-1]);
            const avg = intervals.reduce((a,b) => a+b, 0) / intervals.length;
            const sec = Math.min(Math.max(avg / 1000, 0.03), 1.2);
            d.tapTempo.delayTime.value = sec;
            document.getElementById(`pv-echo-time`).innerText = Math.round(sec*1000) + 'ms';
            const timeInput = box.querySelector('input[data-key="time"]');
            if (timeInput) timeInput.value = sec;
          }
        });
        box.appendChild(tapBtn);
      }

      wrap.appendChild(box);
    });
  }

  // ---- 可視化 ----
  function setupCanvas(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    return { ctx, w: rect.width, h: rect.height };
  }

  function startVisualizers() {
    const scopeCanvas = document.getElementById('scope-canvas');
    const spectrumCanvas = document.getElementById('spectrum-canvas');
    let scope = setupCanvas(scopeCanvas);
    let spectrum = setupCanvas(spectrumCanvas);
    window.addEventListener('resize', () => {
      scope = setupCanvas(scopeCanvas);
      spectrum = setupCanvas(spectrumCanvas);
    });

    function draw() {
      requestAnimationFrame(draw);
      if (scopeAnalyser) {
        const data = scopeAnalyser.getValue();
        const { ctx, w, h } = scope;
        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#111111';
        for (let i = 0; i < data.length; i++) {
          const x = (i / data.length) * w;
          const y = (0.5 - data[i] * 0.5) * h;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      if (spectrumAnalyser) {
        const data = spectrumAnalyser.getValue();
        const { ctx, w, h } = spectrum;
        ctx.clearRect(0, 0, w, h);
        const barCount = 48;
        const step = Math.floor(data.length / barCount);
        const barW = w / barCount;
        ctx.fillStyle = '#111111';
        for (let i = 0; i < barCount; i++) {
          const v = data[i * step];
          const db = typeof v === 'number' ? v : -100;
          const norm = Math.min(1, Math.max(0, (db + 100) / 100));
          const barH = norm * h;
          ctx.globalAlpha = 0.15 + norm * 0.85;
          ctx.fillRect(i * barW + 1, h - barH, barW - 2, barH);
        }
        ctx.globalAlpha = 1;
      }
    }
    draw();
  }

  function drawPadWave(canvas, buffer) {
    const { ctx, w, h } = setupCanvas(canvas);
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / w);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      for (let j = 0; j < step; j++) {
        const idx = x * step + j;
        if (idx >= data.length) break;
        const v = data[idx];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = (0.5 - max * 0.5) * h;
      const y2 = (0.5 - min * 0.5) * h;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
  }

  // ---- パッド ----
  const PAD_COUNT = 6;
  const pads = [];

  function renderPads() {
    const wrap = document.getElementById('pads');
    for (let i = 0; i < PAD_COUNT; i++) {
      const pad = { index: i, state: 'empty', loop: true, recorder: null, chunks: [], player: null, buffer: null };
      pads.push(pad);

      const box = document.createElement('div');
      box.className = 'pad-box';
      box.innerHTML = `
        <div class="pad-box-num">PAD ${i + 1}</div>
        <canvas class="pad-wave" id="pad-wave-${i}" style="display:none;"></canvas>
        <button class="pad-main-btn" id="pad-btn-${i}">TAP TO REC</button>
        <div class="pad-foot-row">
          <button id="pad-loop-${i}" class="loop-on">LOOP</button>
          <button id="pad-clear-${i}" disabled>CLEAR</button>
        </div>
      `;
      wrap.appendChild(box);

      const btn = box.querySelector(`#pad-btn-${i}`);
      const loopBtn = box.querySelector(`#pad-loop-${i}`);
      const clearBtn = box.querySelector(`#pad-clear-${i}`);
      const waveCanvas = box.querySelector(`#pad-wave-${i}`);

      btn.addEventListener('click', () => handlePadTap(pad, btn, clearBtn, waveCanvas));
      loopBtn.addEventListener('click', () => {
        pad.loop = !pad.loop;
        loopBtn.classList.toggle('loop-on', pad.loop);
        if (pad.player) pad.player.loop = pad.loop;
      });
      clearBtn.addEventListener('click', () => clearPad(pad, btn, clearBtn, waveCanvas));
    }
  }

  function setPadVisual(btn, state) {
    btn.className = 'pad-main-btn ' + state;
    btn.innerText = state === 'empty' ? 'TAP TO REC' : state === 'recording' ? 'REC ● TAP TO STOP' : state === 'playing' ? 'PLAYING' : 'TAP TO PLAY';
  }

  function handlePadTap(pad, btn, clearBtn, waveCanvas) {
    if (pad.state === 'empty') startPadRecording(pad, btn, clearBtn, waveCanvas);
    else if (pad.state === 'recording') stopPadRecording(pad);
    else if (pad.state === 'stopped') { pad.player.start(); pad.state = 'playing'; setPadVisual(btn, 'playing'); }
    else if (pad.state === 'playing') { pad.player.stop(); pad.state = 'stopped'; setPadVisual(btn, 'stopped'); }
  }

  function startPadRecording(pad, btn, clearBtn, waveCanvas) {
    pad.chunks = [];
    pad.recorder = new MediaRecorder(micStream, padRecorderMimeType ? { mimeType: padRecorderMimeType } : undefined);
    pad.recorder.ondataavailable = e => { if (e.data.size > 0) pad.chunks.push(e.data); };
    pad.recorder.onstop = async () => {
      const blob = new Blob(pad.chunks, { type: pad.recorder.mimeType || padRecorderMimeType || 'audio/webm' });
      try {
        const arrBuf = await blob.arrayBuffer();
        const decoded = await audioCtxRaw.decodeAudioData(arrBuf);
        pad.buffer = decoded;
        pad.player = new Tone.Player(decoded).connect(chainEntry);
        pad.player.loop = pad.loop;
        pad.state = 'stopped';
        setPadVisual(btn, 'stopped');
        clearBtn.disabled = false;
        waveCanvas.style.display = 'block';
        drawPadWave(waveCanvas, decoded);
        pad.player.onstop = () => {
          if (pad.state === 'playing' && !pad.player.loop) { pad.state = 'stopped'; setPadVisual(btn, 'stopped'); }
        };
      } catch (err) {
        console.error('pad decode failed', err);
        alert(`パッド ${pad.index + 1} の録音を読み込めませんでした。もう一度録音してください。`);
        pad.state = 'empty';
        setPadVisual(btn, 'empty');
      }
    };
    pad.recorder.start();
    pad.state = 'recording';
    setPadVisual(btn, 'recording');
  }

  function stopPadRecording(pad) {
    if (pad.recorder && pad.recorder.state !== 'inactive') pad.recorder.stop();
  }

  function clearPad(pad, btn, clearBtn, waveCanvas) {
    if (pad.player) { try { pad.player.stop(); } catch (e) {} pad.player.dispose(); pad.player = null; }
    pad.buffer = null;
    pad.state = 'empty';
    setPadVisual(btn, 'empty');
    clearBtn.disabled = true;
    waveCanvas.style.display = 'none';
  }

  function stopAllPads() {
    pads.forEach(pad => {
      if (pad.state === 'playing' && pad.player) {
        pad.player.stop();
        pad.state = 'stopped';
        const btn = document.getElementById(`pad-btn-${pad.index}`);
        if (btn) setPadVisual(btn, 'stopped');
      }
    });
  }

  async function init() {
    try {
      await Tone.start();
      audioCtxRaw = Tone.getContext().rawContext;
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      padRecorderMimeType = getSupportedMimeType();

      chainEntry = buildChain();
      const liveSource = audioCtxRaw.createMediaStreamSource(micStream);
      Tone.connect(liveSource, chainEntry);

      renderModules();
      renderPads();
      startVisualizers();
      keepAudioAlive();

      startModal.style.display = 'none';
      app.style.display = 'block';
      liveDot.classList.add('on');

      document.getElementById('knob-master').addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        masterVol.volume.value = v;
        document.getElementById('val-master').innerText = v + 'dB';
      });

      document.getElementById('btn-mute').addEventListener('click', (e) => {
        muted = !muted;
        masterVol.mute = muted;
        e.target.innerText = muted ? 'MUTED' : 'MUTE';
        e.target.style.borderColor = muted ? 'var(--danger)' : 'var(--line-color)';
        e.target.style.color = muted ? 'var(--danger)' : 'var(--text-main)';
      });

      document.getElementById('btn-stop-pads').addEventListener('click', stopAllPads);

      window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= PAD_COUNT) {
          const pad = pads[n - 1];
          const btn = document.getElementById(`pad-btn-${n - 1}`);
          const clearBtn = document.getElementById(`pad-clear-${n - 1}`);
          const waveCanvas = document.getElementById(`pad-wave-${n - 1}`);
          if (pad && btn) handlePadTap(pad, btn, clearBtn, waveCanvas);
        }
      });

    } catch (err) {
      console.error(err);
      startError.style.display = 'block';
      startError.innerText = 'マイクを起動できませんでした。ブラウザのマイク許可設定を確認してもう一度お試しください（別タブ・別ウィンドウで開き直すと直ることがあります）。';
    }
  }

  document.getElementById('btn-start').addEventListener('click', init, { once: true });
})();
