const BACKEND_URL = "https://kokoro-server.onrender.com";
// =======================================================

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

let socket = null;
let nickname = localStorage.getItem("kokoro_nickname") || "";
let isHost = false; // 部屋作成者のみ true
let currentTopic = "";
let revealIndex = 0;
let latestAnswers = [];

// 共有リンクUI
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
}

function renderTop() {
  const html = `
    <div class="card">
      <p class="kicker">ようこそ</p>
      <h2 class="big">「心を合わせて」へ</h2>

      <div class="row" style="margin-bottom:12px;">
        <input id="nicknameInput" type="text" placeholder="ニックネームを入力" value="${nickname || ""}" />
        ${roomId ? "" : `<button id="createRoomBtn">部屋を作る</button>`}
      </div>

      ${
        roomId
          ? `<div class="small">この部屋に参加します：<strong>${roomId}</strong></div>`
          : `<div class="small">「部屋を作る」でURLを発行 → みんなに共有してください</div>`
      }

      <div style="height:12px"></div>
      <div class="card">
        <h3>ルール</h3>
        <ol>
          <li>各自、好きなだけ「お題」を追加します。</li>
          <li>ホストが「ゲーム開始」。</li>
          <li>「次のお題へ」でランダムにお題が出題され、全員がテキスト回答。</li>
          <li>発表フェーズで、ニックネーム付きで一人ずつ回答を表示。</li>
          <li>盛り上がったら次のお題へ！</li>
        </ol>
        <button id="goRulesBtn" ${roomId ? "" : "disabled"}>ルールOK！お題入力へ</button>
      </div>
    </div>
  `;
  view.innerHTML = html;

  const nicknameInput = document.getElementById("nicknameInput");
  nicknameInput?.addEventListener("input", e => {
    nickname = e.target.value.trim();
  });

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
}

function renderRules() {
  const html = `
    <div class="card">
      <h2 class="big">ルール説明</h2>
      <p>これから「お題募集」→「回答」→「発表」をくり返して遊びます。</p>
      <ul>
        <li>お題は各自いくつでも追加OK</li>
        <li>ホストが進行（ゲーム開始/次のお題へ）</li>
        <li>回答はテキストで送信</li>
        <li>発表はニックネーム順で一人ずつ表示</li>
      </ul>
      <div class="row">
        <button id="toTopicsBtn">お題入力へ進む</button>
      </div>
    </div>
  `;
  view.innerHTML = html;
  document.getElementById("toTopicsBtn").addEventListener("click", renderTopicEntry);
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

function renderRevealOne() {
  const ans = latestAnswers[revealIndex];
  const remain = `${revealIndex + 1} / ${latestAnswers.length}`;
  const html = `
    <div class="card center">
      <p class="kicker">発表フェーズ</p>
      <h2 class="big">${escapeHtml(ans.nickname)}</h2>
      <div style="font-size:22px; margin:8px 0 16px;">${escapeHtml(ans.answer)}</div>
      <div class="small">(${remain})</div>
      <div style="height:8px"></div>
      <button id="revealNextBtn">${revealIndex < latestAnswers.length - 1 ? "次へ" : "発表を閉じる"}</button>
    </div>
  `;
  view.innerHTML = html;

  document.getElementById("revealNextBtn").addEventListener("click", () => {
    if (revealIndex < latestAnswers.length - 1) {
      revealIndex++;
      renderRevealOne();
    } else {
      // 発表終わり → ホストが「次のお題へ」
      if (!isHost) {
        // 参加者は待機表示
        renderWaitingNext();
      } else {
        renderHostNextHint();
      }
    }
  });
}

function renderWaitingNext() {
  const html = `
    <div class="card center">
      <h2 class="big">次のお題を待っています…</h2>
      <p class="small">ホストが「次のお題へ」を押すと表示されます</p>
    </div>
  `;
  view.innerHTML = html;
}

function renderHostNextHint() {
  const html = `
    <div class="card center">
      <h2 class="big">みんなの発表が終わりました！</h2>
      <p class="small">「次のお題へ」を押して続けましょう</p>
    </div>
  `;
  view.innerHTML = html;
}

function addTopicPill(text) {
  const list = document.getElementById("topicList");
  if (!list) return;
  const span = document.createElement("span");
  span.className = "topic-pill";
  span.textContent = text;
  list.appendChild(span);
}

// ===== Socket & lifecycle =====

function connectAndJoin() {
  if (socket && socket.connected) return;

  socket = io(BACKEND_URL, { transports: ["websocket"] });

  socket.on("connect", () => {
    socket.emit("joinRoom", { roomId, nickname });
  });

  socket.on("playersUpdate", (players) => {
    playersEl.innerHTML = players.map(p => `<li>${escapeHtml(p.nickname)}</li>`).join("");
  });

  socket.on("topicsUpdate", (count) => {
    topicsCountEl.textContent = count;
  });

  socket.on("gameStarted", () => {
    startBtn.disabled = true;
    nextTopicBtn.classList.toggle("hidden", !isHost);
    renderWaitingNext();
  });

  socket.on("newTopic", (topic) => {
    currentTopic = topic;
    renderAnswer(topic);
  });

  socket.on("showAnswers", (answers) => {
    latestAnswers = answers.slice(); // [{nickname, answer}]
    revealIndex = 0;
    renderRevealOne();
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

// ===== Helpers =====

function makeRoomId() {
  const s = "abcdefghjkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += s[Math.floor(Math.random() * s.length)];
  return id;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ===== Boot =====

(function init() {
  const isRoom = !!roomId;
  if (!isRoom) {
    shareTools.classList.add("hidden");
    roomInfoEl.textContent = "部屋未作成";
    renderTop();
    setHostUI();
    return;
  }

  // 共有UI
  shareTools.classList.remove("hidden");
  roomInfoEl.textContent = `Room: ${roomId}`;
  const hostFlag = localStorage.getItem(`kokoro_host_${roomId}`);
  isHost = !!hostFlag;
  setHostUI();

  // トップ画面（参加＆ルールOKへ）
  renderTop();

  // ホスト操作ボタン
  startBtn.addEventListener("click", () => {
    socket.emit("startGame", { roomId });
  });
  nextTopicBtn.addEventListener("click", () => {
    socket.emit("nextTopic", { roomId });
  });
})();
