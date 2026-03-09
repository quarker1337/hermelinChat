import { useState, useRef, useEffect } from "react";

const GREEN = {
  400: "#4dffa1",
  500: "#2da565",
  600: "#248a53",
  700: "#1a6b3f",
  800: "#114d2c",
  900: "#0a3019",
};

const DARK = {
  bg: "#0c0f0e",
  surface: "#111514",
  elevated: "#1a201f",
  border: "#2a3533",
  muted: "#5a6f6a",
  text: "#c8d8d3",
  textBright: "#e8f0ec",
  yellow: "#f5e642",
};

const MATRIX_CHARS = "アウエオカキクケコサシスセソタチツテトナニネノハヒフヘホマミムメモヤユヨラリルレロワン01234589ABCDEF";

const MatrixRain = () => {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let animId, cols, drops;
    const init = () => {
      canvas.width = canvas.parentElement?.offsetWidth || 800;
      canvas.height = canvas.parentElement?.offsetHeight || 600;
      cols = Math.floor(canvas.width / 14);
      drops = Array(cols).fill(0).map(() => Math.random() * -80);
    };
    const draw = () => {
      ctx.fillStyle = "rgba(12,15,14,0.04)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = "12px monospace";
      for (let i = 0; i < drops.length; i++) {
        const c = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
        const b = Math.random();
        ctx.fillStyle = b > 0.96 ? "#4dffa180" : b > 0.85 ? "#2da56530" : "#1a6b3f15";
        ctx.fillText(c, i * 14, drops[i] * 14);
        if (drops[i] * 14 > canvas.height && Math.random() > 0.98) drops[i] = 0;
        drops[i] += 0.3 + Math.random() * 0.25;
      }
      animId = requestAnimationFrame(draw);
    };
    init();
    window.addEventListener("resize", init);
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener("resize", init); };
  }, []);
  return <canvas ref={canvasRef} style={{ position:"absolute",top:0,left:0,width:"100%",height:"100%",pointerEvents:"none",opacity:0.3,zIndex:0 }} />;
};

const WhiteRabbit = () => {
  const [clicked, setClicked] = useState(false);
  return (
    <div onClick={() => setClicked(!clicked)} style={{
      position:"absolute",bottom:54,right:14,cursor:"pointer",zIndex:11,
      opacity:clicked?0.65:0.1,transition:"all 0.4s ease",
      transform:clicked?"scale(1.15)":"scale(1)",
      filter:clicked?"drop-shadow(0 0 6px #2da56580)":"none",
    }}
    onMouseEnter={e => { if(!clicked) e.currentTarget.style.opacity="0.3"; }}
    onMouseLeave={e => { e.currentTarget.style.opacity=clicked?"0.65":"0.1"; }}
    title="follow the white rabbit...">
      <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
        <ellipse cx="5" cy="2.5" rx="1.8" ry="4" fill="#248a53" transform="rotate(-8 5 2.5)" />
        <ellipse cx="11" cy="2.5" rx="1.8" ry="4" fill="#248a53" transform="rotate(8 11 2.5)" />
        <ellipse cx="8" cy="9" rx="4.5" ry="5" fill="#248a53" />
        <ellipse cx="8" cy="15.5" rx="5.5" ry="4.5" fill="#248a53" />
        <circle cx="6.5" cy="8.2" r="0.7" fill="#4dffa1" />
        <circle cx="9.5" cy="8.2" r="0.7" fill="#4dffa1" />
        <ellipse cx="8" cy="10" rx="0.8" ry="0.4" fill="#4dffa1" />
        <ellipse cx="3.5" cy="17.5" rx="1.8" ry="1" fill="#248a53" transform="rotate(-12 3.5 17.5)" />
        <ellipse cx="12.5" cy="17.5" rx="1.8" ry="1" fill="#248a53" transform="rotate(12 12.5 17.5)" />
        <circle cx="8" cy="17" r="1" fill="#1a6b3f" />
      </svg>
      {clicked && <div style={{
        position:"absolute",bottom:24,right:0,whiteSpace:"nowrap",
        fontSize:9,color:"#2da565",fontFamily:"'JetBrains Mono',monospace",
        animation:"fadeIn 0.3s ease both",textShadow:"0 0 8px #2da56560",
      }}>wake up, wayne...</div>}
    </div>
  );
};

const ScanlineOverlay = () => (
  <div style={{
    position:"absolute",top:0,left:0,right:0,bottom:0,pointerEvents:"none",zIndex:10,
    background:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.06) 2px,rgba(0,0,0,0.06) 4px)",
  }} />
);

const HANS_BANNER = [
  "==================================================================================",
  "",
  "  ##  ##    ####    ##  ##   #####        AUTONOMOUS  AGENT  SYSTEM",
  "  ##  ##   ##  ##   ### ##   ##           ~~~~~~~~~~~~~~~~~~~~~~~~",
  "  ######   ######   ######   #####        HERMES AUTONOMOUS NETWORKED",
  "  ##  ##   ##  ##   ## ###       ##       SYSTEM  //  NOUS RESEARCH",
  "  ##  ##   ##  ##   ##  ##   #####        ~~~~~~~~~~~~~~~~~~~~~~~~",
  "",
  "==================================================================================",
  "  [*] STATUS: ONLINE    [*] MODEL: gpt-5.2    [*] SESSION: ed7e09    [*] v1.0.0",
  "==================================================================================",
];

const SkullLogo = ({ size = 22 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width={size} height={size} stroke="none">
    <path d="M 116 50 L 76 70 L 66 100 L 66 133 L 76 140 L 73 153 L 93 163 L 103 186 L 133 186 L 143 163 L 163 153 L 160 140 L 170 133 L 170 100 L 156 66 Z" fill={GREEN[500]} />
    <path d="M 76 118 L 78 116 L 94 116 L 97 118 L 100 118 L 108 126 L 108 132 L 105 134 L 105 138 L 97 143 L 92 135 L 86 135 L 78 127 L 78 122 Z" fill={DARK.surface} />
    <path d="M 160 116 L 162 118 L 160 122 L 160 127 L 152 135 L 146 135 L 143 138 L 143 143 L 141 143 L 138 143 L 132 138 L 132 134 L 130 132 L 130 126 L 134 122 L 138 118 L 144 116 Z" fill={DARK.surface} />
    <path d="M 116 133 L 120 133 L 123 136 L 123 143 L 126 146 L 126 153 L 120 160 L 116 160 L 110 153 L 110 146 L 113 143 L 113 136 Z" fill={DARK.surface} />
  </svg>
);

const toolCalls = [
  { icon: "\u{1F4CA}", name: "ticker", detail: "fetch --symbols NVDA,MSFT,BRK.B --interval 1d", time: "1.2s" },
  { icon: "\u{1F527}", name: "kubectl", detail: "get pods -n inference --context dgx-prod-01", time: "0.6s" },
  { icon: "\u{1F480}", name: "discord", detail: "post #general --guild=alphagrindset 'cope...'", time: "0.1s" },
  { icon: "\u{1F4C4}", name: "read", detail: "~/.portfolio/holdings.json", time: "0.3s" },
  { icon: "\u{1F4B2}", name: "$", detail: "nvidia-smi --query-gpu=util,mem -i 0,1,2,3,4,5,6,7", time: "0.8s" },
  { icon: "\u{1F527}", name: "terraform", detail: "plan -var-file=prod.tfvars -target=module/k8s", time: "3.1s" },
  { icon: "\u{1F4CA}", name: "sec", detail: "filing --cik=0001652044 --type=10-K --latest", time: "1.8s" },
  { icon: "\u{1F480}", name: "discord", detail: "reply #crypto --quote --attach=wojak_pink.png", time: "0.1s" },
  { icon: "\u{1F4B2}", name: "$", detail: "ssh dgx-node-03 'squeue -u wayne --format=%j,%T'", time: "0.4s" },
  { icon: "\u{1F9E0}", name: "memory", detail: '~memory: "2026-03-02: NVDA earni..."', time: "0.0s" },
];

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
  { category: "autonomous-agents", items: "claude-code, codex, hans-agent" },
  { category: "research", items: "arxiv, sec-edgar, github-codebase" },
];

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

const SidebarItem = ({ label, active, hasAgent }) => (
  <div style={{
    display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:6,cursor:"pointer",
    fontSize:13,fontFamily:"'JetBrains Mono',monospace",
    color:active?GREEN[400]:DARK.muted,background:active?DARK.elevated:"transparent",
  }}>
    {hasAgent ? <AgentIcon color={GREEN[400]} /> : <ChatIcon color={DARK.muted} />}
    <span style={{ overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{label}</span>
  </div>
);

const ToolCallLine = ({ call }) => (
  <div style={{ display:"flex",gap:0,fontFamily:"'JetBrains Mono',monospace",fontSize:13,lineHeight:1.7,color:DARK.text }}>
    <span style={{ width:30,textAlign:"center",flexShrink:0 }}>{call.icon}</span>
    <span style={{ width:90,color:DARK.muted,flexShrink:0 }}>{call.name}</span>
    <span style={{ flex:1,color:DARK.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{call.detail}</span>
    <span style={{ width:50,textAlign:"right",color:DARK.muted,flexShrink:0 }}>{call.time}</span>
  </div>
);

const HansBlock = ({ children }) => (
  <div style={{ margin:"8px 0" }}>
    <div style={{ display:"flex",alignItems:"center",gap:0,marginBottom:4 }}>
      <span style={{ color:DARK.muted }}>{"┌─ "}</span>
      <span style={{ color:GREEN[400] }}>{"\u26A1"}Hans</span>
      <span style={{ color:DARK.muted }}>{" ─"}</span>
      <span style={{ flex:1,borderBottom:`1px solid ${DARK.border}`,marginLeft:4 }} />
    </div>
    <div style={{ paddingLeft:6,borderLeft:`1px solid ${DARK.border}`,marginLeft:6 }}>{children}</div>
    <div style={{ display:"flex",alignItems:"center",marginTop:4 }}>
      <span style={{ color:DARK.muted }}>{"└─"}</span>
      <span style={{ flex:1,borderBottom:`1px solid ${DARK.border}`,marginLeft:4,maxWidth:40 }} />
    </div>
  </div>
);

const UserMessage = ({ text }) => (
  <div style={{ margin:"12px 0",fontFamily:"'JetBrains Mono',monospace",fontSize:13,lineHeight:1.7 }}>
    <span style={{ color:GREEN[500] }}>{"\u25CF "}</span>
    <span style={{ color:DARK.yellow }}>{text}</span>
  </div>
);

export default function HansAgent() {
  const [inputValue, setInputValue] = useState("");
  const [showChat, setShowChat] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowChat(true), 500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{
      width:"100vw",height:"100vh",background:DARK.bg,
      display:"flex",fontFamily:"'JetBrains Mono','Fira Code',monospace",
      color:DARK.textBright,overflow:"hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes blink{50%{opacity:0}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}
        @keyframes asciiGlow{
          0%,100%{filter:brightness(1) drop-shadow(0 0 4px ${GREEN[500]}40)}
          50%{filter:brightness(1.15) drop-shadow(0 0 12px ${GREEN[500]}60)}
        }
        @keyframes flicker{
          0%,96.5%,97.5%,98.5%,100%{opacity:1}
          97%{opacity:0.88}98%{opacity:0.96}
        }
        @keyframes vignettePulse{
          0%,100%{box-shadow:inset 0 0 80px rgba(0,0,0,0.4)}
          50%{box-shadow:inset 0 0 120px rgba(0,0,0,0.5)}
        }
        ::-webkit-scrollbar{width:6px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${DARK.border};border-radius:3px}
        ::selection{background:${GREEN[700]}55}
      `}</style>

      {/* SIDEBAR */}
      <div style={{
        width:250,flexShrink:0,background:DARK.surface,
        borderRight:`1px solid ${DARK.border}`,display:"flex",flexDirection:"column",
        position:"relative",zIndex:2,
      }}>
        <div style={{ padding:"14px 14px 10px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${DARK.border}` }}>
          <div style={{ display:"flex",alignItems:"center",gap:8 }}><BookmarkIcon /><EditIcon /></div>
        </div>
        <div style={{ padding:"10px 10px 6px" }}>
          <div style={{ display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:DARK.elevated,border:`1px solid ${DARK.border}`,fontSize:12,color:DARK.muted }}>
            <SearchIcon />Search messages
          </div>
        </div>
        <div style={{ flex:1,overflow:"auto",padding:"4px 6px" }}>
          <div style={{ padding:"10px 8px 4px",fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",color:DARK.muted }}>Today</div>
          <SidebarItem hasAgent label="MSP Panel Refactor" active />
          <SidebarItem hasAgent label="API Gateway Analysis" />
          <div style={{ padding:"14px 8px 4px",fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",color:DARK.muted }}>Yesterday</div>
          <SidebarItem label="Chatting About Yapping" />
          <SidebarItem hasAgent label="Docker Compose Setup" />
          <SidebarItem label="Test123 Greeting" />
        </div>
        <div style={{ padding:"10px 14px",borderTop:`1px solid ${DARK.border}`,display:"flex",alignItems:"center",gap:8 }}>
          <div style={{
            width:28,height:28,borderRadius:"50%",
            background:`linear-gradient(135deg,${GREEN[700]},${GREEN[500]})`,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#fff",
          }}>WA</div>
          <div>
            <div style={{ fontSize:12,fontWeight:500,color:DARK.textBright }}>wayne</div>
            <div style={{ fontSize:10,color:DARK.muted }}>hans-agent</div>
          </div>
        </div>
      </div>

      {/* MAIN TERMINAL AREA */}
      <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",position:"relative" }}>

        <MatrixRain />
        <ScanlineOverlay />
        <div style={{ position:"absolute",top:0,left:0,right:0,bottom:0,pointerEvents:"none",zIndex:9,animation:"vignettePulse 8s ease-in-out infinite" }} />

        {/* Top bar */}
        <div style={{
          height:40,flexShrink:0,borderBottom:`1px solid ${DARK.border}`,
          display:"flex",alignItems:"center",padding:"0 16px",gap:10,
          background:`${DARK.surface}ee`,position:"relative",zIndex:5,
        }}>
          <SkullLogo size={20} />
          <span style={{ fontSize:12,fontWeight:600,color:GREEN[400] }}>hans-agent</span>
          <span style={{ color:DARK.muted,fontSize:11 }}>{"\u00B7"}</span>
          <span style={{ fontSize:11,color:DARK.muted }}>gpt-5.2 {"\u00B7"} Nous Research</span>
          <span style={{ color:DARK.muted,fontSize:11 }}>{"\u00B7"}</span>
          <span style={{ fontSize:11,color:DARK.muted }}>/home/wayne/projects/msp-panel-lab</span>
          <div style={{ flex:1 }} />
          <span style={{ width:6,height:6,borderRadius:"50%",background:GREEN[500],animation:"blink 2.5s ease infinite",boxShadow:`0 0 6px ${GREEN[500]}` }} />
          <span style={{ fontSize:11,color:DARK.muted }}>
            Session: <span style={{ color:GREEN[500] }}>20260303_101345_ed7e09</span>
          </span>
        </div>

        {/* Terminal scroll area */}
        <div style={{ flex:1,overflow:"auto",padding:"16px 24px",position:"relative",zIndex:5,animation:"flicker 15s linear infinite" }}>

          {/* ASCII Banner */}
          <div style={{ margin:"8px 0 12px",animation:"asciiGlow 3s ease-in-out infinite",width:"100%",overflow:"hidden" }}>
            {HANS_BANNER.map((line, i) => {
              const isBar = i===0||i===8||i===10;
              const isStatus = i===9;
              const isLetter = i>=2&&i<=6;
              return (
                <div key={i} style={{
                  fontFamily:"'JetBrains Mono',monospace",fontSize:"min(1.15vw,13px)",lineHeight:1.4,
                  color:isBar?GREEN[700]:isStatus?GREEN[400]:isLetter?GREEN[500]:"transparent",
                  margin:0,whiteSpace:"pre",
                  textShadow:isStatus?`0 0 12px ${GREEN[500]}90,0 0 30px ${GREEN[500]}40`:isLetter?`0 0 8px ${GREEN[500]}40`:"none",
                  animation:`fadeIn 0.1s ease ${i*0.05}s both`,
                  minHeight:line===""?"0.6em":undefined,
                }}>{line}</div>
              );
            })}
          </div>

          {/* Info Panel */}
          <div style={{ border:`1px solid ${DARK.border}`,borderRadius:4,margin:"0 0 16px",overflow:"hidden",animation:"fadeIn 0.5s ease 0.3s both",background:`${DARK.bg}cc` }}>
            <div style={{ display:"flex",borderBottom:`1px solid ${DARK.border}`,padding:"8px 16px",justifyContent:"center",fontSize:13,color:DARK.textBright }}>
              <span style={{ color:DARK.muted }}>{"── "}</span>Hans Agent v1.0.0<span style={{ color:DARK.muted }}>{" ──"}</span>
            </div>
            <div style={{ display:"flex" }}>
              {/* Skull art */}
              <div style={{ padding:"12px 16px",borderRight:`1px solid ${DARK.border}`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minWidth:210 }}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="140" height="140" stroke="none">
                  <rect x="0" y="0" width="240" height="240" rx="24" fill="transparent" />
                  <path d="M 116 50 L 76 70 L 66 100 L 66 133 L 76 140 L 73 153 L 93 163 L 103 186 L 133 186 L 143 163 L 163 153 L 160 140 L 170 133 L 170 100 L 156 66 Z" fill={GREEN[500]} />
                  <path d="M 76 118 L 78 116 L 94 116 L 97 118 L 100 118 L 108 126 L 108 132 L 105 134 L 105 138 L 97 143 L 92 135 L 86 135 L 78 127 L 78 122 Z" fill={DARK.bg} />
                  <path d="M 160 116 L 162 118 L 160 122 L 160 127 L 152 135 L 146 135 L 143 138 L 143 143 L 141 143 L 138 143 L 132 138 L 132 134 L 130 132 L 130 126 L 134 122 L 138 118 L 144 116 Z" fill={DARK.bg} />
                  <path d="M 116 133 L 120 133 L 123 136 L 123 143 L 126 146 L 126 153 L 120 160 L 116 160 L 110 153 L 110 146 L 113 143 L 113 136 Z" fill={DARK.bg} />
                </svg>
                <div style={{ textAlign:"center",marginTop:10,fontSize:11 }}>
                  <div style={{ color:GREEN[400],fontWeight:600 }}>gpt-5.2</div>
                  <div style={{ color:DARK.muted,fontSize:10 }}>Nous Research</div>
                </div>
                <div style={{ textAlign:"center",marginTop:4,fontSize:10,color:DARK.muted }}>/home/wayne/projects/msp-panel-lab</div>
                <div style={{ textAlign:"center",marginTop:2,fontSize:10,color:DARK.muted }}>Session: 20260303_101345_ed7e09</div>
              </div>
              {/* Tools & Skills */}
              <div style={{ flex:1,padding:"12px 20px",fontSize:13,lineHeight:1.8 }}>
                <div style={{ color:GREEN[400],fontWeight:700,marginBottom:4 }}>Available Tools</div>
                {availableTools.map((t,i) => (
                  <div key={i}><span style={{ color:GREEN[400] }}>{t.category}:</span>{" "}<span style={{ color:GREEN[700] }}>{t.items}</span></div>
                ))}
                <div style={{ color:GREEN[400],fontWeight:700,marginTop:12,marginBottom:4 }}>Available Skills</div>
                {availableSkills.map((s,i) => (
                  <div key={i}><span style={{ color:GREEN[400] }}>{s.category}:</span>{" "}<span style={{ color:GREEN[700] }}>{s.items}</span></div>
                ))}
                <div style={{ marginTop:8,color:GREEN[500],fontWeight:500 }}>32 tools {"\u00B7"} 38 skills {"\u00B7"} /help for commands</div>
              </div>
            </div>
          </div>

          {/* Welcome */}
          <div style={{ fontSize:14,color:DARK.textBright,margin:"16px 0 20px",animation:"fadeIn 0.5s ease 0.5s both" }}>
            Welcome to Hans Agent! Type your message or /help for commands.
          </div>
        </div>

        {/* Input */}
        <div style={{ flexShrink:0,borderTop:`1px solid ${DARK.border}`,background:`${DARK.surface}ee`,position:"relative",zIndex:5 }}>
          <div style={{ display:"flex",alignItems:"center",padding:"12px 24px" }}>
            <span style={{ color:GREEN[500],marginRight:8,fontSize:15,fontWeight:700 }}>{"\u276F"}</span>
            <input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Type your message or /help for commands."
              style={{ flex:1,background:"none",border:"none",outline:"none",color:DARK.textBright,fontSize:14,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.5 }}
            />
          </div>
        </div>

        <WhiteRabbit />
      </div>
    </div>
  );
}
