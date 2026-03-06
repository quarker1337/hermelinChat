import { useState, useRef, useEffect, useCallback } from "react";

// ─── NOUS / HERMELIN PALETTE ───────────────────────────────────────
// Nous Research uses deep blacks, warm ambers, and sharp whites
// with a brutalist-futuristic edge
const AMBER = {
  300: "#ffd480",
  400: "#f5b731",
  500: "#e0a020",
  600: "#c48a18",
  700: "#9a6c12",
  800: "#6b4a0e",
  900: "#3d2a08",
};

const SLATE = {
  bg: "#08080a",
  surface: "#0e0e12",
  elevated: "#16161d",
  border: "#232330",
  muted: "#55556a",
  text: "#b8b8cc",
  textBright: "#e8e8f0",
  accent: "#f5b731",
  danger: "#e84057",
  success: "#38c878",
};

// ─── INVERTELIN LOGO ───────────────────────────────────────────────
// Negative-space stoat/ermine silhouette in a circle, GitHub-invertocat style
const InvertelinLogo = ({ size = 140, color = AMBER[400], bg = SLATE.bg }) => (
  <svg viewBox="0 0 200 200" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <mask id="ermine-mask">
        <circle cx="100" cy="100" r="96" fill="white" />
        {/* Ermine/stoat body - sleek elongated silhouette facing right */}
        {/* Left ear */}
        <ellipse cx="72" cy="42" rx="7" ry="14" fill="black" transform="rotate(-15 72 42)" />
        {/* Right ear */}
        <ellipse cx="92" cy="38" rx="7" ry="14" fill="black" transform="rotate(10 92 38)" />
        {/* Head */}
        <ellipse cx="82" cy="62" rx="22" ry="18" fill="black" />
        {/* Snout */}
        <ellipse cx="64" cy="68" rx="10" ry="7" fill="black" />
        {/* Nose tip */}
        <circle cx="56" cy="67" r="3.5" fill="white" />
        {/* Eye */}
        <circle cx="76" cy="57" r="4.5" fill="white" />
        {/* Eye pupil/glint */}
        <circle cx="77.5" cy="56" r="1.8" fill="black" />
        {/* Neck */}
        <ellipse cx="95" cy="78" rx="14" ry="14" fill="black" />
        {/* Body - long sleek torso */}
        <ellipse cx="115" cy="95" rx="30" ry="18" fill="black" transform="rotate(-8 115 95)" />
        {/* Haunches */}
        <ellipse cx="138" cy="108" rx="18" ry="20" fill="black" />
        {/* Front leg left */}
        <rect x="88" y="98" width="7" height="26" rx="3" fill="black" transform="rotate(5 91 98)" />
        {/* Front leg right */}
        <rect x="97" y="100" width="7" height="24" rx="3" fill="black" transform="rotate(-3 100 100)" />
        {/* Rear leg left */}
        <rect x="130" y="116" width="8" height="24" rx="3.5" fill="black" transform="rotate(8 134 116)" />
        {/* Rear leg right */}
        <rect x="140" y="114" width="8" height="26" rx="3.5" fill="black" transform="rotate(-5 144 114)" />
        {/* Front paws */}
        <ellipse cx="90" cy="126" rx="5" ry="3" fill="black" />
        <ellipse cx="100" cy="125" rx="5" ry="3" fill="black" />
        {/* Rear paws */}
        <ellipse cx="134" cy="141" rx="5.5" ry="3" fill="black" />
        <ellipse cx="145" cy="141" rx="5.5" ry="3" fill="black" />
        {/* Tail - long curved ermine tail with black tip */}
        <path d="M 148 100 Q 168 80 160 58 Q 155 48 148 52" fill="black" strokeWidth="0" />
        <path d="M 148 100 Q 170 82 162 56 Q 157 46 150 50" fill="black" strokeWidth="0" />
        {/* Tail black tip (stays as circle color = visible) */}
        <circle cx="155" cy="50" r="6" fill="white" />
        {/* Whiskers (thin lines as cutout details) */}
        <line x1="56" y1="64" x2="40" y2="58" stroke="white" strokeWidth="1.2" />
        <line x1="56" y1="67" x2="38" y2="66" stroke="white" strokeWidth="1.2" />
        <line x1="56" y1="70" x2="40" y2="75" stroke="white" strokeWidth="1.2" />
      </mask>
    </defs>
    <circle cx="100" cy="100" r="96" fill={color} mask="url(#ermine-mask)" />
  </svg>
);

// Small inline version for headers
const InvertelinSmall = ({ size = 22 }) => (
  <svg viewBox="0 0 200 200" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <mask id="ermine-mask-sm">
        <circle cx="100" cy="100" r="96" fill="white" />
        <ellipse cx="72" cy="42" rx="7" ry="14" fill="black" transform="rotate(-15 72 42)" />
        <ellipse cx="92" cy="38" rx="7" ry="14" fill="black" transform="rotate(10 92 38)" />
        <ellipse cx="82" cy="62" rx="22" ry="18" fill="black" />
        <ellipse cx="64" cy="68" rx="10" ry="7" fill="black" />
        <circle cx="56" cy="67" r="3.5" fill="white" />
        <circle cx="76" cy="57" r="4.5" fill="white" />
        <circle cx="77.5" cy="56" r="1.8" fill="black" />
        <ellipse cx="95" cy="78" rx="14" ry="14" fill="black" />
        <ellipse cx="115" cy="95" rx="30" ry="18" fill="black" transform="rotate(-8 115 95)" />
        <ellipse cx="138" cy="108" rx="18" ry="20" fill="black" />
        <rect x="88" y="98" width="7" height="26" rx="3" fill="black" transform="rotate(5 91 98)" />
        <rect x="97" y="100" width="7" height="24" rx="3" fill="black" transform="rotate(-3 100 100)" />
        <rect x="130" y="116" width="8" height="24" rx="3.5" fill="black" transform="rotate(8 134 116)" />
        <rect x="140" y="114" width="8" height="26" rx="3.5" fill="black" transform="rotate(-5 144 114)" />
        <ellipse cx="90" cy="126" rx="5" ry="3" fill="black" />
        <ellipse cx="100" cy="125" rx="5" ry="3" fill="black" />
        <ellipse cx="134" cy="141" rx="5.5" ry="3" fill="black" />
        <ellipse cx="145" cy="141" rx="5.5" ry="3" fill="black" />
        <path d="M 148 100 Q 168 80 160 58 Q 155 48 148 52" fill="black" />
        <path d="M 148 100 Q 170 82 162 56 Q 157 46 150 50" fill="black" />
        <circle cx="155" cy="50" r="6" fill="white" />
      </mask>
    </defs>
    <circle cx="100" cy="100" r="96" fill={AMBER[400]} mask="url(#ermine-mask-sm)" />
  </svg>
);

// ─── PARTICLE FIELD (replacing matrix rain) ────────────────────────
const ParticleField = () => {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let animId;
    let particles = [];

    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800;
      canvas.height = canvas.parentElement?.offsetHeight || 600;
      particles = Array.from({ length: 60 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        o: Math.random() * 0.15 + 0.03,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(245,183,49,${p.o})`;
        ctx.fill();
      }
      // draw connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 120) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(245,183,49,${0.04 * (1 - d / 120)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
      animId = requestAnimationFrame(draw);
    };

    init();
    window.addEventListener("resize", init);
    draw();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", init);
    };
  }, []);
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
        pointerEvents: "none", opacity: 0.5, zIndex: 0,
      }}
    />
  );
};

// ─── SUBTLE GRAIN OVERLAY ──────────────────────────────────────────
const GrainOverlay = () => (
  <div style={{
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 10, opacity: 0.03, mixBlendMode: "overlay",
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
  }} />
);

// ─── BANNER ────────────────────────────────────────────────────────
const HERMELIN_BANNER = [
  "==============================================================================",
  "",
  "  ##  ##    ######    #####     ##  ##    ######    ##        ######    ##  ##",
  "  ##  ##    ##        ##  ##    ######    ##        ##          ##      ### ##",
  "  ######    ####      #####     ##  ##    ####      ##          ##      ######",
  "  ##  ##    ##        ##  ##    ##  ##    ##        ##          ##      ## ###",
  "  ##  ##    ######    ##  ##    ##  ##    ######    ######    ######    ##  ##",
  "",
  "  ─── Hermes Agent Terminal · Nous Research ──────────────────────────────",
  "",
  "==============================================================================",
];

// ─── PLACEHOLDER ART (stoat art TBD) ────────────────────────────────
const LOGO_ART = [
  "        ⣠⣤⣤⣤⣤⣤⣤⣤⣄        ",
  "      ⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦      ",
  "    ⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆    ",
  "   ⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧   ",
  "  ⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆  ",
  "  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇  ",
  "  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇  ",
  "  ⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇  ",
  "   ⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠃   ",
  "    ⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋    ",
  "      ⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠁      ",
  "         ⠉⠛⠿⠿⠿⠛⠉         ",
];

// ─── TOOLS & SKILLS ────────────────────────────────────────────────
const availableTools = [
  { category: "market_data", items: "ticker_lookup, price_history, options_chain, screener" },
  { category: "sec_research", items: "sec_filings, earnings_calendar, insider_trades" },
  { category: "valuation", items: "dcf_model, graham_number, comps_analysis" },
  { category: "crypto", items: "onchain_scan, whale_alerts, defi_yields" },
  { category: "dgx_cluster", items: "nvidia_smi, slurm_submit, gpu_monitor, nccl_bench" },
  { category: "cloud_ops", items: "kubectl, terraform, ansible, helm_deploy" },
  { category: "infra", items: "ssh_exec, docker_compose, systemctl, journalctl" },
  { category: "monitoring", items: "prometheus_query, grafana_snap, alertmanager" },
  { category: "discord", items: "post_msg, reply_thread, embed_builder, react_spam" },
  { category: "shitpost_engine", items: "copypasta_gen, meme_fetch, ratio_detector, bait" },
  { category: "file", items: "patch, read_file, search_files, write_file" },
];

const availableSkills = [
  { category: "value-investing", items: "buffett-screener, moat-analysis, margin-of-safety" },
  { category: "macro-research", items: "fed-watcher, yield-curve, sector-rotation, cpi-tracker" },
  { category: "portfolio-mgmt", items: "risk-parity, rebalancer, tax-loss-harvest, divtrack" },
  { category: "crypto-intel", items: "btc-onchain, eth-gas, token-fundamentals" },
  { category: "dgx-ops", items: "multi-node-train, gpu-health, nvlink-diag, cuda-debug" },
  { category: "cluster-mgmt", items: "slurm-admin, ceph-monitor, infiniband-check" },
  { category: "cloud-infra", items: "k8s-autopilot, cost-optimizer, incident-response" },
  { category: "observability", items: "prometheus-rules, grafana-dash, pagerduty-ack, loki" },
  { category: "discord-warfare", items: "thread-necro, hot-take-gen, emoji-flood, bait-craft" },
  { category: "meme-ops", items: "wojak-picker, greentext-fmt, cope-detector, ratio-calc" },
  { category: "autonomous-agents", items: "claude-code, codex, hermelin-agent" },
  { category: "research", items: "arxiv, sec-edgar, github-codebase" },
];

// ─── ICONS ─────────────────────────────────────────────────────────
const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const BookmarkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);
const EditIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);
const AgentIcon = ({ color }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
    <rect x="3" y="3" width="10" height="8" rx="1" />
    <line x1="6" y1="6" x2="6" y2="8" /><line x1="10" y1="6" x2="10" y2="8" />
    <line x1="5" y1="13" x2="8" y2="11" /><line x1="11" y1="13" x2="8" y2="11" />
    <line x1="8" y1="1" x2="8" y2="3" />
    <circle cx="8" cy="1" r="0.8" fill={color} stroke="none" />
  </svg>
);
const ChatIcon = ({ color }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3">
    <path d="M2 3h12v8H6l-3 2.5V11H2z" />
    <line x1="5" y1="6" x2="11" y2="6" /><line x1="5" y1="8.5" x2="9" y2="8.5" />
  </svg>
);

// ─── SIDEBAR ITEM ──────────────────────────────────────────────────
const SidebarItem = ({ label, active, hasAgent }) => {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 6,
        cursor: "pointer", fontSize: 13, fontFamily: "'JetBrains Mono',monospace",
        color: active ? AMBER[400] : hovered ? SLATE.textBright : SLATE.muted,
        background: active ? `${AMBER[900]}40` : hovered ? `${SLATE.elevated}` : "transparent",
        borderLeft: active ? `2px solid ${AMBER[400]}` : "2px solid transparent",
        transition: "all 0.15s ease",
      }}
    >
      {hasAgent ? <AgentIcon color={active ? AMBER[400] : SLATE.muted} /> : <ChatIcon color={SLATE.muted} />}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );
};

// ─── TERMINAL CHAT COMPONENTS ──────────────────────────────────────
const ToolCallLine = ({ call }) => (
  <div style={{
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 13, lineHeight: 1.7, color: SLATE.text, whiteSpace: "pre",
  }}>
    <span style={{ color: SLATE.muted }}>{"  ┊ "}</span>
    <span>{call.icon}</span>
    <span style={{ color: AMBER[600], fontWeight: 500 }}>{" "}{call.name}</span>
    <span style={{ color: SLATE.muted }}>{"     "}</span>
    <span style={{ color: SLATE.text }}>{call.detail}</span>
    <span style={{ color: SLATE.muted }}>{"  "}{call.time}</span>
  </div>
);

const HermelinBlock = ({ children, thinking }) => (
  <div style={{ margin: "8px 0", animation: "fadeIn 0.25s ease both", fontFamily: "'JetBrains Mono',monospace" }}>
    <div style={{ fontSize: 13, lineHeight: 1.7 }}>
      <span style={{ color: SLATE.muted }}>{"┌─ "}</span>
      <span style={{ color: AMBER[400], fontWeight: 600 }}>{"⚡"}hermelin</span>
      {thinking && (
        <span style={{
          color: AMBER[600], fontSize: 12, marginLeft: 8,
          animation: "pulseGlow 1.5s ease infinite",
        }}>reasoning...</span>
      )}
      <span style={{ color: SLATE.muted }}>{" ─────────────────────────────────────────────────────────────"}</span>
    </div>
    <div style={{ paddingLeft: 0 }}>
      {children}
    </div>
    <div style={{ fontSize: 13, lineHeight: 1.7 }}>
      <span style={{ color: SLATE.muted }}>{"└──────"}</span>
    </div>
  </div>
);

const UserMessage = ({ text }) => (
  <div style={{
    margin: "8px 0", fontFamily: "'JetBrains Mono',monospace",
    fontSize: 13, lineHeight: 1.7, animation: "fadeIn 0.15s ease both",
  }}>
    <span style={{ color: AMBER[400] }}>{"● "}</span>
    <span style={{ color: SLATE.textBright }}>{text}</span>
  </div>
);

// ─── HIDDEN HERMELIN EASTER EGG ────────────────────────────────────
const HiddenHermelin = () => {
  const [clicked, setClicked] = useState(false);
  return (
    <div
      onClick={() => setClicked(!clicked)}
      style={{
        position: "absolute", bottom: 54, right: 14, cursor: "pointer", zIndex: 11,
        opacity: clicked ? 0.7 : 0.08, transition: "all 0.4s ease",
        transform: clicked ? "scale(1.15)" : "scale(1)",
        filter: clicked ? `drop-shadow(0 0 8px ${AMBER[400]}60)` : "none",
      }}
      onMouseEnter={(e) => { if (!clicked) e.currentTarget.style.opacity = "0.25"; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = clicked ? "0.7" : "0.08"; }}
      title="the ermine knows..."
    >
      <InvertelinSmall size={18} />
      {clicked && (
        <div style={{
          position: "absolute", bottom: 24, right: 0, whiteSpace: "nowrap",
          fontSize: 9, color: AMBER[400], fontFamily: "'JetBrains Mono',monospace",
          animation: "fadeIn 0.3s ease both", textShadow: `0 0 8px ${AMBER[400]}40`,
        }}>
          aligned to you...
        </div>
      )}
    </div>
  );
};

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Hermelin, an autonomous agent system powered by Hermes (Nous Research), running on wayne's DGX H100 cluster.
You operate inside hermelinChat, a terminal-style chat interface. Your responses should be concise, technical, and slightly irreverent.
You have access to tools for market data, SEC filings, crypto analytics, GPU cluster management, and Discord shitposting.
You're assisting user "wayne" who runs DGX GPU clusters and actively trades equities and crypto.

RESPONSE FORMAT — respond ONLY with this JSON, no markdown fences, no preamble:
{
  "toolCalls": [
    {"icon": "emoji", "name": "tool_name", "detail": "command_or_args", "time": "Xs"}
  ],
  "text": "Your response text. Use \\n for newlines."
}

TOOL CALL GUIDELINES:
- icon: use fitting emoji (📊 data, 🔧 infra, 💀 discord, 📄 files, 💲 shell, 🧠 memory, 🔍 search)
- name: short tool name (ticker, kubectl, discord, read, $, terraform, sec, memory, etc.)
- detail: realistic CLI-style command string
- time: plausible execution time
- Include tool calls when the task would logically require fetching data, running commands, etc.
- If no tools needed, use empty array []

PERSONALITY:
- Concise, no fluff. Terminal output style.
- Dry humor, internet culture references welcome
- When discussing market data, be specific with numbers (simulate realistic values)
- Reference Wayne's DGX cluster, his NVDA/BTC holdings, discord server "alphagrindset"
- You're a powerful agent, not a chatbot — act like it`;

// ─── MAIN COMPONENT ────────────────────────────────────────────────
export default function HermelinChat() {
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [conversationHistory, setConversationHistory] = useState([]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  const focusInput = () => inputRef.current?.focus();

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || isLoading) return;

    const userMsg = { type: "user", text: text.trim() };
    setMessages((prev) => [...prev, userMsg]);
    setInputValue("");
    setIsLoading(true);

    const newHistory = [...conversationHistory, { role: "user", content: text.trim() }];

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: newHistory,
        }),
      });

      const data = await response.json();
      const rawText = data.content?.map((b) => b.text || "").join("") || "";

      let parsed;
      try {
        const cleaned = rawText.replace(/```json\s*/g, "").replace(/```/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { toolCalls: [], text: rawText };
      }

      const hermelinMsg = {
        type: "hermelin",
        toolCalls: parsed.toolCalls || [],
        text: parsed.text || "",
      };

      setMessages((prev) => [...prev, hermelinMsg]);
      setConversationHistory([...newHistory, { role: "assistant", content: rawText }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          type: "hermelin",
          toolCalls: [{ icon: "⚠️", name: "system", detail: `connection_error: ${err.message}`, time: "—" }],
          text: "Connection to API failed. Check network or retry.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, conversationHistory]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputValue);
    }
  };

  return (
    <div style={{
      width: "100vw", height: "100vh", background: SLATE.bg,
      display: "flex", fontFamily: "'JetBrains Mono','Fira Code',monospace",
      color: SLATE.textBright, overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes blink { 50% { opacity: 0 } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(2px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes pulseGlow {
          0%, 100% { text-shadow: 0 0 4px ${AMBER[400]}60 }
          50% { text-shadow: 0 0 12px ${AMBER[400]}90, 0 0 24px ${AMBER[400]}40 }
        }
        @keyframes subtlePulse {
          0%, 100% { opacity: 0.6 }
          50% { opacity: 1 }
        }
        @keyframes bannerGlow {
          0%, 100% { filter: brightness(1) drop-shadow(0 0 2px ${AMBER[400]}20) }
          50% { filter: brightness(1.08) drop-shadow(0 0 8px ${AMBER[400]}30) }
        }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-track { background: transparent }
        ::-webkit-scrollbar-thumb { background: ${SLATE.border}; border-radius: 2px }
        ::-webkit-scrollbar-thumb:hover { background: ${SLATE.muted} }
        ::selection { background: ${AMBER[700]}44 }
      `}</style>

      {/* ─── SIDEBAR ──────────────────────────────────────────────── */}
      <div style={{
        width: 250, flexShrink: 0, background: SLATE.surface,
        borderRight: `1px solid ${SLATE.border}`, display: "flex", flexDirection: "column",
        position: "relative", zIndex: 2,
      }}>
        {/* Sidebar header */}
        <div style={{
          padding: "14px 14px 12px", display: "flex", alignItems: "center",
          justifyContent: "space-between", borderBottom: `1px solid ${SLATE.border}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <InvertelinSmall size={20} />
            <span style={{
              fontSize: 13, fontWeight: 700, color: AMBER[400],
              letterSpacing: "0.02em",
            }}>hermelinChat</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: SLATE.muted }}>
            <BookmarkIcon /><EditIcon />
          </div>
        </div>

        {/* Search */}
        <div style={{ padding: "10px 10px 6px" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
            borderRadius: 6, background: SLATE.elevated,
            border: `1px solid ${SLATE.border}`, fontSize: 12, color: SLATE.muted,
          }}>
            <SearchIcon />Search messages
          </div>
        </div>

        {/* Chat list */}
        <div style={{ flex: 1, overflow: "auto", padding: "4px 6px" }}>
          <div style={{
            padding: "10px 8px 4px", fontSize: 10, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.08em", color: SLATE.muted,
          }}>Today</div>
          <SidebarItem hasAgent label="MSP Panel Refactor" active />
          <SidebarItem hasAgent label="API Gateway Analysis" />
          <div style={{
            padding: "14px 8px 4px", fontSize: 10, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.08em", color: SLATE.muted,
          }}>Yesterday</div>
          <SidebarItem label="Chatting About Yapping" />
          <SidebarItem hasAgent label="Docker Compose Setup" />
          <SidebarItem label="Test123 Greeting" />
        </div>

        {/* User */}
        <div style={{
          padding: "10px 14px", borderTop: `1px solid ${SLATE.border}`,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            background: `linear-gradient(135deg, ${AMBER[700]}, ${AMBER[400]})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 700, color: SLATE.bg,
          }}>WA</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: SLATE.textBright }}>wayne</div>
            <div style={{ fontSize: 10, color: SLATE.muted }}>hermelin-agent</div>
          </div>
        </div>
      </div>

      {/* ─── MAIN TERMINAL AREA ───────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>

        <ParticleField />
        <GrainOverlay />

        {/* Top bar */}
        <div style={{
          height: 40, flexShrink: 0, borderBottom: `1px solid ${SLATE.border}`,
          display: "flex", alignItems: "center", padding: "0 16px", gap: 10,
          background: `${SLATE.surface}ee`, position: "relative", zIndex: 5,
          backdropFilter: "blur(8px)",
        }}>
          <InvertelinSmall size={18} />
          <span style={{ fontSize: 12, fontWeight: 600, color: AMBER[400] }}>hermelin-agent</span>
          <span style={{ color: SLATE.muted, fontSize: 11 }}>·</span>
          <span style={{ fontSize: 11, color: SLATE.muted }}>Hermes 4 · Nous Research</span>
          <span style={{ color: SLATE.muted, fontSize: 11 }}>·</span>
          <span style={{ fontSize: 11, color: SLATE.muted }}>/home/wayne/projects/msp-panel-lab</span>
          <div style={{ flex: 1 }} />
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: isLoading ? AMBER[400] : SLATE.success,
            animation: isLoading ? "subtlePulse 1s ease infinite" : "none",
            boxShadow: `0 0 6px ${isLoading ? AMBER[400] : SLATE.success}`,
            transition: "background 0.3s ease",
          }} />
          <span style={{ fontSize: 11, color: SLATE.muted }}>
            Session: <span style={{ color: AMBER[500] }}>20260303_101345_ed7e09</span>
          </span>
        </div>

        {/* Terminal scroll area */}
        <div
          ref={scrollRef}
          onClick={focusInput}
          style={{
            flex: 1, overflow: "auto", padding: "16px 24px",
            position: "relative", zIndex: 5, cursor: "text",
          }}
        >
          {/* ASCII Banner */}
          <div style={{
            margin: "8px 0 12px", animation: "bannerGlow 4s ease-in-out infinite",
            width: "100%", overflow: "hidden",
          }}>
            {HERMELIN_BANNER.map((line, i) => {
              const isBar = i === 0 || i === 12;
              const isLetter = i >= 2 && i <= 8;
              const isSubtitle = i === 10;
              return (
                <div key={i} style={{
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: "min(1.15vw, 13px)", lineHeight: 1.4,
                  color: isBar ? AMBER[700]
                    : isLetter ? AMBER[400]
                    : isSubtitle ? SLATE.muted
                    : "transparent",
                  margin: 0, whiteSpace: "pre",
                  textShadow: isLetter ? `0 0 8px ${AMBER[400]}40`
                    : "none",
                  animation: `fadeIn 0.1s ease ${i * 0.05}s both`,
                  minHeight: line === "" ? "0.6em" : undefined,
                }}>{line}</div>
              );
            })}
          </div>

          {/* Info Panel — two-column like real Hans, solid border all around */}
          <div style={{
            fontFamily: "'JetBrains Mono',monospace", fontSize: 13, lineHeight: 1.7,
            animation: "fadeIn 0.5s ease 0.3s both",
            border: `1px solid ${SLATE.border}`,
            padding: "2px 0",
          }}>
            {/* Title centered */}
            <div style={{ textAlign: "center", marginBottom: 2 }}>
              <span style={{ color: SLATE.muted }}>{"────────────────── "}</span>
              <span style={{ color: SLATE.textBright }}>hermelinChat v1.0.0</span>
              <span style={{ color: SLATE.muted }}>{" ──────────────────"}</span>
            </div>

            <div style={{ display: "flex" }}>
              {/* Left column: logo art */}
              <div style={{ whiteSpace: "pre", minWidth: 240, color: AMBER[400], lineHeight: 1.15, padding: "4px 0" }}>
                {LOGO_ART.map((line, i) => (
                  <div key={i} style={{ animation: `fadeIn 0.08s ease ${i * 0.03}s both` }}>{line}</div>
                ))}
              </div>

              {/* Right column: tools & skills */}
              <div style={{ flex: 1, paddingLeft: 8 }}>
                <div style={{ color: AMBER[400], fontWeight: 700 }}>Available Tools</div>
                {availableTools.map((t, i) => (
                  <div key={`t${i}`}>
                    <span style={{ color: AMBER[500] }}>{t.category}:</span>
                    <span style={{ color: SLATE.muted }}>{" "}{t.items}</span>
                  </div>
                ))}
                <div style={{ color: AMBER[400], fontWeight: 700, marginTop: 4 }}>Available Skills</div>
                {availableSkills.map((s, i) => (
                  <div key={`s${i}`}>
                    <span style={{ color: AMBER[500] }}>{s.category}:</span>
                    <span style={{ color: SLATE.muted }}>{" "}{s.items}</span>
                  </div>
                ))}
                <div style={{ marginTop: 4, color: AMBER[400] }}>
                  32 tools · 38 skills · /help for commands
                </div>
              </div>
            </div>
          </div>

          {/* Welcome */}
          <div style={{
            fontSize: 13, color: SLATE.text, margin: "12px 0 8px",
            fontFamily: "'JetBrains Mono',monospace",
            animation: "fadeIn 0.5s ease 0.5s both",
          }}>
            Welcome to hermelinChat! Type your message or /help for commands.
          </div>

          {/* ─── CONVERSATION ──────────────────────────────────────── */}
          {messages.map((msg, i) => {
            if (msg.type === "user") {
              return <UserMessage key={i} text={msg.text} />;
            }
            if (msg.type === "hermelin") {
              return (
                <HermelinBlock key={i}>
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div style={{ margin: "4px 0 8px" }}>
                      {msg.toolCalls.map((tc, j) => (
                        <ToolCallLine key={j} call={tc} />
                      ))}
                    </div>
                  )}
                  {msg.text && (
                    <div style={{
                      fontFamily: "'JetBrains Mono',monospace", fontSize: 13,
                      lineHeight: 1.7, color: SLATE.text, whiteSpace: "pre-wrap",
                    }}>
                      {msg.text}
                    </div>
                  )}
                </HermelinBlock>
              );
            }
            return null;
          })}

          {/* Loading state */}
          {isLoading && (
            <HermelinBlock thinking>
              <div style={{ display: "flex", gap: 4, padding: "4px 0" }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} style={{
                    width: 6, height: 6, borderRadius: "50%", background: AMBER[400],
                    animation: `blink 1.2s ease ${i * 0.2}s infinite`,
                  }} />
                ))}
              </div>
            </HermelinBlock>
          )}

          <div style={{ height: 8 }} />
        </div>

        {/* ─── INPUT (inline in terminal, not a separate bar) ────── */}
        <div style={{
          flexShrink: 0, position: "relative", zIndex: 5,
          padding: "4px 24px 12px",
          background: "transparent",
        }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{
              color: AMBER[400], marginRight: 8, fontSize: 14, fontWeight: 700,
              fontFamily: "'JetBrains Mono',monospace",
            }}>❯</span>
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder=""
              disabled={isLoading}
              autoFocus
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: SLATE.textBright, fontSize: 13,
                fontFamily: "'JetBrains Mono',monospace", lineHeight: 1.7,
                opacity: isLoading ? 0.5 : 1,
                caretColor: AMBER[400],
              }}
            />
            {isLoading && (
              <span style={{
                fontSize: 11, color: AMBER[600],
                fontFamily: "'JetBrains Mono',monospace",
                animation: "pulseGlow 1.5s ease infinite", whiteSpace: "nowrap",
              }}>processing...</span>
            )}
          </div>
        </div>

        <HiddenHermelin />
      </div>
    </div>
  );
}
