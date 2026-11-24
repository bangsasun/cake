'use strict';

/* =========================================================
 *  케이크 쌓기 게임
 *  - 순수 JavaScript + Canvas, 외부 라이브러리 없음
 *  - 효과음은 Web Audio API로 직접 합성 (음원 파일 없음)
 * ========================================================= */

// ---------- 기본 설정 ----------
const W = 400;             // 게임 논리 해상도 (가로)
const H = 700;             // 게임 논리 해상도 (세로)
const LAYER_H = 32;        // 케이크 한 층의 높이
const BASE_W = 240;        // 첫 층(바닥 케이크)의 너비
const GROUND_Y = 600;      // 접시 윗면의 y 좌표 (카메라 이동 전 기준)
const PERFECT_TOL = 6;     // 이 픽셀 이내로 맞추면 Perfect 판정
const GROW_AMOUNT = 14;    // Perfect 3연속 시 늘어나는 너비

// 층마다 번갈아 나오는 케이크 맛
const FLAVORS = [
  { body: '#FFE3A3', cream: '#FFFDF5', dot: '#F4B942' }, // 바닐라
  { body: '#FFB3C1', cream: '#FFF0F4', dot: '#E8506E' }, // 딸기
  { body: '#A0694A', cream: '#F6DFCB', dot: '#5A3420' }, // 초코
  { body: '#B5D99C', cream: '#F4FBEF', dot: '#5E9440' }, // 말차
  { body: '#BDB8F2', cream: '#F4F3FF', dot: '#5B57C9' }, // 블루베리
  { body: '#FFC98B', cream: '#FFF6EA', dot: '#E9781A' }, // 오렌지
];
const SPRINKLE_COLORS = ['#FF6B8B', '#FFD84D', '#6BCBFF', '#8EE07A', '#C28BFF', '#ffffff'];

// ---------- DOM ----------
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const $score = document.getElementById('score');
const $best = document.getElementById('best');
const $menu = document.getElementById('menu');
const $over = document.getElementById('over');
const $muteBtn = document.getElementById('muteBtn');
const $finalScore = document.getElementById('finalScore');
const $finalLayers = document.getElementById('finalLayers');
const $finalBest = document.getElementById('finalBest');
const $newRecord = document.getElementById('newRecord');

// ---------- localStorage (사용할 수 없는 환경에서도 안전하게) ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* 저장 불가 환경은 무시 */
    }
  },
};

/* =========================================================
 *  효과음 (Web Audio API로 실시간 합성)
 * ========================================================= */
const Sound = {
  ctx: null,
  master: null,
  muted: store.get('cakeStack.muted', '0') === '1',

  // 브라우저 정책상 사용자 입력이 있은 뒤에 오디오를 켜야 함
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  setMuted(m) {
    this.muted = m;
    store.set('cakeStack.muted', m ? '1' : '0');
    if (this.master) this.master.gain.value = m ? 0 : 0.6;
  },

  // 단순한 음 하나 (주파수, 길이, 파형, 볼륨, 지연, 끝 주파수)
  tone(freq, dur, type = 'sine', vol = 0.3, delay = 0, slideTo = null) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },

  // 잡음 (자르는 소리 등에 사용)
  noise(dur, vol = 0.2, filterFreq = 3000, delay = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = filterFreq;
    const gain = this.ctx.createGain();
    gain.gain.value = vol;
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
  },

  // 시작 버튼
  start() {
    this.tone(523, 0.12, 'triangle', 0.3);
    this.tone(784, 0.18, 'triangle', 0.3, 0.09);
  },

  // 층을 내려놓을 때 '퐁' (높이 쌓을수록 음이 조금씩 올라감)
  place(level) {
    const f = 180 + Math.min(level, 40) * 6;
    this.tone(f, 0.18, 'sine', 0.45, 0, f * 0.55);
    this.tone(f * 2, 0.08, 'triangle', 0.12);
  },

  // 삐져나온 부분이 잘릴 때 '슥'
  slice() {
    this.noise(0.14, 0.25, 2500);
  },

  // Perfect! 콤보가 이어질수록 음계가 올라가는 '띠링'
  perfect(combo) {
    const scale = [523, 587, 659, 784, 880, 1047, 1175, 1319];
    const base = scale[Math.min(combo - 1, scale.length - 1)];
    this.tone(base, 0.15, 'triangle', 0.3);
    this.tone(base * 1.5, 0.2, 'triangle', 0.22, 0.07);
    this.tone(base * 2, 0.3, 'sine', 0.15, 0.14);
  },

  // Perfect 3연속 보너스로 케이크가 넓어질 때 '뾰로롱'
  grow() {
    [659, 784, 988, 1319].forEach((f, i) => this.tone(f, 0.12, 'square', 0.08, 0.2 + i * 0.05));
  },

  // 게임 오버 '뿌우우'
  over() {
    this.noise(0.3, 0.2, 800);
    this.tone(392, 0.25, 'triangle', 0.3, 0.1);
    this.tone(330, 0.25, 'triangle', 0.3, 0.3);
    this.tone(262, 0.5, 'triangle', 0.3, 0.5, 180);
  },

  // 신기록 팡파레
  record() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.2, 'triangle', 0.25, 1.1 + i * 0.1));
    this.tone(1047, 0.5, 'sine', 0.2, 1.5);
  },
};

/* =========================================================
 *  게임 상태
 * ========================================================= */
let state = 'menu';      // 'menu' | 'playing' | 'over'
let stack = [];          // 쌓인 층들 { x, w, f }
let current = null;      // 움직이는 층 { x, w, f, dir }
let pieces = [];         // 잘려서 떨어지는 조각
let particles = [];      // 스프링클 파티클
let popups = [];         // 'Perfect!' 같은 글자
let score = 0;
let combo = 0;
let best = parseInt(store.get('cakeStack.best', '0'), 10) || 0;
let camY = 0;            // 카메라가 위로 올라간 정도
let zoom = 1;            // 게임 오버 시 케이크 전체를 보여주기 위한 줌
let landBounce = 0;      // 내려놓을 때 살짝 튀는 연출
let shake = 0;           // 화면 흔들림
let overReadyAt = 0;     // 게임 오버 후 다시하기 입력을 받을 시각
let time = 0;

$best.textContent = best;
$muteBtn.textContent = Sound.muted ? '🔇' : '🔊';

// 층 i의 윗면 y 좌표 (카메라 적용 전)
function layerTop(i) {
  return GROUND_Y - (i + 1) * LAYER_H;
}

// 층이 쌓일수록 빨라지는 이동 속도 (px/초)
function speed() {
  return Math.min(170 + stack.length * 9, 480);
}

function resetGame() {
  stack = [{ x: (W - BASE_W) / 2, w: BASE_W, f: 0 }];
  pieces = [];
  particles = [];
  popups = [];
  score = 0;
  combo = 0;
  camY = 0;
  zoom = 1;
  $score.textContent = '0';
  spawnLayer();
}

// 새로운 층을 왼쪽 또는 오른쪽에서 등장시킴
function spawnLayer() {
  const top = stack[stack.length - 1];
  const fromLeft = stack.length % 2 === 1;
  current = {
    x: fromLeft ? -top.w * 0.3 : W - top.w * 0.7,
    w: top.w,
    f: stack.length % FLAVORS.length,
    dir: fromLeft ? 1 : -1,
  };
}

function startGame() {
  Sound.unlock();
  Sound.start();
  resetGame();
  state = 'playing';
  $menu.classList.add('hidden');
  $over.classList.add('hidden');
}

// 층 떨어뜨리기 (핵심 로직)
function drop() {
  if (state !== 'playing' || !current) return;
  const top = stack[stack.length - 1];
  const idx = stack.length;
  const y = layerTop(idx);

  const left = Math.max(current.x, top.x);
  const right = Math.min(current.x + current.w, top.x + top.w);
  const overlap = right - left;

  // 1) 하나도 겹치지 않음 → 게임 오버
  if (overlap <= 0) {
    pieces.push(makePiece(current.x, y, current.w, current.f, current.dir));
    current = null;
    gameOver();
    return;
  }

  // 2) Perfect! → 위치를 정확히 맞춰 줌
  if (Math.abs(current.x - top.x) <= PERFECT_TOL) {
    combo++;
    let x = top.x;
    let w = top.w;
    const gain = 2 + Math.min(combo - 1, 3); // 콤보가 이어질수록 점수 보너스 증가

    // 3연속부터 케이크 너비가 조금씩 늘어남
    if (combo >= 3 && w < BASE_W) {
      const add = Math.min(GROW_AMOUNT, BASE_W - w);
      x -= add / 2;
      w += add;
      Sound.grow();
      addPopup('넓어졌다! ↔', W / 2, y - 26, '#7a5200');
    }
    stack.push({ x, w, f: current.f });
    score += gain;
    Sound.perfect(combo);
    addPopup(combo > 1 ? `Perfect! x${combo}` : 'Perfect!', x + w / 2, y - 4, '#e8506e');
    burst(x + w / 2, y, 18 + combo * 4);
  } else {
    // 3) 일부만 겹침 → 삐져나온 부분을 잘라냄
    combo = 0;
    if (current.x < top.x) {
      pieces.push(makePiece(current.x, y, top.x - current.x, current.f, -1));
    } else {
      pieces.push(makePiece(top.x + top.w, y, current.x + current.w - (top.x + top.w), current.f, 1));
    }
    stack.push({ x: left, w: overlap, f: current.f });
    score += 1;
    Sound.slice();
  }

  Sound.place(stack.length);
  landBounce = 1;
  $score.textContent = score;
  spawnLayer();
}

function makePiece(x, y, w, f, dir) {
  return { x, y, w, f, vy: -60, vx: dir * 40, rot: 0, vr: dir * (1.5 + Math.random() * 2) };
}

function addPopup(text, x, y, color) {
  popups.push({ text, x, y, color, life: 1 });
}

// 스프링클이 팡 터지는 효과
function burst(x, y, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 80 + Math.random() * 220;
    particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - 120,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 10,
      color: SPRINKLE_COLORS[(Math.random() * SPRINKLE_COLORS.length) | 0],
      life: 1,
    });
  }
}

function gameOver() {
  state = 'over';
  shake = 1;
  Sound.over();

  const layers = stack.length - 1;
  const isRecord = score > best;
  if (isRecord) {
    best = score;
    store.set('cakeStack.best', String(best));
    Sound.record();
  }
  $best.textContent = best;
  $finalScore.textContent = score;
  $finalLayers.textContent = layers;
  $finalBest.textContent = best;
  $newRecord.classList.toggle('hidden', !isRecord);

  // 케이크 전체가 보이도록 줌 아웃한 뒤 결과창 표시
  overReadyAt = performance.now() + 1300;
  setTimeout(() => {
    if (state === 'over') $over.classList.remove('hidden');
  }, 1300);
}

/* =========================================================
 *  업데이트
 * ========================================================= */
function update(dt) {
  time += dt;

  // 움직이는 층
  if (state === 'playing' && current) {
    current.x += current.dir * speed() * dt;
    const minX = -current.w * 0.35;
    const maxX = W - current.w * 0.65;
    if (current.x < minX) { current.x = minX; current.dir = 1; }
    if (current.x > maxX) { current.x = maxX; current.dir = -1; }
  }

  // 카메라: 맨 위층이 화면 위쪽 1/3쯤에 오도록 따라감
  const targetCam = state === 'over' ? 0 : Math.max(0, (stack.length + 1) * LAYER_H - 350);
  camY += (targetCam - camY) * Math.min(1, dt * 5);

  // 게임 오버 시 케이크 전체가 화면에 들어오도록 줌 아웃
  const targetZoom = state === 'over' ? Math.min(1, 290 / (stack.length * LAYER_H + 60)) : 1;
  zoom += (targetZoom - zoom) * Math.min(1, dt * 3);

  // 떨어지는 조각
  for (const p of pieces) {
    p.vy += 1400 * dt;
    p.y += p.vy * dt;
    p.x += p.vx * dt;
    p.rot += p.vr * dt;
  }
  pieces = pieces.filter((p) => p.y < GROUND_Y + 2000);

  // 파티클
  for (const p of particles) {
    p.vy += 600 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.life -= dt * 0.9;
  }
  particles = particles.filter((p) => p.life > 0);

  // 팝업 글자
  for (const p of popups) {
    p.y -= 40 * dt;
    p.life -= dt * 1.1;
  }
  popups = popups.filter((p) => p.life > 0);

  landBounce = Math.max(0, landBounce - dt * 5);
  shake = Math.max(0, shake - dt * 2.5);
}

/* =========================================================
 *  그리기
 * ========================================================= */
function roundRect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// 케이크 한 층 그리기
function drawLayer(x, y, w, f) {
  if (w <= 0.5) return;
  const fl = FLAVORS[f % FLAVORS.length];

  // 케이크 몸통
  ctx.fillStyle = fl.body;
  roundRect(x, y, w, LAYER_H, 7);
  ctx.fill();

  // 아래쪽 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.09)';
  roundRect(x, y + LAYER_H - 7, w, 7, 5);
  ctx.fill();

  // 크림 (윗면 + 흘러내린 방울)
  ctx.fillStyle = fl.cream;
  roundRect(x, y, w, 10, 6);
  ctx.fill();
  ctx.save();
  roundRect(x, y, w, LAYER_H, 7);
  ctx.clip();
  for (let dx = 7; dx < w; dx += 15) {
    const dripH = 3 + (Math.abs(Math.floor(x + dx) * 7) % 5);
    ctx.beginPath();
    ctx.ellipse(x + dx, y + 10, 5, dripH, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 토핑 점
  ctx.fillStyle = fl.dot;
  for (let dx = 14; dx < w - 6; dx += 26) {
    ctx.beginPath();
    ctx.arc(x + dx, y + 22, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 하이라이트
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  roundRect(x + 5, y + 2.5, Math.min(w * 0.3, 40), 3, 2);
  ctx.fill();
}

// 배경 (높이 올라갈수록 하늘 색이 변함)
function drawBackground() {
  const h = (330 + camY * 0.04) % 360;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `hsl(${h}, 70%, 88%)`);
  g.addColorStop(1, `hsl(${(h + 40) % 360}, 75%, 94%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 반짝이는 별/방울 (살짝 시차 스크롤)
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 24; i++) {
    const sx = (i * 97) % W;
    const sy = ((i * 173 + camY * 0.3) % (H + 40)) - 20;
    const r = 1.5 + ((i * 13) % 4) + Math.sin(time * 2 + i) * 0.8;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
  }
}

// 케이크 받침 접시
function drawPlate() {
  const y = GROUND_Y;
  ctx.fillStyle = '#d9cfe8';
  roundRect(W / 2 - 22, y + 14, 44, 70, 6);
  ctx.fill();
  ctx.fillStyle = '#c4b6da';
  roundRect(W / 2 - 70, y + 78, 140, 14, 7);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  roundRect(W / 2 - 155, y, 310, 16, 8);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  roundRect(W / 2 - 155, y + 10, 310, 6, 3);
  ctx.fill();
}

// 게임 오버 시 맨 위에 체리 올리기
function drawCherry(top) {
  const cx = top.x + top.w / 2;
  const cy = layerTop(stack.length - 1) - 9;
  ctx.strokeStyle = '#4f7a2a';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 4);
  ctx.quadraticCurveTo(cx + 4, cy - 18, cx + 12, cy - 22);
  ctx.stroke();
  ctx.fillStyle = '#e0233f';
  ctx.beginPath();
  ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(cx - 3.5, cy - 3.5, 3, 0, Math.PI * 2);
  ctx.fill();
}

function draw() {
  drawBackground();

  ctx.save();
  // 화면 흔들림
  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * 10 * shake, (Math.random() - 0.5) * 10 * shake);
  }
  // 줌 (접시 아래쪽을 기준점으로)
  const pivotY = GROUND_Y + 60;
  ctx.translate(W / 2, pivotY);
  ctx.scale(zoom, zoom);
  ctx.translate(-W / 2, -pivotY + camY);

  drawPlate();

  // 쌓인 층들 (맨 위층은 살짝 눌렸다 튀는 연출)
  for (let i = 0; i < stack.length; i++) {
    const L = stack[i];
    const isTop = i === stack.length - 1 && i > 0;
    const squash = isTop ? Math.sin(landBounce * Math.PI) * 3 : 0;
    drawLayer(L.x - squash, layerTop(i) + squash, L.w + squash * 2, L.f);
  }

  if (state === 'over' && stack.length > 1) drawCherry(stack[stack.length - 1]);

  // 움직이는 층 + 아래로 떨어질 위치 가이드
  if (state === 'playing' && current) {
    const y = layerTop(stack.length);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(current.x, y + LAYER_H - 2, current.w, 2);
    drawLayer(current.x, y, current.w, current.f);
  }

  // 잘린 조각
  for (const p of pieces) {
    ctx.save();
    ctx.translate(p.x + p.w / 2, p.y + LAYER_H / 2);
    ctx.rotate(p.rot);
    drawLayer(-p.w / 2, -LAYER_H / 2, p.w, p.f);
    ctx.restore();
  }

  // 스프링클
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    roundRect(-4, -1.5, 8, 3, 1.5);
    ctx.fill();
    ctx.restore();
  }

  // 팝업 글자
  ctx.textAlign = 'center';
  ctx.font = '900 24px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  for (const p of popups) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
    const scale = 1 + (1 - p.life) * 0.2;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(scale, scale);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'white';
    ctx.strokeText(p.text, 0, 0);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  // 시작 화면에서는 데모로 층 하나가 움직임
  if (state === 'menu') {
    const x = W / 2 - BASE_W / 2 + Math.sin(time * 1.5) * 90;
    drawLayer(x, layerTop(1), BASE_W, 1);
  }
}

/* =========================================================
 *  화면 크기 대응 (고해상도 화면에서도 선명하게)
 * ========================================================= */
function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/* =========================================================
 *  입력
 * ========================================================= */
function handleAction() {
  Sound.unlock();
  if (state === 'playing') drop();
  else if (state === 'over' && performance.now() > overReadyAt) startGame();
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state === 'playing') handleAction();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    if (state === 'menu') startGame();
    else handleAction();
  }
  if (e.code === 'KeyM') toggleMute();
});

document.getElementById('startBtn').addEventListener('click', startGame);
document.getElementById('retryBtn').addEventListener('click', startGame);

function toggleMute() {
  Sound.unlock();
  Sound.setMuted(!Sound.muted);
  $muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
}
$muteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
$muteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMute();
  $muteBtn.blur();
});

/* =========================================================
 *  메인 루프
 * ========================================================= */
stack = [{ x: (W - BASE_W) / 2, w: BASE_W, f: 0 }];
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
