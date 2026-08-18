const C = CHEONGRYEOM_CONTENT;
const DB = CheongDB;
const $ = (selector) => document.querySelector(selector);

let code = null;
let control = null;
let myAnswers = { written: {}, practical: {}, team: {} };
let myPledge = null;
let me = null;
let draft = {};
let rapidSubmitting = false;
let unsubs = [];
let heartbeatTimer = null;
let controlKey = "";

const stages = C.stages;
const storageKey = "cheongryeomStudentRoom";

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const toast = (message) => {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2200);
};

const stageIdx = (key) => stages.findIndex((stage) => stage.key === key);
const virtue = (key) => C.virtues.find((item) => item.key === key);

function currentItem() {
  if (control?.stage === "written") return C.written[Number(control.index || 0)];
  if (control?.stage === "practical") return C.practical[Number(control.index || 0)];
  if (control?.stage === "team") return C.teamMission.tasks[Number(control.index || 0)];
  return null;
}

function mine(stage, key) {
  return myAnswers?.[stage]?.[key] || null;
}

function practicalAnswer(taskId) {
  return mine("practical", taskId)?.payload || null;
}

function teamAnswer(taskId) {
  return mine("team", `${C.teamMission.id}_${taskId}`)?.payload || null;
}

function writtenScore() {
  const correct = C.written.filter(
    (question) => mine("written", question.id)?.choice === question.correct,
  ).length;
  return Math.round((correct / C.written.length) * 100);
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
    const total = task.criteria.reduce((sum, item) => sum + Number(values[item.key] || 0), 0);
    if (total !== 100) return 0;
    const deviation = task.criteria.reduce(
      (sum, item) => sum + Math.abs(Number(values[item.key] || 0) - item.target),
      0,
    );
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

function practicalScore() {
  return C.practical.reduce(
    (sum, task) => sum + scorePracticalTask(task, practicalAnswer(task.id)),
    0,
  );
}

function scoreTeamTask(task, payload) {
  if (!payload) return 0;
  if (task.id === "inspect") {
    const role = C.teamMission.roles[Number(me?.roleIndex || 0)] || C.teamMission.roles[0];
    return (payload.risk === role.correctRisk ? 15 : 0) +
      (String(payload.brief || "").trim().length >= task.minLength ? 10 : 0);
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
    const actionScore = Math.max(0, good * 8 - bad * 6);
    const writingScore = String(payload.statement || "").trim().length >= task.minLength ? 16 : 0;
    return Math.min(task.points, actionScore + writingScore);
  }
  return 0;
}

function teamScore() {
  return C.teamMission.tasks.reduce(
    (sum, task) => sum + scoreTeamTask(task, teamAnswer(task.id)),
    0,
  );
}

function completed(stage) {
  const closed = stageIdx(control?.stage || "waiting") > stageIdx(stage) ||
    (control?.stage === stage && control?.phase === "report");
  if (stage === "written") return closed || C.written.every((question) => mine("written", question.id));
  if (stage === "practical") return closed || C.practical.every((task) => practicalAnswer(task.id));
  if (stage === "team") return closed || C.teamMission.tasks.every((task) => teamAnswer(task.id));
  return false;
}

function competency() {
  const sums = Object.fromEntries(C.virtues.map((item) => [item.key, { value: 0, count: 0 }]));
  const add = (key, value) => {
    if (!sums[key]) return;
    sums[key].value += Math.max(0, Math.min(100, value));
    sums[key].count += 1;
  };

  C.written.forEach((question) => {
    const answer = mine("written", question.id);
    if (!answer) return;
    Object.entries(question.impact || {}).forEach(([key, value]) =>
      add(key, answer.choice === question.correct ? value : value * 0.3),
    );
  });
  C.practical.forEach((task) => {
    const answer = practicalAnswer(task.id);
    if (!answer) return;
    const ratio = task.points ? scorePracticalTask(task, answer) / task.points : 0;
    Object.entries(task.impact || {}).forEach(([key, value]) => add(key, value * ratio));
  });
  C.teamMission.tasks.forEach((task) => {
    const answer = teamAnswer(task.id);
    if (!answer) return;
    const ratio = task.points ? scoreTeamTask(task, answer) / task.points : 0;
    const map = task.id === "inspect"
      ? { honesty: 80, responsibility: 70 }
      : task.id === "hearing"
        ? { fairness: 90, care: 70 }
        : { promise: 95, responsibility: 85, care: 60 };
    Object.entries(map).forEach(([key, value]) => add(key, value * ratio));
  });
  return Object.fromEntries(
    Object.entries(sums).map(([key, item]) => [key, item.count ? Math.round(item.value / item.count) : 0]),
  );
}

function scores() {
  const written = writtenScore();
  const practical = practicalScore();
  const team = teamScore();
  const examComplete = completed("written") && completed("practical") && completed("team");
  const complete = examComplete && Boolean(myPledge?.text);
  const total = Math.round(
    (written * C.scoring.writtenWeight) / 100 +
    (practical * C.scoring.practicalWeight) / 100 +
    (team * C.scoring.teamWeight) / 100,
  );
  const qualification = complete && total >= C.scoring.leaderTotal && practical >= C.scoring.leaderPractical && team >= C.scoring.leaderTeam
    ? "청렴 리더"
    : complete && total >= C.scoring.passTotal
      ? "청렴 서포터"
      : complete
        ? "재도전 권장"
        : "과정 진행 중";
  return { written, practical, team, total, complete, qualification };
}

function progress() {
  const index = Math.max(0, stageIdx(control?.stage || "waiting"));
  const base = Math.round((index / (stages.length - 1)) * 100);
  const percent = control?.phase === "report" ? Math.min(100, base + 8) : base;
  $("#studentStage").textContent = stages[index]?.name || "수험등록";
  $("#studentPct").textContent = `${percent}%`;
  $("#studentBar").style.width = `${percent}%`;
}

function waiting(title, body, character = "character-listen.png") {
  return `<div class="waiting"><img class="official-character" src="assets/official/${character}" alt="청렴 교육 캐릭터"><span class="stage-tag">검정 진행 대기</span><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`;
}

function choices(options, selected, className = "choice") {
  return `<div class="choices">${options.map((option, index) =>
    `<button type="button" class="${className} ${selected === index ? "selected" : ""}" data-choice="${index}"><span class="choice-letter">${String.fromCharCode(65 + index)}</span><span>${esc(typeof option === "string" ? option : option.text)}</span></button>`,
  ).join("")}</div>`;
}

function stageReport(stage) {
  const stageInfo = stages.find((item) => item.key === stage);
  const score = stage === "written" ? writtenScore() : stage === "practical" ? practicalScore() : teamScore();
  const values = competency();
  const ranked = C.virtues
    .map((item) => ({ ...item, value: values[item.key] || 0 }))
    .sort((a, b) => b.value - a.value);
  const strongest = ranked[0];
  const weakest = [...ranked].reverse().find((item) => item.value > 0) || ranked[ranked.length - 1];
  const detail = stage === "written"
    ? C.written.map((question, index) => `<div><span>${index + 1}번</span><b>${mine("written", question.id)?.choice === question.correct ? "정답" : "복습"}</b></div>`).join("")
    : stage === "practical"
      ? C.practical.map((task) => `<div><span>${esc(task.title.replace(/^작업 \d+ · /, ""))}</span><b>${scorePracticalTask(task, practicalAnswer(task.id))}/${task.points}</b></div>`).join("")
      : C.teamMission.tasks.map((task) => `<div><span>${esc(task.title.replace(/^\d교시 · /, ""))}</span><b>${scoreTeamTask(task, teamAnswer(task.id))}/${task.points}</b></div>`).join("");
  return `<div class="report-card">
    <div class="report-hero"><div><span class="stage-tag">${esc(stageInfo.short)} 성적표</span><h2>${score}<small>/100점</small></h2><p>${score >= 85 ? "우수한 수행입니다. 다음 시험에서도 기준을 행동으로 연결해보세요." : score >= 60 ? "합격권입니다. 보완 포인트를 확인하고 다음 시험에서 적용해보세요." : "점수는 인격평가가 아니라 다음 행동을 위한 출발점입니다."}</p></div><img src="assets/official/${score >= 85 ? "character-best.png" : "character-explain.png"}" alt="성적표를 안내하는 캐릭터"></div>
    <div class="score-breakdown">${detail}</div>
    <div class="feedback-duo"><article class="strength"><small>나의 강점</small><b>${esc(strongest?.name || "도전")}</b><p>${esc(strongest?.desc || "끝까지 참여하는 태도")}</p></article><article class="growth"><small>보완할 역량</small><b>${esc(weakest?.name || "실천")}</b><p>${esc(weakest?.feedback || "다음 선택에서 오늘의 기준을 적용해보세요.")}</p></article></div>
    <div class="feedback info">교사가 다음 시험을 열기 전까지 내 성적과 환류 문장을 확인하세요.</div>
  </div>`;
}

function renderWritten(question) {
  if (control.phase === "report") return stageReport("written");
  const answer = mine("written", question.id);
  const active = !control.locked && Number(control.timerEndsAt) > Date.now();
  const options = `<div class="choices">${question.options.map((option, index) =>
    `<button class="choice rapid-choice ${answer?.choice === index ? "selected" : ""}" data-choice="${index}" ${answer || !active ? "disabled" : ""}><span class="choice-letter">${String.fromCharCode(65 + index)}</span><span>${esc(option)}</span></button>`,
  ).join("")}</div>`;
  const feedback = answer
    ? control.reveal
      ? `<div class="feedback ${answer.choice === question.correct ? "good" : "info"}"><b>${answer.choice === question.correct ? "정답입니다." : `정답은 ${String.fromCharCode(65 + question.correct)}입니다.`}</b><br>${esc(question.ex)}</div>`
      : '<div class="feedback info">답안을 제출했습니다. 감독위원이 해설을 공개하면 판단 기준을 확인할 수 있습니다.</div>'
    : `<div id="rapidGuide" class="feedback info">${active ? `${C.writtenSeconds}초 안에 한 번만 선택할 수 있습니다.` : "감독위원이 타이머를 시작하면 답안이 열립니다."}</div>`;
  return `<div class="student-timer"><span>남은 시간</span><strong id="studentTimer">${active ? `${C.writtenSeconds}.0초` : "대기"}</strong></div><span class="stage-tag">STEP 1 · 필기시험 ${Number(control.index) + 1}/${C.written.length}</span><div class="exam-illustration"><img src="assets/official/character-warning.png" alt="문제를 확인하는 캐릭터"><div><small>출제영역 · ${esc(virtue(question.virtue)?.name)}</small><h2>${esc(question.q)}</h2></div></div>${options}${feedback}`;
}

function taskResult(task, score, feedback) {
  return `<div class="task-result"><div><span>작업 저장 완료</span><strong>${score}<small>/${task.points}점</small></strong></div><p>${esc(feedback)}</p></div><div class="feedback info">감독위원이 실기시험 성적표를 공개하면 100점 환산점수와 강·약점을 확인할 수 있습니다.</div>`;
}

function renderSequence(task, answer) {
  if (answer) return taskResult(task, scorePracticalTask(task, answer), task.feedback);
  if (!Array.isArray(draft.order)) draft.order = [2, 0, 3, 1];
  return `<div class="workbench sequence-board"><p class="tool-hint">카드의 ↑ ↓ 버튼을 눌러 업무 순서를 바꾸세요.</p>${draft.order.map((cardIndex, position) => `<div class="sequence-card"><span>${position + 1}</span><p>${esc(task.cards[cardIndex])}</p><div><button data-move="${position}" data-dir="-1" ${position === 0 ? "disabled" : ""} aria-label="위로 이동">↑</button><button data-move="${position}" data-dir="1" ${position === draft.order.length - 1 ? "disabled" : ""} aria-label="아래로 이동">↓</button></div></div>`).join("")}<button id="practicalSubmit" class="btn primary large full">이 순서로 작업 제출</button></div>`;
}

function renderWeights(task, answer) {
  if (answer) return taskResult(task, scorePracticalTask(task, answer), task.feedback);
  if (!draft.values) draft.values = { price: 25, quality: 25, delivery: 25, relationship: 25 };
  const total = task.criteria.reduce((sum, item) => sum + Number(draft.values[item.key] || 0), 0);
  return `<div class="workbench criteria-board"><div class="total-meter ${total === 100 ? "ready" : ""}"><span>배점 합계</span><strong id="weightTotal">${total}</strong><small>/100</small></div>${task.criteria.map((item) => `<label class="weight-row"><span>${esc(item.label)}</span><input type="range" min="0" max="100" step="5" value="${draft.values[item.key]}" data-weight="${item.key}"><b data-weight-value="${item.key}">${draft.values[item.key]}점</b></label>`).join("")}<button id="practicalSubmit" class="btn primary large full" ${total !== 100 ? "disabled" : ""}>평가기준표 제출</button><p class="field-note">합계가 정확히 100점일 때 제출할 수 있습니다.</p></div>`;
}

function renderAudit(task, answer) {
  if (answer) return taskResult(task, scorePracticalTask(task, answer), task.feedback);
  if (!Array.isArray(draft.selected)) draft.selected = [];
  return `<div class="workbench audit-board"><div class="audit-head"><b>감사모드 ON</b><span><strong id="auditCount">${draft.selected.length}</strong>/${task.required}개 표시</span></div><div class="record-grid">${task.records.map((record, index) => `<button class="record-card ${draft.selected.includes(index) ? "flagged" : ""}" data-record="${index}"><span>${draft.selected.includes(index) ? "위험 표시됨" : `기록 ${String(index + 1).padStart(2, "0")}`}</span><b>${esc(record.title)}</b><p>${esc(record.body)}</p></button>`).join("")}</div><button id="practicalSubmit" class="btn primary large full" ${draft.selected.length !== task.required ? "disabled" : ""}>위험신호 보고서 제출</button></div>`;
}

function renderPractical(task) {
  if (control.phase === "report") return stageReport("practical");
  const answer = practicalAnswer(task.id);
  const body = task.type === "sequence" ? renderSequence(task, answer) : task.type === "weights" ? renderWeights(task, answer) : renderAudit(task, answer);
  const image = task.type === "audit" ? "character-magic-cyber.png" : task.type === "weights" ? "character-tablet-cyber.png" : "character-guide.png";
  return `<span class="stage-tag">STEP 2 · 실기시험 ${Number(control.index) + 1}/${C.practical.length}</span><div class="task-intro"><div><small>수행형 작업 · ${task.points}점</small><h2>${esc(task.title)}</h2><p>${esc(task.brief)}</p></div><img src="assets/official/${image}" alt="실기작업 안내 캐릭터"></div>${body}`;
}

function roleCard() {
  const role = C.teamMission.roles[Number(me?.roleIndex || 0)] || C.teamMission.roles[0];
  return `<div class="role-ticket"><span>${esc(me?.teamNo || "-")}조 · 나의 직무</span><b>${esc(role.name)}</b><small>${esc(role.icon)} 담당</small></div>`;
}

function orderBoard(labels, key = "order") {
  if (!Array.isArray(draft[key])) draft[key] = labels.map((_, index) => index);
  return `<div class="sequence-board compact">${draft[key].map((itemIndex, position) => `<div class="sequence-card"><span>${position + 1}</span><p>${esc(labels[itemIndex])}</p><div><button data-team-move="${position}" data-dir="-1" ${position === 0 ? "disabled" : ""}>↑</button><button data-team-move="${position}" data-dir="1" ${position === draft[key].length - 1 ? "disabled" : ""}>↓</button></div></div>`).join("")}</div>`;
}

function renderTeamTask(task, answer) {
  const mission = C.teamMission;
  const role = mission.roles[Number(me?.roleIndex || 0)] || mission.roles[0];
  if (answer) return `${roleCard()}${taskResult(task, scoreTeamTask(task, answer), task.id === "inspect" ? "내 증거 브리핑이 저장되었습니다. 모둠원에게 화면을 보여주지 말고 말로 전달하세요." : "모둠 합의안이 저장되었습니다. 다른 모둠원의 답안과 일치하는지 확인하세요.")}`;
  if (task.id === "inspect") {
    return `${roleCard()}<div class="secret-file"><div class="secret-stamp">CONFIDENTIAL · 내 증거</div><p>${esc(role.evidence)}</p></div><div class="field-form"><label for="riskSelect">이 증거에서 가장 크게 훼손된 청렴역량</label><select id="riskSelect"><option value="">역량을 선택하세요</option>${C.virtues.map((item) => `<option value="${item.key}">${esc(item.name)} · ${esc(item.tag)}</option>`).join("")}</select><label for="teamBrief">30초 구두 브리핑 메모</label><textarea id="teamBrief" maxlength="180" placeholder="증거의 핵심 사실과 왜 문제인지 ${task.minLength}자 이상 정리하세요."></textarea><button id="teamSubmit" class="btn primary large full">감식결과 봉인·제출</button><p class="field-note">이 화면을 다른 역할자에게 보여주지 마세요. 정보가 나뉘어 있어야 합동감사가 시작됩니다.</p></div>`;
  }
  if (task.id === "hearing") {
    const labels = mission.roles.map((item) => `${item.icon} 증거 · ${item.name}`);
    return `${roleCard()}<div class="team-briefing"><h3>① 역할별 구두 브리핑</h3><p>서로의 화면을 보여주지 않고 30초씩 핵심 사실을 설명하세요. 모두 들은 뒤 위험도가 큰 순서로 배치합니다.</p></div>${orderBoard(labels)}<h3>② 사건 최종판정</h3>${choices(task.verdicts, draft.verdict, "verdict-choice")}<button id="teamSubmit" class="btn primary large full">합동심리 결과 제출</button>`;
  }
  if (!Array.isArray(draft.selected)) draft.selected = [];
  return `${roleCard()}<div class="protocol-builder"><h3>① 재발방지 규칙 3개 선택</h3><div class="action-grid">${task.actions.map((action, index) => `<label class="action-choice ${draft.selected.includes(index) ? "selected" : ""}"><input type="checkbox" value="${index}" ${draft.selected.includes(index) ? "checked" : ""}><span>${esc(action.text)}</span></label>`).join("")}</div><label for="protocolText">② 우리 조 한 줄 청렴 프로토콜</label><textarea id="protocolText" maxlength="180" placeholder="예: 우리는 이해관계를 먼저 공개하고, 같은 기준으로 비교한 뒤, 모든 기록을 남긴다."></textarea><button id="teamSubmit" class="btn primary large full">우리 조 프로토콜 제출</button><p class="field-note">모둠원 모두가 같은 규칙과 문장을 제출해야 진짜 합의가 완성됩니다.</p></div>`;
}

function renderTeam(task) {
  if (control.phase === "report") return stageReport("team");
  if (!me?.teamKey) return waiting("조 편성을 기다리고 있습니다.", "감독위원이 4인 1조 자동편성을 완료하면 나의 비밀 역할과 증거가 열립니다.", "character-together.png");
  return `<span class="stage-tag team-badge">STEP 3 · 조별과제 ${Number(control.index) + 1}/${C.teamMission.tasks.length}</span><div class="task-intro team-intro"><div><small>${esc(C.teamMission.title)}</small><h2>${esc(task.title)}</h2><p>${esc(task.instruction)}</p></div><img src="assets/official/character-listen.png" alt="팀 브리핑 캐릭터"></div>${renderTeamTask(task, teamAnswer(task.id))}`;
}

function certificateHTML(result) {
  const values = competency();
  const ranked = C.virtues.map((item) => ({ ...item, value: values[item.key] || 0 })).sort((a, b) => b.value - a.value);
  return `<span class="stage-tag">FINAL · 종합판정</span><h2>청렴직무능력 검정결과</h2><div class="score-box"><div class="score-main"><span>종합 환산점수</span><strong>${result.total}</strong></div><div class="score-grid three"><div><span>필기시험</span><b>${result.written}</b></div><div><span>실기시험</span><b>${result.practical}</b></div><div><span>조별과제</span><b>${result.team}</b></div></div></div><div class="feedback-duo final-feedback"><article class="strength"><small>최고역량</small><b>${esc(ranked[0]?.name)}</b><p>${esc(ranked[0]?.desc)}</p></article><article class="growth"><small>다음 실천과제</small><b>${esc(ranked[ranked.length - 1]?.name)}</b><p>${esc(ranked[ranked.length - 1]?.feedback)}</p></article></div><div id="certificate" class="certificate ${result.qualification === "청렴 리더" ? "leader" : ""}"><img src="assets/official/ci-education.png" alt="국가청렴권익교육원"><div class="cert-type">교육용 청렴직무능력 인증 프로그램</div><h2>청렴역량 인증서</h2><div class="cert-name">${esc(me?.studentName || "청렴ON 도전자")}</div><div class="cert-rank">${esc(result.qualification)}</div><div class="cert-text">위 학생은 「청렴, 자격이 되다 3.0」의<br>필기시험·실기시험·조별과제를 수행하고<br>생활 속 청렴을 실천할 역량을 보여주었으므로<br><b>${esc(result.qualification)}</b>로 인증합니다.</div><div class="cert-date">${new Date().toLocaleDateString("ko-KR")}</div></div><button id="saveCert" class="btn ${result.qualification === "청렴 리더" ? "gold" : "primary"} full">인증서 이미지 저장</button><div class="feedback info">※ 한국산업인력공단의 자격검정 방식을 교육적으로 차용한 것으로, 실제 국가기술자격이 아닙니다.</div>`;
}

function render() {
  if (!control) return;
  progress();
  const stage = control.stage;
  const question = currentItem();
  let html = "";
  if (stage === "waiting") html = waiting("수험등록 완료", "감독위원이 STEP 1 필기시험을 시작할 때까지 검정안내를 확인하세요.", "character-greeting.png");
  if (stage === "written") html = renderWritten(question);
  if (stage === "practical") html = renderPractical(question);
  if (stage === "team") html = renderTeam(question);
  if (stage === "result") {
    if (control.phase !== "certificate") {
      html = `<span class="stage-tag">FINAL · 실천서약</span><div class="task-intro"><div><small>평가에서 실천으로</small><h2>내가 켤 청렴 스위치 한 가지</h2><p>가장 보완하고 싶은 역량을 학교생활의 구체적인 행동으로 바꾸어 적으세요.</p></div><img src="assets/official/character-love.png" alt="실천서약 캐릭터"></div><div class="pledge-area"><label for="pledgeText">나의 청렴 실천서약</label><textarea id="pledgeText" maxlength="160" placeholder="예: 모둠활동에서 친한 친구 의견만 편들지 않고 모두의 의견을 같은 기준으로 듣겠습니다.">${esc(myPledge?.text || "")}</textarea><button id="pledgeBtn" class="btn primary large full">${myPledge ? "실천서약 수정" : "실천서약 서명"}</button></div>`;
    } else {
      const result = scores();
      html = result.complete ? certificateHTML(result) : waiting("아직 완료하지 않은 검정이 있습니다.", "감독위원의 안내에 따라 미응답 작업 또는 실천서약을 완료해주세요.", "character-warning.png");
    }
  }
  $("#studentContent").innerHTML = html;
  bindInteractions();
  updateStudentTimer();
}

function bindInteractions() {
  document.querySelectorAll(".rapid-choice:not(:disabled)").forEach((button) => {
    button.onclick = () => submitRapid(Number(button.dataset.choice));
  });
  document.querySelectorAll("[data-move]").forEach((button) => {
    button.onclick = () => {
      const from = Number(button.dataset.move);
      const to = from + Number(button.dataset.dir);
      [draft.order[from], draft.order[to]] = [draft.order[to], draft.order[from]];
      render();
    };
  });
  document.querySelectorAll("[data-team-move]").forEach((button) => {
    button.onclick = () => {
      const from = Number(button.dataset.teamMove);
      const to = from + Number(button.dataset.dir);
      [draft.order[from], draft.order[to]] = [draft.order[to], draft.order[from]];
      render();
    };
  });
  document.querySelectorAll("[data-weight]").forEach((input) => {
    input.oninput = () => {
      draft.values[input.dataset.weight] = Number(input.value);
      const value = document.querySelector(`[data-weight-value="${input.dataset.weight}"]`);
      if (value) value.textContent = `${input.value}점`;
      const total = C.practical[1].criteria.reduce((sum, item) => sum + Number(draft.values[item.key] || 0), 0);
      $("#weightTotal").textContent = total;
      $("#practicalSubmit").disabled = total !== 100;
      $(".total-meter")?.classList.toggle("ready", total === 100);
    };
  });
  document.querySelectorAll("[data-record]").forEach((button) => {
    button.onclick = () => {
      const index = Number(button.dataset.record);
      if (draft.selected.includes(index)) draft.selected = draft.selected.filter((value) => value !== index);
      else if (draft.selected.length < currentItem().required) draft.selected.push(index);
      else return toast(`위험신호는 ${currentItem().required}개만 표시할 수 있습니다.`);
      render();
    };
  });
  document.querySelectorAll(".verdict-choice").forEach((button) => {
    button.onclick = () => {
      draft.verdict = Number(button.dataset.choice);
      render();
    };
  });
  document.querySelectorAll('.action-choice input[type="checkbox"]').forEach((checkbox) => {
    checkbox.onchange = () => {
      const index = Number(checkbox.value);
      if (checkbox.checked && !draft.selected.includes(index)) draft.selected.push(index);
      if (!checkbox.checked) draft.selected = draft.selected.filter((value) => value !== index);
      if (draft.selected.length > currentItem().required) {
        draft.selected = draft.selected.filter((value) => value !== index);
        checkbox.checked = false;
        toast(`${currentItem().required}개만 선택할 수 있습니다.`);
      }
    };
  });
  if ($("#practicalSubmit")) $("#practicalSubmit").onclick = submitPractical;
  if ($("#teamSubmit")) $("#teamSubmit").onclick = submitTeam;
  if ($("#pledgeBtn")) $("#pledgeBtn").onclick = savePledge;
  if ($("#saveCert")) $("#saveCert").onclick = saveCertificate;
}

async function submitRapid(choice) {
  if (rapidSubmitting || mine("written", currentItem().id)) return;
  if (control.locked || !control.timerEndsAt || Number(control.timerEndsAt) <= Date.now()) return toast("응답 시간이 종료되었습니다.");
  rapidSubmitting = true;
  document.querySelectorAll(".rapid-choice").forEach((button) => { button.disabled = true; });
  try {
    await DB.submitWritten(code, currentItem().id, choice);
    toast("필기 답안을 제출했습니다.");
  } catch (error) {
    console.error(error);
    toast("답안을 제출하지 못했습니다.");
  } finally {
    rapidSubmitting = false;
  }
}

async function submitPractical() {
  const task = currentItem();
  let payload = null;
  if (task.type === "sequence") payload = { order: [...draft.order] };
  if (task.type === "weights") {
    const total = task.criteria.reduce((sum, item) => sum + Number(draft.values[item.key] || 0), 0);
    if (total !== 100) return toast("평가기준 합계를 100점으로 맞춰주세요.");
    payload = { values: { ...draft.values } };
  }
  if (task.type === "audit") {
    if (draft.selected.length !== task.required) return toast(`위험신호 ${task.required}개를 표시해주세요.`);
    payload = { selected: [...draft.selected] };
  }
  try {
    await DB.submitPracticalTask(code, task.id, payload);
    draft = {};
    toast("실기작업을 제출했습니다.");
  } catch (error) {
    console.error(error);
    toast("실기작업을 저장하지 못했습니다.");
  }
}

async function submitTeam() {
  const task = currentItem();
  let payload = null;
  if (task.id === "inspect") {
    const risk = $("#riskSelect").value;
    const brief = $("#teamBrief").value.trim();
    if (!risk) return toast("훼손된 청렴역량을 선택해주세요.");
    if (brief.length < task.minLength) return toast(`브리핑을 ${task.minLength}자 이상 작성해주세요.`);
    payload = { risk, brief };
  }
  if (task.id === "hearing") {
    if (!Number.isInteger(draft.verdict)) return toast("사건 판정을 선택해주세요.");
    payload = { order: [...draft.order], verdict: draft.verdict };
  }
  if (task.id === "protocol") {
    const statement = $("#protocolText").value.trim();
    if (draft.selected.length !== task.required) return toast(`재발방지 규칙 ${task.required}개를 선택해주세요.`);
    if (statement.length < task.minLength) return toast(`프로토콜을 ${task.minLength}자 이상 작성해주세요.`);
    payload = { selected: [...draft.selected], statement };
  }
  try {
    await DB.submitTeamTask(code, C.teamMission.id, task.id, payload);
    draft = {};
    toast("조별과제 답안을 제출했습니다.");
  } catch (error) {
    console.error(error);
    toast("조별과제 답안을 저장하지 못했습니다.");
  }
}

async function savePledge() {
  const text = $("#pledgeText").value.trim();
  if (text.length < 12) return toast("실천서약을 12자 이상 구체적으로 적어주세요.");
  try {
    await DB.savePledge(code, text);
    toast("실천서약을 저장했습니다.");
  } catch (error) {
    console.error(error);
    toast("실천서약을 저장하지 못했습니다.");
  }
}

async function saveCertificate() {
  const element = $("#certificate");
  if (!element) return;
  try {
    const canvas = await html2canvas(element, { scale: 2, backgroundColor: "#ffffff" });
    const link = document.createElement("a");
    link.download = `청렴ON_${scores().qualification}_${me?.studentName || "인증서"}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (error) {
    window.print();
  }
}

function updateStudentTimer() {
  const element = $("#studentTimer");
  if (!element || control?.stage !== "written" || control?.phase === "report") return;
  const remaining = Math.max(0, Number(control.timerEndsAt || 0) - Date.now());
  if (!control.timerEndsAt || control.locked) {
    element.textContent = control.reveal ? "해설" : "대기";
    return;
  }
  element.textContent = `${(remaining / 1000).toFixed(1)}초`;
  element.classList.toggle("urgent", remaining <= 3000);
  if (remaining <= 0) {
    document.querySelectorAll(".rapid-choice").forEach((button) => { button.disabled = true; });
    const guide = $("#rapidGuide");
    if (guide) guide.textContent = "응답 시간이 종료되었습니다.";
  }
}

function subscribe() {
  unsubs.forEach((unsubscribe) => unsubscribe());
  myAnswers = { written: {}, practical: {}, team: {} };
  unsubs = [
    DB.on("control", code, (value) => {
      control = value || { stage: "waiting", locked: true };
      const nextKey = `${control.stage}:${control.index}:${control.phase}`;
      if (nextKey !== controlKey) draft = {};
      controlKey = nextKey;
      render();
    }),
    DB.on(`pledges/${DB.uid}`, code, (value) => { myPledge = value || null; render(); }),
    DB.on(`participants/${DB.uid}`, code, (value) => { me = value || me; render(); }),
  ];
  C.written.forEach((question) => {
    unsubs.push(DB.on(`answers/written/${question.id}/${DB.uid}`, code, (value) => {
      if (value) myAnswers.written[question.id] = value;
      else delete myAnswers.written[question.id];
      render();
    }));
  });
  C.practical.forEach((task) => {
    unsubs.push(DB.on(`answers/practical/${task.id}/${DB.uid}`, code, (value) => {
      if (value) myAnswers.practical[task.id] = value;
      else delete myAnswers.practical[task.id];
      render();
    }));
  });
  C.teamMission.tasks.forEach((task) => {
    const key = `${C.teamMission.id}_${task.id}`;
    unsubs.push(DB.on(`answers/team/${key}/${DB.uid}`, code, (value) => {
      if (value) myAnswers.team[key] = value;
      else delete myAnswers.team[key];
      render();
    }));
  });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  DB.heartbeat(code);
  heartbeatTimer = setInterval(() => DB.heartbeat(code), 25000);
}

async function enterExam(roomCode, participant) {
  code = roomCode;
  me = participant;
  localStorage.setItem(storageKey, code);
  $("#joinPanel").classList.add("hidden");
  $("#examPanel").classList.remove("hidden");
  subscribe();
}

async function join() {
  const roomCode = $("#joinCode").value.trim();
  const studentName = $("#studentName").value.trim().replace(/\s+/g, " ");
  if (!/^\d{6}$/.test(roomCode)) return toast("6자리 참여코드를 확인해주세요.");
  if (studentName.length < 2 || studentName.length > 20) return toast("학생 이름을 정확히 입력해주세요.");
  if (!/^[가-힣A-Za-z ]+$/.test(studentName)) return toast("이름에는 한글·영문과 띄어쓰기만 사용할 수 있습니다.");
  try {
    const schoolLevel = $("#schoolLevel").value;
    await DB.joinRoom(roomCode, studentName, schoolLevel);
    await enterExam(roomCode, { studentName, schoolLevel });
    toast(`${studentName} 학생, 수험등록을 완료했습니다.`);
  } catch (error) {
    console.error(error);
    toast(error.message || "수업방에 입장할 수 없습니다.");
  }
}

async function initialize() {
  const roomFromURL = new URLSearchParams(location.search).get("room");
  const savedRoom = localStorage.getItem(storageKey);
  const candidateRoom = /^\d{6}$/.test(roomFromURL || "") ? roomFromURL : /^\d{6}$/.test(savedRoom || "") ? savedRoom : "";
  if (roomFromURL) $("#joinCode").value = roomFromURL;
  if (!DB.configured) {
    $("#configError").classList.remove("hidden");
    $("#studentStatus").textContent = "준비 중";
    $("#studentStatus").classList.add("error");
    return;
  }
  try {
    await DB.init();
    $("#studentStatus").textContent = "실시간 연결";
    $("#studentStatus").classList.add("online");
    $("#joinBtn").onclick = join;
    if (candidateRoom) {
      const participant = await DB.resumeParticipant(candidateRoom);
      if (participant) {
        await enterExam(candidateRoom, participant);
        toast("진행 중이던 수험 화면을 다시 열었습니다.");
        return;
      }
      if (!roomFromURL) localStorage.removeItem(storageKey);
    }
    $("#joinPanel").classList.remove("hidden");
  } catch (error) {
    console.error(error);
    $("#configError").classList.remove("hidden");
    $("#studentStatus").textContent = "연결 실패";
    $("#studentStatus").classList.add("error");
  }
}

setInterval(updateStudentTimer, 150);
initialize();
