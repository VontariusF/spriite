/**
 * One design system for the phone page (Now and Setup tabs share it):
 * surfaces, type scale, buttons, pills, rows, and form fields. Green on
 * near-black mirrors the glasses' display.
 */
export const THEME_CSS = `
  .sp {
    --bg: #050b06; --surface: #0a150b; --surface-2: #0f1d10; --line: #1a2e1c; --line-2: #26432a;
    --text: #eaf6eb; --muted: #94ab96; --faint: #67806a;
    --accent: #4be36a; --accent-ink: #032109; --accent-soft: #10331a;
    --warn: #e9c94e; --warn-soft: #2d2810; --danger: #ff8473; --danger-soft: #331512;
    --factory: #7cc8ff; --cursor: #c9a5ff; --spriite: #4be36a;
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: var(--text); background: var(--bg); min-height: 100vh;
    max-width: 560px; margin: 0 auto; padding-bottom: calc(32px + env(safe-area-inset-bottom));
    -webkit-font-smoothing: antialiased;
  }
  .sp * { box-sizing: border-box; }

  /* ---------------------------------------------------------- header */
  .sp header {
    position: sticky; top: 0; z-index: 5; background: rgba(5, 11, 6, 0.94);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    padding: calc(12px + env(safe-area-inset-top)) 16px 12px; border-bottom: 1px solid var(--line);
  }
  .sp .brand { display: flex; align-items: center; gap: 10px; }
  .sp .brand h1 { margin: 0; font-size: 19px; font-weight: 800; letter-spacing: 0.5px; color: var(--accent); }
  .sp .link-pill {
    margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--muted); padding: 4px 10px; border-radius: 999px;
    background: var(--surface); border: 1px solid var(--line);
  }
  .sp .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; }
  .sp .dot.on { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .sp .dot.off { background: var(--danger); }
  .sp .segs {
    display: flex; gap: 4px; margin-top: 12px; padding: 4px; border-radius: 12px;
    background: var(--surface); border: 1px solid var(--line);
  }
  .sp .seg {
    flex: 1; padding: 8px 0; border: 0; border-radius: 9px; background: transparent;
    color: var(--muted); font: inherit; font-size: 14px; font-weight: 600;
  }
  .sp .seg.on { background: var(--surface-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line-2); }
  .sp .seg .badge {
    display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px;
    background: var(--warn); color: #1d1600; font-size: 11px; line-height: 18px; font-weight: 800;
  }
  .sp main { padding: 16px 16px 0; display: flex; flex-direction: column; gap: 14px; }
  .sp .pane { display: none; flex-direction: column; gap: 14px; }
  .sp .pane.on { display: flex; }

  /* ------------------------------------------------------------ cards */
  .sp .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
  .sp .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .sp .eyebrow {
    font-size: 11px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; color: var(--faint);
  }
  .sp .card-head .eyebrow { flex: 1; }
  .sp h2 { margin: 0; font-size: 17px; font-weight: 700; color: var(--text); }
  .sp p { margin: 0; }
  .sp .muted { color: var(--muted); }
  .sp .small { font-size: 13px; }
  .sp .stack { display: flex; flex-direction: column; gap: 10px; }

  /* ---------------------------------------------------------- buttons */
  .sp button { font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .sp button:focus { outline: none; }
  .sp button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .sp .btn {
    padding: 10px 16px; border-radius: 10px; border: 1px solid transparent; font-size: 15px; font-weight: 700;
    background: var(--accent); color: var(--accent-ink); min-height: 42px;
  }
  .sp .btn.secondary { background: transparent; color: var(--text); border-color: var(--line-2); }
  .sp .btn.quiet { background: transparent; color: var(--muted); border-color: transparent; padding-left: 8px; padding-right: 8px; }
  .sp .btn.danger { background: transparent; color: var(--danger); border-color: #4a2420; }
  .sp .btn.small { min-height: 32px; padding: 5px 12px; font-size: 13px; border-radius: 8px; }
  .sp .btn:disabled { opacity: 0.45; }
  .sp .btns { display: flex; flex-wrap: wrap; gap: 8px; }
  .sp .btns.grow > .btn { flex: 1; }

  /* ------------------------------------------------------------ pills */
  .sp .pill {
    flex: 0 0 auto; font-size: 11px; font-weight: 800; letter-spacing: 0.4px; padding: 3px 8px;
    border-radius: 999px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--line-2);
  }
  .sp .pill.ok { background: var(--accent-soft); color: var(--accent); border-color: #1f5a2c; }
  .sp .pill.warn { background: var(--warn-soft); color: var(--warn); border-color: #4e4416; }
  .sp .pill.err { background: var(--danger-soft); color: var(--danger); border-color: #5a2620; }
  .sp .pill.factory { color: var(--factory); border-color: #1d3b52; background: #0b1822; }
  .sp .pill.cursor { color: var(--cursor); border-color: #3a2d55; background: #151022; }
  .sp .pill.spriite { color: var(--spriite); border-color: #1f5a2c; background: var(--accent-soft); }

  /* ------------------------------------------------------------- rows */
  .sp .rows { display: flex; flex-direction: column; }
  .sp .row {
    display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
    padding: 12px 4px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--text);
  }
  .sp .row:last-child { border-bottom: 0; }
  .sp .row .t { flex: 1; min-width: 0; }
  .sp .row .t b { display: block; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sp .row .t span { display: block; margin-top: 2px; font-size: 13px; color: var(--muted); }
  .sp .row .chev { color: var(--faint); font-size: 18px; }
  .sp .row:active { background: var(--surface-2); }

  /* ----------------------------------------------------------- fields */
  .sp input[type=text], .sp input[type=password], .sp select {
    width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--line-2);
    background: var(--bg); color: var(--text); font: inherit; font-size: 16px; min-height: 44px;
  }
  .sp input:focus, .sp select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .sp label.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .sp label.check { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); }
  .sp a { color: var(--accent); text-decoration: none; font-weight: 600; }

  /* ---------------------------------------------------------- notices */
  .sp .msg { font-size: 13px; line-height: 1.4; }
  .sp .msg:empty { display: none; }
  .sp .msg.ok { color: var(--accent); } .sp .msg.err { color: var(--danger); } .sp .msg.muted { color: var(--muted); }
  .sp .callout { border-radius: 10px; padding: 10px 12px; font-size: 13px; line-height: 1.4; }
  .sp .callout.err { background: var(--danger-soft); color: #ffc2b9; border: 1px solid #5a2620; }
  .sp .callout b { display: block; color: var(--danger); margin-bottom: 2px; }
`
