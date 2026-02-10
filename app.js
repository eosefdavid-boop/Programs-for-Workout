/* =========================================================
   FORGEFIT — Smart Program Maker (Option 1 + Option 2)
   - Option 1: rule-based program generator (offline)
   - Option 2: smart scoring (fatigue/recovery/performance)
   - LocalStorage persistence
   - PWA install + offline service worker
   ========================================================= */

(() => {
  "use strict";

  /* =========================
     Utilities
  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const round = (n, d = 0) => {
    const m = Math.pow(10, d);
    return Math.round(n * m) / m;
  };

  const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
  const todayISO = () => new Date().toISOString().slice(0, 10);

  const debounce = (fn, ms = 200) => {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  };

  /* =========================
     Toasts + Modal
  ========================= */
  const toastWrap = $("#toastWrap");
  function toast(title, text, ms = 2600) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `
      <div class="toastTitle">${escapeHTML(title)}</div>
      <div class="toastText">${escapeHTML(text)}</div>
    `;
    toastWrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      el.style.transition = "opacity .25s ease, transform .25s ease";
      setTimeout(() => el.remove(), 260);
    }, ms);
  }

  const modalWrap = $("#modalWrap");
  const modalTitle = $("#modalTitle");
  const modalBody = $("#modalBody");
  const modalFoot = $("#modalFoot");
  $("#modalClose").addEventListener("click", () => closeModal());
  modalWrap.addEventListener("click", (e) => {
    if (e.target === modalWrap) closeModal();
  });

  function openModal({ title, bodyHTML, footHTML = "" }) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHTML;
    modalFoot.innerHTML = footHTML;
    modalWrap.classList.remove("hidden");
    modalWrap.setAttribute("aria-hidden", "false");
  }
  function closeModal() {
    modalWrap.classList.add("hidden");
    modalWrap.setAttribute("aria-hidden", "true");
  }

  /* =========================
     HTML escaping for safety
  ========================= */
  function escapeHTML(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /* =========================
     Storage Layer
  ========================= */
  const STORAGE_KEY = "forgefit_v1";
  const defaultState = {
    theme: "dark",
    settings: {
      units: "kg",
      startWeek: "mon",
    },
    profile: null, // generator inputs
    program: null, // generated plan
    todayIndex: 0,
    timer: { seconds: 0, running: false },
    history: [],
    stats: {
      streak: 0,
      lastLogDate: null,
    },
    scoring: {
      fatigue: 35,     // 0..100 (higher = more fatigued)
      recovery: 55,    // 0..100 (higher = more recovered)
      performance: 55, // 0..100 (higher = better)
      lastUpdated: null,
      weekCounter: 1,
      deloadSuggestedAtWeek: null,
    }
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(defaultState);
      const parsed = JSON.parse(raw);
      return deepMerge(structuredClone(defaultState), parsed);
    } catch {
      return structuredClone(defaultState);
    }
  }

  function saveState() {
    state._dirty = false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $("#pillSaved").textContent = "Saved";
    $("#pillSaved").classList.remove("ghost");
    setTimeout(() => {
      $("#pillSaved").textContent = "Saved";
      $("#pillSaved").classList.add("ghost");
    }, 850);
  }

  function deepMerge(base, patch) {
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      for (const k of Object.keys(patch)) {
        if (patch[k] && typeof patch[k] === "object" && !Array.isArray(patch[k])) {
          base[k] = deepMerge(base[k] ?? {}, patch[k]);
        } else {
          base[k] = patch[k];
        }
      }
    }
    return base;
  }

  let state = loadState();

  /* =========================
     PWA install + Service Worker
  ========================= */
  let deferredPrompt = null;
  const btnInstall = $("#btnInstall");
  btnInstall.style.display = "none";

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btnInstall.style.display = "inline-flex";
  });

  btnInstall.addEventListener("click", async () => {
    if (!deferredPrompt) return toast("Install", "Install prompt not available.");
    deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    deferredPrompt = null;
    btnInstall.style.display = "none";
    toast("Install", res.outcome === "accepted" ? "Installed!" : "Install dismissed.");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  /* =========================
     Exercise Library (core data)
     - gym + home variants
     - alternatives for substitutions
  ========================= */
  const EX = [
    // PUSH (chest/shoulders/triceps)
    ex("Barbell Bench Press", "push", "chest", "gym", ["Dumbbell Bench Press", "Machine Chest Press", "Push-ups"]),
    ex("Dumbbell Bench Press", "push", "chest", "gym", ["Barbell Bench Press", "Machine Chest Press", "Push-ups"]),
    ex("Machine Chest Press", "push", "chest", "gym", ["Barbell Bench Press", "Dumbbell Bench Press", "Push-ups"]),
    ex("Incline Dumbbell Press", "push", "chest", "gym", ["Incline Bench Press", "Machine Incline Press", "Feet-elevated Push-ups"]),
    ex("Cable Fly", "push", "chest", "gym", ["Pec Deck", "Dumbbell Fly", "Push-up Wide"]),
    ex("Overhead Press", "push", "shoulders", "gym", ["Dumbbell Shoulder Press", "Arnold Press", "Pike Push-ups"]),
    ex("Lateral Raise", "push", "shoulders", "gym", ["Cable Lateral Raise", "Band Lateral Raise", "Lean-away Lateral Raise"]),
    ex("Triceps Pushdown", "push", "triceps", "gym", ["Overhead Triceps Extension", "Close-Grip Push-ups", "Bench Dips"]),
    ex("Dips", "push", "triceps", "gym", ["Close-Grip Bench", "Bench Dips", "Push-ups Close"]),
    ex("Push-ups", "push", "chest", "home", ["Knee Push-ups", "Feet-elevated Push-ups", "Diamond Push-ups"]),
    ex("Pike Push-ups", "push", "shoulders", "home", ["Handstand Hold", "Dumbbell Shoulder Press", "Band Overhead Press"]),
    ex("Band Overhead Press", "push", "shoulders", "home", ["Dumbbell Shoulder Press", "Pike Push-ups", "Arnold Press"]),
    ex("Diamond Push-ups", "push", "triceps", "home", ["Close-Grip Push-ups", "Bench Dips", "Band Pushdown"]),

    // PULL (back/biceps)
    ex("Pull-ups", "pull", "back", "gym", ["Lat Pulldown", "Assisted Pull-ups", "Band Pull-down"]),
    ex("Lat Pulldown", "pull", "back", "gym", ["Pull-ups", "Band Pull-down", "One-arm Cable Pulldown"]),
    ex("Barbell Row", "pull", "back", "gym", ["Dumbbell Row", "Seated Cable Row", "Chest-Supported Row"]),
    ex("Seated Cable Row", "pull", "back", "gym", ["Barbell Row", "Dumbbell Row", "Band Row"]),
    ex("Dumbbell Row", "pull", "back", "gym", ["Barbell Row", "Cable Row", "Band Row"]),
    ex("Face Pull", "pull", "rear_delts", "gym", ["Rear Delt Fly", "Band Face Pull", "High Row"]),
    ex("Biceps Curl", "pull", "biceps", "gym", ["Hammer Curl", "Cable Curl", "Band Curl"]),
    ex("Hammer Curl", "pull", "biceps", "gym", ["Biceps Curl", "Band Curl", "Incline DB Curl"]),
    ex("Band Row", "pull", "back", "home", ["One-arm DB Row", "Towel Row", "Band Lat Pulldown"]),
    ex("Band Curl", "pull", "biceps", "home", ["DB Curl", "Hammer Curl", "Isometric Curl Hold"]),
    ex("Rear Delt Fly", "pull", "rear_delts", "home", ["Band Face Pull", "Reverse Snow Angels", "Band Pull-aparts"]),
    ex("Band Pull-aparts", "pull", "rear_delts", "home", ["Rear Delt Fly", "Band Face Pull", "Scapular Retractions"]),

    // LEGS (quads/hamstrings/glutes/calves)
    ex("Back Squat", "legs", "quads", "gym", ["Front Squat", "Leg Press", "Goblet Squat"]),
    ex("Leg Press", "legs", "quads", "gym", ["Back Squat", "Goblet Squat", "Hack Squat"]),
    ex("Romanian Deadlift", "legs", "hamstrings", "gym", ["Hip Hinge DB", "Good Morning", "Hamstring Curl"]),
    ex("Hamstring Curl", "legs", "hamstrings", "gym", ["Romanian Deadlift", "Glute Bridge", "Nordic Curl (assisted)"]),
    ex("Walking Lunges", "legs", "glutes", "gym", ["Split Squat", "Step-ups", "Reverse Lunge"]),
    ex("Calf Raise", "legs", "calves", "gym", ["Seated Calf Raise", "Single-leg Calf Raise", "Calf Raise (stairs)"]),
    ex("Goblet Squat", "legs", "quads", "home", ["Bodyweight Squat", "Split Squat", "Tempo Squat"]),
    ex("Split Squat", "legs", "glutes", "home", ["Reverse Lunge", "Step-ups", "Walking Lunges"]),
    ex("Glute Bridge", "legs", "glutes", "home", ["Hip Thrust", "Single-leg Bridge", "RDL DB"]),
    ex("Bodyweight Squat", "legs", "quads", "home", ["Tempo Squat", "Jump Squat", "Goblet Squat"]),
    ex("Single-leg Calf Raise", "legs", "calves", "home", ["Calf Raise (stairs)", "Seated Calf Raise", "Calf Raise"]),

    // CORE
    ex("Plank", "core", "core", "home", ["Side Plank", "Dead Bug", "Hollow Hold"]),
    ex("Dead Bug", "core", "core", "home", ["Plank", "Bird Dog", "Hollow Hold"]),
    ex("Hanging Knee Raise", "core", "core", "gym", ["Cable Crunch", "Reverse Crunch", "Plank"]),
    ex("Cable Crunch", "core", "core", "gym", ["Hanging Knee Raise", "Ab Wheel", "Reverse Crunch"]),
    ex("Russian Twist", "core", "core", "home", ["Bicycle Crunch", "Dead Bug", "Side Plank"])
  ];

  function ex(name, category, muscle, env, alts = []) {
    return { id: uid(), name, category, muscle, env, alts };
  }

  const CATEGORY_LABEL = {
    push: "Push",
    pull: "Pull",
    legs: "Legs",
    core: "Core",
  };

  /* =========================
     Rule-based Generator (Option 1)
     Inputs -> Split -> Days -> Exercises -> Prescription
  ========================= */
  function chooseSplit({ days, prefSplit }) {
    if (prefSplit && prefSplit !== "auto") return prefSplit;

    // Auto logic:
    // - 3 days: full body or upper/lower+full
    // - 4 days: upper/lower (best)
    // - 5-6 days: PPL or Bro (advanced)
    if (days <= 3) return "fullbody";
    if (days === 4) return "upperlower";
    if (days === 5) return "ppl";
    return "ppl";
  }

  function buildWeekTemplate(split, days) {
    // Returns array of day focus labels that map to categories.
    // We'll still insert core on most days depending on time.
    if (split === "fullbody") {
      if (days === 3) return ["Full Body A", "Full Body B", "Full Body C"];
      if (days === 4) return ["Full Body A", "Full Body B", "Full Body C", "Full Body D"];
      return Array.from({ length: days }, (_, i) => `Full Body ${String.fromCharCode(65 + i)}`);
    }

    if (split === "upperlower") {
      if (days === 4) return ["Upper A", "Lower A", "Upper B", "Lower B"];
      if (days === 3) return ["Upper", "Lower", "Upper (lite)"];
      if (days === 5) return ["Upper A", "Lower A", "Upper B", "Lower B", "Upper (pump)"];
      return ["Upper A", "Lower A", "Upper B", "Lower B"];
    }

    if (split === "ppl") {
      if (days === 3) return ["Push", "Pull", "Legs"];
      if (days === 4) return ["Push", "Pull", "Legs", "Upper (lite)"];
      if (days === 5) return ["Push", "Pull", "Legs", "Push (lite)", "Pull (lite)"];
      return ["Push", "Pull", "Legs", "Push", "Pull", "Legs"];
    }

    if (split === "bro") {
      // Classic bodybuilding style
      const bro = ["Chest", "Back", "Legs", "Shoulders", "Arms", "Core"];
      return bro.slice(0, days);
    }

    return ["Push", "Pull", "Legs"];
  }

  function pickExercises({ mode, dayLabel, minutes, goal, level, limits }) {
    // Filter allowed environment
    const envAllowed = mode === "gym" ? ["gym", "home"] : ["home", "gym"]; // home can still include simple gym ones if needed
    const pool = EX.filter(e => envAllowed.includes(e.env));

    // Safety / limit-based exclusions (simple keyword rules)
    const lim = (limits || "").toLowerCase();
    const avoidOverhead = lim.includes("shoulder") || lim.includes("overhead");
    const avoidKnee = lim.includes("knee");
    const avoidBack = lim.includes("back");

    function safe(e) {
      const n = e.name.toLowerCase();
      if (avoidOverhead && (n.includes("overhead press") || n.includes("shoulder press"))) return false;
      if (avoidKnee && (n.includes("squat") || n.includes("lunge") || n.includes("leg press"))) return false;
      if (avoidBack && (n.includes("deadlift") || n.includes("row") || n.includes("good morning") || n.includes("back squat"))) return false;
      return true;
    }

    const safePool = pool.filter(safe);

    // Determine session size based on minutes
    const baseCount = minutes <= 20 ? 4 : minutes <= 30 ? 5 : minutes <= 45 ? 6 : 7;

    // Full-body day composition
    const isFull = dayLabel.toLowerCase().includes("full body");
    const isUpper = dayLabel.toLowerCase().includes("upper");
    const isLower = dayLabel.toLowerCase().includes("lower");
    const isPush = dayLabel.toLowerCase().includes("push") || dayLabel.toLowerCase().includes("chest") || dayLabel.toLowerCase().includes("shoulders") || dayLabel.toLowerCase().includes("arms");
    const isPull = dayLabel.toLowerCase().includes("pull") || dayLabel.toLowerCase().includes("back");
    const isLegs = dayLabel.toLowerCase().includes("legs") || dayLabel.toLowerCase().includes("lower");

    // category targets
    let targets = [];
    if (isFull) targets = ["legs", "push", "pull", "core"];
    else if (isUpper) targets = ["push", "pull", "core"];
    else if (isLower) targets = ["legs", "core"];
    else if (isPush) targets = ["push", "core"];
    else if (isPull) targets = ["pull", "core"];
    else if (isLegs) targets = ["legs", "core"];
    else targets = ["push", "pull", "legs", "core"];

    // Build using weighted selection (avoid duplicates; ensure variety)
    const chosen = [];
    const usedNames = new Set();

    function chooseFromCategory(cat) {
      const candidates = safePool.filter(e => e.category === cat && !usedNames.has(e.name));
      if (!candidates.length) return null;

      // Preference rules:
      // - Gym: include at least one compound (bench, squat, row, pull-ups, OHP)
      // - Home: include tempo / bodyweight if no equipment
      let weighted = candidates.map(e => {
        let w = 1;

        const n = e.name.toLowerCase();
        // compounds weigh more
        if (cat === "push" && (n.includes("bench") || n.includes("press") || n.includes("dips"))) w += 1.2;
        if (cat === "pull" && (n.includes("row") || n.includes("pull"))) w += 1.2;
        if (cat === "legs" && (n.includes("squat") || n.includes("press") || n.includes("deadlift") || n.includes("lunge"))) w += 1.2;

        // goal-based emphasis
        if (goal === "strength") {
          if (n.includes("barbell") || n.includes("back squat") || n.includes("bench") || n.includes("row")) w += 1.1;
        }
        if (goal === "fatloss") {
          if (cat === "core") w += 0.3;
          if (n.includes("walking") || n.includes("lunge")) w += 0.25;
        }
        if (goal === "hypertrophy") {
          if (n.includes("cable") || n.includes("machine") || n.includes("raise") || n.includes("fly")) w += 0.35;
        }

        // level-based variety
        if (level === "beginner") {
          if (n.includes("barbell row") || n.includes("pull-ups")) w -= 0.2; // slightly reduce difficulty
        }

        return { e, w };
      });

      // pick weighted random
      const sum = weighted.reduce((a, x) => a + x.w, 0);
      let r = Math.random() * sum;
      for (const it of weighted) {
        r -= it.w;
        if (r <= 0) return it.e;
      }
      return weighted[weighted.length - 1].e;
    }

    // Fill plan using target cycles
    while (chosen.length < baseCount) {
      const cat = targets[chosen.length % targets.length];
      const pick = chooseFromCategory(cat);
      if (!pick) break;
      chosen.push(pick);
      usedNames.add(pick.name);
    }

    // Ensure at least 1 core if time allows
    if (!chosen.some(x => x.category === "core") && minutes >= 30) {
      const corePick = chooseFromCategory("core");
      if (corePick) chosen.push(corePick);
    }

    return chosen.slice(0, baseCount);
  }

  function prescribeSetsReps({ goal, level, minutes, tone, mode, exerciseName }) {
    // Rule-based prescription with slight “AI feel”
    // Returns { sets, reps, rest, tempo, rpeHint }
    const n = exerciseName.toLowerCase();
    const isCompound = (
      n.includes("bench") || n.includes("squat") || n.includes("deadlift") || n.includes("row") ||
      n.includes("pull-up") || n.includes("press") || n.includes("leg press") || n.includes("lunge")
    );

    // Base sets by time and tone
    let sets = minutes <= 20 ? 2 : minutes <= 30 ? 3 : 3;
    if (tone === "highvolume") sets += 1;
    if (tone === "minimal") sets = Math.max(2, sets - 1);

    // Level adjustments
    if (level === "beginner") sets = Math.max(2, sets - 1);
    if (level === "advanced") sets += isCompound ? 1 : 0;

    // Goal adjustments
    let reps = 10;
    let rest = 75;
    let tempo = "2-0-2";
    let rpeHint = "Leave 1–2 reps in reserve";

    if (goal === "strength") {
      reps = isCompound ? 5 : 8;
      rest = isCompound ? 150 : 90;
      tempo = "2-0-1";
      rpeHint = "Heavy but clean form (RPE 7–8)";
    } else if (goal === "hypertrophy") {
      reps = isCompound ? 8 : 12;
      rest = isCompound ? 105 : 75;
      tempo = "2-0-2";
      rpeHint = "Control the negative, chase pump (RPE 7–9)";
    } else if (goal === "fatloss") {
      reps = isCompound ? 10 : 14;
      rest = isCompound ? 75 : 45;
      tempo = "2-0-2";
      rpeHint = "Move with intent, keep rest tight";
    } else if (goal === "recomp") {
      reps = isCompound ? 8 : 12;
      rest = isCompound ? 90 : 60;
      tempo = "2-0-2";
      rpeHint = "Progress slowly, recover well";
    }

    // Home scaling (tempo-based difficulty)
    if (mode === "home") {
      // if bodyweight-ish, increase reps and tempo to make it harder
      if (n.includes("push-ups") || n.includes("plank") || n.includes("squat") || n.includes("bridge")) {
        reps += 4;
        tempo = goal === "strength" ? "3-1-1" : "3-0-2";
        rest = Math.max(30, rest - 15);
      }
      if (tone === "athletic") {
        rest = Math.max(30, rest - 10);
      }
    }

    // cap sanity
    sets = clamp(sets, 2, 6);
    reps = clamp(reps, 4, 20);
    rest = clamp(rest, 25, 180);

    return { sets, reps, rest, tempo, rpeHint };
  }

  function makeProgram(profile) {
    const days = Number(profile.days);
    const split = chooseSplit(profile);
    const weekTemplate = buildWeekTemplate(split, days);

    // Option 2: smart adaptation uses scoring to slightly scale volume/intensity
    const adaptOn = profile.smartAdapt;
    const { fatigue, recovery, performance } = state.scoring;

    // scale:
    // - if fatigue high or recovery low -> reduce sets by 1 on some accessories
    // - if performance high and recovery high -> slightly increase reps or sets
    let globalSetDelta = 0;
    let globalRepDelta = 0;

    if (adaptOn) {
      const readiness = computeReadinessScore({ fatigue, recovery, performance });
      if (readiness < 42) { globalSetDelta = -1; globalRepDelta = -1; }
      else if (readiness > 70) { globalSetDelta = +0; globalRepDelta = +1; }
      else { globalSetDelta = 0; globalRepDelta = 0; }
    }

    const week = weekTemplate.map((label, idx) => {
      const exercises = pickExercises({
        mode: profile.mode,
        dayLabel: label,
        minutes: Number(profile.minutes),
        goal: profile.goal,
        level: profile.level,
        limits: profile.limits
      }).map((e) => {
        const p = prescribeSetsReps({
          goal: profile.goal,
          level: profile.level,
          minutes: Number(profile.minutes),
          tone: profile.tone,
          mode: profile.mode,
          exerciseName: e.name
        });

        // Apply smart delta carefully: compounds less affected
        const isCompound = /bench|squat|deadlift|row|pull|press|leg press|lunge/i.test(e.name);
        let sets = p.sets;
        let reps = p.reps;

        if (adaptOn) {
          if (!isCompound) sets = clamp(sets + globalSetDelta, 2, 6);
          reps = clamp(reps + globalRepDelta, 4, 20);
        }

        return {
          exId: e.id,
          name: e.name,
          category: e.category,
          muscle: e.muscle,
          env: e.env,
          alts: e.alts,
          prescription: { sets, reps, rest: p.rest, tempo: p.tempo, rpeHint: p.rpeHint },
          // performance tracking fields (user can edit during workout)
          workingWeight: "", // user can type
          completedSets: 0,
          notes: ""
        };
      });

      // Day meta
      const focus = deriveFocusLabel(label);
      return {
        id: uid(),
        index: idx,
        label,
        focus,
        exercises
      };
    });

    const program = {
      id: uid(),
      createdAt: new Date().toISOString(),
      profile: { ...profile, split },
      week,
      meta: {
        split,
        version: 1,
      }
    };

    return program;
  }

  function deriveFocusLabel(dayLabel) {
    const s = dayLabel.toLowerCase();
    if (s.includes("push") || s.includes("chest") || s.includes("shoulder") || s.includes("arms")) return "Push";
    if (s.includes("pull") || s.includes("back")) return "Pull";
    if (s.includes("legs") || s.includes("lower")) return "Legs";
    if (s.includes("core")) return "Core";
    if (s.includes("upper")) return "Upper";
    if (s.includes("full body")) return "Full Body";
    return "Workout";
  }

  /* =========================
     Smart Scoring (Option 2)
  ========================= */
  function computeReadinessScore({ fatigue, recovery, performance }) {
    // Weighted blend; fatigue reduces readiness.
    const raw = (recovery * 0.45) + (performance * 0.35) + ((100 - fatigue) * 0.20);
    return clamp(Math.round(raw), 0, 100);
  }

  function updateScoringAfterWorkout({ sessionRating, completedPct, intensity }) {
    // sessionRating: 1..5 subjective
    // completedPct: 0..1
    // intensity: "easy" | "normal" | "hard"
    let { fatigue, recovery, performance } = state.scoring;

    const ratingBoost = (sessionRating - 3) * 3; // -6..+6
    const completionBoost = (completedPct - 0.75) * 20; // around -15..+5 typical
    const intensityMod = intensity === "hard" ? 8 : intensity === "easy" ? -4 : 2;

    // fatigue goes up with hard sessions and high completion
    fatigue = clamp(fatigue + intensityMod + (completedPct * 6) - (sessionRating >= 4 ? 2 : 0), 0, 100);

    // recovery drops after workout; recovers over days (handled elsewhere)
    recovery = clamp(recovery - (10 + (intensity === "hard" ? 6 : 3)) + (sessionRating >= 4 ? 2 : 0), 0, 100);

    // performance increases if you complete well and rated session ok
    performance = clamp(performance + ratingBoost + completionBoost, 0, 100);

    state.scoring.fatigue = fatigue;
    state.scoring.recovery = recovery;
    state.scoring.performance = performance;
    state.scoring.lastUpdated = new Date().toISOString();

    // Deload suggestion logic (very simple week counter)
    // Increase week counter after a full "week" of sessions roughly
    // We'll just bump occasionally based on number of logs.
    const logs = state.history.length;
    if (logs % 4 === 0) state.scoring.weekCounter = (state.scoring.weekCounter || 1) + 1;

    maybeSuggestDeload();
  }

  function recoverOverTime() {
    // Called on load / daily
    const last = state.scoring.lastUpdated ? new Date(state.scoring.lastUpdated) : null;
    const now = new Date();
    if (!last) return;

    const days = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    if (days <= 0) return;

    // each rest day: fatigue down, recovery up, performance slight stabilization
    const decayFatigue = 5 * days;
    const gainRecovery = 9 * days;

    state.scoring.fatigue = clamp(state.scoring.fatigue - decayFatigue, 0, 100);
    state.scoring.recovery = clamp(state.scoring.recovery + gainRecovery, 0, 100);

    // performance drifts toward 55 baseline slowly
    const baseline = 55;
    const p = state.scoring.performance;
    const drift = Math.sign(baseline - p) * Math.min(Math.abs(baseline - p), 2 * days);
    state.scoring.performance = clamp(p + drift, 0, 100);
  }

  function maybeSuggestDeload() {
    const on = state.profile?.autoDeload;
    if (!on) return;

    const wk = state.scoring.weekCounter || 1;
    const last = state.scoring.deloadSuggestedAtWeek;

    // Suggest around week 5-6 if fatigue high
    const ready = computeReadinessScore(state.scoring);
    const fatigueHigh = state.scoring.fatigue >= 65;
    const should = (wk >= 5 && (fatigueHigh || ready < 45));

    if (should && last !== wk) {
      state.scoring.deloadSuggestedAtWeek = wk;
      toast("Deload Suggestion", "Your fatigue is high. Consider a lighter week (reduce volume 30–40%).", 4200);
    }
  }

  function buildAdviceText() {
    if (!state.program) return "Create a plan to get adaptive recommendations.";

    const s = state.scoring;
    const ready = computeReadinessScore(s);

    if (ready >= 75) return "You’re fresh. Push performance today: add 1 rep on accessories or small weight increase.";
    if (ready >= 58) return "Solid readiness. Train normally and focus on clean reps and consistent rest.";
    if (ready >= 42) return "Caution: slightly tired. Keep form strict. Reduce 1 set on accessories if needed.";
    return "Low readiness: prioritize recovery. Consider a deload-style session (lighter weights, fewer sets).";
  }

  /* =========================
     Auto Progression (Option 1 add-on)
     - after logging, suggest next targets
  ========================= */
  function suggestProgressionForExercise(ex) {
    // ex: exercise object inside today workout; reads completedSets + notes
    // We produce a small suggestion text.
    const sets = ex.prescription.sets;
    const done = ex.completedSets || 0;
    const completion = done / sets;

    // Very simple:
    // - if >= 1.0 -> progress
    // - if 0.7-0.99 -> maintain
    // - else -> regress slightly
    if (completion >= 1.0) return "Next time: add +1 rep (or small weight).";
    if (completion >= 0.75) return "Next time: keep same target, aim to finish all sets.";
    return "Next time: reduce target slightly or increase rest to hit quality reps.";
  }

  /* =========================
     Rendering
  ========================= */
  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
  }

  function routeTo(view) {
    $$(".view").forEach(v => v.classList.remove("active"));
    $(`#view-${view}`).classList.add("active");

    $$(".navItem").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    $$(".bNav").forEach(b => b.classList.toggle("active", b.dataset.view === view));

    // render certain views on demand
    if (view === "today") renderToday();
    if (view === "history") renderHistory();
    if (view === "library") renderLibrary();
    if (view === "settings") renderSettings();
    if (view === "dashboard") renderDashboard();
    if (view === "generator") renderProgramOutput();
  }

  function renderMiniStatus() {
    const p = state.profile;
    const split = state.program?.profile?.split || "—";
    $("#miniMode").textContent = p ? (p.mode === "gym" ? "Gym" : "Home") : "—";
    $("#miniGoal").textContent = p ? labelGoal(p.goal) : "—";
    $("#miniSplit").textContent = splitLabel(split);
  }

  function renderDashboard() {
    renderMiniStatus();

    // Stats
    $("#kpiStreak").textContent = String(state.stats.streak || 0);
    $("#kpiWorkouts").textContent = String(state.history.length);
    $("#kpiWeek").textContent = String(countThisWeek());
    $("#kpiFocus").textContent = state.program ? (state.program.week[state.todayIndex]?.focus || "—") : "—";

    // Score
    const s = state.scoring;
    const ready = state.program ? computeReadinessScore(s) : null;
    $("#badgeScore").textContent = ready === null ? "—" : String(ready);
    $("#badgeSub").textContent = state.program ? "Based on logs + recovery" : "Make a plan to start";

    $("#scoreFatigue").textContent = String(s.fatigue);
    $("#scoreRecovery").textContent = String(s.recovery);
    $("#scorePerformance").textContent = String(s.performance);

    $("#barFatigue").style.width = `${clamp(s.fatigue, 0, 100)}%`;
    $("#barRecovery").style.width = `${clamp(s.recovery, 0, 100)}%`;
    $("#barPerformance").style.width = `${clamp(s.performance, 0, 100)}%`;

    $("#adviceText").textContent = buildAdviceText();

    renderNextPreview();
    renderBalanceBars();
  }

  function renderNextPreview() {
    const wrap = $("#nextPreview");
    wrap.innerHTML = "";

    if (!state.program) {
      wrap.innerHTML = `
        <div class="empty">
          <div class="emptyTitle">No plan yet</div>
          <div class="emptyText">Go to Program Maker and generate your first plan.</div>
        </div>
      `;
      return;
    }

    const day = state.program.week[state.todayIndex] || state.program.week[0];
    const s = state.scoring;
    const ready = computeReadinessScore(s);

    const top = document.createElement("div");
    top.className = "dayCard";
    top.innerHTML = `
      <div class="dayHead">
        <div>
          <div class="dayName">${escapeHTML(day.label)} • <span class="muted">${escapeHTML(day.focus)}</span></div>
          <div class="dayMeta">Readiness: <b>${ready}</b> • Auto-adjust: ${state.profile?.smartAdapt ? "On" : "Off"}</div>
        </div>
        <div class="tag">${ready >= 70 ? "Push" : ready >= 50 ? "Normal" : ready >= 42 ? "Caution" : "Recover"}</div>
      </div>
      <div class="exerciseList" id="dashExList"></div>
    `;
    wrap.appendChild(top);

    const list = $("#dashExList");
    day.exercises.slice(0, 4).forEach(ex => {
      const item = document.createElement("div");
      item.className = "exerciseItem";
      item.innerHTML = `
        <div class="exerciseLeft">
          <div class="exerciseName">${escapeHTML(ex.name)}</div>
          <div class="exerciseSub">${escapeHTML(CATEGORY_LABEL[ex.category] || ex.category)} • ${escapeHTML(ex.muscle)}</div>
        </div>
        <div class="exerciseRight">
          <div><b>${ex.prescription.sets}</b>x<b>${ex.prescription.reps}</b></div>
          <div class="exerciseSub">${ex.prescription.rest}s rest</div>
        </div>
      `;
      list.appendChild(item);
    });
  }

  function renderBalanceBars() {
    const dist = calcCategoryDistribution();
    const max = Math.max(1, dist.push, dist.pull, dist.legs, dist.core);

    const setBar = (idFill, idVal, v) => {
      $(idFill).style.width = `${Math.round((v / max) * 100)}%`;
      $(idVal).textContent = String(v);
    };

    setBar("#balPush", "#balPushVal", dist.push);
    setBar("#balPull", "#balPullVal", dist.pull);
    setBar("#balLegs", "#balLegsVal", dist.legs);
    setBar("#balCore", "#balCoreVal", dist.core);
  }

  function renderProgramOutput() {
    renderMiniStatus();

    const out = $("#programOutput");
    out.innerHTML = "";

    if (!state.program) {
      out.innerHTML = `
        <div class="empty">
          <div class="emptyTitle">Nothing generated yet</div>
          <div class="emptyText">Fill the form above and hit “Generate Program”.</div>
        </div>
      `;
      return;
    }

    state.program.week.forEach((day, idx) => {
      const card = document.createElement("div");
      card.className = "dayCard";
      card.innerHTML = `
        <div class="dayHead">
          <div>
            <div class="dayName">${escapeHTML(day.label)} • <span class="muted">${escapeHTML(day.focus)}</span></div>
            <div class="dayMeta">Day ${idx + 1} • ${state.program.profile.minutes} min • ${labelGoal(state.program.profile.goal)}</div>
          </div>
          <div class="tag">${escapeHTML(splitLabel(state.program.profile.split))}</div>
        </div>
        <div class="exerciseList"></div>
      `;
      const list = card.querySelector(".exerciseList");

      day.exercises.forEach((exObj, exi) => {
        const item = document.createElement("div");
        item.className = "exerciseItem";
        item.innerHTML = `
          <div class="exerciseLeft">
            <div class="exerciseName">${escapeHTML(exObj.name)}</div>
            <div class="exerciseSub">${escapeHTML(CATEGORY_LABEL[exObj.category] || exObj.category)} • ${escapeHTML(exObj.muscle)} • tempo ${escapeHTML(exObj.prescription.tempo)}</div>
            <div class="exerciseSub">${escapeHTML(exObj.prescription.rpeHint)}</div>
          </div>
          <div class="exerciseRight">
            <div><b>${exObj.prescription.sets}</b>x<b>${exObj.prescription.reps}</b></div>
            <div class="exerciseSub">${exObj.prescription.rest}s rest</div>
            <div class="exerciseSmallBtnRow">
              <button class="miniBtn" data-act="swap" data-day="${idx}" data-ex="${exi}">Swap</button>
              <button class="miniBtn" data-act="note" data-day="${idx}" data-ex="${exi}">Note</button>
            </div>
          </div>
        `;
        list.appendChild(item);
      });

      out.appendChild(card);
    });

    // attach delegation
    out.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const day = Number(b.dataset.day);
      const exi = Number(b.dataset.ex);
      if (!Number.isFinite(day) || !Number.isFinite(exi)) return;

      if (act === "swap") openSwapModal(day, exi);
      if (act === "note") openNoteModal(day, exi);
    };
  }

  function renderToday() {
    renderMiniStatus();

    const wrap = $("#todayList");
    wrap.innerHTML = "";

    if (!state.program) {
      $("#todayTitle").textContent = "No plan yet";
      $("#todayMeta").textContent = "Go to Program Maker and generate your plan.";
      wrap.innerHTML = `
        <div class="empty">
          <div class="emptyTitle">No plan</div>
          <div class="emptyText">Generate a program first.</div>
        </div>
      `;
      return;
    }

    const day = state.program.week[state.todayIndex];
    $("#todayTitle").textContent = day.label;
    $("#todayMeta").textContent = `${day.focus} • ${state.program.profile.minutes} min • ${labelGoal(state.program.profile.goal)} • ${state.program.profile.mode === "gym" ? "Gym" : "Home"}`;

    day.exercises.forEach((exObj, idx) => {
      const card = document.createElement("div");
      card.className = "dayCard";

      card.innerHTML = `
        <div class="dayHead">
          <div>
            <div class="dayName">${escapeHTML(exObj.name)}</div>
            <div class="dayMeta">${escapeHTML(CATEGORY_LABEL[exObj.category] || exObj.category)} • ${escapeHTML(exObj.muscle)} • tempo ${escapeHTML(exObj.prescription.tempo)}</div>
          </div>
          <div class="tag">${exObj.prescription.rest}s rest</div>
        </div>

        <div class="setGrid">
          <div class="setCell">
            <div class="setLabel">Target</div>
            <div class="setValue"><b>${exObj.prescription.sets}</b> sets × <b>${exObj.prescription.reps}</b> reps</div>
            <div class="help">${escapeHTML(exObj.prescription.rpeHint)}</div>
          </div>

          <div class="setCell">
            <div class="setLabel">Working Weight</div>
            <div class="setValue">
              <input class="weightInput" data-idx="${idx}" value="${escapeHTML(exObj.workingWeight || "")}" placeholder="${state.settings.units}…" />
            </div>
            <div class="help">Optional</div>
          </div>

          <div class="setCell">
            <div class="setLabel">Completed Sets</div>
            <div class="setValue"><b id="done-${idx}">${exObj.completedSets || 0}</b> / ${exObj.prescription.sets}</div>
            <div class="setActions">
              <button class="miniBtn" data-act="minus" data-idx="${idx}">-</button>
              <button class="miniBtn" data-act="plus" data-idx="${idx}">+</button>
              <button class="miniBtn" data-act="rest" data-idx="${idx}">Start Rest</button>
            </div>
          </div>

          <div class="setCell">
            <div class="setLabel">Tools</div>
            <div class="setValue">Options</div>
            <div class="setActions">
              <button class="miniBtn" data-act="swap" data-idx="${idx}">Swap</button>
              <button class="miniBtn" data-act="note" data-idx="${idx}">Note</button>
            </div>
            <div class="help">Your edits save.</div>
          </div>
        </div>
      `;

      wrap.appendChild(card);
    });

    // Weight input listener
    $$(".weightInput").forEach(inp => {
      inp.addEventListener("input", debounce((e) => {
        const idx = Number(e.target.dataset.idx);
        if (!Number.isFinite(idx)) return;
        state.program.week[state.todayIndex].exercises[idx].workingWeight = e.target.value.trim();
        state._dirty = true;
        saveState();
      }, 220));
    });

    // Delegated buttons
    wrap.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const act = b.dataset.act;
      const idx = Number(b.dataset.idx);

      if (!Number.isFinite(idx)) return;
      const exObj = state.program.week[state.todayIndex].exercises[idx];

      if (act === "minus") {
        exObj.completedSets = clamp((exObj.completedSets || 0) - 1, 0, exObj.prescription.sets);
        state._dirty = true; saveState(); renderToday();
      }
      if (act === "plus") {
        exObj.completedSets = clamp((exObj.completedSets || 0) + 1, 0, exObj.prescription.sets);
        state._dirty = true; saveState(); renderToday();
      }
      if (act === "rest") {
        startTimer(exObj.prescription.rest);
        toast("Rest Timer", `${exObj.prescription.rest}s started.`);
      }
      if (act === "swap") {
        openSwapModal(state.todayIndex, idx, true);
      }
      if (act === "note") {
        openNoteModal(state.todayIndex, idx, true);
      }
    };
  }

  function renderHistory() {
    renderMiniStatus();
    const list = $("#historyList");
    list.innerHTML = "";

    if (!state.history.length) {
      list.innerHTML = `
        <div class="empty">
          <div class="emptyTitle">No logs yet</div>
          <div class="emptyText">Finish a workout to create your first log.</div>
        </div>
      `;
      return;
    }

    state.history.slice().reverse().forEach((log) => {
      const card = document.createElement("div");
      card.className = "histCard";
      const ready = log.readiness ?? "—";

      const badgeIntensity = log.intensity === "hard" ? "warn" : log.intensity === "easy" ? "" : "good";
      const badgeCompletion = log.completedPct >= 0.95 ? "good" : log.completedPct >= 0.75 ? "warn" : "bad";

      card.innerHTML = `
        <div class="histTop">
          <div>
            <div class="histTitle">${escapeHTML(log.date)} • ${escapeHTML(log.dayLabel)}</div>
            <div class="histMeta">${escapeHTML(log.focus)} • ${escapeHTML(labelGoal(log.goal))} • Readiness: <b>${ready}</b></div>
          </div>
          <div class="histBadges">
            <span class="badge ${badgeIntensity}">Intensity: ${escapeHTML(log.intensity)}</span>
            <span class="badge ${badgeCompletion}">Completion: ${Math.round(log.completedPct * 100)}%</span>
            <span class="badge">Rating: ${log.rating}/5</span>
          </div>
        </div>
        <div class="muted small" style="margin-top:10px;">
          ${escapeHTML(log.summary)}
        </div>
      `;
      list.appendChild(card);
    });
  }

  function renderLibrary(filter = "") {
    renderMiniStatus();
    const grid = $("#libraryGrid");
    grid.innerHTML = "";

    const q = (filter || "").toLowerCase().trim();
    const items = EX.filter(x => !q || x.name.toLowerCase().includes(q) || x.category.includes(q) || x.muscle.includes(q));

    items.forEach((x) => {
      const el = document.createElement("div");
      el.className = "libCard";
      el.innerHTML = `
        <div class="libName">${escapeHTML(x.name)}</div>
        <div class="libMeta">${escapeHTML(CATEGORY_LABEL[x.category] || x.category)} • ${escapeHTML(x.muscle)} • ${escapeHTML(x.env.toUpperCase())}</div>
        <div class="libMeta">Alternatives: ${x.alts?.length ? escapeHTML(x.alts.join(", ")) : "—"}</div>
      `;
      el.addEventListener("click", () => {
        openModal({
          title: x.name,
          bodyHTML: `
            <div class="muted">Category: <b>${escapeHTML(CATEGORY_LABEL[x.category] || x.category)}</b></div>
            <div class="muted" style="margin-top:6px;">Muscle: <b>${escapeHTML(x.muscle)}</b></div>
            <div class="muted" style="margin-top:6px;">Environment: <b>${escapeHTML(x.env)}</b></div>
            <div class="divider"></div>
            <div><b>Alternatives</b></div>
            <div class="muted" style="margin-top:6px; line-height:1.5;">
              ${x.alts?.length ? escapeHTML(x.alts.join(" • ")) : "No alternatives listed."}
            </div>
          `,
          footHTML: `<button class="btn ghost" type="button" onclick="document.getElementById('modalClose').click()">Close</button>`
        });
      });
      grid.appendChild(el);
    });
  }

  function renderSettings() {
    $("#units").value = state.settings.units;
    $("#startWeek").value = state.settings.startWeek;
  }

  /* =========================
     Swap / Note modals
  ========================= */
  function openSwapModal(dayIndex, exIndex, fromToday = false) {
    const exObj = state.program.week[dayIndex].exercises[exIndex];
    const altNames = exObj.alts || [];
    const candidates = EX
      .filter(e => e.category === exObj.category)
      .map(e => e.name)
      .filter(n => n !== exObj.name);

    // Prefer listed alternatives; then other same-category
    const merged = [...new Set([...altNames, ...candidates])].slice(0, 12);

    const itemsHTML = merged.map((name) => {
      return `<button class="btn soft" data-swap="${escapeHTML(name)}" type="button" style="width:100%; justify-content:flex-start; margin-top:8px;">
        ${escapeHTML(name)}
      </button>`;
    }).join("");

    openModal({
      title: "Swap Exercise",
      bodyHTML: `
        <div class="muted small">Replacing: <b>${escapeHTML(exObj.name)}</b></div>
        <div class="divider"></div>
        <div><b>Pick a replacement</b></div>
        <div>${itemsHTML || `<div class="muted" style="margin-top:10px;">No options available.</div>`}</div>
      `,
      footHTML: `
        <button class="btn ghost" id="swapCancel" type="button">Cancel</button>
      `
    });

    $("#swapCancel").onclick = () => closeModal();
    modalBody.onclick = (e) => {
      const b = e.target.closest("button[data-swap]");
      if (!b) return;
      const newName = b.dataset.swap;

      const newEx = EX.find(x => x.name === newName);
      if (!newEx) return;

      // Keep prescription style; re-run prescriber for the new name
      const profile = state.program.profile;
      const p = prescribeSetsReps({
        goal: profile.goal,
        level: profile.level,
        minutes: Number(profile.minutes),
        tone: profile.tone,
        mode: profile.mode,
        exerciseName: newEx.name
      });

      exObj.name = newEx.name;
      exObj.exId = newEx.id;
      exObj.category = newEx.category;
      exObj.muscle = newEx.muscle;
      exObj.env = newEx.env;
      exObj.alts = newEx.alts;
      exObj.prescription = { ...exObj.prescription, rest: p.rest, tempo: p.tempo, rpeHint: p.rpeHint };
      exObj.completedSets = 0;
      exObj.notes = exObj.notes || "";

      state._dirty = true;
      saveState();
      closeModal();
      toast("Swap", "Exercise replaced and saved.");

      if (fromToday) renderToday();
      else renderProgramOutput();
      renderDashboard();
    };
  }

  function openNoteModal(dayIndex, exIndex, fromToday = false) {
    const exObj = state.program.week[dayIndex].exercises[exIndex];
    openModal({
      title: "Notes",
      bodyHTML: `
        <div class="muted small">Exercise: <b>${escapeHTML(exObj.name)}</b></div>
        <div class="divider"></div>
        <textarea id="noteArea" style="width:100%; min-height:140px; resize:vertical; padding:12px; border-radius:14px; border:1px solid var(--stroke); background: rgba(255,255,255,.04); color: var(--text);" placeholder="Write cues, pain notes, targets…">${escapeHTML(exObj.notes || "")}</textarea>
      `,
      footHTML: `
        <button class="btn ghost" id="noteCancel" type="button">Cancel</button>
        <button class="btn" id="noteSave" type="button">Save</button>
      `
    });

    $("#noteCancel").onclick = () => closeModal();
    $("#noteSave").onclick = () => {
      const val = $("#noteArea").value.trim();
      exObj.notes = val;
      state._dirty = true;
      saveState();
      closeModal();
      toast("Saved", "Notes updated.");

      if (fromToday) renderToday();
      else renderProgramOutput();
    };
  }

  /* =========================
     Timer
  ========================= */
  let timerInterval = null;
  function setTimerUI() {
    const s = state.timer.seconds || 0;
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("#timerTime").textContent = `${mm}:${ss}`;
  }

  function startTimer(seconds) {
    state.timer.seconds = seconds;
    state.timer.running = true;
    setTimerUI();
    saveState();

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!state.timer.running) return;
      state.timer.seconds = Math.max(0, (state.timer.seconds || 0) - 1);
      setTimerUI();
      if (state.timer.seconds <= 0) {
        state.timer.running = false;
        clearInterval(timerInterval);
        timerInterval = null;
        saveState();
        toast("Timer", "Rest finished. Go lift 😤");
        try { navigator.vibrate?.([120, 60, 120]); } catch {}
      }
    }, 1000);
  }

  function stopTimer() {
    state.timer.running = false;
    saveState();
  }
  function resetTimer() {
    state.timer.seconds = 0;
    state.timer.running = false;
    setTimerUI();
    saveState();
  }

  /* =========================
     Logging workout
  ========================= */
  function openFinishWorkoutModal() {
    if (!state.program) return toast("No plan", "Generate a program first.");

    const day = state.program.week[state.todayIndex];

    // Compute completion
    const totalSets = day.exercises.reduce((a, x) => a + x.prescription.sets, 0);
    const doneSets = day.exercises.reduce((a, x) => a + (x.completedSets || 0), 0);
    const completedPct = totalSets ? doneSets / totalSets : 0;

    const bodyHTML = `
      <div class="muted">Day: <b>${escapeHTML(day.label)}</b> • Focus: <b>${escapeHTML(day.focus)}</b></div>
      <div class="muted" style="margin-top:6px;">Completion: <b>${Math.round(completedPct * 100)}%</b></div>

      <div class="divider"></div>

      <div class="field">
        <label>How hard was it?</label>
        <select id="logIntensity">
          <option value="easy">Easy</option>
          <option value="normal" selected>Normal</option>
          <option value="hard">Hard</option>
        </select>
      </div>

      <div class="field" style="margin-top:10px;">
        <label>Session rating (1–5)</label>
        <select id="logRating">
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3" selected>3</option>
          <option value="4">4</option>
          <option value="5">5</option>
        </select>
        <div class="help">This updates your smart score (fatigue/recovery/performance).</div>
      </div>

      <div class="field" style="margin-top:10px;">
        <label>Quick notes</label>
        <input id="logNotes" placeholder="e.g. felt strong, shoulder tight, good pump…" />
      </div>

      <div class="divider"></div>
      <div><b>Auto Progression Suggestions</b></div>
      <div class="muted" style="margin-top:8px; line-height:1.55;">
        ${day.exercises.map(x => `• ${escapeHTML(x.name)}: ${escapeHTML(suggestProgressionForExercise(x))}`).join("<br/>")}
      </div>
    `;

    openModal({
      title: "Finish & Log Workout",
      bodyHTML,
      footHTML: `
        <button class="btn ghost" id="logCancel" type="button">Cancel</button>
        <button class="btn" id="logSave" type="button">Save Log</button>
      `
    });

    $("#logCancel").onclick = () => closeModal();
    $("#logSave").onclick = () => {
      const intensity = $("#logIntensity").value;
      const rating = Number($("#logRating").value);
      const notes = ($("#logNotes").value || "").trim();

      const s = state.scoring;
      const readiness = computeReadinessScore(s);

      const summary = buildLogSummary(day, completedPct, intensity, rating, notes);

      state.history.push({
        id: uid(),
        date: todayISO(),
        dayLabel: day.label,
        focus: day.focus,
        goal: state.program.profile.goal,
        mode: state.program.profile.mode,
        completedPct: round(completedPct, 3),
        intensity,
        rating,
        readiness,
        summary
      });

      // Update streak
      updateStreakOnLog();

      // Smart scoring update
      if (state.profile?.smartAdapt) {
        updateScoringAfterWorkout({ sessionRating: rating, completedPct, intensity });
      } else {
        // still set lastUpdated so recoverOverTime behaves
        state.scoring.lastUpdated = new Date().toISOString();
      }

      // Reset completed sets for next time (but keep notes & weights)
      day.exercises.forEach(x => { x.completedSets = 0; });

      state._dirty = true;
      saveState();
      closeModal();

      toast("Logged", "Workout saved. Your program will adapt automatically.");
      renderDashboard();
      renderHistory();
      routeTo("dashboard");
    };
  }

  function buildLogSummary(day, completedPct, intensity, rating, notes) {
    const exDone = day.exercises
      .filter(x => (x.completedSets || 0) > 0)
      .map(x => `${x.name} (${x.completedSets}/${x.prescription.sets} sets)`)
      .slice(0, 6);

    const base = `Finished ${day.label} • ${Math.round(completedPct * 100)}% completion • intensity ${intensity} • rating ${rating}/5.`;
    const detail = exDone.length ? ` Top: ${exDone.join(", ")}.` : "";
    const user = notes ? ` Notes: ${notes}` : "";
    return base + detail + user;
  }

  function updateStreakOnLog() {
    const today = todayISO();
    const last = state.stats.lastLogDate;

    if (!last) {
      state.stats.streak = 1;
      state.stats.lastLogDate = today;
      return;
    }

    // Compare days difference
    const d1 = new Date(last + "T00:00:00");
    const d2 = new Date(today + "T00:00:00");
    const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      // already logged today
      state.stats.lastLogDate = today;
      return;
    }
    if (diffDays === 1) {
      state.stats.streak = (state.stats.streak || 0) + 1;
      state.stats.lastLogDate = today;
      return;
    }
    // streak broken
    state.stats.streak = 1;
    state.stats.lastLogDate = today;
  }

  function countThisWeek() {
    // crude weekly count based on last 7 days
    const now = new Date();
    const cutoff = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    let c = 0;
    for (const log of state.history) {
      const dt = new Date(log.date + "T00:00:00");
      if (dt >= cutoff) c++;
    }
    return c;
  }

  function calcCategoryDistribution() {
    if (!state.program) return { push: 0, pull: 0, legs: 0, core: 0 };
    const dist = { push: 0, pull: 0, legs: 0, core: 0 };
    state.program.week.forEach(d => {
      d.exercises.forEach(x => {
        if (dist[x.category] !== undefined) dist[x.category] += 1;
      });
    });
    return dist;
  }

  /* =========================
     Labels
  ========================= */
  function labelGoal(g) {
    return g === "hypertrophy" ? "Muscle" :
           g === "fatloss" ? "Fat Loss" :
           g === "strength" ? "Strength" :
           g === "recomp" ? "Recomp" : g;
  }

  function splitLabel(s) {
    return s === "fullbody" ? "Full Body" :
           s === "upperlower" ? "Upper/Lower" :
           s === "ppl" ? "PPL" :
           s === "bro" ? "Bro Split" :
           s === "auto" ? "Auto" : (s || "—");
  }

  /* =========================
     Form -> Profile
  ========================= */
  function readProfileFromForm() {
    return {
      mode: $("#mode").value,
      goal: $("#goal").value,
      level: $("#level").value,
      days: $("#days").value,
      minutes: $("#minutes").value,
      equip: $("#equip").value,
      limits: $("#limits").value.trim(),
      prefSplit: $("#prefSplit").value,
      tone: $("#tone").value,
      autoProg: $("#toggleAutoProg").checked,
      smartAdapt: $("#toggleSmartAdapt").checked,
      autoDeload: $("#toggleDeload").checked,
    };
  }

  function writeFormFromProfile(p) {
    if (!p) return;
    $("#mode").value = p.mode;
    $("#goal").value = p.goal;
    $("#level").value = p.level;
    $("#days").value = String(p.days);
    $("#minutes").value = String(p.minutes);
    $("#equip").value = p.equip;
    $("#limits").value = p.limits || "";
    $("#prefSplit").value = p.prefSplit || "auto";
    $("#tone").value = p.tone || "balanced";
    $("#toggleAutoProg").checked = !!p.autoProg;
    $("#toggleSmartAdapt").checked = !!p.smartAdapt;
    $("#toggleDeload").checked = !!p.autoDeload;
  }

  /* =========================
     Actions
  ========================= */
  function generateProgram() {
    const profile = readProfileFromForm();

    // If home mode, we’ll bias exercise picks by equipment (simple rule)
    // (kept light: the exercise pool already includes home options)
    // You can expand this later.

    state.profile = profile;

    const program = makeProgram(profile);
    state.program = program;
    state.todayIndex = 0;

    state._dirty = true;
    saveState();

    toast("Generated", `Program created: ${splitLabel(program.profile.split)} • ${profile.days} days/week`);
    renderProgramOutput();
    renderDashboard();
    routeTo("generator");
  }

  function rebuildTodayWithCurrentScoring() {
    if (!state.profile) return toast("No profile", "Generate a program first.");
    // Regenerate but keep weights/notes if same exercise appears.
    const old = state.program;
    const fresh = makeProgram(state.profile);

    // Attempt to carry over weight/notes by matching exercise name
    const map = new Map();
    old?.week?.forEach(d => d.exercises.forEach(ex => map.set(ex.name, { workingWeight: ex.workingWeight, notes: ex.notes })));

    fresh.week.forEach(d => d.exercises.forEach(ex => {
      const saved = map.get(ex.name);
      if (saved) {
        ex.workingWeight = saved.workingWeight;
        ex.notes = saved.notes;
      }
    }));

    state.program = fresh;
    state._dirty = true;
    saveState();

    toast("Rebuilt", "Today’s plan refreshed based on readiness.");
    renderDashboard();
    renderToday();
  }

  function quickLog() {
    if (!state.program) return toast("No plan", "Generate a program first.");

    openModal({
      title: "Quick Log (No set tracking)",
      bodyHTML: `
        <div class="muted">Use this when you did a session but didn’t track sets.</div>
        <div class="divider"></div>
        <div class="field">
          <label>Intensity</label>
          <select id="qIntensity">
            <option value="easy">Easy</option>
            <option value="normal" selected>Normal</option>
            <option value="hard">Hard</option>
          </select>
        </div>
        <div class="field" style="margin-top:10px;">
          <label>Rating (1–5)</label>
          <select id="qRating">
            <option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option>
          </select>
        </div>
        <div class="field" style="margin-top:10px;">
          <label>Completion estimate</label>
          <select id="qComp">
            <option value="0.6">60%</option>
            <option value="0.75" selected>75%</option>
            <option value="0.9">90%</option>
            <option value="1">100%</option>
          </select>
        </div>
        <div class="field" style="margin-top:10px;">
          <label>Notes</label>
          <input id="qNotes" placeholder="quick note…" />
        </div>
      `,
      footHTML: `
        <button class="btn ghost" id="qCancel" type="button">Cancel</button>
        <button class="btn" id="qSave" type="button">Save</button>
      `
    });

    $("#qCancel").onclick = () => closeModal();
    $("#qSave").onclick = () => {
      const intensity = $("#qIntensity").value;
      const rating = Number($("#qRating").value);
      const completedPct = Number($("#qComp").value);
      const notes = ($("#qNotes").value || "").trim();

      const day = state.program.week[state.todayIndex];
      const readiness = computeReadinessScore(state.scoring);
      const summary = `Quick log • ${Math.round(completedPct * 100)}% • intensity ${intensity} • rating ${rating}/5. ${notes ? "Notes: " + notes : ""}`;

      state.history.push({
        id: uid(),
        date: todayISO(),
        dayLabel: day.label,
        focus: day.focus,
        goal: state.program.profile.goal,
        mode: state.program.profile.mode,
        completedPct: round(completedPct, 3),
        intensity,
        rating,
        readiness,
        summary
      });

      updateStreakOnLog();
      if (state.profile?.smartAdapt) {
        updateScoringAfterWorkout({ sessionRating: rating, completedPct, intensity });
      } else {
        state.scoring.lastUpdated = new Date().toISOString();
      }

      state._dirty = true;
      saveState();
      closeModal();
      toast("Saved", "Quick log stored.");
      renderDashboard();
    };
  }

  function exportJSON() {
    const data = JSON.stringify({ ...state, _dirty: undefined }, null, 2);
    // Create download
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `forgefit-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Backup", "Downloaded JSON backup.");
  }

  function restoreJSON() {
    openModal({
      title: "Restore Backup",
      bodyHTML: `
        <div class="muted">Paste your JSON backup below. This will replace current data.</div>
        <div class="divider"></div>
        <textarea id="restoreArea" style="width:100%; min-height:180px; resize:vertical; padding:12px; border-radius:14px; border:1px solid var(--stroke); background: rgba(255,255,255,.04); color: var(--text);" placeholder="{...}"></textarea>
      `,
      footHTML: `
        <button class="btn ghost" id="rCancel" type="button">Cancel</button>
        <button class="btn" id="rApply" type="button">Restore</button>
      `
    });

    $("#rCancel").onclick = () => closeModal();
    $("#rApply").onclick = () => {
      try {
        const txt = $("#restoreArea").value.trim();
        const obj = JSON.parse(txt);
        state = deepMerge(structuredClone(defaultState), obj);
        setTheme(state.theme || "dark");
        saveState();
        closeModal();
        toast("Restored", "Backup loaded successfully.");
        hydrateUIFromState();
        renderDashboard();
      } catch {
        toast("Error", "Invalid JSON. Paste a valid backup.");
      }
    };
  }

  function wipeAll() {
    openModal({
      title: "Wipe All Data",
      bodyHTML: `
        <div class="muted">This deletes your plan, logs, and settings from this device.</div>
        <div class="divider"></div>
        <div><b>Type WIPE to confirm</b></div>
        <input id="wipeConfirm" style="width:100%; margin-top:10px; padding:10px 12px; border-radius:14px; border:1px solid var(--stroke); background: rgba(255,255,255,.04); color: var(--text);" placeholder="WIPE" />
      `,
      footHTML: `
        <button class="btn ghost" id="wipeCancel" type="button">Cancel</button>
        <button class="btn danger" id="wipeGo" type="button">Wipe</button>
      `
    });

    $("#wipeCancel").onclick = () => closeModal();
    $("#wipeGo").onclick = () => {
      const v = ($("#wipeConfirm").value || "").trim();
      if (v !== "WIPE") return toast("Confirm", "Type WIPE exactly to continue.");
      localStorage.removeItem(STORAGE_KEY);
      state = structuredClone(defaultState);
      setTheme(state.theme);
      saveState();
      closeModal();
      toast("Wiped", "All data cleared.");
      hydrateUIFromState();
      renderDashboard();
      routeTo("dashboard");
    };
  }

  function resetAllQuick() {
    localStorage.removeItem(STORAGE_KEY);
    state = structuredClone(defaultState);
    setTheme(state.theme);
    saveState();
    hydrateUIFromState();
    renderDashboard();
    toast("Reset", "App reset complete.");
  }

  function explainScore() {
    const s = state.scoring;
    const readiness = computeReadinessScore(s);
    openModal({
      title: "How the score works",
      bodyHTML: `
        <div class="muted">This is “Smart Scoring” (Option 2). It’s not an API — it runs offline.</div>
        <div class="divider"></div>
        <div><b>Readiness Score: ${readiness}/100</b></div>
        <div class="muted" style="margin-top:6px; line-height:1.5;">
          • <b>Fatigue</b> increases after hard sessions and drops with rest days.<br/>
          • <b>Recovery</b> drops after workouts and rises each rest day.<br/>
          • <b>Performance</b> increases when you complete workouts and rate sessions well.
        </div>
        <div class="divider"></div>
        <div class="muted" style="line-height:1.5;">
          When readiness is low, the generator reduces accessory volume and suggests deloads.
          When readiness is high, it nudges reps slightly up.
        </div>
      `,
      footHTML: `<button class="btn ghost" type="button" onclick="document.getElementById('modalClose').click()">Close</button>`
    });
  }

  function suggestDeloadManual() {
    if (!state.program) return toast("No plan", "Generate a plan first.");
    const ready = computeReadinessScore(state.scoring);
    const fatigue = state.scoring.fatigue;

    openModal({
      title: "Deload Suggestion",
      bodyHTML: `
        <div class="muted">Readiness: <b>${ready}</b> • Fatigue: <b>${fatigue}</b></div>
        <div class="divider"></div>
        <div><b>Recommended deload if:</b></div>
        <div class="muted" style="margin-top:6px; line-height:1.6;">
          • Fatigue ≥ 65 <br/>
          • Readiness ≤ 45 <br/>
          • You feel joint pain, sleep is bad, or you’re plateauing
        </div>
        <div class="divider"></div>
        <div><b>Deload rules (simple & effective):</b></div>
        <div class="muted" style="margin-top:6px; line-height:1.6;">
          • Reduce sets by ~30–40% <br/>
          • Keep technique crisp <br/>
          • Stop 2–3 reps before failure <br/>
          • Prioritize sleep + food
        </div>
      `,
      footHTML: `<button class="btn ghost" type="button" onclick="document.getElementById('modalClose').click()">Close</button>`
    });
  }

  /* =========================
     Hydration / UI
  ========================= */
  function hydrateUIFromState() {
    setTheme(state.theme || "dark");
    $("#units").value = state.settings.units;
    $("#startWeek").value = state.settings.startWeek;

    // Fill generator form
    if (state.profile) writeFormFromProfile(state.profile);

    // Timer
    setTimerUI();

    // Offline badge
    $("#pillOffline").textContent = navigator.onLine ? "Online" : "Offline Ready";
  }

  /* =========================
     Event listeners
  ========================= */
  // Sidebar + bottom nav routing
  $$(".navItem").forEach(b => b.addEventListener("click", () => routeTo(b.dataset.view)));
  $$(".bNav").forEach(b => b.addEventListener("click", () => routeTo(b.dataset.view)));
  $$("[data-nav]").forEach(b => b.addEventListener("click", () => routeTo(b.dataset.nav)));

  $("#btnTheme").addEventListener("click", () => {
    const next = state.theme === "light" ? "dark" : "light";
    setTheme(next);
    saveState();
    toast("Theme", next === "light" ? "Light mode" : "Dark mode");
  });

  $("#btnQuickGen").addEventListener("click", () => routeTo("generator"));
  $("#btnGenerate").addEventListener("click", generateProgram);
  $("#btnRebuildToday").addEventListener("click", rebuildTodayWithCurrentScoring);
  $("#btnRecalcBalance").addEventListener("click", renderBalanceBars);

  $("#btnStartWorkout").addEventListener("click", () => routeTo("today"));
  $("#btnLogQuick").addEventListener("click", quickLog);
  $("#btnReset").addEventListener("click", resetAllQuick);

  $("#btnFinishWorkout").addEventListener("click", openFinishWorkoutModal);

  $("#btnPrevDay").addEventListener("click", () => {
    if (!state.program) return;
    state.todayIndex = (state.todayIndex - 1 + state.program.week.length) % state.program.week.length;
    saveState();
    renderToday();
    renderDashboard();
  });
  $("#btnNextDay").addEventListener("click", () => {
    if (!state.program) return;
    state.todayIndex = (state.todayIndex + 1) % state.program.week.length;
    saveState();
    renderToday();
    renderDashboard();
  });

  // Timer buttons
  $("#btnTimerStart").addEventListener("click", () => {
    if (state.timer.seconds <= 0) startTimer(60);
    else startTimer(state.timer.seconds);
  });
  $("#btnTimerStop").addEventListener("click", () => stopTimer());
  $("#btnTimerReset").addEventListener("click", () => resetTimer());

  // Export / Copy
  $("#btnExport").addEventListener("click", () => {
    if (!state.program) return toast("No program", "Generate a plan first.");
    exportJSON();
  });

  $("#btnCopyText").addEventListener("click", async () => {
    if (!state.program) return toast("No program", "Generate a plan first.");
    const txt = programToText(state.program);
    const ok = await copyToClipboard(txt);
    toast("Copy", ok ? "Program copied." : "Copy failed.");
  });

  $("#btnClearHistory").addEventListener("click", () => {
    openModal({
      title: "Clear History",
      bodyHTML: `<div class="muted">This deletes all workout logs (your plan remains).</div>`,
      footHTML: `
        <button class="btn ghost" id="hcCancel" type="button">Cancel</button>
        <button class="btn danger" id="hcGo" type="button">Clear</button>
      `
    });
    $("#hcCancel").onclick = () => closeModal();
    $("#hcGo").onclick = () => {
      state.history = [];
      state.stats.streak = 0;
      state.stats.lastLogDate = null;
      state._dirty = true;
      saveState();
      closeModal();
      toast("Cleared", "History deleted.");
      renderDashboard();
      renderHistory();
    };
  });

  $("#btnLoadDemo").addEventListener("click", () => {
    const demo = {
      mode: "gym",
      goal: "hypertrophy",
      level: "intermediate",
      days: "4",
      minutes: "60",
      equip: "db_bands",
      limits: "",
      prefSplit: "auto",
      tone: "balanced",
      autoProg: true,
      smartAdapt: true,
      autoDeload: true,
    };
    writeFormFromProfile(demo);
    toast("Demo", "Demo profile loaded.");
  });

  $("#btnExplainScore").addEventListener("click", explainScore);
  $("#btnDeload").addEventListener("click", suggestDeloadManual);

  // Settings
  $("#units").addEventListener("change", () => {
    state.settings.units = $("#units").value;
    saveState();
    toast("Settings", "Units updated.");
    renderToday();
  });
  $("#startWeek").addEventListener("change", () => {
    state.settings.startWeek = $("#startWeek").value;
    saveState();
    toast("Settings", "Week start updated.");
  });
  $("#btnBackup").addEventListener("click", exportJSON);
  $("#btnRestore").addEventListener("click", restoreJSON);
  $("#btnWipeAll").addEventListener("click", wipeAll);

  // Library search
  $("#libSearch").addEventListener("input", debounce((e) => {
    renderLibrary(e.target.value);
  }, 150));
  $("#btnLibReset").addEventListener("click", () => {
    $("#libSearch").value = "";
    renderLibrary("");
  });

  // Online/offline indicator
  window.addEventListener("online", () => $("#pillOffline").textContent = "Online");
  window.addEventListener("offline", () => $("#pillOffline").textContent = "Offline Ready");

  /* =========================
     Text export
  ========================= */
  function programToText(program) {
    const p = program.profile;
    const lines = [];
    lines.push(`ForgeFit Program — ${new Date(program.createdAt).toLocaleString()}`);
    lines.push(`Mode: ${p.mode} • Goal: ${labelGoal(p.goal)} • Level: ${p.level}`);
    lines.push(`Days: ${p.days}/week • Minutes: ${p.minutes} • Split: ${splitLabel(p.split)}`);
    lines.push(`AutoProg: ${p.autoProg ? "On" : "Off"} • SmartAdapt: ${p.smartAdapt ? "On" : "Off"}`);
    lines.push("");
    program.week.forEach((day, i) => {
      lines.push(`DAY ${i + 1}: ${day.label} (${day.focus})`);
      day.exercises.forEach(ex => {
        const pr = ex.prescription;
        lines.push(`- ${ex.name}: ${pr.sets}x${pr.reps} • rest ${pr.rest}s • tempo ${pr.tempo} • ${pr.rpeHint}`);
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  /* =========================
     Init
  ========================= */
  recoverOverTime();
  hydrateUIFromState();
  renderDashboard();
  routeTo("dashboard");
  saveState();

})();
