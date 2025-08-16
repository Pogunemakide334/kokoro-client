// ====== サーバーURL（ご指定の Render ）======
const BACKEND_URL = "https://kokoro-server.onrender.com";
// ============================================

const qs = new URLSearchParams(location.search);
const roomId = qs.get("room") || "";

const view = document.getElementById("view");
const playersEl = document.getElementById("players");
const topicsCountEl = document.getElementById("topicsCount");
const roomInfoEl = document.getElementById("roomInfo");
const startBtn = document.getElementById("startBtn");
const nextTopicBtn = document.getElementById("nextTopicBtn");
const shareTools = document.getElementById("shareTools");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const copyStatus = document.getElementById("copyStatus");
const topicProgText = document.getElementById("topicProgressText");
const answerProgText = document.getElementById("answerProgressText");
const scoreboardEl = document.getElementById("scoreboard");
const revealModeSelect = document.getElementById("revealModeSelect");

let socket = null;
let nickname = localStorage.getItem("kokoro_nickname") || "";
let isHost = false;
let currentTopic = "";
let revealIndex = 0;
let latestAnswers = []; // [{nickname, answer}]
let answerProgress = { done: 0, total: 0 };
let topicProgress = { done: 0, total: 0 };
let currentMode = "sequential"; // 'sequential' | 'all'
let myLikes = {}; // index: boolean (簡易クライアント側状態)

/* ===== 共有リンク（ヘッダー） ===== */
copyLinkBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    copyStatus.textContent = "コピーしました！";
    setTimeout(() => (copyStatus.textContent = ""), 1500);
  } catch {
    copyStatus.textContent = "コピーできませんでした";
  }
});

function setHostUI() {
  document.querySelectorAll(".host-only").forEach(el => {
    el.classList.toggle("hidden", !isHost);
  });
  startBtn.disabled = !(topicProgress.done === topicProgress.total && topicProgress.total > 0);
  nextTopicBtn.disabled = true;
  revealModeSelect.value = currentMode;
}

function makeRoomId() {
  const s = "abcdefghjkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += s[Math.floor(Math.random() * s.length)];
  return id;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ========== 画面 ========== */
function renderTop() {
  const html = `
    <div class="card">
      <p class="kicker">ようこそ</p>
      <h2 class="big">「心を合わせて」へ</h2>

      <div class="row" style="margin-bottom:12px;">
        <input id="nicknameInput" type="text" placeholder="ニックネームを入力" value="${escapeHtml(nickname)}" />
        ${roomId ? "" : `<button id="createRoomBtn">部屋を作る</button>`}
      </div>

      ${ roomId
        ? `<div class="small">この部屋に参加します：<strong>${roomId}</strong></div>`
        : `<div class="small">「部屋を作る」でURLを発行 → みんなに共有してください</div>` }

      ${ roomId ? `
        <div class="card" style="margin-top:12px;">
          <div class="row">
            <input id="inviteInput" type="text" readonly value="${location.href}" />
            <button id="copyLinkLocalBtn">招待リンクをコピー</button>
          </div>
          <p class="small">コピーできない場合は長押しで選択→コピーしてください。</p>
        </div>
      ` : "" }

      <div style="height:12px"></div>
      <div class="card">
        <h3>ルール</h3>
        <ol>
          <li>各自、好きなだけ「お題」を追加</li>
          <li>ホストが「ゲーム開始」</li>
          <li>「次のお題へ」でランダム出題 → 全員がテキスト回答</li>
          <li>発表は「順番」または「全員同時」モード</li>
          <li>👍で投票、スコア加算</li>
        </ol>
        <button id="goRulesBtn" ${roomId ? "" : "disabled"}>ルールOK！お題入力へ</button>
      </div>
    </div>
  `;
  view.innerHTML = html;

  const nicknameInput = document.getElementById("nicknameInput");
  nicknameInput?.addEventListener("input", e => { nickname = e.target.value.trim(); });

  document.getElementById("createRoomBtn")?.addEventListener("click", () => {
    if (!nickname) { alert("ニックネームを入力してください"); return; }
    const newRoom = makeRoomId();
    localStorage.setItem(`kokoro_host_${newRoom}`, "1");
    location.href = `${location.pathname}?room=${newRoom}`;
  });

  document.getElementById("goRulesBtn")?.addEventListener("click", () => {
    if (!nickname) { alert("ニックネームを入力してください"); return; }
    localStorage.setItem("kokoro_nickname", nickname);
    connectAndJoin();
    renderRules();
  });

  document.getElementById("copyLinkLocalBtn")?.addEventListener("click", async () => {
    const el = document.getElementById("inviteInput");
    el.select();
    try { await navigator.clipboard.writeText(el.value); alert("招待リンクをコピーしました！"); }
    catch { document.execCommand?.("copy"); alert("コピーできました（フォールバック）"); }
  });
}

function renderRules() {
  const html = `
    <div class="card">
      <h2 class="big">ルール説明</h2>
      <p>「お題募集」→「回答」→「発表」を繰り返します。</p>
      <ul>
        <li>お題は無制限に追加OK</li>
        <li>ホストが進行（開始/次のお題へ/発表モード切替）</li>
        <li>回答は全員テキスト送信</li>
        <li>発表は順番 or 全員同時。👍で投票、スコア加点</li>
      </ul>
      <div class="row">
        <button id="toTopicsBtn">お題入力へ進む</button>
      </div>
    </div>
  `;
  view.innerHTML = html;
  document.getElementById("toTopicsBtn").addEventListener("click", renderTopicEntry);
}

function addTopicPill(text) {
  const list = document.getElementById("topicList");
  if (!list) return;
  const span = document.createElement("span");
  span.className = "topic-pill";
  span.textContent = text;
  list.appendChild(span);
}

function renderTopicEntry() {
  const html = `
    <div class="card">
      <h2 class="big">お題募集フェーズ</h2>
      <div class="row">
        <input id="topicInput" type="text" placeholder="例）Aさんが寝坊した時の一言とは？" />
        <button id="addTopicBtn">追加</button>
      </div>
      <p class="small">※ お題はいくつでも追加できます</p>
      <div id="topicList" style="margin-top:8px;"></div>
      <div style="height:8px"></div>
      <div class="row">
        <button id="markTopicReadyBtn">お題入力は完了しました</button>
      </div>
      <p class="small">ホストは、全員の入力が済んだら「ゲーム開始」を押してください。</p>
    </div>
  `;
  view.innerHTML = html;

  const input = document.getElementById("topicInput");
  document.getElementById("addTopicBtn").addEventListener("click", () => {
    const t = (input.value || "").trim();
    if (!t) return;
    socket.emit("addTopic", { roomId, topic: t });
    addTopicPill(t);
    input.value = "";
    input.focus();
  });

  document.getElementById("markTopicReadyBtn").addEventListener("click", () => {
    socket.emit("markTopicReady", { roomId });
    document.getElementById("markTopicReadyBtn").disabled = true;
  });
}

function renderAnswer(topic) {
  const html = `
    <div class="card">
      <p class="kicker">お題</p>
      <h2 class="big">${escapeHtml(topic)}</h2>

      <div class="row">
        <input id="answerInput" type="text" placeholder="あなたの回答を入力" />
        <button id="sendAnswerBtn">送信</button>
      </div>
      <p class="small">全員の回答がそろうと自動で発表フェーズに進みます。</p>
    </div>
  `;
  view.innerHTML = html;

  const answerInput = document.getElementById("answerInput");
  document.getElementById("sendAnswerBtn").addEventListener("click", () => {
    const a = (answerInput.value || "").trim();
    if (!a) return;
    socket.emit("submitAnswer", { roomId, answer: a, nickname });
    answerInput.disabled = true;
  });
}

/* ===== 発表（順番）：スロット演出 → 1人分を表示 ===== */
function renderRevealWithSlot(nextAns, onDone) {
  // スロットに回す候補（参加者名）
  const options = latestAnswers.map(a => a.nickname);
  let tick = 0;
  const duration = 1400; // ms
  const interval = 70;

  const html = `
    <div class="card center">
      <p class="kicker">発表フェーズ（順番）</p>
      <div class="slot" id="slotBox">---</div>
      <div style="height:10px"></div>
      <button id="slotSkipBtn">スキップして表示</button>
    </div>
  `;
  view.innerHTML = html;

  const slotBox = document.getElementById("slotBox");
  const timer = setInterval(() => {
    slotBox.textContent = options[tick % options.length] || "---";
    tick++;
  }, interval);

  const end = () => {
    clearInterval(timer);
    renderRevealOne(nextAns);
    onDone && onDone();
  };

  const timeout = setTimeout(end, duration);
  document.getElementById("slotSkipBtn").addEventListener("click", () => {
    clearTimeout(timeout);
    end();
  });
}

/* ===== 発表（順番）：1人分の表示＋👍 ===== */
function renderRevealOne(ans, indexInRound) {
  // indexInRound は latestAnswers 内の並びindex（サーバー側もこのindexでいいね集計）
  const remain = `${revealIndex + 1} / ${latestAnswers.length}`;
  const liked = !!myLikes[indexInRound];
  const html = `
    <div class="card center">
      <p class="kicker">発表フェーズ（順番）</p>
      <h2 class="big">${escapeHtml(ans.nickname)}</h2>
      <div style="font-size:22px; margin:8px 0 16px;">${escapeHtml(ans.answer)}</div>
      <div class="small">(${remain})</div>

      <div class="like-row">
        <button class="like-btn" id="likeBtn">${liked ? "👍 取り消す" : "👍 いいね"}</button>
        <span class="like-count">Likes: <span id="likeCount">0</span></span>
      </div>

      <div style="height:8px"></div>
      <button id="revealNextBtn">${revealIndex < latestAnswers.length - 1 ? "次へ" : "発表を閉じる"}</button>
    </div>
  `;
  view.innerHTML = html;

  document.getElementById("likeBtn").addEventListener("click", () => {
    const on = !myLikes[indexInRound];
    socket.emit("likeAnswer", { roomId, index: indexInRound, on });
    myLikes[indexInRound] = on;
    document.getElementById("likeBtn").textContent = on ? "👍 取り消す" : "👍 いいね";
  });

  document.getElementById("revealNextBtn").addEventListener("click", () => {
    if (revealIndex < latestAnswers.length - 1) {
      revealIndex++;
      // 次の人をスロット演出してから表示
      renderRevealWithSlot(latestAnswers[revealIndex], null);
    } else {
      if (!isHost) renderWaitingNext();
      else renderHostNextHint();
    }
  });
}

/* ===== 発表（全員同時）：一覧表示＋各カードに👍 ===== */
function renderRevealAll() {
  const cards = latestAnswers
    .map((a, i) => `
      <div class="card">
        <p class="kicker">${escapeHtml(a.nickname)}</p>
        <div style="font-size:18px; margin:6px 0 10px;">${escapeHtml(a.answer)}</div>
        <div class="like-row">
          <button class="like-btn" data-idx="${i}">👍 いいね</button>
          <span class="like-count">Likes: <span id="likeCount-${i}">0</span></span>
        </div>
      </div>
    `).join("");

  const html = `
    <div class="card">
      <p class="kicker">発表フェーズ（全員同時）</p>
      <div class="grid">
        ${cards}
      </div>
      <div style="height:12px"></div>
      <div class="center">
        <button id="closeRevealBtn">発表を閉じる</button>
      </div>
    </div>
  `;
  view.innerHTML = html;

  document.querySelectorAll(".like-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.getAttribute("data-idx"));
      const on = !myLikes[idx];
      socket.emit("likeAnswer", { roomId, index: idx, on });
      myLikes[idx] = on;
      e.currentTarget.textContent = on ? "👍 取り消す" : "👍 いいね";
    });
  });

  document.getElementById("closeRevealBtn").addEventListener("click", () => {
    if (!isHost) renderWaitingNext(); else renderHostNextHint();
  });
}

function renderWaitingNext() {
  view.innerHTML = `
    <div class="card center">
      <h2 class="big">次のお題を待っています…</h2>
      <p class="small">ホストが「次のお題へ」を押すと表示されます</p>
    </div>
  `;
}

function renderHostNextHint() {
  view.innerHTML = `
    <div class="card center">
      <h2 class="big">みんなの発表が終わりました！</h2>
      <p class="small">「次のお題へ」を押して続けましょう</p>
    </div>
  `;
}

/* ===== スコア表示 ===== */
function renderScores(scores) {
  const arr = Object.entries(scores || {}).sort((a,b) => b[1]-a[1]);
  scoreboardEl.innerHTML = arr.map(([name, pt]) =>
    `<li><span>${escapeHtml(name)}</span><span>${pt}</span></li>`
  ).join("");
}

/* ========== Socket接続 ========== */
function connectAndJoin() {
  if (socket && socket.connected) return;

  socket = io(BACKEND_URL, { transports: ["websocket"] });

  socket.on("connect", () => {
    socket.emit("joinRoom", { roomId, nickname });
  });

  socket.on("playersUpdate", (players) => {
    playersEl.innerHTML = players.map(p => `<li>${escapeHtml(p.nickname)}</li>`).join("");
    topicProgress.total = players.length;
    answerProgress.total = players.length;
    topicProgText.textContent = `${topicProgress.done}/${topicProgress.total}`;
    answerProgText.textContent = `${answerProgress.done}/${answerProgress.total}`;
    setHostUI();
  });

  socket.on("topicsUpdate", (count) => {
    topicsCountEl.textContent = count;
  });

  socket.on("topicProgress", ({ done, total }) => {
    topicProgress = { done, total };
    topicProgText.textContent = `${done}/${total}`;
    if (isHost) startBtn.disabled = !(done === total && total > 0);
  });

  socket.on("answerProgress", ({ done, total }) => {
    answerProgress = { done, total };
    answerProgText.textContent = `${done}/${total}`;
    if (isHost) nextTopicBtn.disabled = !(done === total && total > 0);
  });

  socket.on("gameStarted", ({ mode }) => {
    currentMode = mode || currentMode;
    startBtn.disabled = true;
    nextTopicBtn.classList.toggle("hidden", !isHost);
    if (isHost) nextTopicBtn.disabled = true;
    renderWaitingNext();
  });

  socket.on("newTopic", (topic) => {
    currentTopic = topic;
    myLikes = {}; // ラウンドごとにリセット（クライアント側のメモ）
    if (isHost) nextTopicBtn.disabled = true;
    renderAnswer(topic);
  });

  // 発表：サーバーから回答一覧とモードが届く
  socket.on("showAnswers", ({ answers, mode }) => {
    latestAnswers = answers.slice();
    currentMode = mode;
    revealIndex = 0;

    if (currentMode === "all") {
      renderRevealAll();
    } else {
      // 最初の人はスロット演出してから
      renderRevealWithSlot(latestAnswers[revealIndex], null);
    }
  });

  socket.on("likesUpdate", ({ counts }) => {
    // counts: { index: numberLike }
    Object.entries(counts || {}).forEach(([idx, c]) => {
      const el = document.getElementById(`likeCount-${idx}`);
      if (el) el.textContent = c;
      if (Number(idx) === revealIndex) {
        const one = document.getElementById("likeCount");
        if (one) one.textContent = c;
      }
    });
  });

  socket.on("scoreUpdate", ({ scores }) => {
    renderScores(scores);
  });

  socket.on("noMoreTopics", () => {
    view.innerHTML = `
      <div class="card center">
        <h2 class="big">お題はすべて使い切りました！</h2>
        <p class="small">お疲れさまでした 🎉</p>
      </div>
    `;
  });
}

/* ========== 起動 ========== */
(function init() {
  const isRoom = !!roomId;

  if (!isRoom) {
    shareTools.classList.add("hidden");
    roomInfoEl.textContent = "部屋未作成";
    renderTop();
    setHostUI();
    return;
  }

  shareTools.classList.remove("hidden");
  roomInfoEl.textContent = `Room: ${roomId}`;
  const hostFlag = localStorage.getItem(`kokoro_host_${roomId}`);
  isHost = !!hostFlag;
  setHostUI();

  // トップ（参加＆ルールへ）
  renderTop();

  // ホスト操作
  startBtn.addEventListener("click", () => {
    socket.emit("startGame", { roomId });
  });
  nextTopicBtn.addEventListener("click", () => {
    socket.emit("nextTopic", { roomId });
  });
  revealModeSelect.addEventListener("change", (e) => {
    const mode = e.target.value;
    socket.emit("setRevealMode", { roomId, mode }); // サーバーに保存
  });
})();
