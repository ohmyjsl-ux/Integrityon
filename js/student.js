const C = CHEONGRYEOM_CONTENT;
const DB = CheongDB;
const $ = (selector) => document.querySelector(selector);

let code = null;
let control = null;
let myAnswers = { written: {}, practical: {}, field: {} };
let myPledge = null;
let me = null;
let selected = null;
let revisingPractical = false;
let rapidSubmitting = false;
let unsubs = [];
let heartbeatTimer = null;

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
  setTimeout(() => element.classList.remove("show"), 2000);
};

const stageIdx = (key) => stages.findIndex((stage) => stage.key === key);

function currentItem() {
  const list =
    control?.stage === "written"
      ? C.written
      : control?.stage === "practical"
        ? C.practical
        : control?.stage === "field"
          ? C.fieldMissions
          : [];
  return list[Number(control?.index || 0)] || null;
}

function mine(stage, key) {
  return myAnswers?.[stage]?.[key] || null;
}

function practicalAnswer(questionId) {
  const first = mine("practical", `${questionId}_first`);
  const final = mine("practical", `${questionId}_final`);
  if (!first || !Number.isInteger(first.choice)) return null;
  return {
    firstChoice: first.choice,
    finalChoice: Number.isInteger(final?.choice) ? final.choice : first.choice,
    revised: Number.isInteger(final?.choice),
  };
}

function fieldSubmission() {
  const missionId = C.fieldMissions[0].id;
  const verdict = mine("field", `${missionId}_verdict`);
  const action1 = mine("field", `${missionId}_action1`);
  const action2 = mine("field", `${missionId}_action2`);
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
    reason: me?.fieldReason || "",
  };
}

function choiceHTML(options, selectedChoice, settings = {}) {
  const mode = settings.mode || "regular";
  const disabled = Boolean(settings.disabled);
  return `<div class="choices">${options
    .map((option, index) => {
      const text = typeof option === "string" ? option : option.text;
      return `<button class="choice ${mode === "rapid" ? "rapid-choice" : ""} ${selectedChoice === index ? "selected" : ""}" data-choice="${index}" data-mode="${mode}" ${disabled ? "disabled" : ""}><span class="choice-letter">${String.fromCharCode(65 + index)}</span><span>${esc(text)}</span></button>`;
    })
    .join("")}</div>`;
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

function comp() {
  const sums = Object.fromEntries(
    C.virtues.map((virtue) => [virtue.key, { score: 0, count: 0 }]),
  );

  C.written.forEach((question) => {
    const answer = mine("written", question.id);
    if (!answer) return;
    Object.entries(question.impact || {}).forEach(([key, value]) => {
      sums[key].score +=
        answer.choice === question.correct ? value : Math.round(value * 0.3);
      sums[key].count += 1;
    });
  });

  C.practical.forEach((question) => {
    const answer = practicalAnswer(question.id);
    const selectedOption = question.options[answer?.finalChoice];
    if (!selectedOption) return;
    Object.entries(selectedOption.impact || {}).forEach(([key, value]) => {
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

function scores() {
  let correctWritten = 0;
  C.written.forEach((question) => {
    if (mine("written", question.id)?.choice === question.correct) {
      correctWritten += 1;
    }
  });
  const written = Math.round((correctWritten / C.written.length) * 100);

  const practicalValues = C.practical
    .map((question) => {
      const answer = practicalAnswer(question.id);
      return Number.isInteger(answer?.finalChoice)
        ? question.options[answer.finalChoice]?.score
        : null;
    })
    .filter((value) => value != null);
  const practical =
    practicalValues.length === C.practical.length
      ? Math.round(
          practicalValues.reduce((sum, value) => sum + value, 0) /
            practicalValues.length,
        )
      : 0;

  const submission = fieldSubmission();
  const field = fieldScore(submission);
  const complete =
    C.written.every((question) => mine("written", question.id)) &&
    C.practical.every((question) =>
      Number.isInteger(practicalAnswer(question.id)?.finalChoice),
    ) &&
    Boolean(submission) &&
    Boolean(myPledge?.text);
  const total = Math.round(
    (written * C.scoring.writtenWeight) / 100 +
      (practical * C.scoring.practicalWeight) / 100 +
      (field * C.scoring.fieldWeight) / 100,
  );
  const qualification =
    complete &&
    total >= C.scoring.leaderTotal &&
    practical >= C.scoring.leaderPractical &&
    field >= C.scoring.leaderField
      ? "청렴 리더"
      : complete
        ? "청렴 서포터"
        : "과정 진행 중";
  return { written, practical, field, total, complete, qualification };
}

function progress() {
  const index = Math.max(0, stageIdx(control?.stage || "waiting"));
  const percent = Math.round((index / (stages.length - 1)) * 100);
  $("#studentStage").textContent = stages[index]?.name || "수험등록";
  $("#studentPct").textContent = `${percent}%`;
  $("#studentBar").style.width = `${percent}%`;
}

function waiting(title, body) {
  const character =
    {
      waiting: "character-listen.png",
      written: "character-warning.png",
      practical: "character-tablet.png",
      field: "character-listen.png",
      result: "character-harmony.png",
    }[control?.stage || "waiting"] || "character-greeting.png";
  return `<div class="waiting"><img class="official-character" src="assets/official/${character}" alt="국민권익위원회 캐릭터"><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`;
}

function practicalContext(question) {
  const index = C.practical.findIndex((item) => item.id === question.id);
  if (index <= 0 || !question.introFromPrevious) return question.context;
  const previous = practicalAnswer(C.practical[index - 1].id);
  return question.introFromPrevious[previous?.finalChoice] || question.context;
}

function evidenceHTML(mission) {
  return `<div class="evidence-grid">${mission.evidence
    .map(
      (evidence, index) => `
        <details class="evidence-card" ${index === 0 ? "open" : ""}>
          <summary><span>${esc(evidence.no)}</span><b>${esc(evidence.title)}</b></summary>
          <p>${esc(evidence.body)}</p>
        </details>`,
    )
    .join("")}</div>`;
}

function fieldSubmissionSummary(mission, submission) {
  const selectedActions = (submission.actions || [])
    .map((index) => mission.actions[index]?.text)
    .filter(Boolean);
  return `<div class="field-result"><div class="score-main"><span>${esc(me?.teamNo || "-")}모둠 · 나의 현장미션 점수</span><strong>${fieldScore(submission)}</strong></div><p><b>판정</b> ${esc(mission.verdicts[submission.verdict] || "-")}</p><p><b>개선조치</b><br>${selectedActions.map((action) => `• ${esc(action)}`).join("<br>")}</p><p><b>판정 근거</b><br>${esc(submission.reason || "")}</p></div>`;
}

function renderField(mission) {
  if (!me?.teamKey) {
    return waiting(
      "4인 1팀 편성을 기다리고 있습니다.",
      "교사가 모둠편성을 완료하면 사건파일과 답안지가 열립니다.",
    );
  }

  const submission = fieldSubmission();
  const answerSheet = submission
    ? `${fieldSubmissionSummary(mission, submission)}<div class="feedback good"><b>나의 현장미션 답안을 제출했습니다.</b><br>모둠 토론 뒤 모든 모둠원이 각자 같은 합의안을 제출합니다.</div>`
    : `<div id="fieldForm" class="field-form"><h3>1. 사건 판정</h3><div class="verdict-grid">${mission.verdicts.map((verdict, index) => `<button class="verdict-choice" data-verdict="${index}">${esc(verdict)}</button>`).join("")}</div><h3>2. 재발방지 조치 두 가지</h3><div class="action-grid">${mission.actions.map((action, index) => `<label class="action-choice"><input type="checkbox" value="${index}"><span>${esc(action.text)}</span></label>`).join("")}</div><label for="fieldReason">3. 증거를 연결한 판정 근거</label><textarea id="fieldReason" maxlength="240" placeholder="서로 다른 증거 두 가지 이상을 연결해 ${mission.reasonMinLength}자 이상 작성하세요."></textarea><button id="fieldSubmitBtn" class="btn primary large full">나의 팀 합의안 제출</button><p class="field-note">4명이 함께 토론해 합의한 뒤, 모든 모둠원이 각자 동일한 판정과 조치를 제출합니다.</p></div>`;

  return `<span class="stage-tag team-badge">${esc(me.teamNo)}모둠 · 4인 팀 미션</span><h2>${esc(mission.title)}</h2><div class="student-context">${esc(mission.brief)}</div>${evidenceHTML(mission)}${answerSheet}`;
}

function certificateHTML(result) {
  return `<span class="stage-tag">STEP 4 · 자격취득</span><h2>축하합니다!</h2><div class="score-box"><div class="score-main"><span>종합 청렴역량 점수</span><strong>${result.total}</strong></div><div class="score-grid three"><div><span>순간판단</span><b>${result.written}</b></div><div><span>시뮬레이터</span><b>${result.practical}</b></div><div><span>현장미션</span><b>${result.field}</b></div></div></div><div id="certificate" class="certificate ${result.qualification === "청렴 리더" ? "leader" : ""}"><img src="assets/official/ci-education.png" alt="국가청렴권익교육원"><div class="cert-type">교육용 청렴능력 인증 프로그램</div><h2>청렴능력 자격증</h2><div class="cert-name">${esc(me?.studentName || "청렴ON 도전자")}</div><div class="cert-rank">${esc(result.qualification)}</div><div class="cert-text">위 학생은 「청렴, 자격이 되다 2.0」의<br>순간판단·시뮬레이션·현장미션 전 과정을 수행하고,<br>생활 속 청렴을 실천할 역량을 보여주었으므로<br><b>${esc(result.qualification)}</b>로 인증합니다.</div><div class="cert-date">${new Date().toLocaleDateString("ko-KR")}</div></div><div class="student-submit"><button id="saveCert" class="btn ${result.qualification === "청렴 리더" ? "gold" : "primary"} full">자격증 이미지 저장</button></div><div class="feedback info">※ 실제 국가기술자격이 아닌 교육용 청렴역량 인증입니다.</div>`;
}

function render() {
  if (!control) return;
  progress();
  const question = currentItem();
  const stage = control.stage;
  let html = "";

  if (stage === "waiting") {
    html = waiting(
      "수험등록 완료",
      "교사가 STEP 1을 시작할 때까지 잠시 기다려주세요.",
    );
  }

  if (stage === "written") {
    const answer = mine("written", question.id);
    const active =
      !control.locked &&
      Number(control.timerEndsAt) > 0 &&
      Number(control.timerEndsAt) > Date.now();
    html = `<div class="student-timer"><span>남은 시간</span><strong id="studentTimer">${active ? "10.0초" : "대기"}</strong></div><span class="stage-tag">STEP 1 · 순간판단 ${Number(control.index) + 1}/${C.written.length}</span><h2>${esc(question.q)}</h2>${choiceHTML(question.options, answer?.choice, { mode: "rapid", disabled: Boolean(answer) || !active })}${answer ? (control.reveal ? `<div class="feedback ${answer.choice === question.correct ? "good" : "info"}"><b>${answer.choice === question.correct ? "정답입니다." : "판단 기준을 확인해보세요."}</b><br>${esc(question.ex)}</div>` : '<div class="feedback info">답안이 제출되었습니다. 교사가 해설을 공개하면 설명을 확인할 수 있습니다.</div>') : `<div id="rapidGuide" class="feedback info">${active ? "10초 안에 한 번만 선택할 수 있습니다. 선택 즉시 제출됩니다." : "교사가 10초 타이머를 시작하면 선택지가 열립니다."}</div>`}`;
  }

  if (stage === "practical") {
    const answer = practicalAnswer(question.id);
    const outcome = Number.isInteger(answer?.finalChoice)
      ? question.options[answer.finalChoice]?.outcome
      : "";
    const choosing = !answer || revisingPractical;
    html = `<span class="stage-tag">STEP 2 · 선택의 결과 ${Number(control.index) + 1}/${C.practical.length}</span><h2>${esc(question.title)}</h2><div class="student-context branch-context">${esc(practicalContext(question))}</div><h3>${esc(question.q)}</h3>${choiceHTML(question.options, choosing ? selected : answer?.finalChoice, { disabled: !choosing })}${choosing ? `<div class="student-submit"><button id="practicalSubmitBtn" class="btn primary large full" disabled>${answer ? "최종 선택 확정" : "선택의 결과 확인"}</button></div>` : `<div class="consequence-card"><small>나의 선택이 만든 결과</small><p>${esc(outcome)}</p></div><div class="feedback info">${answer.revised ? `최초 선택 ${String.fromCharCode(65 + answer.firstChoice)} → 최종 선택 ${String.fromCharCode(65 + answer.finalChoice)}로 기록되었습니다.` : "결과를 확인한 뒤 한 번 다시 선택할 수 있습니다."}</div>${!answer.revised ? '<button id="reviseBtn" class="btn outline full">결과를 보고 다시 선택하기</button>' : ""}`}`;
  }

  if (stage === "field") {
    html = renderField(question);
  }

  if (stage === "result") {
    if (control.phase !== "certificate") {
      html = `<span class="stage-tag">STEP 4 · 실천서약</span><h2>내가 켤 청렴 스위치 한 가지</h2><div class="student-context">학교생활에서 오늘부터 직접 실천할 수 있는 행동 한 가지를 구체적으로 적어주세요.</div><div class="pledge-area"><label for="pledgeText">나의 청렴 실천서약</label><textarea id="pledgeText" maxlength="160" placeholder="예: 모둠활동에서 친한 친구 의견만 편들지 않고 모두의 의견을 같은 기준으로 듣겠습니다.">${esc(myPledge?.text || "")}</textarea><div class="student-submit"><button id="pledgeBtn" class="btn primary large full">${myPledge ? "실천서약 수정" : "실천서약 서명"}</button></div></div>`;
    } else {
      const result = scores();
      html = result.complete
        ? certificateHTML(result)
        : waiting(
            "아직 완료하지 않은 과정이 있습니다.",
            "교사의 안내에 따라 미응답 문항, 모둠 현장미션 또는 실천서약을 완료해주세요.",
          );
    }
  }

  $("#studentContent").innerHTML = html;
  bindInteractions();
  updateStudentTimer();
}

function bindRegularChoices() {
  document
    .querySelectorAll('.choice[data-mode="regular"]:not(:disabled)')
    .forEach((button) => {
      button.onclick = () => {
        selected = Number(button.dataset.choice);
        document
          .querySelectorAll('.choice[data-mode="regular"]')
          .forEach((item) => {
            item.classList.toggle("selected", item === button);
          });
        const submitButton = $("#practicalSubmitBtn");
        if (submitButton) submitButton.disabled = false;
      };
    });
}

function bindFieldForm() {
  const mission = C.fieldMissions[0];
  document.querySelectorAll(".verdict-choice").forEach((button) => {
    button.onclick = () => {
      document
        .querySelectorAll(".verdict-choice")
        .forEach((item) => item.classList.toggle("selected", item === button));
    };
  });
  document
    .querySelectorAll('.action-choice input[type="checkbox"]')
    .forEach((checkbox) => {
      checkbox.onchange = () => {
        const checked = [
          ...document.querySelectorAll(
            '.action-choice input[type="checkbox"]:checked',
          ),
        ];
        if (checked.length > mission.requiredActions) {
          checkbox.checked = false;
          toast(
            `개선조치는 ${mission.requiredActions}개만 선택할 수 있습니다.`,
          );
        }
      };
    });
  if ($("#fieldSubmitBtn")) $("#fieldSubmitBtn").onclick = submitField;
}

function bindInteractions() {
  document
    .querySelectorAll(".rapid-choice:not(:disabled)")
    .forEach((button) => {
      button.onclick = () => submitRapid(Number(button.dataset.choice));
    });
  bindRegularChoices();
  if ($("#practicalSubmitBtn")) {
    $("#practicalSubmitBtn").onclick = submitPractical;
  }
  if ($("#reviseBtn")) {
    $("#reviseBtn").onclick = () => {
      revisingPractical = true;
      selected = null;
      render();
    };
  }
  bindFieldForm();
  if ($("#pledgeBtn")) $("#pledgeBtn").onclick = savePledge;
  if ($("#saveCert")) $("#saveCert").onclick = saveCertificate;
}

async function submitRapid(choice) {
  if (rapidSubmitting || mine("written", currentItem().id)) return;
  if (
    control.locked ||
    !control.timerEndsAt ||
    Number(control.timerEndsAt) <= Date.now()
  ) {
    toast("응답 시간이 종료되었습니다.");
    return;
  }
  rapidSubmitting = true;
  document.querySelectorAll(".rapid-choice").forEach((button) => {
    button.disabled = true;
  });
  try {
    await DB.submitWritten(code, currentItem().id, choice);
    toast("순간판단 답안을 제출했습니다.");
  } catch (error) {
    console.error(error);
    toast("답안을 제출하지 못했습니다. 제한시간을 확인해주세요.");
  } finally {
    rapidSubmitting = false;
  }
}

async function submitPractical() {
  if (selected == null) return;
  const question = currentItem();
  const existing = practicalAnswer(question.id);
  try {
    if (existing && revisingPractical) {
      await DB.revisePractical(
        code,
        question.id,
        existing.firstChoice,
        selected,
      );
      toast("최종 선택을 확정했습니다.");
    } else {
      await DB.submitPracticalInitial(code, question.id, selected);
      toast("선택의 결과가 공개됩니다.");
    }
    selected = null;
    revisingPractical = false;
  } catch (error) {
    console.error(error);
    toast("선택을 저장하지 못했습니다.");
  }
}

async function submitField() {
  const mission = C.fieldMissions[0];
  const selectedVerdict = $(".verdict-choice.selected");
  const selectedActions = [
    ...document.querySelectorAll(
      '.action-choice input[type="checkbox"]:checked',
    ),
  ].map((checkbox) => Number(checkbox.value));
  const reason = $("#fieldReason").value.trim();
  if (!selectedVerdict) return toast("사건 판정을 먼저 선택해주세요.");
  if (selectedActions.length !== mission.requiredActions) {
    return toast(`재발방지 조치 ${mission.requiredActions}개를 선택해주세요.`);
  }
  if (reason.length < mission.reasonMinLength) {
    return toast(`판정 근거를 ${mission.reasonMinLength}자 이상 작성해주세요.`);
  }
  try {
    await DB.submitField(code, mission.id, me.teamKey, {
      verdict: Number(selectedVerdict.dataset.verdict),
      actions: selectedActions,
      reason,
    });
    toast("모둠 현장미션 답안을 제출했습니다.");
  } catch (error) {
    console.error(error);
    toast("다른 모둠원이 먼저 제출했는지 확인해주세요.");
  }
}

async function savePledge() {
  const text = $("#pledgeText").value.trim();
  if (text.length < 8) {
    return toast("실천서약을 조금 더 구체적으로 적어주세요.");
  }
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
    const canvas = await html2canvas(element, {
      scale: 2,
      backgroundColor: "#ffffff",
    });
    const link = document.createElement("a");
    link.download = `청렴ON_${scores().qualification}_${me?.studentName || "자격증"}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (error) {
    window.print();
  }
}

function updateStudentTimer() {
  const element = $("#studentTimer");
  if (!element || control?.stage !== "written") return;
  const remaining = Math.max(0, Number(control.timerEndsAt || 0) - Date.now());
  if (!control.timerEndsAt || control.locked) {
    element.textContent = control.reveal ? "해설" : "대기";
    return;
  }
  element.textContent = `${(remaining / 1000).toFixed(1)}초`;
  element.classList.toggle("urgent", remaining <= 3000);
  if (remaining <= 0) {
    document.querySelectorAll(".rapid-choice").forEach((button) => {
      button.disabled = true;
    });
    const guide = $("#rapidGuide");
    if (guide) guide.textContent = "응답 시간이 종료되었습니다.";
  }
}

function subscribe() {
  unsubs.forEach((unsubscribe) => unsubscribe());
  myAnswers = { written: {}, practical: {}, field: {} };
  unsubs = [
    DB.on("control", code, (value) => {
      control = value || { stage: "waiting", locked: true };
      selected = null;
      revisingPractical = false;
      render();
    }),
    DB.on(`pledges/${DB.uid}`, code, (value) => {
      myPledge = value || null;
      render();
    }),
    DB.on(`participants/${DB.uid}`, code, (value) => {
      me = value || me;
      render();
    }),
  ];

  C.written.forEach((question) => {
    unsubs.push(
      DB.on(`answers/written/${question.id}/${DB.uid}`, code, (value) => {
        if (value) myAnswers.written[question.id] = value;
        else delete myAnswers.written[question.id];
        render();
      }),
    );
  });

  C.practical.forEach((question) => {
    ["first", "final"].forEach((phase) => {
      const key = `${question.id}_${phase}`;
      unsubs.push(
        DB.on(`answers/practical/${key}/${DB.uid}`, code, (value) => {
          if (value) myAnswers.practical[key] = value;
          else delete myAnswers.practical[key];
          render();
        }),
      );
    });
  });

  const missionId = C.fieldMissions[0].id;
  ["verdict", "action1", "action2"].forEach((part) => {
    const key = `${missionId}_${part}`;
    unsubs.push(
      DB.on(`answers/field/${key}/${DB.uid}`, code, (value) => {
        if (value) myAnswers.field[key] = value;
        else delete myAnswers.field[key];
        render();
      }),
    );
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
  if (!/^\d{6}$/.test(roomCode)) {
    return toast("6자리 참여코드를 확인해주세요.");
  }
  if (studentName.length < 2 || studentName.length > 20) {
    return toast("학생 이름을 정확히 입력해주세요.");
  }
  if (!/^[가-힣A-Za-z ]+$/.test(studentName)) {
    return toast("이름에는 한글·영문과 띄어쓰기만 사용할 수 있습니다.");
  }
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
  const candidateRoom = /^\d{6}$/.test(roomFromURL || "")
    ? roomFromURL
    : /^\d{6}$/.test(savedRoom || "")
      ? savedRoom
      : "";
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
