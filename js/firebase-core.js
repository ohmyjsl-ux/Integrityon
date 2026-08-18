(function () {
  const cfg = window.CHEONGRYEOM_FIREBASE || {};
  const configured = Boolean(
    cfg.apiKey &&
      !String(cfg.apiKey).startsWith("YOUR_") &&
      cfg.databaseURL &&
      !String(cfg.databaseURL).includes("YOUR_PROJECT"),
  );

  let db = null;
  let auth = null;
  let uid = null;

  async function init() {
    if (!configured) throw new Error("FIREBASE_NOT_CONFIGURED");
    if (!window.firebase) throw new Error("FIREBASE_SDK_NOT_LOADED");
    if (!firebase.apps.length) firebase.initializeApp(cfg);

    auth = firebase.auth();
    db = firebase.database();
    if (auth.currentUser) {
      uid = auth.currentUser.uid;
    } else {
      const credential = await auth.signInAnonymously();
      uid = credential.user.uid;
    }
    return { uid, db };
  }

  const roomRef = (code, path = "") =>
    db.ref(`rooms/${code}${path ? "/" + path : ""}`);

  async function roomMeta(code) {
    return roomRef(code, "meta")
      .once("value")
      .then((snapshot) => snapshot.val());
  }

  async function roomExists(code) {
    return Boolean(await roomMeta(code));
  }

  async function ownedRoom(code) {
    const meta = await roomMeta(code);
    return meta && meta.hostUid === uid ? meta : null;
  }

  async function createRoom(code, title) {
    if (await roomExists(code)) {
      throw new Error("이미 사용 중인 참여코드입니다.");
    }
    const now = Date.now();
    await roomRef(code).set({
      meta: {
        hostUid: uid,
        title: title || "청렴, 자격이 되다 3.0",
        createdAt: now,
        status: "open",
      },
      control: {
        stage: "waiting",
        index: 0,
        phase: "pre",
        reveal: false,
        locked: true,
        timerEndsAt: null,
        updatedAt: now,
      },
      publicStats: { participantCount: 0, updatedAt: now },
    });
  }

  async function joinRoom(code, studentName, schoolLevel) {
    const meta = await roomMeta(code);
    if (!meta) throw new Error("수업방을 찾을 수 없습니다.");
    if (meta.status !== "open") throw new Error("종료된 수업방입니다.");

    const now = Date.now();
    const participant = await roomRef(code, `participants/${uid}`)
      .once("value")
      .then((snapshot) => snapshot.val());
    await roomRef(code, `participants/${uid}`).update({
      studentName,
      schoolLevel,
      joinedAt: participant?.joinedAt || now,
    });

    const presenceRef = roomRef(code, `presence/${uid}`);
    await presenceRef.set({ studentName, at: now });
    presenceRef.onDisconnect().remove();
    return uid;
  }

  async function resumeParticipant(code) {
    if (!(await roomExists(code))) return null;
    return roomRef(code, `participants/${uid}`)
      .once("value")
      .then((snapshot) => snapshot.val());
  }

  async function heartbeat(code) {
    if (!uid || !code) return;
    return roomRef(code, `presence/${uid}`).update({ at: Date.now() });
  }

  async function setControl(code, patch) {
    return roomRef(code, "control").update({
      ...patch,
      updatedAt: Date.now(),
    });
  }

  async function assignTeams(code, teamAssignments) {
    const patch = {};
    Object.entries(teamAssignments).forEach(([participantUid, assignment]) => {
      const teamNo = Number(assignment?.teamNo ?? assignment);
      const roleIndex = Number(assignment?.roleIndex ?? 0);
      patch[`participants/${participantUid}/teamNo`] = teamNo;
      patch[`participants/${participantUid}/teamKey`] = `team-${teamNo}`;
      patch[`participants/${participantUid}/roleIndex`] = roleIndex;
    });
    return roomRef(code).update(patch);
  }

  async function submitAnswer(code, stage, questionId, choice) {
    return roomRef(code, `answers/${stage}/${questionId}/${uid}`).set({
      choice,
      at: Date.now(),
    });
  }

  async function submitWritten(code, questionId, choice) {
    return submitAnswer(code, "written", questionId, choice);
  }

  async function submitPracticalInitial(code, questionId, choice) {
    return submitAnswer(code, "practical", `${questionId}_first`, choice);
  }

  async function revisePractical(code, questionId, _firstChoice, finalChoice) {
    return submitAnswer(code, "practical", `${questionId}_final`, finalChoice);
  }

  async function submitPracticalTask(code, taskId, payload) {
    return roomRef(code, `answers/practical/${taskId}/${uid}`).set({
      payload,
      at: Date.now(),
    });
  }

  async function submitTeamTask(code, missionId, taskId, payload) {
    return roomRef(code, `answers/team/${missionId}_${taskId}/${uid}`).set({
      payload,
      at: Date.now(),
    });
  }

  async function submitField(code, missionId, _teamKey, payload) {
    const now = Date.now();
    const actions = [...payload.actions].sort((a, b) => a - b);
    const patch = {
      [`answers/field/${missionId}_verdict/${uid}`]: {
        choice: payload.verdict,
        at: now,
      },
      [`answers/field/${missionId}_action1/${uid}`]: {
        choice: actions[0],
        at: now,
      },
      [`answers/field/${missionId}_action2/${uid}`]: {
        choice: actions[1],
        at: now,
      },
      [`participants/${uid}/fieldReason`]: payload.reason,
      [`participants/${uid}/fieldSubmittedAt`]: now,
    };
    return roomRef(code).update(patch);
  }

  async function savePledge(code, text) {
    return roomRef(code, `pledges/${uid}`).set({ text, at: Date.now() });
  }

  async function publishStats(code, data) {
    return roomRef(code, "publicStats").update({
      ...data,
      updatedAt: Date.now(),
    });
  }

  async function deleteRoom(code) {
    return roomRef(code).remove();
  }

  function on(path, code, callback) {
    const ref = roomRef(code, path);
    const handler = (snapshot) => callback(snapshot.val());
    ref.on("value", handler);
    return () => ref.off("value", handler);
  }

  function once(path, code) {
    return roomRef(code, path)
      .once("value")
      .then((snapshot) => snapshot.val());
  }

  window.CheongDB = {
    configured,
    init,
    roomMeta,
    roomExists,
    ownedRoom,
    createRoom,
    joinRoom,
    resumeParticipant,
    heartbeat,
    setControl,
    assignTeams,
    submitWritten,
    submitAnswer,
    submitPracticalInitial,
    revisePractical,
    submitPracticalTask,
    submitTeamTask,
    submitField,
    savePledge,
    publishStats,
    deleteRoom,
    on,
    once,
    get uid() {
      return uid;
    },
    get db() {
      return db;
    },
  };
})();
