import { useState, useRef, useEffect, useCallback } from "react";

// ─── PALETTE ──────────────────────────────────────────────────────
const AMBER = {
  300: "#ffd480", 400: "#f5b731", 500: "#e0a020",
  600: "#c48a18", 700: "#9a6c12", 800: "#6b4a0e", 900: "#3d2a08",
};
const S = {
  bg: "#08080a", surface: "#0e0e12", elevated: "#16161d",
  border: "#232330", muted: "#55556a", text: "#b8b8cc",
  textBright: "#e8e8f0", danger: "#e84057", success: "#38c878",
  info: "#60a5fa", purple: "#a78bfa", cyan: "#22d3ee",
};

// ─── ICONS ────────────────────────────────────────────────────────
const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
);
const SettingsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);
const NewChatIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
);
const PanelCloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
);
const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
);
const PinIcon = ({ pinned }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 17v5"/><path d="M5 17h14"/><path d="M15 3.36C15 2.61 14.39 2 13.64 2H10.36C9.61 2 9 2.61 9 3.36V6l-3 5h12L15 6V3.36z"/>
  </svg>
);
const MaximizeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
);
const LogoutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
);

// ─── SIMULATED GPU DATA ───────────────────────────────────────────
const gpuData = [
  { id: 0, name: "H100 SXM", util: 94, temp: 71, mem: 76.2, memTotal: 80, power: 648, fan: 72, proc: "train_llama4_70b" },
  { id: 1, name: "H100 SXM", util: 91, temp: 69, mem: 74.8, memTotal: 80, power: 635, fan: 70, proc: "train_llama4_70b" },
  { id: 2, name: "H100 SXM", util: 87, temp: 73, mem: 71.3, memTotal: 80, power: 612, fan: 74, proc: "train_llama4_70b" },
  { id: 3, name: "H100 SXM", util: 92, temp: 70, mem: 75.1, memTotal: 80, power: 641, fan: 71, proc: "train_llama4_70b" },
  { id: 4, name: "H100 SXM", util: 23, temp: 42, mem: 12.4, memTotal: 80, power: 180, fan: 38, proc: "vllm_serve" },
  { id: 5, name: "H100 SXM", util: 18, temp: 40, mem: 11.8, memTotal: 80, power: 165, fan: 36, proc: "vllm_serve" },
  { id: 6, name: "H100 SXM", util: 0, temp: 34, mem: 0.4, memTotal: 80, power: 72, fan: 28, proc: "idle" },
  { id: 7, name: "H100 SXM", util: 0, temp: 33, mem: 0.3, memTotal: 80, power: 68, fan: 27, proc: "idle" },
];

const utilizationHistory = [
  [88, 91, 85, 94, 89, 92, 90, 87, 93, 94, 91, 88, 92, 90, 94],
  [82, 85, 88, 91, 87, 90, 89, 91, 88, 85, 90, 92, 91, 89, 91],
  [78, 82, 85, 80, 83, 87, 85, 82, 86, 88, 84, 87, 85, 88, 87],
  [85, 88, 90, 92, 89, 91, 93, 90, 88, 92, 91, 93, 90, 92, 92],
];

// ─── SIMULATED K8S DATA ──────────────────────────────────────────
const k8sData = [
  { ns: "production", name: "hermes-api-7f8d4", status: "Running", restarts: 0, cpu: "240m", mem: "512Mi", age: "4d", node: "dgx-01" },
  { ns: "production", name: "hermes-gateway-2b1c", status: "Running", restarts: 0, cpu: "180m", mem: "384Mi", age: "4d", node: "dgx-01" },
  { ns: "production", name: "vllm-hermes3-405b-a", status: "Running", restarts: 1, cpu: "8000m", mem: "78Gi", age: "2d", node: "dgx-01" },
  { ns: "production", name: "vllm-hermes3-405b-b", status: "Running", restarts: 0, cpu: "7800m", mem: "76Gi", age: "2d", node: "dgx-01" },
  { ns: "training", name: "llama4-70b-finetune", status: "Running", restarts: 0, cpu: "16000m", mem: "156Gi", age: "18h", node: "dgx-01" },
  { ns: "monitoring", name: "prometheus-0", status: "Running", restarts: 0, cpu: "320m", mem: "2Gi", age: "12d", node: "dgx-01" },
  { ns: "monitoring", name: "grafana-5c4f8", status: "Running", restarts: 0, cpu: "120m", mem: "256Mi", age: "12d", node: "dgx-01" },
  { ns: "default", name: "hermelin-chat-ui", status: "Running", restarts: 0, cpu: "80m", mem: "128Mi", age: "1d", node: "dgx-01" },
  { ns: "staging", name: "msp-panel-dev-3a9f", status: "CrashLoopBackOff", restarts: 14, cpu: "0m", mem: "0Mi", age: "6h", node: "dgx-01" },
];

// ─── SIMULATED LOG STREAM ─────────────────────────────────────────
const logLines = [
  { ts: "08:45:02.331", level: "INFO", src: "hermes-api", msg: "POST /v1/chat/completions 200 — 1247ms — model=z-ai/glm-5 tokens=842" },
  { ts: "08:45:02.892", level: "INFO", src: "gateway", msg: "session_create user=wayne session=20260307_084502_f3a1 model=openai/gpt-5.2" },
  { ts: "08:45:03.104", level: "DEBUG", src: "hermes-api", msg: "tool_registry loaded 22 tools, 54 skills for session f3a1" },
  { ts: "08:45:04.218", level: "INFO", src: "vllm", msg: "Request queued — pending=3 running=2 gpu_util=91.2%" },
  { ts: "08:45:05.001", level: "WARN", src: "k8s-monitor", msg: "Pod msp-panel-dev-3a9f CrashLoopBackOff — restart #14 — OOMKilled" },
  { ts: "08:45:05.447", level: "INFO", src: "ha-bridge", msg: "homeassistant state_changed: sensor.server_room_temp = 22.4°C" },
  { ts: "08:45:06.112", level: "INFO", src: "hermes-api", msg: "POST /v1/chat/completions 200 — 892ms — model=openai/gpt-5.2 tokens=614" },
  { ts: "08:45:06.893", level: "ERROR", src: "cronjob", msg: "blogwatcher failed: timeout fetching https://feeds.arxiv.org — retrying in 60s" },
  { ts: "08:45:07.201", level: "INFO", src: "vllm", msg: "Batch complete — 4 requests — avg_latency=1.1s — throughput=2847 tok/s" },
  { ts: "08:45:08.334", level: "INFO", src: "gateway", msg: "discord webhook delivered to #alphagrindset — msg_id=1198234" },
  { ts: "08:45:09.001", level: "DEBUG", src: "memory", msg: "vector_store query 'gpu monitoring' — 3 results — 12ms" },
  { ts: "08:45:09.445", level: "INFO", src: "hermes-api", msg: "skill_invoke: codebase-inspection on repo=hermelin-chat — 340ms" },
  { ts: "08:45:10.112", level: "WARN", src: "nccl", msg: "NVLink P2P bandwidth degraded GPU2↔GPU3: 38.2 GB/s (expected >45)" },
  { ts: "08:45:10.887", level: "INFO", src: "slurm", msg: "Job train_llama4_70b step 14280/50000 — loss=0.847 — lr=1.2e-5 — 4x H100" },
  { ts: "08:45:11.201", level: "INFO", src: "ha-bridge", msg: "homeassistant state_changed: light.server_room = on — brightness=180" },
];

// ─── SIMULATED HA MAP DATA ───────────────────────────────────────
const haDevices = [
  { name: "Server Room", type: "climate", state: "22.4°C", icon: "🌡️", x: 72, y: 28 },
  { name: "DGX Rack", type: "power", state: "4.8 kW", icon: "⚡", x: 68, y: 42 },
  { name: "UPS Status", type: "sensor", state: "Online", icon: "🔋", x: 55, y: 42 },
  { name: "Server Light", type: "light", state: "On (70%)", icon: "💡", x: 82, y: 55 },
  { name: "Office Desk", type: "light", state: "Off", icon: "💡", x: 25, y: 35 },
  { name: "Front Door", type: "lock", state: "Locked", icon: "🔒", x: 10, y: 80 },
  { name: "Hallway Motion", type: "motion", state: "Clear", icon: "👁️", x: 40, y: 75 },
  { name: "Kitchen Temp", type: "climate", state: "21.1°C", icon: "🌡️", x: 30, y: 55 },
  { name: "Network Switch", type: "sensor", state: "1Gbps", icon: "🌐", x: 65, y: 58 },
];

// ─── SPARKLINE ────────────────────────────────────────────────────
const Sparkline = ({ data, color, width = 80, height = 24 }) => {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * height}`).join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={`0,${height} ${pts} ${width},${height}`} fill={`${color}15`} stroke="none" />
    </svg>
  );
};

// ─── BAR ──────────────────────────────────────────────────────────
const UtilBar = ({ pct, color, height = 6 }) => (
  <div style={{ width: "100%", height, background: S.elevated, borderRadius: height / 2, overflow: "hidden" }}>
    <div style={{
      width: `${pct}%`, height: "100%", borderRadius: height / 2,
      background: color,
      transition: "width 0.6s cubic-bezier(0.16,1,0.3,1)",
      boxShadow: pct > 80 ? `0 0 8px ${color}60` : "none",
    }} />
  </div>
);

const utilColor = (pct) => pct > 85 ? AMBER[400] : pct > 50 ? S.info : pct > 0 ? S.success : S.muted;
const tempColor = (t) => t > 75 ? S.danger : t > 60 ? AMBER[400] : S.success;
const statusColor = (s) => s === "Running" ? S.success : s === "CrashLoopBackOff" ? S.danger : AMBER[400];
const levelColor = (l) => l === "ERROR" ? S.danger : l === "WARN" ? AMBER[400] : l === "DEBUG" ? S.muted : S.text;

// ═══════════════════════════════════════════════════════════════════
// ARTIFACT: GPU DASHBOARD
// ═══════════════════════════════════════════════════════════════════
const GpuDashboard = () => {
  const totalPower = gpuData.reduce((a, g) => a + g.power, 0);
  const avgUtil = Math.round(gpuData.reduce((a, g) => a + g.util, 0) / gpuData.length);
  const totalMem = gpuData.reduce((a, g) => a + g.mem, 0).toFixed(1);
  const totalMemMax = gpuData.reduce((a, g) => a + g.memTotal, 0);

  return (
    <div style={{ padding: "12px 14px", fontFamily: "'JetBrains Mono',monospace" }}>
      {/* Summary row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[
          { label: "GPUs", value: "8× H100", color: AMBER[400] },
          { label: "Avg Util", value: `${avgUtil}%`, color: utilColor(avgUtil) },
          { label: "VRAM", value: `${totalMem}/${totalMemMax} GB`, color: S.info },
          { label: "Power", value: `${totalPower}W`, color: S.purple },
        ].map((s) => (
          <div key={s.label} style={{
            background: S.elevated, borderRadius: 6, padding: "8px 10px",
            border: `1px solid ${S.border}`,
          }}>
            <div style={{ fontSize: 9, color: S.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</div>
            <div style={{ fontSize: 13, color: s.color, fontWeight: 600, marginTop: 2 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Utilization history */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: S.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Training GPUs — 15min utilization
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {utilizationHistory.map((hist, i) => (
            <div key={i} style={{
              background: S.elevated, borderRadius: 6, padding: "8px 10px",
              border: `1px solid ${S.border}`, display: "flex", alignItems: "center", gap: 10,
            }}>
              <div style={{ fontSize: 10, color: S.muted, minWidth: 42 }}>GPU {i}</div>
              <Sparkline data={hist} color={AMBER[400]} width={100} height={20} />
              <div style={{ fontSize: 11, color: AMBER[400], fontWeight: 600 }}>{hist[hist.length - 1]}%</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-GPU table */}
      <div style={{ fontSize: 10, color: S.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        All GPUs
      </div>
      <div style={{ border: `1px solid ${S.border}`, borderRadius: 6, overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "36px 1fr 60px 50px 70px 52px",
          gap: 0, padding: "6px 10px", background: S.elevated,
          fontSize: 9, color: S.muted, textTransform: "uppercase", letterSpacing: "0.04em",
          borderBottom: `1px solid ${S.border}`,
        }}>
          <span>ID</span><span>Process</span><span>Util</span><span>Temp</span><span>VRAM</span><span>Power</span>
        </div>
        {gpuData.map((g) => (
          <div key={g.id} style={{
            display: "grid", gridTemplateColumns: "36px 1fr 60px 50px 70px 52px",
            gap: 0, padding: "5px 10px", alignItems: "center",
            borderBottom: `1px solid ${S.border}20`, fontSize: 11,
          }}>
            <span style={{ color: S.muted }}>{g.id}</span>
            <span style={{
              color: g.proc === "idle" ? S.muted : S.textBright,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{g.proc}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <UtilBar pct={g.util} color={utilColor(g.util)} />
              <span style={{ color: utilColor(g.util), fontSize: 10, minWidth: 24, textAlign: "right" }}>{g.util}%</span>
            </div>
            <span style={{ color: tempColor(g.temp) }}>{g.temp}°C</span>
            <span style={{ color: S.text }}>{g.mem}/{g.memTotal}</span>
            <span style={{ color: S.muted }}>{g.power}W</span>
          </div>
        ))}
      </div>

      {/* NVLink status */}
      <div style={{ marginTop: 14, padding: "8px 10px", background: `${AMBER[900]}30`, border: `1px solid ${AMBER[700]}30`, borderRadius: 6 }}>
        <div style={{ fontSize: 10, color: AMBER[400], fontWeight: 600 }}>⚠ NVLink Alert</div>
        <div style={{ fontSize: 11, color: S.text, marginTop: 2 }}>P2P bandwidth degraded GPU2↔GPU3: 38.2 GB/s (expected &gt;45)</div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// ARTIFACT: K8S PODS TABLE
// ═══════════════════════════════════════════════════════════════════
const K8sPodsTable = () => (
  <div style={{ padding: "12px 14px", fontFamily: "'JetBrains Mono',monospace" }}>
    <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
      {["all", "production", "training", "monitoring", "staging"].map((ns, i) => (
        <button key={ns} style={{
          padding: "4px 10px", borderRadius: 4, border: `1px solid ${i === 0 ? AMBER[600] : S.border}`,
          background: i === 0 ? `${AMBER[900]}50` : "transparent",
          color: i === 0 ? AMBER[400] : S.muted, fontSize: 10, cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace", textTransform: "uppercase", letterSpacing: "0.04em",
        }}>{ns}</button>
      ))}
    </div>
    <div style={{ border: `1px solid ${S.border}`, borderRadius: 6, overflow: "hidden" }}>
      <div style={{
        display: "grid", gridTemplateColumns: "90px 1fr 110px 50px 60px 60px",
        padding: "6px 10px", background: S.elevated,
        fontSize: 9, color: S.muted, textTransform: "uppercase", letterSpacing: "0.04em",
        borderBottom: `1px solid ${S.border}`,
      }}>
        <span>Namespace</span><span>Pod</span><span>Status</span><span>↻</span><span>CPU</span><span>Mem</span>
      </div>
      {k8sData.map((p, i) => (
        <div key={i} style={{
          display: "grid", gridTemplateColumns: "90px 1fr 110px 50px 60px 60px",
          padding: "5px 10px", alignItems: "center",
          borderBottom: `1px solid ${S.border}20`, fontSize: 11,
          background: p.status !== "Running" ? `${S.danger}08` : "transparent",
        }}>
          <span style={{ color: S.purple, fontSize: 10 }}>{p.ns}</span>
          <span style={{ color: S.textBright, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: statusColor(p.status), boxShadow: `0 0 4px ${statusColor(p.status)}50`, flexShrink: 0 }} />
            <span style={{ color: statusColor(p.status), fontSize: 10 }}>{p.status}</span>
          </div>
          <span style={{ color: p.restarts > 0 ? S.danger : S.muted }}>{p.restarts}</span>
          <span style={{ color: S.text }}>{p.cpu}</span>
          <span style={{ color: S.text }}>{p.mem}</span>
        </div>
      ))}
    </div>
    <div style={{ marginTop: 10, fontSize: 10, color: S.muted }}>
      9 pods · 1 unhealthy · total CPU: 32.7 cores · total Mem: 313.3 Gi
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════════════
// ARTIFACT: LOG STREAM
// ═══════════════════════════════════════════════════════════════════
const LogStream = () => {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? logLines : logLines.filter((l) => l.level === filter.toUpperCase());
  return (
    <div style={{ padding: "12px 14px", fontFamily: "'JetBrains Mono',monospace" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {["all", "error", "warn", "info", "debug"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "3px 8px", borderRadius: 4,
            border: `1px solid ${filter === f ? AMBER[600] : S.border}`,
            background: filter === f ? `${AMBER[900]}50` : "transparent",
            color: filter === f ? AMBER[400] : S.muted,
            fontSize: 10, cursor: "pointer", fontFamily: "'JetBrains Mono',monospace",
            textTransform: "uppercase", letterSpacing: "0.04em",
          }}>{f}</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: S.success, display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: S.success, animation: "livePulse 2s ease infinite" }} />
          live
        </span>
      </div>
      <div style={{
        border: `1px solid ${S.border}`, borderRadius: 6, overflow: "hidden",
        maxHeight: 420, overflowY: "auto",
      }}>
        {filtered.map((l, i) => (
          <div key={i} style={{
            padding: "4px 10px", fontSize: 11, lineHeight: 1.6,
            borderBottom: `1px solid ${S.border}10`,
            background: l.level === "ERROR" ? `${S.danger}08` : l.level === "WARN" ? `${AMBER[900]}15` : "transparent",
            display: "flex", gap: 8,
          }}>
            <span style={{ color: S.muted, flexShrink: 0 }}>{l.ts}</span>
            <span style={{
              color: levelColor(l.level), fontWeight: 600, flexShrink: 0, width: 38,
              fontSize: 10, lineHeight: "18px",
            }}>{l.level}</span>
            <span style={{ color: S.purple, flexShrink: 0, minWidth: 80, fontSize: 10, lineHeight: "18px" }}>{l.src}</span>
            <span style={{ color: S.text, wordBreak: "break-all" }}>{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// ARTIFACT: HOME ASSISTANT FLOOR MAP
// ═══════════════════════════════════════════════════════════════════
const HaFloorMap = () => {
  const [hovered, setHovered] = useState(null);
  return (
    <div style={{ padding: "12px 14px", fontFamily: "'JetBrains Mono',monospace" }}>
      {/* Map area */}
      <div style={{
        position: "relative", width: "100%", aspectRatio: "16/10",
        background: S.elevated, borderRadius: 8, border: `1px solid ${S.border}`,
        overflow: "hidden",
      }}>
        {/* Grid lines */}
        <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0, opacity: 0.15 }}>
          {Array.from({ length: 20 }, (_, i) => (
            <line key={`v${i}`} x1={`${i * 5}%`} y1="0" x2={`${i * 5}%`} y2="100%" stroke={S.muted} strokeWidth="0.5" />
          ))}
          {Array.from({ length: 12 }, (_, i) => (
            <line key={`h${i}`} x1="0" y1={`${i * 8.3}%`} x2="100%" y2={`${i * 8.3}%`} stroke={S.muted} strokeWidth="0.5" />
          ))}
        </svg>

        {/* Room outlines */}
        <svg width="100%" height="100%" style={{ position: "absolute", top: 0, left: 0 }}>
          {/* Office */}
          <rect x="5%" y="15%" width="40%" height="55%" rx="3" fill="none" stroke={S.border} strokeWidth="1.5" />
          <text x="7%" y="13%" fill={S.muted} fontSize="9" fontFamily="JetBrains Mono">Office</text>
          {/* Server Room */}
          <rect x="50%" y="15%" width="45%" height="55%" rx="3" fill={`${AMBER[900]}15`} stroke={AMBER[700]} strokeWidth="1.5" strokeDasharray="4 2" />
          <text x="52%" y="13%" fill={AMBER[600]} fontSize="9" fontFamily="JetBrains Mono">Server Room</text>
          {/* Hallway */}
          <rect x="5%" y="73%" width="90%" height="15%" rx="3" fill="none" stroke={S.border} strokeWidth="1" />
          <text x="42%" y="85%" fill={S.muted} fontSize="9" fontFamily="JetBrains Mono">Hallway</text>
          {/* Kitchen */}
          <rect x="5%" y="40%" width="18%" height="30%" rx="3" fill="none" stroke={S.border} strokeWidth="1" />
          <text x="7%" y="39%" fill={S.muted} fontSize="8" fontFamily="JetBrains Mono">Kitchen</text>
        </svg>

        {/* Device markers */}
        {haDevices.map((d, i) => (
          <div
            key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            style={{
              position: "absolute", left: `${d.x}%`, top: `${d.y}%`,
              transform: "translate(-50%, -50%)", cursor: "pointer",
              zIndex: hovered === i ? 10 : 1,
            }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: "50%",
              background: hovered === i ? `${AMBER[400]}30` : `${S.bg}cc`,
              border: `1.5px solid ${hovered === i ? AMBER[400] : S.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, transition: "all 0.15s ease",
              boxShadow: hovered === i ? `0 0 12px ${AMBER[400]}30` : "none",
            }}>
              {d.icon}
            </div>
            {hovered === i && (
              <div style={{
                position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
                transform: "translateX(-50%)", whiteSpace: "nowrap",
                background: S.surface, border: `1px solid ${S.border}`,
                borderRadius: 6, padding: "6px 10px", fontSize: 10,
                boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                animation: "fadeIn 0.1s ease both",
              }}>
                <div style={{ color: S.textBright, fontWeight: 600, marginBottom: 2 }}>{d.name}</div>
                <div style={{ color: AMBER[400] }}>{d.state}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Device list */}
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {haDevices.map((d, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "5px 8px", borderRadius: 4, fontSize: 11,
            background: hovered === i ? S.elevated : "transparent",
            cursor: "pointer", transition: "background 0.1s ease",
          }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <span>{d.icon}</span>
            <span style={{ color: S.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
            <span style={{ color: d.state === "Off" || d.state === "Clear" ? S.muted : AMBER[400], fontSize: 10, flexShrink: 0 }}>{d.state}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// ARTIFACT TAB CONFIG
// ═══════════════════════════════════════════════════════════════════
const ARTIFACT_TABS = [
  { id: "gpu", label: "nvidia-smi", icon: "🖥️", component: GpuDashboard, agent: "gpu_monitor", desc: "DGX H100 cluster status" },
  { id: "k8s", label: "kubectl", icon: "☸️", component: K8sPodsTable, agent: "kubectl", desc: "Kubernetes pod overview" },
  { id: "logs", label: "logs", icon: "📜", component: LogStream, agent: "journalctl", desc: "Live aggregated log stream" },
  { id: "ha", label: "floorplan", icon: "🏠", component: HaFloorMap, agent: "ha_get_state", desc: "Home Assistant floor map" },
];

// ═══════════════════════════════════════════════════════════════════
// SIDEBAR ITEM
// ═══════════════════════════════════════════════════════════════════
const SidebarItem = ({ label, time, active }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "7px 12px", cursor: "pointer",
        color: active ? AMBER[400] : hovered ? S.textBright : S.text,
        background: active ? `${AMBER[900]}30` : hovered ? S.elevated : "transparent",
        borderLeft: active ? `2px solid ${AMBER[400]}` : "2px solid transparent",
        transition: "all 0.12s ease", fontSize: 13,
        fontFamily: "'JetBrains Mono',monospace",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{label}</span>
      <span style={{ fontSize: 10, color: S.muted, flexShrink: 0, marginLeft: 8 }}>{time}</span>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════
export default function HermelinChatArtifacts() {
  const [artifactTab, setArtifactTab] = useState("gpu");
  const [panelOpen, setPanelOpen] = useState(true);
  const [pinned, setPinned] = useState(false);

  const currentArtifact = ARTIFACT_TABS.find((t) => t.id === artifactTab);
  const ArtifactComponent = currentArtifact?.component;

  // Simulated conversation that triggered the panel
  const terminalLines = [
    { type: "user", text: "show me gpu utilization across the cluster" },
    { type: "agent", tool: { icon: "🖥️", name: "gpu_monitor", detail: "nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv", time: "0.3s" } },
    { type: "agent", tool: { icon: "📊", name: "render_panel", detail: 'type=dashboard target="gpu_cluster_overview"', time: "0.1s" } },
    { type: "agent", text: "Rendered GPU dashboard to artifact panel. 4 GPUs active on training job, 2 serving vLLM, 2 idle.\nNVLink bandwidth warning on GPU2↔GPU3 — might want to check that." },
    { type: "user", text: "also show me the k8s pods and tail the logs" },
    { type: "agent", tool: { icon: "☸️", name: "kubectl", detail: "get pods --all-namespaces -o wide", time: "0.4s" } },
    { type: "agent", tool: { icon: "📜", name: "journalctl", detail: "--follow --output=json --priority=0..6 --lines=50", time: "0.2s" } },
    { type: "agent", tool: { icon: "📊", name: "render_panel", detail: 'type=table target="k8s_pods" + type=stream target="logs"', time: "0.1s" } },
    { type: "agent", text: "Added kubectl and log stream tabs. msp-panel-dev is in CrashLoopBackOff — OOMKilled after 14 restarts. Might want to bump the memory limit." },
  ];

  return (
    <div style={{
      width: "100vw", height: "100vh", background: S.bg,
      display: "flex", fontFamily: "'JetBrains Mono','Fira Code',monospace",
      color: S.textBright, overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(2px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes blink { 50% { opacity: 0 } }
        @keyframes livePulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }
        @keyframes panelSlide { from { transform: translateX(30px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
        @keyframes pulseGlow {
          0%, 100% { text-shadow: 0 0 4px ${AMBER[400]}60 }
          50% { text-shadow: 0 0 12px ${AMBER[400]}90, 0 0 24px ${AMBER[400]}40 }
        }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-track { background: transparent }
        ::-webkit-scrollbar-thumb { background: ${S.border}; border-radius: 2px }
        ::-webkit-scrollbar-thumb:hover { background: ${S.muted} }
        ::selection { background: ${AMBER[700]}44 }
      `}</style>

      {/* ─── SIDEBAR ─────────────────────────────────────────── */}
      <div style={{
        width: 250, flexShrink: 0, background: S.surface,
        borderRight: `1px solid ${S.border}`, display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between",
          borderBottom: `1px solid ${S.border}`, minHeight: 48,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: AMBER[400], letterSpacing: "0.02em" }}>hermelinChat</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: S.muted }}>
            <div style={{ cursor: "pointer", display: "flex" }}><SettingsIcon /></div>
            <div style={{ cursor: "pointer", display: "flex" }}><NewChatIcon /></div>
          </div>
        </div>

        <div style={{ padding: "10px 10px 6px" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
            borderRadius: 6, background: S.elevated, border: `1px solid ${S.border}`,
            fontSize: 12, color: S.muted,
          }}>
            <SearchIcon />Search messages
          </div>
        </div>

        <div style={{
          padding: "8px 6px 4px", fontSize: 10, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: "0.08em", color: S.muted,
        }}>Active</div>
        <div style={{
          margin: "0 6px 4px", padding: "8px 12px", borderRadius: 6,
          background: `${AMBER[900]}25`, border: `1px solid ${AMBER[700]}30`,
          color: AMBER[400], fontSize: 13, cursor: "pointer",
          fontFamily: "'JetBrains Mono',monospace",
        }}>+ New session</div>

        <div style={{ flex: 1, overflow: "auto", padding: "0 0 4px" }}>
          <div style={{ padding: "10px 12px 4px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: S.muted }}>Today</div>
          <SidebarItem label="GPU Cluster Check" time="08:45" active />
          <SidebarItem label="Quick Responsiveness Test" time="08:42" />
          <SidebarItem label="Good Morning Greeting" time="08:30" />
          <div style={{ padding: "10px 12px 4px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: S.muted }}>Yesterday</div>
          <SidebarItem label="General Discussion" time="21:09" />
          <SidebarItem label="General Discussion" time="20:08" />
          <SidebarItem label="Testing Session Behaviour" time="18:37" />
          <SidebarItem label="Show Hans Ascii" time="18:22" />
          <SidebarItem label="Show Teknium Discussion" time="18:21" />
        </div>

        <div style={{
          padding: "10px 14px", borderTop: `1px solid ${S.border}`,
          display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: S.muted,
          fontSize: 12, fontFamily: "'JetBrains Mono',monospace",
        }}>
          <LogoutIcon />
          <span>Logout</span>
        </div>
      </div>

      {/* ─── TERMINAL AREA ───────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Top bar */}
        <div style={{
          height: 40, flexShrink: 0, borderBottom: `1px solid ${S.border}`,
          display: "flex", alignItems: "center", padding: "0 16px", gap: 10,
          background: `${S.surface}ee`, fontSize: 12,
        }}>
          <span>🐍</span>
          <span style={{ color: AMBER[400], fontWeight: 600 }}>hermes</span>
          <span style={{ color: S.muted }}>·</span>
          <span style={{ color: S.muted }}>new session</span>
          <span style={{ color: S.muted }}>·</span>
          <span style={{ color: S.muted }}>model:</span>
          <span style={{ color: AMBER[500] }}>openai/gpt-5.2</span>
          <span style={{ color: S.muted }}>·</span>
          <span style={{ color: S.muted }}>cwd:</span>
          <span style={{ color: S.muted }}>/home/wayne/hermelinChat</span>
          <div style={{ flex: 1 }} />
          <span style={{
            width: 6, height: 6, borderRadius: "50%", background: S.success,
            boxShadow: `0 0 6px ${S.success}`,
          }} />
          <span style={{ color: S.muted, fontSize: 11 }}>PTY</span>
        </div>

        {/* Terminal content */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px 24px" }}>
          {terminalLines.map((line, i) => {
            if (line.type === "user") {
              return (
                <div key={i} style={{ margin: "8px 0", fontSize: 13, lineHeight: 1.7, animation: `fadeIn 0.15s ease ${i * 0.05}s both` }}>
                  <span style={{ color: AMBER[400] }}>● </span>
                  <span style={{ color: S.textBright }}>{line.text}</span>
                </div>
              );
            }
            if (line.tool) {
              return (
                <div key={i} style={{ fontSize: 13, lineHeight: 1.7, animation: `fadeIn 0.15s ease ${i * 0.05}s both` }}>
                  <span style={{ color: S.muted }}>{"  ┊ "}</span>
                  <span>{line.tool.icon}</span>
                  <span style={{ color: AMBER[600], fontWeight: 500 }}> {line.tool.name}</span>
                  <span style={{ color: S.muted }}>{"     "}</span>
                  <span style={{ color: S.text }}>{line.tool.detail}</span>
                  <span style={{ color: S.muted }}>  {line.tool.time}</span>
                </div>
              );
            }
            if (line.text) {
              return (
                <div key={i} style={{ margin: "4px 0 12px", animation: `fadeIn 0.15s ease ${i * 0.05}s both` }}>
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                    <span style={{ color: S.muted }}>{"┌─ "}</span>
                    <span style={{ color: AMBER[400], fontWeight: 600 }}>⚡hermelin</span>
                    <span style={{ color: S.muted }}>{" ─────────────────────────────────────────"}</span>
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.7, color: S.text, whiteSpace: "pre-wrap", padding: "2px 0" }}>
                    {line.text}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                    <span style={{ color: S.muted }}>{"└──────"}</span>
                  </div>
                </div>
              );
            }
            return null;
          })}
        </div>

        {/* Input */}
        <div style={{ flexShrink: 0, padding: "4px 24px 12px" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ color: AMBER[400], marginRight: 8, fontSize: 14, fontWeight: 700 }}>❯</span>
            <span style={{ color: S.muted, fontSize: 13 }}>show me the home assistant floor plan too</span>
            <span style={{ width: 2, height: 16, background: AMBER[400], marginLeft: 1, animation: "blink 1s step-end infinite" }} />
          </div>
        </div>
      </div>

      {/* ─── ARTIFACT PANEL ──────────────────────────────────── */}
      {panelOpen && (
        <div style={{
          width: 480, flexShrink: 0, background: S.surface,
          borderLeft: `1px solid ${S.border}`, display: "flex", flexDirection: "column",
          animation: "panelSlide 0.25s cubic-bezier(0.16,1,0.3,1) both",
          overflow: "hidden",
        }}>
          {/* Panel header */}
          <div style={{
            padding: "0 12px", height: 40, flexShrink: 0,
            borderBottom: `1px solid ${S.border}`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: AMBER[400], fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>artifact</span>
              <span style={{ fontSize: 10, color: S.muted }}>·</span>
              <span style={{ fontSize: 10, color: S.muted }}>{currentArtifact?.desc}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: S.muted }}>
              <div onClick={() => setPinned(!pinned)} style={{ cursor: "pointer", display: "flex", padding: 2, color: pinned ? AMBER[400] : S.muted }}
                title={pinned ? "Unpin" : "Pin panel"}>
                <PinIcon pinned={pinned} />
              </div>
              <div style={{ cursor: "pointer", display: "flex", padding: 2 }} title="Refresh"><RefreshIcon /></div>
              <div style={{ cursor: "pointer", display: "flex", padding: 2 }} title="Maximize"><MaximizeIcon /></div>
              <div onClick={() => setPanelOpen(false)} style={{ cursor: "pointer", display: "flex", padding: 2 }} title="Close"><PanelCloseIcon /></div>
            </div>
          </div>

          {/* Tab bar */}
          <div style={{
            display: "flex", borderBottom: `1px solid ${S.border}`,
            padding: "0 8px", gap: 0, flexShrink: 0,
          }}>
            {ARTIFACT_TABS.map((tab) => (
              <div
                key={tab.id}
                onClick={() => setArtifactTab(tab.id)}
                style={{
                  padding: "8px 12px", cursor: "pointer",
                  fontSize: 11, display: "flex", alignItems: "center", gap: 5,
                  color: artifactTab === tab.id ? AMBER[400] : S.muted,
                  borderBottom: artifactTab === tab.id ? `2px solid ${AMBER[400]}` : "2px solid transparent",
                  transition: "all 0.12s ease",
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                <span style={{ fontSize: 12 }}>{tab.icon}</span>
                <span>{tab.label}</span>
              </div>
            ))}
          </div>

          {/* Tool source indicator */}
          <div style={{
            padding: "6px 14px", borderBottom: `1px solid ${S.border}10`,
            display: "flex", alignItems: "center", gap: 6, fontSize: 10,
          }}>
            <span style={{ color: S.muted }}>via</span>
            <span style={{ color: AMBER[600], fontWeight: 500 }}>render_panel</span>
            <span style={{ color: S.muted }}>→</span>
            <span style={{ color: S.text }}>{currentArtifact?.agent}</span>
            <div style={{ flex: 1 }} />
            <span style={{ color: S.success, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 4, height: 4, borderRadius: "50%", background: S.success }} />
              <span>live</span>
            </span>
          </div>

          {/* Artifact content */}
          <div style={{ flex: 1, overflow: "auto" }}>
            {ArtifactComponent && <ArtifactComponent />}
          </div>

          {/* Panel footer */}
          <div style={{
            padding: "6px 14px", borderTop: `1px solid ${S.border}`,
            fontSize: 10, color: S.muted, display: "flex", justifyContent: "space-between",
          }}>
            <span>Updated 2s ago</span>
            <span>auto-refresh: 5s</span>
          </div>
        </div>
      )}

      {/* Panel reopen button (when closed) */}
      {!panelOpen && (
        <div
          onClick={() => setPanelOpen(true)}
          style={{
            position: "fixed", right: 0, top: "50%", transform: "translateY(-50%)",
            background: S.surface, border: `1px solid ${S.border}`, borderRight: "none",
            borderRadius: "6px 0 0 6px", padding: "12px 6px", cursor: "pointer",
            color: S.muted, zIndex: 10,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = AMBER[400]}
          onMouseLeave={(e) => e.currentTarget.style.color = S.muted}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span style={{ fontSize: 8, writingMode: "vertical-lr", letterSpacing: "0.1em", textTransform: "uppercase" }}>PANEL</span>
        </div>
      )}
    </div>
  );
}
