const C = CHEONGRYEOM_CONTENT;
const DB = CheongDB;
const $ = (selector) => document.querySelector(selector);

let code = null;
let roomMeta = null;
let control = {
  stage: "waiting",
  index: 0,
  phase: "pre",
  reveal: false,
  locked: true,
  timerEndsAt: null,
};
let participants = {};
let presence = {};
let answers = {};
let pledges = {};
let unsubs = [];
let timerLockPending = false;

const stages = C.stages;
const storageKey = "cheongryeomTeacherRoom";

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

const items = (stage) => {
  if (stage === "written") return C.written;
  if (stage === "practical") return C.practical;
  if (stage === "field") return C.fieldMissions;
  return [];
};

const item = () => items(control.stage)[Number(control.index || 0)] || null;

const stageCharacter = {
  waiting: "character-greeting.png",
  written: "character-warning.png",
  practical: "character-tablet.png",
  field: "character-listen.png",
  result: "character-harmony.png",
};

function charBox(stage) {
  const file = stageCharacter[stage] || "character-guide.png";
  return `<div class="teacher-char character-panel"><img class="official-character" src="assets/official/${file}" alt="국민권익위원회 캐릭터"></div>`;
}

function studentURL() {
  const url = new URL("student.html", location.href);
  url.searchParams.set("room", code);
  return url.href;
}

function renderNav() {
  $("#stageNav").innerHTML = stages
    .map(
      (stage, index) => `
        <button class="stage-btn ${stage.key === control.stage ? "active" : ""}" data-key="${stage.key}">
          <span class="stage-num">${index + 1}</span>
          <span class="stage-copy"><small>${esc(stage.step)} · ${stage.duration}분</small><b>${esc(stage.name)}</b></span>
        </button>`,
    )
    .join("");
  document.querySelectorAll(".stage-btn").forEach((button) => {
    button.onclick = () => go(button.dataset.key, 0);
  });
}

function renderQR() {
  const target = $("#qr");
  target.innerHTML = "";
  if (window.QRCode) {
    new QRCode(target, {
      text: studentURL(),
      width: 170,
      height: 170,
      colorDark: "#063b5c",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  } else {
    target.innerHTML =
      '<div class="helper">QR을 불러오지 못했습니다.<br>학생 링크 복사 버튼을 사용하세요.</div>';
  }
}

function answerList(stage, key) {
  return Object.values(answers?.[stage]?.[key] || {});
}

function choiceOf(answer) {
  if (!answer) return null;
  if (Number.isInteger(answer.finalChoice)) return answer.finalChoice;
  return Number.isInteger(answer.choice) ? answer.choice : null;
}

function practicalAnswerFor(uid, questionId) {
  const first = answers?.practical?.[`${questionId}_first`]?.[uid];
  const final = answers?.practical?.[`${questionId}_final`]?.[uid];
  if (!first || !Number.isInteger(first.choice)) return null;
  return {
    firstChoice: first.choice,
    finalChoice: Number.isInteger(final?.choice) ? final.choice : first.choice,
    revised: Number.isInteger(final?.choice),
  };
}

function practicalAnswerList(questionId) {
  return Object.keys(answers?.practical?.[`${questionId}_first`] || {})
    .map((uid) => practicalAnswerFor(uid, questionId))
    .filter(Boolean);
}

function bars(labels, list) {
  const counts = Array(labels.length).fill(0);
  list.forEach((answer) => {
    const choice = choiceOf(answer);
    if (Number.isInteger(choice) && counts[choice] != null) counts[choice] += 1;
  });
  const total = list.length;
  return labels
    .map((label, index) => {
      const percent = total ? Math.round((counts[index] / total) * 100) : 0;
      return `<div class="bar-row"><b class="bar-letter">${String.fromCharCode(65 + index)}</b><div class="bar-track" title="${esc(label)}"><div class="bar-fill" style="width:${percent}%"></div></div><span class="bar-value">${counts[index]}명 · ${percent}%</span></div>`;
    })
    .join("");
}

function fieldScore(submission) {
  if (!submission) return 0;
  const mission = C.fieldMissions[0];
  const verdictScore =
    Number(submission.verdict) === mission.correctVerdict
      ? 40
      : Number(submission.verdict) === 1
        ? 20
        : 0;
  const actionScore = (submission.actions || []).reduce(
    (sum, actionIndex) =>
      sum + Number(mission.actions[actionIndex]?.score || 0),
    0,
  );
  const reasonScore =
    String(submission.reason || "").trim().length >= mission.reasonMinLength
      ? 10
      : 0;
  return Math.min(100, verdictScore + actionScore + reasonScore);
}

function fieldSubmissionFor(uid) {
  const missionId = C.fieldMissions[0].id;
  const verdict = answers?.field?.[`${missionId}_verdict`]?.[uid];
  const action1 = answers?.field?.[`${missionId}_action1`]?.[uid];
  const action2 = answers?.field?.[`${missionId}_action2`]?.[uid];
  if (
    !Number.isInteger(verdict?.choice) ||
    !Number.isInteger(action1?.choice) ||
    !Number.isInteger(action2?.choice)
  ) {
    return null;
  }
  return {
    verdict: verdict.choice,
    actions: [action1.choice, action2.choice],
    reason: participants?.[uid]?.fieldReason || "",
  };
}

function compForUser(uid) {
  const sums = Object.fromEntries(
    C.virtues.map((virtue) => [virtue.key, { score: 0, count: 0 }]),
  );

  C.written.forEach((question) => {
    const answer = answers?.written?.[question.id]?.[uid];
    if (!answer) return;
    Object.entries(question.impact || {}).forEach(([key, value]) => {
      sums[key].score +=
        answer.choice === question.correct ? value : Math.round(value * 0.3);
      sums[key].count += 1;
    });
  });

  C.practical.forEach((question) => {
    const answer = practicalAnswerFor(uid, question.id);
    const selected = question.options[choiceOf(answer)];
    if (!selected) return;
    Object.entries(selected.impact || {}).forEach(([key, value]) => {
      sums[key].score += value;
      sums[key].count += 1;
    });
  });

  return Object.fromEntries(
    Object.entries(sums).map(([key, value]) => [
      key,
      value.count ? Math.round(value.score / value.count) : 0,
    ]),
  );
}

function calcStudent(uid) {
  const scoring = C.scoring;
  let correctWritten = 0;
  C.written.forEach((question) => {
    if (answers?.written?.[question.id]?.[uid]?.choice === question.correct) {
      correctWritten += 1;
    }
  });
  const written = Math.round((correctWritten / C.written.length) * 100);

  const practicalScores = C.practical
    .map((question) => {
      const selected = choiceOf(practicalAnswerFor(uid, question.id));
      return Number.isInteger(selected)
        ? question.options[selected]?.score
        : null;
    })
    .filter((value) => value != null);
  const practical =
    practicalScores.length === C.practical.length
      ? Math.round(
          practicalScores.reduce((sum, value) => sum + value, 0) /
            practicalScores.length,
        )
      : 0;

  const fieldSubmission = fieldSubmissionFor(uid);
  const field = fieldScore(fieldSubmission);
  const hasPledge = Boolean(pledges?.[uid]?.text);
  const complete =
    C.written.every((question) => answers?.written?.[question.id]?.[uid]) &&
    C.practical.every((question) =>
      Number.isInteger(choiceOf(practicalAnswerFor(uid, question.id))),
    ) &&
    Boolean(fieldSubmission) &&
    hasPledge;
  const total = Math.round(
    (written * scoring.writtenWeight) / 100 +
      (practical * scoring.practicalWeight) / 100 +
      (field * scoring.fieldWeight) / 100,
  );
  const qualification =
    complete &&
    total >= scoring.leaderTotal &&
    practical >= scoring.leaderPractical &&
    field >= scoring.leaderField
      ? "청렴 리더"
      : complete
        ? "청렴 서포터"
        : "과정 진행 중";
  return { written, practical, field, total, complete, qualification };
}

function renderRoster() {
  const ids = Object.keys(participants || {}).sort((a, b) =>
    String(participants[a]?.studentName || "").localeCompare(
      String(participants[b]?.studentName || ""),
      "ko",
    ),
  );
  $("#roster").innerHTML = ids.length
    ? ids
        .map((uid) => {
          const participant = participants[uid] || {};
          const result = calcStudent(uid);
          const done = result.complete;
          return `<div class="roster-item ${done ? "done" : ""}"><b>${esc(participant.studentName || "이름 미확인")}</b><span>${participant.schoolLevel === "high" ? "고등학생" : "중학생"} · ${participant.teamNo ? `${participant.teamNo}모둠 · ` : ""}${done ? result.qualification : "과정 진행 중"}</span></div>`;
        })
        .join("")
    : '<div class="empty" style="grid-column:1/-1;min-height:80px">아직 등록한 학생이 없습니다.</div>';
}

function renderClassComp() {
  const ids = Object.keys(participants || {});
  const totals = Object.fromEntries(C.virtues.map((virtue) => [virtue.key, 0]));
  ids.forEach((uid) => {
    const competency = compForUser(uid);
    C.virtues.forEach((virtue) => {
      totals[virtue.key] += competency[virtue.key] || 0;
    });
  });
  $("#classComp").innerHTML = C.virtues
    .map((virtue) => {
      const value = ids.length
        ? Math.round(totals[virtue.key] / ids.length)
        : 0;
      return `<div class="comp-row"><div class="comp-meta"><span>${esc(virtue.name)}</span><b>${value}</b></div><div class="comp-track"><span style="width:${value}%"></span></div></div>`;
    })
    .join("");
}

function scheduleHTML() {
  return `<div class="schedule-strip">${stages
    .map(
      (stage) =>
        `<div class="schedule-item"><small>${esc(stage.step)}</small><b>${esc(stage.short)}</b><span>${stage.duration}분</span></div>`,
    )
    .join("")}</div>`;
}

function teacherFieldOverview() {
  const mission = C.fieldMissions[0];
  return `<div class="mission-preview"><div class="case-label">DIGITAL CASE FILE</div><h2>${esc(mission.title)}</h2><p class="context-box">${esc(mission.brief)}</p><div class="evidence-mini-grid">${mission.evidence.map((evidence) => `<div><small>${esc(evidence.no)}</small><b>${esc(evidence.title)}</b></div>`).join("")}</div><div class="change-box"><b>교사 진행 포인트</b><br>${esc(mission.guide)}</div></div>`;
}

function resultSummaryHTML() {
  const results = Object.keys(participants).map(calcStudent);
  const leader = results.filter(
    (result) => result.qualification === "청렴 리더",
  ).length;
  const supporter = results.filter(
    (result) => result.qualification === "청렴 서포터",
  ).length;
  const inProgress = results.filter((result) => !result.complete).length;
  const completed = results.filter((result) => result.complete);
  const average = completed.length
    ? Math.round(
        completed.reduce((sum, result) => sum + result.total, 0) /
          completed.length,
      )
    : 0;
  return `<div class="result-summary"><div class="result-tile"><b>${supporter}</b><span>청렴 서포터</span></div><div class="result-tile leader-tile"><b>${leader}</b><span>청렴 리더</span></div><div class="result-tile"><b>${inProgress}</b><span>미완료</span></div><div class="result-tile"><b>${average}</b><span>완료자 평균</span></div></div>`;
}

function renderContent() {
  renderNav();
  const stage =
    stages.find((value) => value.key === control.stage) || stages[0];
  const question = item();
  $("#stageKicker").textContent = `${stage.step} · ${stage.duration}분`;
  $("#stageTitle").textContent = stage.name;
  $("#timerBtn").classList.toggle("hidden", control.stage !== "written");
  $("#revealBtn").classList.toggle("hidden", control.stage !== "written");
  $("#teamBtn").classList.toggle("hidden", control.stage !== "field");
  $("#revealBtn").textContent = control.reveal
    ? "해설 숨기기"
    : "정답·해설 공개";

  let html = "";
  if (control.stage === "waiting") {
    html = `<span class="eyebrow">EXAM CHECK-IN</span><h2>${esc(C.intro.title)}</h2><p class="context-box">학생이 QR 또는 6자리 참여코드로 입장합니다. 등록 인원을 확인한 뒤 STEP 1을 시작하세요.</p>${scheduleHTML()}<div class="change-box"><b>총 ${C.program.totalMinutes}분 수업</b> · 빠른 개인판단 → 선택 결과 체험 → 4인 팀 증거분석 → 자격취득</div>`;
  }
  if (control.stage === "written") {
    html = `<div class="timer-panel"><div><small>문항당 제한시간</small><strong id="teacherTimer">대기</strong></div><p>‘10초 시작’을 누르면 학생 화면의 선택지가 동시에 열립니다. 시간이 끝나면 답안이 자동으로 잠깁니다.</p></div><span class="eyebrow">RAPID TEST ${Number(control.index) + 1}/${C.written.length}</span><h2>${esc(question.q)}</h2><div class="option-grid">${question.options.map((option, index) => `<div class="option-view"><b>${String.fromCharCode(65 + index)}.</b> ${esc(option)}</div>`).join("")}</div>${control.reveal ? `<div class="feedback good"><b>정답 ${String.fromCharCode(65 + question.correct)}</b><br>${esc(question.ex)}</div>` : ""}`;
  }
  if (control.stage === "practical") {
    html = `<span class="eyebrow">BRANCHING SIMULATOR ${Number(control.index) + 1}/${C.practical.length}</span><h2>${esc(question.title)}</h2><p class="context-box">${esc(question.context)}</p><h3>${esc(question.q)}</h3><div class="option-grid">${question.options.map((option, index) => `<div class="option-view"><b>${String.fromCharCode(65 + index)}.</b> ${esc(option.text)}</div>`).join("")}</div><div class="change-box"><b>필기시험과 다른 점</b><br>학생은 선택 직후 결과를 확인하고 한 번 다시 선택할 수 있습니다. 다음 상황은 학생의 앞선 최종 선택에 따라 달라집니다.</div>`;
  }
  if (control.stage === "field") {
    html = teacherFieldOverview();
  }
  if (control.stage === "result") {
    const phase = control.phase === "certificate" ? "certificate" : "pledge";
    html = `<span class="eyebrow">${phase === "pledge" ? "FINAL PLEDGE" : "QUALIFICATION"}</span><h2>${phase === "pledge" ? "자격취득 전, 나의 청렴 행동을 선언합니다." : "청렴능력 자격판정"}</h2><p class="context-box">${phase === "pledge" ? "학생이 학교생활에서 직접 실천할 행동 한 가지를 자신의 언어로 작성합니다. 모두 제출하면 ‘자격증 공개’로 전환하세요." : "전 과정을 완료한 학생 화면에 개인 점수와 디지털 청렴능력 자격증이 표시됩니다."}</p><div class="phase-tools"><button class="btn ${phase === "pledge" ? "primary" : "outline"}" onclick="setResultPhase('pledge')">① 실천서약</button><button class="btn ${phase === "certificate" ? "primary" : "outline"}" onclick="setResultPhase('certificate')">② 자격증 공개</button></div>${phase === "certificate" ? resultSummaryHTML() : ""}`;
  }

  $("#teacherContent").innerHTML =
    `<div class="teacher-content-grid"><div>${html}</div>${charBox(control.stage)}</div>`;
  renderStats();
  renderClassComp();
  renderRoster();

  const list = items(control.stage);
  $("#prevBtn").disabled =
    stageIdx(control.stage) === 0 && Number(control.index) === 0;
  if (control.stage === "result") {
    $("#nextBtn").textContent =
      control.phase === "certificate" ? "자격증 공개 중" : "자격증 공개 →";
    $("#nextBtn").disabled = control.phase === "certificate";
  } else {
    $("#nextBtn").disabled = false;
    $("#nextBtn").textContent =
      list.length && Number(control.index) < list.length - 1
        ? "다음 문항 →"
        : "다음 단계 →";
  }
  updateTimer();
}

function teamNumbers() {
  return [
    ...new Set(
      Object.values(participants)
        .map((participant) => Number(participant.teamNo))
        .filter(Number.isInteger),
    ),
  ].sort((a, b) => a - b);
}

function fieldTeamCards() {
  const teams = teamNumbers();
  if (!teams.length) {
    return '<div class="empty">‘4인 1팀 자동편성’을 눌러 모둠을 먼저 만들어주세요.</div>';
  }
  return `<div class="team-grid">${teams
    .map((teamNo) => {
      const teamKey = `team-${teamNo}`;
      const memberEntries = Object.entries(participants).filter(
        ([, participant]) => participant.teamKey === teamKey,
      );
      const members = memberEntries
        .map(([, participant]) => esc(participant.studentName))
        .join(" · ");
      const submissions = memberEntries
        .map(([uid]) => fieldSubmissionFor(uid))
        .filter(Boolean);
      const average = submissions.length
        ? Math.round(
            submissions.reduce(
              (sum, submission) => sum + fieldScore(submission),
              0,
            ) / submissions.length,
          )
        : 0;
      const complete =
        submissions.length === memberEntries.length && submissions.length > 0;
      return `<article class="team-card ${complete ? "submitted" : ""}"><div><b>${teamNo}모둠</b><small>${members || "편성 대기"}</small></div>${submissions.length ? `<strong>${average}점</strong><span>${submissions.length}/${memberEntries.length}명 제출</span>` : '<span class="waiting-chip">제출 대기</span>'}</article>`;
    })
    .join("")}</div>`;
}

function renderStats() {
  const question = item();
  if (control.stage === "written") {
    const list = answerList("written", question.id);
    $("#responseChip").textContent = `${list.length}명 응답`;
    $("#statsArea").className = "";
    $("#statsArea").innerHTML = bars(question.options, list);
    publishPublic(question.options, list);
    return;
  }

  if (control.stage === "practical") {
    const list = practicalAnswerList(question.id);
    const changed = list.filter(
      (answer) => answer.revised && answer.firstChoice !== answer.finalChoice,
    ).length;
    $("#responseChip").textContent = `${list.length}명 응답`;
    $("#statsArea").className = "";
    $("#statsArea").innerHTML =
      bars(
        question.options.map((option) => option.text),
        list,
      ) +
      `<div class="change-box">결과 확인 후 선택을 바꾼 학생 <b>${changed}/${list.length}명</b></div>`;
    publishPublic(
      question.options.map((option) => option.text),
      list,
    );
    return;
  }

  if (control.stage === "field") {
    const submitted = Object.keys(participants).filter((uid) =>
      fieldSubmissionFor(uid),
    ).length;
    $("#responseChip").textContent =
      `${submitted}/${Object.keys(participants).length}명 제출`;
    $("#statsArea").className = "";
    $("#statsArea").innerHTML = fieldTeamCards();
    return;
  }

  if (control.stage === "result") {
    const submitted = Object.keys(pledges || {}).length;
    $("#responseChip").textContent = `${submitted}명 서약`;
    $("#statsArea").innerHTML =
      `<div class="empty">등록 ${Object.keys(participants).length}명 중 ${submitted}명이 실천서약을 제출했습니다.</div>`;
    return;
  }

  $("#responseChip").textContent = "집계 대기";
  $("#statsArea").innerHTML =
    '<div class="empty">STEP 1을 시작하면 학생 응답이 실시간으로 표시됩니다.</div>';
}

async function publishPublic(labels, list) {
  if (!code) return;
  const counts = Array(labels.length).fill(0);
  list.forEach((answer) => {
    const choice = choiceOf(answer);
    if (Number.isInteger(choice) && counts[choice] != null) counts[choice] += 1;
  });
  try {
    await DB.publishStats(code, {
      participantCount: Object.keys(presence || {}).length,
      stage: control.stage,
      index: Number(control.index || 0),
      labels,
      counts,
      total: list.length,
    });
  } catch (error) {
    console.warn("실시간 공개 통계 갱신 실패", error);
  }
}

function controlDefaults(stage, index) {
  return {
    stage,
    index,
    phase: stage === "result" ? "pledge" : "pre",
    reveal: false,
    locked: stage === "written",
    timerEndsAt: null,
  };
}

async function go(stage, index = 0) {
  await DB.setControl(code, controlDefaults(stage, index));
}

window.setResultPhase = (phase) =>
  DB.setControl(code, {
    phase,
    locked: false,
    timerEndsAt: null,
  });

async function next() {
  if (control.stage === "result") {
    if (control.phase !== "certificate")
      return window.setResultPhase("certificate");
    return;
  }
  const list = items(control.stage);
  const index = Number(control.index || 0);
  if (list.length && index < list.length - 1) {
    return DB.setControl(code, controlDefaults(control.stage, index + 1));
  }
  const nextStage = stages[stageIdx(control.stage) + 1];
  if (nextStage) return go(nextStage.key, 0);
}

async function prev() {
  if (control.stage === "result" && control.phase === "certificate") {
    return window.setResultPhase("pledge");
  }
  const list = items(control.stage);
  const index = Number(control.index || 0);
  if (list.length && index > 0) {
    return DB.setControl(code, controlDefaults(control.stage, index - 1));
  }
  const previousStage = stages[stageIdx(control.stage) - 1];
  if (previousStage) {
    const previousItems = items(previousStage.key);
    return go(previousStage.key, Math.max(0, previousItems.length - 1));
  }
}

async function startTimer() {
  timerLockPending = false;
  await DB.setControl(code, {
    locked: false,
    reveal: false,
    timerEndsAt: Date.now() + C.writtenSeconds * 1000,
  });
}

function updateTimer() {
  const element = $("#teacherTimer");
  if (!element) return;
  if (control.stage !== "written" || !control.timerEndsAt) {
    element.textContent = control.reveal ? "해설" : "대기";
    element.classList.remove("urgent");
    return;
  }
  const remaining = Math.max(0, Number(control.timerEndsAt) - Date.now());
  element.textContent = `${(remaining / 1000).toFixed(1)}초`;
  element.classList.toggle("urgent", remaining <= 3000);
  if (remaining <= 0 && !control.locked && !timerLockPending) {
    timerLockPending = true;
    DB.setControl(code, { locked: true, timerEndsAt: null }).finally(() => {
      timerLockPending = false;
    });
  }
}

async function assignTeams() {
  const ids = Object.keys(participants).sort(
    (a, b) =>
      Number(participants[a]?.joinedAt || 0) -
      Number(participants[b]?.joinedAt || 0),
  );
  if (!ids.length) return toast("등록한 학생이 없습니다.");
  if (
    Object.keys(answers?.field || {}).length &&
    !confirm("이미 제출된 모둠 답안이 있습니다. 모둠을 다시 편성할까요?")
  ) {
    return;
  }
  const assignments = {};
  ids.forEach((uid, index) => {
    assignments[uid] = Math.floor(index / 4) + 1;
  });
  await DB.assignTeams(code, assignments);
  toast(`${Math.ceil(ids.length / 4)}개 모둠으로 편성했습니다.`);
}

function subscribe() {
  unsubs.forEach((unsubscribe) => unsubscribe());
  unsubs = [
    DB.on("control", code, (value) => {
      control = value || control;
      renderContent();
    }),
    DB.on("participants", code, (value) => {
      participants = value || {};
      $("#joinedCount").textContent = Object.keys(participants).length;
      renderContent();
    }),
    DB.on("presence", code, (value) => {
      presence = value || {};
      $("#activeCount").textContent = Object.keys(presence).length;
    }),
    DB.on("answers", code, (value) => {
      answers = value || {};
      renderContent();
    }),
    DB.on("pledges", code, (value) => {
      pledges = value || {};
      renderContent();
    }),
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
  if (requestedCode && !/^\d{6}$/.test(requestedCode)) {
    return toast("수업방 코드는 6자리 숫자로 입력해주세요.");
  }
  const title = $("#roomTitleInput").value.trim() || C.program.title;
  const attempts = requestedCode ? 1 : 6;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const nextCode =
      requestedCode || String(Math.floor(100000 + Math.random() * 900000));
    try {
      await DB.createRoom(nextCode, title);
      await openDashboard(nextCode, {
        title,
        hostUid: DB.uid,
        status: "open",
      });
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
  const rows = [
    [
      "수험ID",
      "학생이름",
      "학교급",
      "모둠",
      "순간판단",
      "시뮬레이터",
      "현장미션",
      "종합",
      "자격",
      "실천서약",
    ],
  ];
  Object.entries(participants).forEach(([uid, participant]) => {
    const result = calcStudent(uid);
    rows.push([
      uid,
      participant.studentName,
      participant.schoolLevel === "high" ? "고등학생" : "중학생",
      participant.teamNo || "미편성",
      result.written,
      result.practical,
      result.field,
      result.total,
      result.qualification,
      pledges?.[uid]?.text || "",
    ]);
  });
  const data =
    "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blobUrl = URL.createObjectURL(
    new Blob([data], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `청렴ON_${code}_결과.csv`;
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
    $("#revealBtn").onclick = () =>
      DB.setControl(code, {
        reveal: !control.reveal,
        locked: true,
        timerEndsAt: null,
      });
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
