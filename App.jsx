import { useState, useEffect, useRef } from "react";
import {
  Camera, Pencil, Mic, Sparkles, ChevronLeft, ChevronRight,
  Plus, X, Loader2, Activity, Check
} from "lucide-react";

// ---- axis system -----------------------------------------------------------
const AXES = {
  focus:       { label: "Focus",       color: "#5B8DEF", target: 240 },
  movement:    { label: "Movement",    color: "#F2A65A", target: 45  },
  rest:        { label: "Rest",        color: "#A78BFA", target: 75  },
  nourishment: { label: "Nourishment", color: "#34D39E", target: 60  },
  connection:  { label: "Connection",  color: "#F472A0", target: 90  },
};
const AXIS_KEYS = Object.keys(AXES);

const CAT_TO_AXIS = {
  working: "focus", meeting: "focus", studying: "focus", planning: "focus",
  exercising: "movement", walking: "movement", commuting: "movement", driving: "movement", errands: "movement",
  resting: "rest", sleeping: "rest", relaxing: "rest", leisure: "rest",
  eating: "nourishment", cooking: "nourishment",
  socializing: "connection", family: "connection", call: "connection",
};

// ---- date + time helpers ---------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const prettyDate = (key) => {
  const [y, m, dd] = key.split("-").map(Number);
  const d = new Date(y, m - 1, dd);
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
};
const minOfDay = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const minToHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const nowHHMM = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---- storage (localStorage — your data stays on this device) ---------------
const dayKey = (k) => `rhythm:day:${k}`;
function loadDay(k) {
  try {
    const raw = localStorage.getItem(dayKey(k));
    return raw ? JSON.parse(raw) : { entries: [], sensor: null, suggestions: [] };
  } catch {
    return { entries: [], sensor: null, suggestions: [] };
  }
}
function saveDay(k, data) {
  try { localStorage.setItem(dayKey(k), JSON.stringify(data)); } catch { /* storage full / blocked */ }
}

// ---- claude api (via your own serverless function) -------------------------
async function callClaude(messages) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error("api error " + res.status);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function parseJSON(text) {
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

const CLASSIFY_INSTRUCTIONS =
  'Classify the single activity. Respond ONLY with JSON, no markdown, no preamble: ' +
  '{"label": short 1-3 word human label, "category": one of ' +
  '[working,meeting,studying,planning,exercising,walking,commuting,driving,errands,resting,sleeping,relaxing,leisure,eating,cooking,socializing,family,call,other], ' +
  '"axis": one of [focus,movement,rest,nourishment,connection], "confidence": number 0 to 1}.';

async function classifyPhoto(base64, mediaType, timeLabel) {
  const text = await callClaude([{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: `Time of day: ${timeLabel}. ${CLASSIFY_INSTRUCTIONS}` },
    ],
  }]);
  return parseJSON(text);
}
async function classifyNote(note, timeLabel) {
  const text = await callClaude([{
    role: "user",
    content: `A person logged this about what they're doing at ${timeLabel}: "${note}". ${CLASSIFY_INSTRUCTIONS}`,
  }]);
  return parseJSON(text);
}
function normalizeClass(c) {
  let axis = AXIS_KEYS.includes(c.axis) ? c.axis : (CAT_TO_AXIS[c.category] || "rest");
  return {
    label: (c.label || c.category || "Activity").toString().slice(0, 40),
    category: c.category || "other",
    axis,
    confidence: typeof c.confidence === "number" ? Math.max(0, Math.min(1, c.confidence)) : 0.6,
  };
}

// ---- scoring + segments ----------------------------------------------------
function computeStats(entries, sensor) {
  const sorted = [...entries].sort((a, b) => a.min - b.min);
  const segs = [];
  const byAxis = Object.fromEntries(AXIS_KEYS.map((k) => [k, 0]));
  sorted.forEach((e, i) => {
    const start = e.min;
    let end = i < sorted.length - 1 ? sorted[i + 1].min : Math.min(start + 60, 1440);
    if (end <= start) end = Math.min(start + 30, 1440);
    let dur = end - start;
    if (dur > 180) dur = 180;
    byAxis[e.axis] += dur;
    segs.push({ ...e, start, end: start + dur });
  });

  const axisScore = {};
  AXIS_KEYS.forEach((k) => {
    let suff = Math.min(1, byAxis[k] / AXES[k].target);
    if (k === "movement" && sensor && sensor.steps) {
      suff = Math.max(suff, Math.min(1, sensor.steps / 8000));
    }
    axisScore[k] = Math.round(suff * 100);
  });

  const covered = AXIS_KEYS.filter((k) => byAxis[k] > 0 || (k === "movement" && sensor?.steps)).length;
  const coverage = covered / AXIS_KEYS.length;
  const sufficiency = AXIS_KEYS.reduce((s, k) => s + axisScore[k] / 100, 0) / AXIS_KEYS.length;
  const total = Math.round(100 * (0.5 * coverage + 0.5 * sufficiency));
  return { segs, byAxis, axisScore, total };
}

// ---- ring geometry ---------------------------------------------------------
const CX = 120, CY = 120, R_OUT = 110, R_IN = 80;
function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
}
function arc(startMin, endMin) {
  const s = (startMin / 1440) * 360;
  const e = (endMin / 1440) * 360;
  const so = polar(R_OUT, s), eo = polar(R_OUT, e);
  const si = polar(R_IN, e), ei = polar(R_IN, s);
  const large = e - s > 180 ? 1 : 0;
  return `M ${so.x} ${so.y} A ${R_OUT} ${R_OUT} 0 ${large} 1 ${eo.x} ${eo.y} L ${si.x} ${si.y} A ${R_IN} ${R_IN} 0 ${large} 0 ${ei.x} ${ei.y} Z`;
}

// ---- speech (optional) -----------------------------------------------------
function getRecognition() {
  const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return null;
  const r = new SR();
  r.lang = "en-US";
  r.interimResults = false;
  r.maxAlternatives = 1;
  return r;
}

// ============================================================================
export default function DayRhythm() {
  const [dateKey, setDateKey] = useState(ymd(new Date()));
  const [day, setDay] = useState({ entries: [], sensor: null, suggestions: [] });
  const [loading, setLoading] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [sensorOpen, setSensorOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setDay(loadDay(dateKey));
    setLoading(false);
    setLogOpen(false);
  }, [dateKey]);

  const persist = (next) => { setDay(next); saveDay(dateKey, next); };
  const stats = computeStats(day.entries, day.sensor);

  const shiftDay = (delta) => {
    const [y, m, dd] = dateKey.split("-").map(Number);
    const d = new Date(y, m - 1, dd + delta);
    setDateKey(ymd(d));
    setError("");
  };
  const isToday = dateKey === ymd(new Date());

  const addEntry = (entry) => persist({ ...day, entries: [...day.entries, entry], suggestions: [] });
  const removeEntry = (id) => persist({ ...day, entries: day.entries.filter((e) => e.id !== id), suggestions: [] });
  const setEntryAxis = (id, axis) => persist({
    ...day,
    entries: day.entries.map((e) => (e.id === id ? { ...e, axis, confidence: 1 } : e)),
    suggestions: [],
  });

  const getSuggestions = async () => {
    setSuggesting(true); setError("");
    try {
      const summary = {
        date: prettyDate(dateKey),
        balanceScore: stats.total,
        minutesByAxis: stats.byAxis,
        steps: day.sensor?.steps || null,
        moments: day.entries.slice().sort((a, b) => a.min - b.min)
          .map((e) => ({ time: minToHHMM(e.min), what: e.label, axis: e.axis })),
      };
      const text = await callClaude([{
        role: "user",
        content:
          "You are a thoughtful day-design coach. The five axes of a well-shaped day are focus, movement, rest, nourishment, and connection. " +
          "Given this person's logged day, give 2-3 specific, kind, actionable suggestions to make tomorrow better-SHAPED — balanced, not merely more productive. " +
          "Reference the actual data. Never use guilt or shame. Respond ONLY as a JSON array of plain strings.\n\n" +
          JSON.stringify(summary),
      }]);
      const arr = parseJSON(text);
      persist({ ...day, suggestions: Array.isArray(arr) ? arr.slice(0, 3) : [] });
    } catch {
      setError("Couldn't generate suggestions just now — try again in a moment.");
    } finally {
      setSuggesting(false);
    }
  };

  const ink = "#0F1216", surface = "#171B22", surface2 = "#1E232C", line = "#2A313C";
  const textHi = "#ECEEF2", textMid = "#9AA3B2", textLo = "#6B7480";

  return (
    <div style={{ background: ink, minHeight: "100%", color: textHi, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "20px 16px 48px" }}>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Activity size={18} color={AXES.focus.color} />
            <span style={{ fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: textMid, fontWeight: 600 }}>Day Rhythm</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => shiftDay(-1)} style={iconBtn(line, textMid)} aria-label="Previous day"><ChevronLeft size={18} /></button>
            <button onClick={() => shiftDay(1)} disabled={isToday} style={{ ...iconBtn(line, textMid), opacity: isToday ? 0.35 : 1 }} aria-label="Next day"><ChevronRight size={18} /></button>
          </div>
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.4, marginBottom: 18 }}>
          {prettyDate(dateKey)} {isToday && <span style={{ fontSize: 13, color: AXES.movement.color, fontWeight: 600 }}> · today</span>}
        </div>

        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          <svg viewBox="0 0 240 240" style={{ width: "min(78vw, 300px)", height: "auto" }}>
            <circle cx={CX} cy={CY} r={(R_OUT + R_IN) / 2} fill="none" stroke={surface2} strokeWidth={R_OUT - R_IN} />
            {[0, 6, 12, 18].map((h) => {
              const p1 = polar(R_OUT + 2, (h / 24) * 360);
              const p2 = polar(R_OUT + 8, (h / 24) * 360);
              const lp = polar(R_OUT + 16, (h / 24) * 360);
              return (
                <g key={h}>
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={line} strokeWidth={1.5} />
                  <text x={lp.x} y={lp.y} fill={textLo} fontSize="8" fontFamily="ui-monospace, monospace" textAnchor="middle" dominantBaseline="middle">{pad(h)}</text>
                </g>
              );
            })}
            {stats.segs.map((s) => (<path key={s.id} d={arc(s.start, s.end)} fill={AXES[s.axis].color} opacity={0.92} />))}
            <text x={CX} y={CY - 12} fill={textLo} fontSize="9" letterSpacing="2" textAnchor="middle" fontFamily="ui-monospace, monospace">BALANCE</text>
            <text x={CX} y={CY + 16} fill={textHi} fontSize="44" fontWeight="700" textAnchor="middle" fontFamily="ui-monospace, monospace">{stats.total}</text>
            <text x={CX} y={CY + 38} fill={textMid} fontSize="9" textAnchor="middle" fontFamily="ui-monospace, monospace">
              {day.entries.length} moment{day.entries.length === 1 ? "" : "s"}
            </text>
          </svg>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginBottom: 20 }}>
          {AXIS_KEYS.map((k) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: AXES[k].color, display: "inline-block" }} />
              <span style={{ fontSize: 12, color: textMid }}>{AXES[k].label}</span>
            </div>
          ))}
        </div>

        {!logOpen ? (
          <button onClick={() => { setLogOpen(true); setError(""); }} style={{
            width: "100%", padding: "14px", borderRadius: 14, border: `1px solid ${line}`,
            background: surface, color: textHi, fontSize: 15, fontWeight: 600, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 18,
          }}><Plus size={18} /> Log a moment</button>
        ) : (
          <LogPanel surface={surface} surface2={surface2} line={line} textHi={textHi} textMid={textMid} textLo={textLo}
            onClose={() => setLogOpen(false)} onAdd={(e) => { addEntry(e); setLogOpen(false); }} onError={setError} />
        )}

        {error && (
          <div style={{ background: "#2A1A1E", border: "1px solid #50343C", color: "#F4A7B6", padding: "10px 12px", borderRadius: 10, fontSize: 13, marginBottom: 16 }}>{error}</div>
        )}

        <div style={{ marginBottom: 22 }}>
          {loading ? (
            <div style={{ color: textLo, fontSize: 13, textAlign: "center", padding: 20 }}>Loading…</div>
          ) : day.entries.length === 0 ? (
            <div style={{ color: textLo, fontSize: 14, textAlign: "center", padding: "24px 12px", lineHeight: 1.6 }}>
              No moments logged yet.<br />Tap <strong style={{ color: textMid }}>Log a moment</strong> to capture the first one — a photo or a quick note.
            </div>
          ) : (
            [...day.entries].sort((a, b) => a.min - b.min).map((e) => (
              <EntryRow key={e.id} e={e} surface={surface} surface2={surface2} line={line} textHi={textHi} textMid={textMid} textLo={textLo}
                onRemove={() => removeEntry(e.id)} onAxis={(ax) => setEntryAxis(e.id, ax)} />
            ))
          )}
        </div>

        {day.entries.length > 0 && (
          <div style={{ background: surface, border: `1px solid ${line}`, borderRadius: 16, padding: 16, marginBottom: 18 }}>
            <div style={{ fontSize: 12, letterSpacing: 1.5, textTransform: "uppercase", color: textLo, marginBottom: 14, fontWeight: 600 }}>How the day was shaped</div>
            {AXIS_KEYS.map((k) => (
              <div key={k} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                  <span style={{ color: textMid }}>{AXES[k].label}
                    {k === "movement" && day.sensor?.steps
                      ? <span style={{ color: textLo, fontSize: 11 }}> · {day.sensor.steps.toLocaleString()} steps</span>
                      : <span style={{ color: textLo, fontSize: 11 }}> · {stats.byAxis[k]} min</span>}
                  </span>
                  <span style={{ color: textMid, fontFamily: "ui-monospace, monospace" }}>{stats.axisScore[k]}</span>
                </div>
                <div style={{ height: 7, background: surface2, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${stats.axisScore[k]}%`, height: "100%", background: AXES[k].color, borderRadius: 4, transition: "width .4s" }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {day.entries.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <button onClick={getSuggestions} disabled={suggesting} style={{
              width: "100%", padding: "13px", borderRadius: 14, border: "none",
              background: suggesting ? surface2 : AXES.connection.color,
              color: suggesting ? textMid : "#1A0E14", fontSize: 14, fontWeight: 700, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}>
              {suggesting ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
              {suggesting ? "Reading your day…" : "End of day — get suggestions"}
            </button>
            {day.suggestions.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {day.suggestions.map((s, i) => (
                  <div key={i} style={{ background: surface, border: `1px solid ${line}`, borderLeft: `3px solid ${AXES.connection.color}`, borderRadius: 10, padding: "12px 14px", fontSize: 14, lineHeight: 1.5, color: textHi }}>{s}</div>
                ))}
              </div>
            )}
          </div>
        )}

        <SensorPanel open={sensorOpen} setOpen={setSensorOpen} sensor={day.sensor}
          surface={surface} surface2={surface2} line={line} textHi={textHi} textMid={textMid} textLo={textLo}
          onSave={(sensor) => persist({ ...day, sensor, suggestions: [] })} />
      </div>

      <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ---- log panel -------------------------------------------------------------
function LogPanel({ surface, surface2, line, textHi, textMid, textLo, onClose, onAdd, onError }) {
  const [tab, setTab] = useState("photo");
  const [note, setNote] = useState("");
  const [time, setTime] = useState(nowHHMM());
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const fileRef = useRef(null);
  const recRef = useRef(null);

  const finish = (cls) => {
    const n = normalizeClass(cls);
    onAdd({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 6), min: minOfDay(time), ...n });
  };

  const handlePhoto = async (file) => {
    if (!file) return;
    setBusy(true); onError("");
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = rej; r.readAsDataURL(file);
      });
      const cls = await classifyPhoto(base64, file.type || "image/jpeg", time);
      finish(cls);
    } catch {
      onError("Couldn't read that photo — try again, or log it as a note instead.");
    } finally { setBusy(false); }
  };

  const handleNote = async () => {
    if (!note.trim()) return;
    setBusy(true); onError("");
    try {
      const cls = await classifyNote(note.trim(), time);
      finish(cls);
    } catch {
      onError("Couldn't classify that note — try rephrasing it.");
    } finally { setBusy(false); }
  };

  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const r = getRecognition();
    if (!r) { onError("Voice input isn't available in this browser — type the note instead."); return; }
    recRef.current = r;
    r.onresult = (ev) => setNote((prev) => (prev ? prev + " " : "") + ev.results[0][0].transcript);
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    setListening(true); r.start();
  };

  const tabBtn = (id, icon, label) => (
    <button onClick={() => setTab(id)} style={{
      flex: 1, padding: "9px", borderRadius: 9, border: "none", cursor: "pointer",
      background: tab === id ? surface2 : "transparent", color: tab === id ? textHi : textLo,
      fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    }}>{icon}{label}</button>
  );

  return (
    <div style={{ background: surface, border: `1px solid ${line}`, borderRadius: 16, padding: 14, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 6, flex: 1 }}>
          {tabBtn("photo", <Camera size={15} />, "Photo")}
          {tabBtn("note", <Pencil size={15} />, "Note")}
        </div>
        <button onClick={onClose} style={{ ...iconBtn(line, textMid), marginLeft: 8 }} aria-label="Close"><X size={16} /></button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: textLo }}>Time</span>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
          style={{ background: surface2, border: `1px solid ${line}`, color: textHi, borderRadius: 8, padding: "6px 8px", fontSize: 13, fontFamily: "ui-monospace, monospace" }} />
      </div>

      {tab === "photo" ? (
        <div>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={(e) => handlePhoto(e.target.files?.[0])} />
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={{
            width: "100%", padding: "26px 12px", borderRadius: 12, border: `1px dashed ${line}`,
            background: surface2, color: textMid, cursor: "pointer", fontSize: 14, fontWeight: 600,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
            {busy ? <><Loader2 size={18} className="spin" /> Classifying…</> : <><Camera size={20} /> Snap or choose a photo</>}
          </button>
          <div style={{ fontSize: 11, color: textLo, textAlign: "center", marginTop: 8 }}>Claude reads the photo and picks the activity for you.</div>
        </div>
      ) : (
        <div>
          <div style={{ position: "relative" }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
              placeholder="What are you doing? e.g. deep work on the deck, lunch with the team, evening walk…"
              style={{ width: "100%", boxSizing: "border-box", background: surface2, border: `1px solid ${line}`, color: textHi, borderRadius: 10, padding: "10px 40px 10px 12px", fontSize: 14, resize: "vertical", fontFamily: "inherit" }} />
            <button onClick={toggleMic} aria-label="Voice input" style={{ position: "absolute", right: 8, top: 8, ...iconBtn(line, listening ? "#F472A0" : textMid) }}><Mic size={16} /></button>
          </div>
          <button onClick={handleNote} disabled={busy || !note.trim()} style={{
            width: "100%", padding: "11px", borderRadius: 10, border: "none", marginTop: 10,
            background: note.trim() && !busy ? AXES.focus.color : surface2,
            color: note.trim() && !busy ? "#0B1220" : textLo, fontSize: 14, fontWeight: 700, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
            {busy ? <><Loader2 size={16} className="spin" /> Classifying…</> : <><Check size={16} /> Log it</>}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- entry row -------------------------------------------------------------
function EntryRow({ e, surface, surface2, line, textHi, textMid, textLo, onRemove, onAxis }) {
  const [editing, setEditing] = useState(false);
  const low = e.confidence < 0.55;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: `1px solid ${line}` }}>
      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: textLo, width: 42, paddingTop: 3 }}>{minToHHMM(e.min)}</div>
      <div style={{ width: 4, alignSelf: "stretch", borderRadius: 3, background: AXES[e.axis].color, minHeight: 28 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, color: textHi, fontWeight: 600 }}>{e.label}</div>
        {!editing ? (
          <button onClick={() => setEditing(true)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", marginTop: 2, fontSize: 12, color: low ? "#F2A65A" : textMid }}>
            {AXES[e.axis].label}{low ? " · tap to confirm" : " · change"}
          </button>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
            {AXIS_KEYS.map((k) => (
              <button key={k} onClick={() => { onAxis(k); setEditing(false); }} style={{
                fontSize: 11, padding: "4px 8px", borderRadius: 7, cursor: "pointer",
                border: `1px solid ${e.axis === k ? AXES[k].color : line}`,
                background: e.axis === k ? AXES[k].color : "transparent",
                color: e.axis === k ? "#0B1220" : textMid, fontWeight: 600,
              }}>{AXES[k].label}</button>
            ))}
          </div>
        )}
      </div>
      <button onClick={onRemove} style={iconBtn(line, textLo)} aria-label="Remove"><X size={14} /></button>
    </div>
  );
}

// ---- sensor / shortcuts panel ----------------------------------------------
function SensorPanel({ open, setOpen, sensor, surface, surface2, line, textHi, textMid, textLo, onSave }) {
  const [raw, setRaw] = useState("");
  const [msg, setMsg] = useState("");

  const save = () => {
    try {
      const parsed = JSON.parse(raw);
      const steps = Number(parsed.steps) || 0;
      const locations = Array.isArray(parsed.locations) ? parsed.locations : [];
      onSave({ steps, locations });
      setMsg(`Saved · ${steps.toLocaleString()} steps, ${locations.length} location${locations.length === 1 ? "" : "s"}`);
      setRaw("");
    } catch {
      setMsg('That isn\'t valid JSON. Expected something like { "steps": 8200, "locations": ["Office"] }');
    }
  };

  return (
    <div style={{ background: surface, border: `1px solid ${line}`, borderRadius: 16, overflow: "hidden" }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", padding: "13px 16px", background: "none", border: "none", cursor: "pointer",
        display: "flex", justifyContent: "space-between", alignItems: "center", color: textMid, fontSize: 13, fontWeight: 600,
      }}>
        <span>Passive data {sensor?.steps ? `· ${sensor.steps.toLocaleString()} steps synced` : "· connect Apple Shortcuts"}</span>
        {open ? <ChevronLeft size={16} style={{ transform: "rotate(-90deg)" }} /> : <ChevronRight size={16} style={{ transform: "rotate(90deg)" }} />}
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px" }}>
          <div style={{ fontSize: 12, color: textLo, lineHeight: 1.6, marginBottom: 10 }}>
            A web app can't read your steps or location in the background — that's a native power. Build one Apple Shortcut that pulls
            today's step count from Health and your saved locations, outputs JSON, and paste it here.
          </div>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={3}
            placeholder={'{ "steps": 8200, "locations": ["Office", "Gym", "Home"] }'}
            style={{ width: "100%", boxSizing: "border-box", background: surface2, border: `1px solid ${line}`, color: textHi, borderRadius: 10, padding: 10, fontSize: 12, fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
          <button onClick={save} disabled={!raw.trim()} style={{
            marginTop: 8, padding: "9px 14px", borderRadius: 9, border: "none", cursor: "pointer",
            background: raw.trim() ? AXES.movement.color : surface2, color: raw.trim() ? "#1A1208" : textLo, fontSize: 13, fontWeight: 700,
          }}>Save passive data</button>
          {msg && <div style={{ fontSize: 12, color: textMid, marginTop: 8 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

function iconBtn(line, color) {
  return { background: "transparent", border: `1px solid ${line}`, color, borderRadius: 9, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 };
}
