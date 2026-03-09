/**
 * HANS Agent GOD MODE — Matrix Rain Effect
 * Vanilla JS canvas implementation with ~18% red characters
 * 
 * Usage: 
 *   1. Add a <canvas id="matrix-rain"></canvas> to your HTML
 *   2. Position it absolute/fixed behind your content
 *   3. Call initMatrixRain("matrix-rain") or pass your own canvas element
 */

const MATRIX_CHARS =
  "アウエオカキクケコサシスセソタチツテトナニネノハヒフヘホマミムメモヤユヨラリルレロワン01234589ABCDEF";

function initMatrixRain(canvasOrId, options = {}) {
  const canvas =
    typeof canvasOrId === "string"
      ? document.getElementById(canvasOrId)
      : canvasOrId;

  if (!canvas) {
    console.error("Matrix rain: canvas not found");
    return;
  }

  const ctx = canvas.getContext("2d");

  // --- Tunables ---
  const FONT_SIZE     = options.fontSize     || 12;   // px per character
  const COL_WIDTH     = options.colWidth     || 14;   // px between columns
  const DROP_SPEED    = options.dropSpeed    || 0.18;  // rows per frame (lower = slower)
  const FRAME_MS      = options.frameMs      || 50;   // ms between draws (~20fps)
  const RED_CHANCE    = options.redChance    || 0.18;  // 0-1, fraction of red chars
  const TRAIL_FADE    = options.trailFade    || 0.05;  // alpha overlay per frame (lower = longer trails)
  const RESET_CHANCE  = options.resetChance  || 0.985; // higher = columns stay longer before resetting
  const BG_COLOR      = options.bgColor      || "rgba(12,15,14,{alpha})"; // {alpha} gets replaced with TRAIL_FADE

  // Green palette (bright / mid / dim)
  const GREEN_BRIGHT = options.greenBright || "#4dffa180";
  const GREEN_MID    = options.greenMid    || "#2da56530";
  const GREEN_DIM    = options.greenDim    || "#1a6b3f15";

  // Red palette (bright / mid / dim)
  const RED_BRIGHT   = options.redBright   || "#ff4d4d80";
  const RED_MID      = options.redMid      || "#cc2a2a30";
  const RED_DIM      = options.redDim      || "#7a161615";

  let cols, drops, animId;

  function resize() {
    const parent = canvas.parentElement || document.body;
    canvas.width  = parent.offsetWidth  || window.innerWidth;
    canvas.height = parent.offsetHeight || window.innerHeight;
    cols  = Math.floor(canvas.width / COL_WIDTH);
    drops = Array(cols).fill(0).map(() => Math.random() * -80);
  }

  let lastFrame = 0;

  function draw(now) {
    animId = requestAnimationFrame(draw);

    // Throttle to target framerate
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    // Fade previous frame (creates the trailing effect)
    ctx.fillStyle = BG_COLOR.replace("{alpha}", TRAIL_FADE);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = `${FONT_SIZE}px monospace`;

    for (let i = 0; i < drops.length; i++) {
      // Pick a random character
      const char = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];

      // Brightness roll — determines bright/mid/dim
      const brightness = Math.random();

      // Color selection: ~18% chance of red, rest green
      const isRed = Math.random() < RED_CHANCE;

      if (isRed) {
        ctx.fillStyle =
          brightness > 0.96 ? RED_BRIGHT :
          brightness > 0.85 ? RED_MID    : RED_DIM;
      } else {
        ctx.fillStyle =
          brightness > 0.96 ? GREEN_BRIGHT :
          brightness > 0.85 ? GREEN_MID    : GREEN_DIM;
      }

      // Draw the character
      ctx.fillText(char, i * COL_WIDTH, drops[i] * COL_WIDTH);

      // Reset column to top once it passes the bottom
      if (drops[i] * COL_WIDTH > canvas.height && Math.random() > RESET_CHANCE) {
        drops[i] = 0;
      }

      // Advance the drop
      drops[i] += DROP_SPEED;
    }
  }

  // --- Init ---
  resize();
  window.addEventListener("resize", resize);
  draw(0);

  // Return a cleanup function
  return function destroy() {
    cancelAnimationFrame(animId);
    window.removeEventListener("resize", resize);
  };
}


// ============================================================
// EXAMPLE USAGE — drop this in an HTML file to see it run:
// ============================================================
//
// <html>
// <head><style>
//   body { margin: 0; background: #0c0f0e; overflow: hidden; }
//   #matrix-rain {
//     position: fixed;
//     top: 0; left: 0;
//     width: 100vw; height: 100vh;
//     opacity: 0.35;
//     pointer-events: none;
//   }
// </style></head>
// <body>
//   <canvas id="matrix-rain"></canvas>
//   <script src="matrix-rain.js"></script>
//   <script>
//     // Default settings (slow god-mode rain with red mix):
//     initMatrixRain("matrix-rain");
//
//     // Or customise everything:
//     // initMatrixRain("matrix-rain", {
//     //   dropSpeed: 0.12,    // even slower
//     //   frameMs: 60,        // ~16fps
//     //   redChance: 0.25,    // more red
//     //   trailFade: 0.03,    // longer trails
//     // });
//   </script>
// </body>
// </html>
