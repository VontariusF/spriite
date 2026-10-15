/**
 * The phone's one design system, drawn from the redesign boards
 * (docs/design/redesign/Home, Mission, Ask, Settings). Every colour reads a
 * token from tokens.ts; the legacy classes the reused panels render
 * (.card .btn .row .pill .msg .field .check ...) are restyled to the same
 * tokens so a Settings sheet looks like the board around it. New shell
 * classes use the `ph-` prefix.
 */
export const THEME_CSS = `
  .sp {
    /* Legacy names the reused panels still read, mapped onto the tokens. */
    --bg: var(--sp-ground); --surface: var(--sp-surface); --surface-2: var(--sp-raised);
    --line: var(--sp-line); --line-2: var(--sp-line-strong);
    --text: var(--sp-text); --muted: var(--sp-muted); --faint: var(--sp-placeholder);
    --accent: var(--sp-accent); --accent-ink: var(--sp-accent-ink); --accent-soft: var(--sp-selected);
    --warn: var(--sp-amber); --warn-soft: var(--sp-amber-ground);
    --danger: var(--sp-danger); --danger-soft: rgba(255, 138, 122, 0.10);
    --factory: var(--sp-factory); --cursor: var(--sp-cursor); --spriite: var(--sp-accent);
    font-family: var(--sp-font-ui); font-size: 16px; line-height: 1.4;
    color: var(--sp-text); background: var(--sp-ground); min-height: 100vh;
    max-width: 560px; margin: 0 auto; display: flex; flex-direction: column;
    -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
  }
  .sp * { box-sizing: border-box; }
  .sp [hidden] { display: none !important; }
  .sp a { color: var(--sp-accent); text-decoration: none; font-weight: 600; }
  .sp a:hover { color: var(--sp-accent-hover); }
  .sp p { margin: 0; }
  .sp h1, .sp h2, .sp h3, .sp h4 { margin: 0; }
  .sp button { font-family: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .sp button:focus { outline: none; }
  .sp button:focus-visible, .sp a:focus-visible, .sp summary:focus-visible { outline: 2px solid var(--sp-accent); outline-offset: 2px; }
  .sp input::placeholder, .sp textarea::placeholder { color: var(--sp-placeholder); }

  /* ------------------------------------------------------------ shell */
  .sp .ph-screens { flex: 1; display: flex; flex-direction: column; }
  .sp .ph-screen { flex: 1; display: flex; flex-direction: column; gap: 16px;
    padding: calc(18px + env(safe-area-inset-top)) 18px 24px; }
  .sp .ph-screen.ph-settings { gap: 20px; }
  .sp .ph-screen.ph-mission { gap: 18px; padding-top: calc(14px + env(safe-area-inset-top)); padding-bottom: 20px; }
  .sp .ph-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .sp .ph-brand { font-family: var(--sp-font-display); font-weight: 700; font-size: 22px; letter-spacing: -0.01em; }
  .sp .ph-title { font-family: var(--sp-font-display); font-weight: 700; font-size: 28px; letter-spacing: -0.02em; }
  .sp .ph-ico { display: inline-flex; align-items: center; justify-content: center; line-height: 0; flex: 0 0 auto; }

  /* Glasses pill: on is the accent pill; off and unknown keep its shape in muted colours. */
  .sp .ph-glasses { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600;
    color: var(--sp-muted); background: var(--sp-surface); border: 1px solid var(--sp-line-strong);
    border-radius: 999px; padding: 6px 12px; white-space: nowrap; }
  .sp .ph-glasses i { width: 8px; height: 8px; border-radius: 4px; background: var(--sp-radio-off); }
  .sp .ph-glasses.on { color: var(--sp-accent); background: var(--sp-selected); }
  .sp .ph-glasses.on i { background: var(--sp-accent); }

  /* Bottom nav (Home and Settings boards). */
  .sp .ph-nav { position: sticky; bottom: 0; z-index: 6; border-top: 1px solid var(--sp-line); background: var(--sp-nav);
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
    padding: 6px 8px calc(14px + env(safe-area-inset-bottom)); }
  .sp .ph-nav a { min-height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 3px; color: var(--sp-muted); font-size: 12px; font-weight: 600; text-decoration: none; }
  .sp .ph-nav a[aria-current="page"] { color: var(--sp-accent); }
  .sp .ph-nav .ph-badge { position: absolute; }
  .sp .ph-tab { position: relative; }
  .sp .ph-dotbadge { position: absolute; top: 8px; left: calc(50% + 8px); min-width: 16px; height: 16px; padding: 0 4px;
    border-radius: 8px; background: var(--sp-amber); color: var(--sp-amber-ink); font-size: 11px; line-height: 16px; font-weight: 700; }

  /* ---------------------------------------------- On your glasses mirror */
  .sp .ph-mirror { background: var(--sp-glass); border: 1px solid var(--sp-line); border-radius: 18px; padding: 16px;
    display: flex; flex-direction: column; gap: 14px; }
  .sp .ph-mirror-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .sp .ph-glass-label { font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sp-glass-label); }
  .sp .ph-glass-meta { font-size: 12px; color: var(--sp-glass-label); }
  .sp .ph-mirror-main { display: flex; gap: 14px; align-items: center; }
  .sp .ph-mirror-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
  .sp .ph-glass-title { font-size: 17px; font-weight: 600; color: var(--sp-glass-title); overflow-wrap: anywhere; }
  .sp .ph-glass-body { font-size: 14px; line-height: 1.4; color: var(--sp-glass-body); overflow-wrap: anywhere; white-space: pre-wrap; }
  .sp .ph-segs { display: grid; gap: 4px; }
  .sp .ph-seg { height: 6px; border-radius: 3px; background: var(--sp-glass-bar-off); }
  .sp .ph-seg.done { background: var(--sp-accent); }
  .sp .ph-seg.review { background: repeating-linear-gradient(90deg, var(--sp-accent) 0 4px, transparent 4px 7px); }
  .sp .ph-pair { display: flex; gap: 8px; }
  .sp .ph-pair > * { flex: 1; }
  .sp .ph-glass-btn { min-height: 44px; border-radius: 10px; font: 600 14px var(--sp-font-ui); text-decoration: none;
    display: flex; align-items: center; justify-content: center; color: var(--sp-text); }
  .sp .ph-glass-btn.solid { background: var(--sp-raised); border: 0; }
  .sp .ph-glass-btn.outline { background: transparent; border: 1px solid var(--sp-line-strong); }
  .sp .ph-glass-btn:disabled { opacity: 0.45; }
  .sp .spr { flex: 0 0 auto; }

  /* --------------------------------------------------------- Needs you */
  .sp .ph-needs { background: var(--sp-amber-ground); border: 1.5px solid var(--sp-amber); border-radius: 18px; padding: 16px;
    display: flex; flex-direction: column; gap: 12px; }
  .sp .ph-needs-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sp .ph-needs-label { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sp-amber); }
  .sp .ph-needs-meta { font-size: 12px; color: var(--sp-amber-muted); }
  .sp .ph-needs-q { font-size: 16px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
  .sp .ph-needs-opts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .sp .ph-needs-opts.one { grid-template-columns: minmax(0, 1fr); }
  .sp .ph-amber-btn { min-height: 44px; border-radius: 10px; font: 600 14px var(--sp-font-ui); padding: 0 6px; }
  .sp .ph-amber-btn.solid { border: 0; background: var(--sp-amber); color: var(--sp-amber-ink); }
  .sp .ph-amber-btn.outline { border: 1px solid var(--sp-amber-line); background: transparent; color: var(--sp-amber-soft); }
  .sp .ph-amber-btn:disabled { opacity: 0.45; }
  .sp .ph-needs-link { font-size: 14px; font-weight: 600; color: var(--sp-amber); text-decoration: none; min-height: 32px;
    display: flex; align-items: center; background: transparent; border: 0; padding: 0; align-self: flex-start; }
  .sp .ph-needs-more { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--sp-amber-line); padding-top: 12px; }
  .sp .ph-needs .row { border-bottom-color: var(--sp-amber-line); }
  .sp .ph-needs .row .t span { color: var(--sp-amber-muted); }
  .sp .ph-needs .btn { background: var(--sp-amber); color: var(--sp-amber-ink); }
  .sp .ph-needs .btn.secondary { background: transparent; color: var(--sp-amber-soft); border-color: var(--sp-amber-line); }

  /* ------------------------------------------------------- composer */
  .sp .ph-card { background: var(--sp-surface); border: 1px solid var(--sp-line); border-radius: 18px; }
  .sp .ph-compose { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .sp .ph-compose > label { font-size: 15px; font-weight: 600; }
  .sp .ph-compose textarea { resize: none; width: 100%; border-radius: 12px; border: 1px solid var(--sp-line-strong);
    background: var(--sp-ground); color: var(--sp-text); font: 16px/1.4 var(--sp-font-ui); padding: 12px; }
  .sp .ph-compose textarea:focus { outline: 2px solid var(--sp-accent); outline-offset: -1px; border-color: transparent; }
  .sp .ph-compose-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sp .ph-spacer { flex: 1; }
  .sp .ph-chip { min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--sp-line-strong);
    background: transparent; color: var(--sp-muted); font: 500 13px var(--sp-font-ui); display: flex; align-items: center; gap: 6px; }
  .sp .ph-chip.on { background: var(--sp-raised); color: var(--sp-text); }
  .sp .ph-chip:disabled { opacity: 0.45; }
  .sp .ph-round { width: 44px; height: 44px; border-radius: 22px; border: 1px solid var(--sp-line-strong); background: transparent;
    color: var(--sp-text); display: flex; align-items: center; justify-content: center; padding: 0; flex: 0 0 auto; }
  .sp .ph-round.go { border: 0; background: var(--sp-accent); color: var(--sp-accent-ink); }
  .sp .ph-round:disabled { opacity: 0.45; }
  .sp .ph-hint { font-size: 13px; color: var(--sp-muted); line-height: 1.4; }
  .sp .ph-hint:empty { display: none; }

  /* ---------------------------------------------------------- builds */
  .sp .ph-section { display: flex; flex-direction: column; gap: 10px; }
  .sp .ph-settings .ph-section { gap: 8px; }
  .sp .ph-section-head { display: flex; justify-content: space-between; align-items: baseline; }
  .sp .ph-h2 { font-family: var(--sp-font-display); font-size: 20px; font-weight: 700; }
  .sp .ph-see-all { font-size: 14px; font-weight: 600; text-decoration: none; color: var(--sp-accent); background: transparent; border: 0; padding: 0; }
  .sp .ph-list { display: flex; flex-direction: column; }
  .sp .ph-build { text-decoration: none; color: var(--sp-text); display: flex; gap: 12px; align-items: center; padding: 14px 16px;
    width: 100%; text-align: left; background: transparent; border: 0; border-top: 1px solid var(--sp-line); font: inherit; }
  .sp .ph-build:first-child { border-top: 0; }
  .sp .ph-build:disabled { opacity: 0.55; }
  .sp .ph-build-dot { width: 10px; height: 10px; flex: 0 0 10px; border-radius: 5px; background: var(--sp-accent); }
  .sp .ph-build-text { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .sp .ph-build-name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp .ph-build-status { font-size: 13px; color: var(--sp-muted); }
  .sp .ph-src { font-size: 12px; font-weight: 600; border: 1px solid currentColor; border-radius: 6px; padding: 2px 6px; flex: 0 0 auto; }
  .sp .ph-src.local { color: var(--sp-accent); } .sp .ph-src.factory { color: var(--sp-factory); } .sp .ph-src.cursor { color: var(--sp-cursor); }
  .sp .ph-filters { display: flex; gap: 8px; flex-wrap: wrap; }
  .sp .empty { padding: 18px 16px; text-align: center; color: var(--sp-muted); font-size: 14px; }

  /* --------------------------------------------------------- mission */
  .sp .ph-mission-top { display: flex; align-items: center; justify-content: space-between; }
  .sp .ph-icon-btn { width: 44px; height: 44px; border: 0; background: transparent; color: var(--sp-text);
    display: flex; align-items: center; justify-content: center; padding: 0; }
  .sp .ph-icon-btn.ph-back { margin-left: -10px; }
  .sp .ph-mission-id { display: flex; gap: 14px; align-items: center; }
  .sp .ph-sprite-box { width: 72px; height: 72px; flex: 0 0 72px; border-radius: 18px; background: var(--sp-glass);
    display: flex; align-items: center; justify-content: center; }
  .sp .ph-mission-name { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .sp .ph-mission-name h1 { font-family: var(--sp-font-display); font-weight: 700; font-size: 26px; line-height: 1.1;
    letter-spacing: -0.02em; overflow-wrap: anywhere; }
  .sp .ph-mission-where { font-size: 14px; color: var(--sp-muted); overflow-wrap: anywhere; }
  .sp .ph-menu { background: var(--sp-surface); border: 1px solid var(--sp-line-strong); border-radius: 16px; padding: 12px;
    display: flex; flex-direction: column; gap: 10px; }
  .sp .ph-timeline { display: flex; flex-direction: column; }
  .sp .ph-step { display: flex; gap: 14px; }
  .sp .ph-step-rail { display: flex; flex-direction: column; align-items: center; width: 24px; flex: 0 0 24px; }
  .sp .ph-step-ring { width: 24px; height: 24px; border-radius: 12px; border: 2px solid var(--sp-step-off); background: var(--sp-ground);
    color: var(--sp-accent-ink); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
  .sp .ph-step-line { width: 2px; flex: 1; min-height: 18px; background: var(--sp-line); }
  .sp .ph-step-text { display: flex; flex-direction: column; gap: 3px; padding-bottom: 16px; flex: 1; min-width: 0; }
  .sp .ph-step-title { font-size: 15px; font-weight: 600; color: var(--sp-muted); overflow-wrap: anywhere; }
  .sp .ph-step-detail { font-size: 13px; color: var(--sp-muted); line-height: 1.4; overflow-wrap: anywhere; }
  .sp .ph-step.done .ph-step-ring { border-color: var(--sp-accent); background: var(--sp-accent); }
  .sp .ph-step.done .ph-step-line { background: var(--sp-accent); }
  .sp .ph-step.done .ph-step-title { color: var(--sp-text); }
  .sp .ph-step.now .ph-step-ring { border-color: var(--sp-accent); }
  .sp .ph-step.now .ph-step-title { color: var(--sp-accent); }
  .sp .ph-step.last .ph-step-line { background: transparent; }
  .sp .ph-label { font-size: 13px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sp-muted); }
  .sp .ph-group { background: var(--sp-surface); border: 1px solid var(--sp-line); border-radius: 16px; display: flex; flex-direction: column; }
  .sp .ph-agent { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-top: 1px solid var(--sp-line); }
  .sp .ph-agent:first-child { border-top: 0; }
  .sp .ph-mono { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 10px; background: var(--sp-raised);
    display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
  .sp .ph-agent-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .sp .ph-agent-name { font-size: 14px; font-weight: 600; }
  .sp .ph-agent-doing { font-size: 13px; color: var(--sp-muted); line-height: 1.35; overflow-wrap: anywhere; }
  .sp .ph-agent-state { font-size: 12px; font-weight: 600; }
  /* The chat flows in the page: one scroller, so a long chat reaches its end on a phone. */
  .sp .ph-bubbles { display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
  .sp .ph-bubbles > * { scroll-margin-top: calc(16px + env(safe-area-inset-top)); }
  .sp .bubble { align-self: flex-start; max-width: 300px; background: var(--sp-raised); border-radius: 14px 14px 14px 4px;
    padding: 10px 12px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .sp .bubble:empty { display: none; }
  .sp .bubble b { display: block; font-size: 12px; font-weight: 600; color: var(--sp-accent); margin-bottom: 2px; }
  .sp .bubble.you { align-self: flex-end; max-width: 280px; background: var(--sp-accent); color: var(--sp-accent-ink); border-radius: 14px 14px 4px 14px; }
  .sp .bubble.you b { display: none; }
  .sp .bubble.watched { border: 1px dashed var(--sp-line-strong); }
  /* Full-bleed under the page (the Mission board puts it outside the 18 px gutter). */
  .sp .ph-msgbar { position: sticky; bottom: 0; z-index: 6; border-top: 1px solid var(--sp-line); background: var(--sp-nav);
    margin: auto -18px -20px; padding: 12px 14px calc(18px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; }
  .sp .ph-msgbar-row { display: flex; gap: 8px; align-items: center; }
  .sp .ph-msgbar input { flex: 1; min-width: 0; min-height: 46px; padding: 0 14px; border-radius: 23px; border: 1px solid var(--sp-line-strong);
    background: var(--sp-ground); color: var(--sp-text); font: 16px var(--sp-font-ui); }
  .sp .ph-msgbar input:focus { outline: 2px solid var(--sp-accent); outline-offset: -1px; border-color: transparent; }
  .sp .ph-msgbar .ph-round { width: 46px; height: 46px; border-radius: 23px; }
  .sp .ph-msgbar .ph-round.raised { border: 0; background: var(--sp-raised); }
  .sp .ph-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* ----------------------------------------------------------- sheets */
  .sp .ph-overlay { position: fixed; inset: 0; z-index: 20; background: var(--sp-scrim); display: flex; flex-direction: column;
    justify-content: flex-end; max-width: 560px; margin: 0 auto; }
  .sp .ph-sheet { background: var(--sp-surface); border-top: 1px solid var(--sp-line-strong); border-radius: 24px 24px 0 0;
    padding: 10px 20px calc(24px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 16px;
    max-height: 92vh; max-height: calc(100dvh - 56px - env(safe-area-inset-top)); overflow-y: auto;
    -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  /* Pinned above the content: the handle and a visible Close always stay in reach. */
  .sp .ph-sheet-top { position: sticky; top: -10px; z-index: 1; background: var(--sp-surface); margin: -10px -20px -8px;
    padding: 0 12px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; touch-action: none; }
  .sp .ph-sheet-top .ph-handle { grid-column: 2; margin: 0; }
  .sp .ph-sheet-top .ph-sheet-close { grid-column: 3; justify-self: end; align-self: center; padding: 0 8px; }
  .sp .ph-handle { width: 64px; height: 44px; margin: -20px 0; align-self: center; flex: 0 0 44px; border: 0; padding: 0; background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .sp .ph-handle::before { content: ''; width: 40px; height: 4px; border-radius: 2px; background: var(--sp-step-off); }
  .sp .ph-sheet-close { align-self: flex-end; background: transparent; border: 0; color: var(--sp-muted); font: 600 14px var(--sp-font-ui); min-height: 44px; padding: 0 4px; }
  .sp .ph-sheet-head { display: flex; flex-direction: column; gap: 4px; }
  .sp .ph-sheet-head .ph-sheet-title { font-family: var(--sp-font-display); font-weight: 700; font-size: 22px; line-height: 1.2; letter-spacing: -0.01em; }
  .sp .ph-sheet-head .ph-sheet-role { font-size: 14px; color: var(--sp-muted); }
  .sp .ph-sheet-head .pill { align-self: flex-start; }
  /* Ready's optional extras open their key sheet above the setup flow (z 30). */
  .sp .ph-overlay.ph-overlay--over-flow { z-index: 40; }
  .sp .ph-fullscreen { position: fixed; inset: 0; z-index: 30; background: var(--sp-ground); overflow-y: auto; max-width: 560px; margin: 0 auto; }

  /* Ask sheet (Ask board). */
  /* Ask.dc.html: 16 px between the asker row, question, options, actions and footnote. */
  .sp .ph-sheet-content.ph-ask { gap: 16px; }
  .sp .ph-ask-who { display: flex; gap: 12px; align-items: center; }
  .sp .ph-ask-who-text { display: flex; flex-direction: column; gap: 2px; }
  .sp .ph-ask-label { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sp-amber); }
  .sp .ph-ask-meta { font-size: 13px; color: var(--sp-muted); }
  .sp .ph-ask-q { display: flex; flex-direction: column; gap: 6px; }
  .sp .ph-ask-q h1 { font-family: var(--sp-font-display); font-weight: 700; font-size: 22px; line-height: 1.2; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .sp .ph-ask-q p { font-size: 14px; line-height: 1.45; color: var(--sp-muted); }
  .sp .ph-radios { display: flex; flex-direction: column; gap: 8px; }
  .sp .ph-radio { min-height: 56px; border-radius: 14px; border: 1px solid var(--sp-line); background: var(--sp-ground); color: var(--sp-text);
    padding: 10px 14px; display: flex; gap: 12px; align-items: center; text-align: left; font-family: inherit; width: 100%; }
  .sp .ph-radio[aria-checked="true"] { border: 1.5px solid var(--sp-accent); background: var(--sp-selected); }
  .sp .ph-radio-ring { width: 20px; height: 20px; flex: 0 0 20px; border-radius: 10px; border: 2px solid var(--sp-radio-off);
    display: flex; align-items: center; justify-content: center; }
  .sp .ph-radio-ring i { width: 10px; height: 10px; border-radius: 5px; background: transparent; }
  .sp .ph-radio[aria-checked="true"] .ph-radio-ring { border-color: var(--sp-accent); }
  .sp .ph-radio[aria-checked="true"] .ph-radio-ring i { background: var(--sp-accent); }
  .sp .ph-radio-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .sp .ph-radio-label { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .sp .ph-radio-hint { font-size: 13px; color: var(--sp-muted); }
  .sp .ph-radio-hint:empty { display: none; }
  .sp .ph-ask-actions { display: flex; gap: 8px; }
  .sp .ph-say { flex: 0 0 auto; min-height: 52px; padding: 0 16px; border-radius: 14px; border: 1px solid var(--sp-line-strong);
    background: transparent; color: var(--sp-text); font: 600 15px var(--sp-font-ui); display: flex; align-items: center; gap: 8px; }
  .sp .ph-send { flex: 1; min-height: 52px; border-radius: 14px; background: var(--sp-accent); color: var(--sp-accent-ink); border: 0;
    font: 600 16px var(--sp-font-ui); display: flex; align-items: center; justify-content: center; }
  .sp .ph-send:disabled, .sp .ph-say:disabled { opacity: 0.45; }
  .sp .ph-foot { font-size: 12px; color: var(--sp-muted); text-align: center; }

  /* -------------------------------------------------------- settings */
  .sp .ph-rows { background: var(--sp-surface); border: 1px solid var(--sp-line); border-radius: 16px; display: flex; flex-direction: column; }
  .sp .ph-conn { min-height: 60px; text-decoration: none; color: var(--sp-text); display: flex; gap: 12px; align-items: center;
    padding: 10px 14px; border: 0; border-top: 1px solid var(--sp-line); background: transparent; width: 100%; text-align: left; font: inherit; }
  .sp .ph-rows > :first-child { border-top: 0; }
  .sp .ph-conn-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .sp .ph-conn-name { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .sp .ph-conn-detail { font-size: 13px; color: var(--sp-muted); overflow-wrap: anywhere; }
  .sp .ph-state { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--sp-muted); white-space: nowrap; }
  .sp .ph-state i { width: 8px; height: 8px; border-radius: 4px; background: currentColor; }
  .sp .ph-state.ok { color: var(--sp-accent); } .sp .ph-state.err { color: var(--sp-danger); }
  .sp .ph-pref { min-height: 54px; text-decoration: none; color: var(--sp-text); display: flex; gap: 12px; align-items: center;
    justify-content: space-between; padding: 8px 14px; border: 0; border-top: 1px solid var(--sp-line); background: transparent;
    width: 100%; text-align: left; font: inherit; }
  .sp .ph-pref-name { font-size: 15px; }
  .sp .ph-pref-value { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--sp-muted); text-align: right; }
  .sp .ph-setup-row { min-height: 60px; text-decoration: none; color: var(--sp-text); display: flex; gap: 12px; align-items: center;
    padding: 10px 14px; border: 0; border-top: 1px solid var(--sp-line); background: transparent; width: 100%; text-align: left; font: inherit; }
  .sp .ph-setup-row input[type=checkbox] { width: 22px; height: 22px; accent-color: var(--sp-accent); flex: 0 0 auto; }
  .sp .ph-setup-text { flex: 1; display: flex; flex-direction: column; gap: 2px; background: transparent; border: 0; padding: 0;
    color: inherit; text-align: left; font: inherit; }
  .sp details.ph-advanced { background: var(--sp-surface); border: 1px solid var(--sp-line); border-radius: 16px; padding: 4px 14px; }
  .sp details.ph-advanced > summary { min-height: 48px; display: flex; align-items: center; font-size: 15px; font-weight: 600; cursor: pointer; list-style: none; }
  .sp details.ph-advanced > summary::-webkit-details-marker { display: none; }
  .sp .ph-adv-body { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 14px; font-size: 14px; color: var(--sp-muted); }
  .sp details.ph-adv-section > summary { cursor: pointer; list-style: none; min-height: 32px; display: flex; align-items: center; }
  .sp details.ph-adv-section > summary::-webkit-details-marker { display: none; }
  .sp details.ph-adv-section[open] > summary { color: var(--sp-text); }
  .sp .ph-adv-content { display: flex; flex-direction: column; gap: 12px; padding: 8px 0 12px; color: var(--sp-text); }
  /* A step shown inside Advanced reads as part of its section, not as a sheet. */
  .sp .ph-adv-content .ph-sheet-head { display: none; }
  .sp .ph-kv { display: flex; flex-direction: column; gap: 2px; }
  .sp .ph-kv b { font-size: 12px; font-weight: 600; color: var(--sp-muted); }
  .sp .ph-kv span { font-family: var(--sp-font-mono); font-weight: 500; font-size: 13px; overflow-wrap: anywhere; }

  /* ---------------------------------------------- legacy classes, restyled */
  .sp .card { background: var(--sp-surface); border: 1px solid var(--sp-line); border-radius: 18px; padding: 16px; }
  .sp .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .sp .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sp-muted); }
  .sp .card-head .eyebrow { flex: 1; }
  .sp h2 { font-size: 17px; font-weight: 600; color: var(--sp-text); }
  .sp h3 { font-size: 15px; font-weight: 600; }
  .sp h4 { font-size: 14px; font-weight: 600; }
  .sp .muted { color: var(--sp-muted); }
  .sp .small { font-size: 13px; }
  .sp .stack { display: flex; flex-direction: column; gap: 10px; }
  .sp .btn { padding: 10px 16px; border-radius: 10px; border: 1px solid transparent; font: 600 14px var(--sp-font-ui);
    background: var(--sp-accent); color: var(--sp-accent-ink); min-height: 44px; text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center; text-align: center; }
  .sp .btn.secondary { background: transparent; color: var(--sp-text); border-color: var(--sp-line-strong); }
  .sp .btn.quiet { background: transparent; color: var(--sp-muted); border-color: transparent; padding-left: 8px; padding-right: 8px; }
  .sp .btn.danger { background: transparent; color: var(--sp-danger); border-color: rgba(255, 138, 122, 0.4); }
  .sp .btn.small { min-height: 36px; padding: 5px 12px; font-size: 13px; border-radius: 10px; }
  .sp .btn:disabled { opacity: 0.45; }
  .sp .btns { display: flex; flex-wrap: wrap; gap: 8px; }
  .sp .btns.grow > .btn { flex: 1; }
  .sp .pill { flex: 0 0 auto; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    background: transparent; color: var(--sp-muted); border: 1px solid var(--sp-line-strong); }
  .sp .pill:empty { display: none; }
  .sp .pill.ok { color: var(--sp-accent); border-color: var(--sp-accent); }
  .sp .pill.warn { color: var(--sp-amber); border-color: var(--sp-amber-line); }
  .sp .pill.err { color: var(--sp-danger); border-color: var(--sp-danger); }
  .sp .pill.factory { color: var(--sp-factory); border-color: var(--sp-factory); }
  .sp .pill.cursor { color: var(--sp-cursor); border-color: var(--sp-cursor); }
  .sp .pill.spriite { color: var(--sp-accent); border-color: var(--sp-accent); }
  .sp .rows { display: flex; flex-direction: column; }
  .sp .row { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 12px 0; border: 0;
    border-bottom: 1px solid var(--sp-line); background: transparent; color: var(--sp-text); font: inherit; }
  .sp .row:last-child { border-bottom: 0; }
  .sp .row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
  .sp .row .t { flex: 1; min-width: 0; }
  .sp .row .t b { display: block; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .sp .row .t span { display: block; margin-top: 2px; font-size: 13px; color: var(--sp-muted); }
  .sp .row .chev { color: var(--sp-muted); font-size: 18px; }
  /* Zero specificity: a component's own input rule (the setup code boxes, the Repo search, the
     message bar) always wins over these defaults, whatever order the stylesheets load in. */
  :where(.sp) :where(input[type=text], input[type=password], input[type=url], input:not([type]), select, textarea) {
    width: 100%; padding: 11px 12px; border-radius: 12px; border: 1px solid var(--sp-line-strong);
    background: var(--sp-ground); color: var(--sp-text); font: 16px/1.4 var(--sp-font-ui); min-height: 44px; }
  :where(.sp) :where(input:focus, select:focus, textarea:focus) { outline: 2px solid var(--sp-accent); outline-offset: -1px; border-color: transparent; }
  .sp input[type=checkbox], .sp input[type=radio] { width: 20px; height: 20px; accent-color: var(--sp-accent); flex: 0 0 auto; }
  .sp label.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--sp-muted); }
  .sp label.check { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--sp-text); min-height: 44px; }
  .sp label.stack { font-size: 13px; font-weight: 600; color: var(--sp-muted); gap: 6px; }
  .sp .msg { font-size: 13px; line-height: 1.4; }
  .sp .msg:empty { display: none; }
  .sp .msg.ok { color: var(--sp-accent); } .sp .msg.err { color: var(--sp-danger); } .sp .msg.muted { color: var(--sp-muted); }
  .sp .callout { border-radius: 12px; padding: 10px 12px; font-size: 13px; line-height: 1.4; }
  .sp .callout.err { background: var(--danger-soft); color: var(--sp-text); border: 1px solid var(--sp-danger); }
  .sp .callout b { display: block; color: var(--sp-danger); margin-bottom: 2px; }
  .sp .sub { padding-top: 12px; border-top: 1px dashed var(--sp-dash); display: flex; flex-direction: column; gap: 10px; }
  .sp .current { padding: 10px 12px; border-radius: 12px; background: var(--sp-ground); border: 1px solid var(--sp-line-strong);
    font-size: 14px; overflow-wrap: anywhere; }
  .sp .current b { display: block; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sp-muted); margin-bottom: 2px; }
  .sp ul.small { padding-left: 18px; margin: 0; }

  /* Activity log (Settings > Advanced > Durable runtime and developer flags). */
  .sp details.log { padding: 12px 14px; border-radius: 16px; }
  .sp details.log summary { list-style: none; display: flex; align-items: center; gap: 8px; cursor: pointer; min-height: 32px; }
  .sp details.log summary::-webkit-details-marker { display: none; }
  .sp details.log summary .eyebrow { flex: 1; }
  .sp .feed { list-style: none; margin: 10px 0 0; padding: 0; max-height: min(48vh, 440px); overflow-y: auto;
    -webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-color: var(--sp-line-strong) transparent; }
  .sp .feed li { display: flex; gap: 12px; padding: 9px 0; border-top: 1px solid var(--sp-line); }
  .sp .feed time { flex: 0 0 42px; color: var(--sp-muted); font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 1px; }
  .sp .feed .w { flex: 1; min-width: 0; }
  .sp .feed .w b { font-size: 13px; color: var(--sp-text); }
  .sp .feed .w span { display: block; color: var(--sp-muted); font-size: 13px; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  /* Native request panel: the Ask sheet's type and radio rows. */
  .sp #native-request-panel { background: var(--sp-surface); border: 1px solid var(--sp-line-strong); border-radius: 24px; padding: 16px 20px; }
  .sp #native-request-panel h3 { font-family: var(--sp-font-display); font-weight: 700; font-size: 20px; line-height: 1.2; }
  .sp #native-request-panel label.check { min-height: 56px; border-radius: 14px; border: 1px solid var(--sp-line); background: var(--sp-ground); padding: 10px 14px; }
  .sp #native-request-panel label.check:has(input:checked) { border: 1.5px solid var(--sp-accent); background: var(--sp-selected); }
`
