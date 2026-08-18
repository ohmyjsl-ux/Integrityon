const C = CHEONGRYEOM_CONTENT;
const DB = CheongDB;
const $ = (selector) => document.querySelector(selector);

let code = null;
let roomMeta = null;
let control = { stage: "waiting", index: 0, phase: "exam", reveal: false, locked: true, timerEndsAt: null };
let participants = {};
let presence = {};
let answers = {};
let pledges = {};
let unsubs = [];
let timerLockPending = false;

const stages = C.stages;
const storageKey = "cheongryeomTeacherRoom";
const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const toast = (message) => {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2200);
};
const stageIdx = (key) => stages.findIndex((stage) => stage.key === key);
const virtue = (key) => C.virtues.find((item) => item.key === key);

function items(stage) {
  if (stage === "written") return C.written;
  if (stage === "practical") return C.practical;
  if (stage === "team") return C.teamMission.tasks;
  return [];
}

function item() {
  return items(control.stage)[Number(control.index || 0)] || null;
}

function answer(stage, key, uid) {
  return answers?.[stage]?.[key]?.[uid] || null;
}

function practicalAnswer(taskId, uid) {
  return answer("practical", taskId, uid)?.payload || null;
}

function teamAnswer(taskId, uid) {
  return answer("team", `${C.teamMission.id}_${taskId}`, uid)?.payload || null;
}

function scorePracticalTask(task, payload) {
  if (!payload) return 0;
  if (task.type === "sequence") {
    const order = Array.isArray(payload.order) ? payload.order : [];
    const correct = task.correctOrder.filter((value, index) => order[index] === value).length;
    return Math.round((task.points * correct) / task.correctOrder.length);
  }
  if (task.type === "weights") {
    const values = payload.values || {};
    const total = task.criteria.reduce((sum, criterion) => sum + Number(values[criterion.key] || 0), 0);
    if (total !== 100) return 0;
    const deviation = task.criteria.reduce((sum, criterion) => sum + Math.abs(Number(values[criterion.key] || 0) - criterion.target), 0);
    return Math.max(0, Math.round(task.points * (1 - deviation / 100)));
  }
  if (task.type === "audit") {
    const selected = Array.isArray(payload.selected) ? payload.selected : [];
    const hits = selected.filter((index) => task.records[index]?.risk).length;
    const falseHits = selected.length - hits;
    return Math.max(0, Math.round((task.points * hits) / task.required) - falseHits * 5);
  }
  return 0;
}

function scoreTeamTask(task, payload, uid) {
  if (!payload) return 0;
  if (task.id === "inspect") {
    const role = C.teamMission.roles[Number(participants?.[uid]?.roleIndex || 0)] || C.teamMission.roles[0];
    return (payload.risk === role.correctRisk ? 15 : 0) + (String(payload.brief || "").trim().length >= task.minLength ? 10 : 0);
  }
  if (task.id === "hearing") {
    const verdict = Number(payload.verdict) === task.correctVerdict ? 15 : 0;
    const order = Array.isArray(payload.order) ? payload.order : [];
    const positions = task.correctOrder.filter((value, index) => order[index] === value).length;
    return verdict + Math.round((20 * positions) / task.correctOrder.length);
  }
  if (task.id === "protocol") {
    const selected = Array.isArray(payload.selected) ? payload.selected : [];
    const good = selected.filter((index) => task.actions[index]?.correct).length;
    const bad = selected.length - good;
    return Math.min(task.points, Math.max(0, good * 8 - bad * 6) + (String(payload.statement || "").trim().length >= task.minLength ? 16 : 0));
  }
  return 0;
}

function completed(uid, stage) {
  const closed = stageIdx(control?.stage || "waiting") > stageIdx(stage) ||
    (control?.stage === stage && control?.phase === "report");
  if (stage === "written") return closed || C.written.every((question) => answer("written", question.id, uid));
  if (stage === "practical") return closed || C.practical.every((task) => practicalAnswer(task.id, uid));
  if (stage === "team") return closed || C.teamMission.tasks.every((task) => teamAnswer(task.id, uid));
  return false;
}

function competency(uid) {
  const sums = Object.fromEntries(C.virtues.map((item) => [item.key, { value: 0, count: 0 }]));
  const add = (key, value) => {
    if (!sums[key]) return;
    sums[key].value += Math.max(0, Math.min(100, value));
    sums[key].count += 1;
  };
  C.written.forEach((question) => {
    const response = answer("written", question.id, uid);
    if (!response) return;
    Object.entries(question.impact || {}).forEach(([key, value]) => add(key, response.choice === question.correct ? value : value * 0.3));
  });
  C.practical.forEach((task) => {
    const response = practicalAnswer(task.id, uid);
    if (!response) return;
    const ratio = scorePracticalTask(task, response) / task.points;
    Object.entries(task.impact || {}).forEach(([key, value]) => add(key, value * ratio));
  });
  C.teamMission.tasks.forEach((task) => {
    const response = teamAnswer(task.id, uid);
    if (!response) return;
    const ratio = scoreTeamTask(task, response, uid) / task.points;
    const map = task.id === "inspect" ? { honesty: 80, responsibility: 70 } : task.id === "hearing" ? { fairness: 90, care: 70 } : { promise: 95, responsibility: 85, care: 60 };
    Object.entries(map).forEach(([key, value]) => add(key, value * ratio));
  });
  return Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, value.count ? Math.round(value.value / value.count) : 0]));
}

function calcStudent(uid) {
  const writtenCorrect = C.written.filter((question) => answer("written", question.id, uid)?.choice === question.correct).length;
  const written = Math.round((writtenCorrect / C.written.length) * 100);
  const practical = C.practical.reduce((sum, task) => sum + scorePracticalTask(task, practicalAnswer(task.id, uid)), 0);
  const team = C.teamMission.tasks.reduce((sum, task) => sum + scoreTeamTask(task, teamAnswer(task.id, uid), uid), 0);
  const examComplete = completed(uid, "written") && completed(uid, "practical") && completed(uid, "team");
  const complete = examComplete && Boolean(pledges?.[uid]?.text);
  const total = Math.round((written * C.scoring.writtenWeight) / 100 + (practical * C.scoring.practicalWeight) / 100 + (team * C.scoring.teamWeight) / 100);
  const qualification = complete && total >= C.scoring.leaderTotal && practical >= C.scoring.leaderPractical && team >= C.scoring.leaderTeam
    ? "청렴 리더"
    : complete && total >= C.scoring.passTotal
      ? "청렴 서포터"
      : complete
        ? "재도전 권장"
        : "과정 진행 중";
  return { written, practical, team, total, complete, qualification };
}

function studentURL() {
  const url = new URL("student.html", location.href);
  url.searchParams.set("room", code);
  return url.href;
}

function renderQR() {
  const target = $("#qr");
  target.innerHTML = "";
  if (window.QRCode) new QRCode(target, { text: studentURL(), width: 170, height: 170, colorDark: "#063b5c", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
  else target.innerHTML = '<div class="helper">QR을 불러오지 못했습니다.<br>학생 링크 복사 버튼을 사용하세요.</div>';
}

function renderNav() {
  $("#stageNav").innerHTML = stages.map((stage, index) => `<button class="stage-btn ${stage.key === control.stage ? "active" : ""}" data-key="${stage.key}"><span class="stage-num">${index + 1}</span><span class="stage-copy"><small>${esc(stage.step)} · ${stage.duration}분</small><b>${esc(stage.name)}</b></span></button>`).join("");
  document.querySelectorAll(".stage-btn").forEach((button) => { button.onclick = () => go(button.dataset.key, 0); });
}

function scheduleHTML() {
  return `<div class="schedule-strip">${stages.map((stage) => `<div class="schedule-item"><small>${esc(stage.step)}</small><b>${esc(stage.short)}</b><span>${stage.duration}분</span></div>`).join("")}</div>`;
}

const stageCharacter = { waiting: "character-greeting.png", written: "character-warning.png", practical: "character-tablet-cyber.png", team: "character-together.png", result: "character-harmony.png" };
function charBox(stage) {
  return `<div class="teacher-char character-panel"><img class="official-character" src="assets/official/${stageCharacter[stage] || "character-guide.png"}" alt="청렴 교육 캐릭터"></div>`;
}

function bars(labels, list) {
  const counts = Array(labels.length).fill(0);
  list.forEach((response) => { if (Number.isInteger(response?.choice) && counts[response.choice] != null) counts[response.choice] += 1; });
  return labels.map((label, index) => {
    const percent = list.length ? Math.round((counts[index] / list.length) * 100) : 0;
    return `<div class="bar-row"><b class="bar-letter">${String.fromCharCode(65 + index)}</b><div class="bar-track" title="${esc(label)}"><div class="bar-fill" style="width:${percent}%"></div></div><span class="bar-value">${counts[index]}명 · ${percent}%</span></div>`;
  }).join("");
}

function scoreTiles(stage) {
  const ids = Object.keys(participants);
  const values = ids.map((uid) => calcStudent(uid)[stage]);
  const done = ids.filter((uid) => completed(uid, stage));
  const average = done.length ? Math.round(done.reduce((sum, uid) => sum + calcStudent(uid)[stage], 0) / done.length) : 0;
  const high = values.filter((value) => value >= 85).length;
  const needs = values.filter((value) => value > 0 && value < 60).length;
  return `<div class="result-summary"><div class="result-tile leader-tile"><b>${average}</b><span>완료자 평균</span></div><div class="result-tile"><b>${done.length}/${ids.length}</b><span>채점 완료</span></div><div class="result-tile"><b>${high}</b><span>85점 이상</span></div><div class="result-tile"><b>${needs}</b><span>환류 필요</span></div></div>`;
}

function stageReportHTML(stage) {
  const info = stages.find((item) => item.key === stage);
  const focus = stage === "written" ? "오답 문항의 판단 기준을 짧게 다시 말하게 해보세요." : stage === "practical" ? "점수보다 작업 순서·기준표·위험탐지 과정의 차이를 질문하세요." : "모둠 점수가 아닌 정보 공유와 합의의 질을 되짚어보세요.";
  return `<span class="eyebrow">SECTION SCORE REPORT</span><h2>${esc(info.short)} 채점·환류</h2><p class="context-box">학생 화면에 개인 100점 성적표, 강점역량, 보완역량과 다음 행동 문장이 공개되었습니다. 다음 단계로 바로 넘기지 말고 1분간 결과를 읽게 해주세요.</p>${scoreTiles(stage)}<div class="change-box"><b>교사 환류 질문</b><br>${esc(focus)}</div>`;
}

function practicalPreview(task) {
  const typeName = { sequence: "절차 배열", weights: "100점 기준표 설계", audit: "디지털 오류 탐지" }[task.type];
  const sample = task.type === "sequence"
    ? `<div class="evidence-mini-grid">${task.cards.map((card, index) => `<div><small>업무카드 ${index + 1}</small><b>${esc(card)}</b></div>`).join("")}</div>`
    : task.type === "weights"
      ? `<div class="evidence-mini-grid">${task.criteria.map((criterion) => `<div><small>평가항목</small><b>${esc(criterion.label)} · 모범 ${criterion.target}점</b></div>`).join("")}</div>`
      : `<div class="evidence-mini-grid">${task.records.map((record) => `<div><small>${record.risk ? "위험신호" : "정상기록"}</small><b>${esc(record.title)}</b></div>`).join("")}</div>`;
  return `<span class="eyebrow">PRACTICAL WORK ${Number(control.index) + 1}/${C.practical.length}</span><h2>${esc(task.title)}</h2><p class="context-box">${esc(task.brief)}</p><div class="activity-signature"><b>${esc(typeName)}</b><span>${task.points}점 · 버튼 선택형이 아닌 실제 수행작업</span></div>${sample}<div class="change-box"><b>관찰 포인트</b><br>${esc(task.feedback)}</div>`;
}

function teamPreview(task) {
  const mission = C.teamMission;
  const roleHTML = mission.roles.map((role, index) => `<div class="role-mini"><span>${index + 1}</span><b>${esc(role.name)}</b><small>${esc(role.icon)} 증거</small></div>`).join("");
  return `<span class="eyebrow">TEAM PERFORMANCE ${Number(control.index) + 1}/${mission.tasks.length}</span><h2>${esc(task.title)}</h2><p class="context-box">${esc(task.instruction)}</p><div class="role-mini-grid">${roleHTML}</div><div class="change-box"><b>차별화 장치 · 분산정보 합동감사</b><br>${esc(mission.guide)}</div>`;
}

function resultSummaryHTML() {
  const results = Object.keys(participants).map(calcStudent);
  const leader = results.filter((result) => result.qualification === "청렴 리더").length;
  const supporter = results.filter((result) => result.qualification === "청렴 서포터").length;
  const retry = results.filter((result) => result.qualification === "재도전 권장").length;
  const incomplete = results.filter((result) => !result.complete).length;
  return `<div class="result-summary"><div class="result-tile leader-tile"><b>${leader}</b><span>청렴 리더</span></div><div class="result-tile"><b>${supporter}</b><span>청렴 서포터</span></div><div class="result-tile"><b>${retry}</b><span>재도전 권장</span></div><div class="result-tile"><b>${incomplete}</b><span>미완료</span></div></div>`;
}

function renderContent() {
  renderNav();
  const stage = stages.find((value) => value.key === control.stage) || stages[0];
  const question = item();
  const isReport = control.phase === "report";
  $("#stageKicker").textContent = `${stage.step} · ${stage.duration}분`;
  $("#stageTitle").textContent = stage.name;
  $("#timerBtn").classList.toggle("hidden", control.stage !== "written" || isReport);
  $("#revealBtn").classList.toggle("hidden", control.stage !== "written" || isReport);
  $("#teamBtn").classList.toggle("hidden", control.stage !== "team" || isReport);
  $("#timerBtn").textContent = `${C.writtenSeconds}초 시작`;
  $("#teamBtn").textContent = "4인 1조 역할편성";
  $("#revealBtn").textContent = control.reveal ? "해설 숨기기" : "정답·해설 공개";

  let html = "";
  if (control.stage === "waiting") html = `<span class="eyebrow">EXAM CHECK-IN</span><h2>${esc(C.intro.title)}</h2><p class="context-box">${esc(C.intro.body)}</p>${scheduleHTML()}<div class="change-box"><b>총 ${C.program.totalMinutes}분 · 준비물 최소화</b><br>교사 PC 1대와 학생 휴대폰만으로 수험등록, 채점, 환류, 디지털 인증까지 진행합니다.</div>`;
  if (control.stage === "written") {
    if (isReport) html = stageReportHTML("written");
    else html = `<div class="timer-panel"><div><small>문항당 제한시간</small><strong id="teacherTimer">대기</strong></div><p>‘${C.writtenSeconds}초 시작’을 누르면 학생 답안이 동시에 열립니다. 종료 후 해설을 공개하세요.</p></div><span class="eyebrow">WRITTEN EXAM ${Number(control.index) + 1}/${C.written.length}</span><small class="domain-chip">출제영역 · ${esc(virtue(question.virtue)?.name)}</small><h2>${esc(question.q)}</h2><div class="option-grid">${question.options.map((option, index) => `<div class="option-view"><b>${String.fromCharCode(65 + index)}.</b> ${esc(option)}</div>`).join("")}</div>${control.reveal ? `<div class="feedback good"><b>정답 ${String.fromCharCode(65 + question.correct)}</b><br>${esc(question.ex)}</div>` : ""}`;
  }
  if (control.stage === "practical") html = isReport ? stageReportHTML("practical") : practicalPreview(question);
  if (control.stage === "team") html = isReport ? stageReportHTML("team") : teamPreview(question);
  if (control.stage === "result") {
    const phase = control.phase === "certificate" ? "certificate" : "pledge";
    html = `<span class="eyebrow">${phase === "pledge" ? "ACTION PLEDGE" : "QUALIFICATION"}</span><h2>${phase === "pledge" ? "점수를 행동으로 바꾸는 실천서약" : "청렴직무능력 종합판정"}</h2><p class="context-box">${phase === "pledge" ? "학생이 보완역량을 학교생활의 구체적인 행동으로 바꿔 작성합니다. 모두 제출하면 인증서를 공개하세요." : "필기 30%·실기 35%·조별과제 35%를 합산한 결과와 교육용 인증서가 학생 화면에 표시됩니다."}</p><div class="phase-tools"><button class="btn ${phase === "pledge" ? "primary" : "outline"}" onclick="setResultPhase('pledge')">① 실천서약</button><button class="btn ${phase === "certificate" ? "primary" : "outline"}" onclick="setResultPhase('certificate')">② 종합판정 공개</button></div>${phase === "certificate" ? resultSummaryHTML() : ""}`;
  }
  $("#teacherContent").innerHTML = `<div class="teacher-content-grid"><div>${html}</div>${charBox(control.stage)}</div>`;
  renderStats();
  renderClassComp();
  renderRoster();

  const list = items(control.stage);
  $("#prevBtn").disabled = stageIdx(control.stage) === 0 && Number(control.index) === 0;
  if (control.stage === "result") {
    $("#nextBtn").textContent = control.phase === "certificate" ? "종합판정 공개 중" : "종합판정 공개 →";
    $("#nextBtn").disabled = control.phase === "certificate";
  } else if (isReport) {
    $("#nextBtn").textContent = "다음 시험 시작 →";
    $("#nextBtn").disabled = false;
  } else {
    $("#nextBtn").textContent = list.length && Number(control.index) < list.length - 1 ? "다음 문항·작업 →" : list.length ? `${stage.short} 채점 →` : "필기시험 시작 →";
    $("#nextBtn").disabled = false;
  }
  updateTimer();
}

function renderStats() {
  const ids = Object.keys(participants);
  const question = item();
  if (control.phase === "report" && ["written", "practical", "team"].includes(control.stage)) {
    $("#responseChip").textContent = `${ids.filter((uid) => completed(uid, control.stage)).length}/${ids.length}명 채점`;
    $("#statsArea").className = "";
    $("#statsArea").innerHTML = scoreTiles(control.stage);
    return;
  }
  if (control.stage === "written") {
    const list = Object.values(answers?.written?.[question.id] || {});
    $("#responseChip").textContent = `${list.length}명 응답`;
    $("#statsArea").className = "";
    $("#statsArea").innerHTML = bars(question.options, list);
    publishPublic(question.options, list);
    return;
  }
  if (control.stage === "practical") {
    const responses = Object.entries(answers?.practical?.[question.id] || {});
    const average = responses.length ? Math.round(responses.reduce((sum, [, response]) => sum + scorePracticalTask(question, response.payload), 0) / responses.length) : 0;
    $("#responseChip").textContent = `${responses.length}/${ids.length}명 제출`;
    $("#statsArea").className = "";
    $("#statsArea").innerHTML = `<div class="live-task"><span>현재 작업 평균</span><strong>${average}<small>/${question.points}점</small></strong><p>학생별 결과는 자동 저장되며, 실기시험 종료 뒤 100점 성적표로 환산됩니다.</p></div>`;
    return;
  }
  if (control.stage === "team") {
    $("#responseChip").textContent = `${Object.keys(answers?.team?.[`${C.teamMission.id}_${question.id}`] || {}).length}/${ids.length}명 제출`;
    $("#statsArea").className = "";
    $("#statsArea").innerHTML = teamCards(question);
    return;
  }
  if (control.stage === "result") {
    $("#responseChip").textContent = `${Object.keys(pledges).length}/${ids.length}명 서약`;
    $("#statsArea").innerHTML = `<div class="empty">학생의 서약 내용은 CSV 결과표에 함께 저장할 수 있습니다.</div>`;
    return;
  }
  $("#responseChip").textContent = "집계 대기";
  $("#statsArea").innerHTML = '<div class="empty">필기시험을 시작하면 실시간 응답과 채점 현황이 표시됩니다.</div>';
}

function teamNumbers() {
  return [...new Set(Object.values(participants).map((participant) => Number(participant.teamNo)).filter(Number.isInteger))].sort((a, b) => a - b);
}

function teamCards(task) {
  const teams = teamNumbers();
  if (!teams.length) return '<div class="empty">‘4인 1조 역할편성’을 눌러 분산정보 역할을 배정해주세요.</div>';
  return `<div class="team-grid">${teams.map((teamNo) => {
    const entries = Object.entries(participants).filter(([, participant]) => participant.teamNo === teamNo);
    const done = entries.filter(([uid]) => teamAnswer(task.id, uid));
    const average = done.length ? Math.round(done.reduce((sum, [uid]) => sum + scoreTeamTask(task, teamAnswer(task.id, uid), uid), 0) / done.length) : 0;
    return `<article class="team-card ${done.length === entries.length && done.length ? "submitted" : ""}"><div><b>${teamNo}조</b><small>${entries.map(([, participant]) => esc(participant.studentName)).join(" · ")}</small></div><strong>${average}<small>/${task.points}</small></strong><span>${done.length}/${entries.length}명</span></article>`;
  }).join("")}</div>`;
}

function renderClassComp() {
  const ids = Object.keys(participants);
  const totals = Object.fromEntries(C.virtues.map((item) => [item.key, 0]));
  ids.forEach((uid) => {
    const values = competency(uid);
    C.virtues.forEach((item) => { totals[item.key] += values[item.key] || 0; });
  });
  $("#classComp").innerHTML = C.virtues.map((item) => {
    const value = ids.length ? Math.round(totals[item.key] / ids.length) : 0;
    return `<div class="comp-row"><div class="comp-meta"><span>${esc(item.name)}</span><b>${value}</b></div><div class="comp-track"><span style="width:${value}%"></span></div></div>`;
  }).join("");
}

function renderRoster() {
  const entries = Object.entries(participants).sort(([, a], [, b]) => String(a.studentName || "").localeCompare(String(b.studentName || ""), "ko"));
  $("#roster").innerHTML = entries.length ? entries.map(([uid, participant]) => {
    const result = calcStudent(uid);
    const role = participant.teamNo ? C.teamMission.roles[Number(participant.roleIndex || 0)]?.name : "역할 대기";
    return `<div class="roster-item ${result.complete ? "done" : ""}"><div><b>${esc(participant.studentName || "이름 미확인")}</b><span>${participant.schoolLevel === "high" ? "고등학생" : "중학생"} · ${participant.teamNo ? `${participant.teamNo}조 ${esc(role)}` : "미편성"}</span></div><div class="roster-scores"><span>필 ${result.written}</span><span>실 ${result.practical}</span><span>조 ${result.team}</span><b>${result.complete ? result.qualification : "진행 중"}</b></div></div>`;
  }).join("") : '<div class="empty" style="grid-column:1/-1;min-height:80px">아직 등록한 학생이 없습니다.</div>';
}

async function publishPublic(labels, list) {
  if (!code) return;
  const counts = Array(labels.length).fill(0);
  list.forEach((response) => { if (Number.isInteger(response?.choice)) counts[response.choice] += 1; });
  try {
    await DB.publishStats(code, { participantCount: Object.keys(presence).length, stage: control.stage, index: Number(control.index || 0), labels, counts, total: list.length });
  } catch (error) {
    console.warn("공개 통계 갱신 실패", error);
  }
}

function controlDefaults(stage, index, phase = "exam") {
  return { stage, index, phase: stage === "result" ? "pledge" : phase, reveal: false, locked: stage === "written", timerEndsAt: null };
}

async function go(stage, index = 0) {
  await DB.setControl(code, controlDefaults(stage, index));
}

window.setResultPhase = (phase) => DB.setControl(code, { phase, locked: false, timerEndsAt: null });

async function next() {
  if (control.stage === "result") {
    if (control.phase !== "certificate") return window.setResultPhase("certificate");
    return;
  }
  const list = items(control.stage);
  const index = Number(control.index || 0);
  if (control.phase === "report") {
    const nextStage = stages[stageIdx(control.stage) + 1];
    if (nextStage) return go(nextStage.key, 0);
    return;
  }
  if (list.length && index < list.length - 1) return DB.setControl(code, controlDefaults(control.stage, index + 1));
  if (list.length && ["written", "practical", "team"].includes(control.stage)) return DB.setControl(code, controlDefaults(control.stage, index, "report"));
  const nextStage = stages[stageIdx(control.stage) + 1];
  if (nextStage) return go(nextStage.key, 0);
}

async function prev() {
  if (control.stage === "result" && control.phase === "certificate") return window.setResultPhase("pledge");
  const list = items(control.stage);
  const index = Number(control.index || 0);
  if (control.phase === "report") return DB.setControl(code, controlDefaults(control.stage, Math.max(0, list.length - 1)));
  if (list.length && index > 0) return DB.setControl(code, controlDefaults(control.stage, index - 1));
  const previousStage = stages[stageIdx(control.stage) - 1];
  if (previousStage) {
    const previousItems = items(previousStage.key);
    const previousPhase = ["written", "practical", "team"].includes(previousStage.key) ? "report" : "exam";
    return DB.setControl(code, controlDefaults(previousStage.key, Math.max(0, previousItems.length - 1), previousPhase));
  }
}

async function startTimer() {
  timerLockPending = false;
  await DB.setControl(code, { locked: false, reveal: false, timerEndsAt: Date.now() + C.writtenSeconds * 1000 });
}

function updateTimer() {
  const element = $("#teacherTimer");
  if (!element) return;
  if (control.stage !== "written" || !control.timerEndsAt || control.phase === "report") {
    element.textContent = control.reveal ? "해설" : "대기";
    element.classList.remove("urgent");
    return;
  }
  const remaining = Math.max(0, Number(control.timerEndsAt) - Date.now());
  element.textContent = `${(remaining / 1000).toFixed(1)}초`;
  element.classList.toggle("urgent", remaining <= 3000);
  if (remaining <= 0 && !control.locked && !timerLockPending) {
    timerLockPending = true;
    DB.setControl(code, { locked: true, timerEndsAt: null }).finally(() => { timerLockPending = false; });
  }
}

async function assignTeams() {
  const ids = Object.keys(participants).sort((a, b) => Number(participants[a]?.joinedAt || 0) - Number(participants[b]?.joinedAt || 0));
  if (!ids.length) return toast("등록한 학생이 없습니다.");
  if (Object.keys(answers?.team || {}).length && !confirm("이미 제출된 조별과제가 있습니다. 역할을 다시 편성할까요?")) return;
  const assignments = {};
  ids.forEach((uid, index) => {
    assignments[uid] = { teamNo: Math.floor(index / 4) + 1, roleIndex: index % 4 };
  });
  await DB.assignTeams(code, assignments);
  toast(`${Math.ceil(ids.length / 4)}개 조에 4가지 감사역할을 배정했습니다.`);
}

function subscribe() {
  unsubs.forEach((unsubscribe) => unsubscribe());
  unsubs = [
    DB.on("control", code, (value) => { control = value || control; renderContent(); }),
    DB.on("participants", code, (value) => { participants = value || {}; $("#joinedCount").textContent = Object.keys(participants).length; renderContent(); }),
    DB.on("presence", code, (value) => { presence = value || {}; $("#activeCount").textContent = Object.keys(presence).length; }),
    DB.on("answers", code, (value) => { answers = value || {}; renderContent(); }),
    DB.on("pledges", code, (value) => { pledges = value || {}; renderContent(); }),
  ];
}

async function openDashboard(roomCode, meta) {
  code = roomCode;
  roomMeta = meta;
  localStorage.setItem(storageKey, code);
  $("#roomSetup").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  $("#roomCode").textContent = code;
  $("#roomName").textContent = roomMeta?.title || C.program.title;
  renderQR();
  subscribe();
}

async function create() {
  const requestedCode = $("#roomCodeInput").value.trim();
  if (requestedCode && !/^\d{6}$/.test(requestedCode)) return toast("수업방 코드는 6자리 숫자로 입력해주세요.");
  const title = $("#roomTitleInput").value.trim() || C.program.title;
  const attempts = requestedCode ? 1 : 6;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const nextCode = requestedCode || String(Math.floor(100000 + Math.random() * 900000));
    try {
      await DB.createRoom(nextCode, title);
      await openDashboard(nextCode, { title, hostUid: DB.uid, status: "open" });
      toast("수업방을 개설했습니다.");
      return;
    } catch (error) {
      if (requestedCode || !String(error.message).includes("사용 중")) {
        toast(error.message || "수업방 개설에 실패했습니다.");
        return;
      }
    }
  }
  toast("참여코드 생성에 실패했습니다. 다시 시도해주세요.");
}

async function copyStudentLink() {
  const link = studentURL();
  try {
    await navigator.clipboard.writeText(link);
    toast("학생 링크를 복사했습니다.");
  } catch (error) {
    window.prompt("아래 학생 링크를 복사해주세요.", link);
  }
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCSV() {
  const rows = [["수험ID", "학생이름", "학교급", "조", "감사역할", "필기시험", "실기시험", "조별과제", "종합", "판정", "강점역량", "보완역량", "실천서약"]];
  Object.entries(participants).forEach(([uid, participant]) => {
    const result = calcStudent(uid);
    const values = competency(uid);
    const ranked = C.virtues.map((item) => ({ ...item, value: values[item.key] || 0 })).sort((a, b) => b.value - a.value);
    rows.push([uid, participant.studentName, participant.schoolLevel === "high" ? "고등학생" : "중학생", participant.teamNo || "미편성", C.teamMission.roles[Number(participant.roleIndex || 0)]?.name || "미배정", result.written, result.practical, result.team, result.total, result.qualification, ranked[0]?.name || "-", ranked[ranked.length - 1]?.name || "-", pledges?.[uid]?.text || ""]);
  });
  const data = "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blobUrl = URL.createObjectURL(new Blob([data], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `청렴ON_${code}_검정결과.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

async function initialize() {
  if (!DB.configured) {
    $("#configError").classList.remove("hidden");
    $("#serverStatus").textContent = "설정 필요";
    $("#serverStatus").classList.add("error");
    return;
  }
  try {
    await DB.init();
    $("#serverStatus").textContent = "실시간 서버 연결";
    $("#serverStatus").classList.add("online");
    $("#createRoomBtn").onclick = create;
    $("#nextBtn").onclick = next;
    $("#prevBtn").onclick = prev;
    $("#timerBtn").onclick = startTimer;
    $("#teamBtn").onclick = assignTeams;
    $("#revealBtn").onclick = () => DB.setControl(code, { reveal: !control.reveal, locked: true, timerEndsAt: null });
    $("#copyLink").onclick = copyStudentLink;
    $("#exportBtn").onclick = exportCSV;
    $("#deleteBtn").onclick = async () => {
      if (!confirm("수업방과 학생 이름·응답·서약을 모두 삭제할까요?")) return;
      await DB.deleteRoom(code);
      localStorage.removeItem(storageKey);
      location.reload();
    };
    const savedCode = localStorage.getItem(storageKey);
    if (savedCode && /^\d{6}$/.test(savedCode)) {
      const savedMeta = await DB.ownedRoom(savedCode);
      if (savedMeta) {
        await openDashboard(savedCode, savedMeta);
        toast("진행 중이던 수업방을 다시 열었습니다.");
        return;
      }
      localStorage.removeItem(storageKey);
    }
    $("#roomSetup").classList.remove("hidden");
  } catch (error) {
    console.error(error);
    $("#configError").classList.remove("hidden");
    $("#serverStatus").textContent = "연결 실패";
    $("#serverStatus").classList.add("error");
  }
}

setInterval(updateTimer, 150);
initialize();
