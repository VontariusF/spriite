/**
 * Setup flow styles: `sf-` classes over the C1 phone tokens. Every value is
 * the board's (Main, Pair, Paired, Repo, Ready, Move). Each token carries its
 * board value as the var() fallback so the flow still renders true when it is
 * mounted outside the `.sp` root (tests, a bare preview).
 *
 * No runtime imports and erasable-only syntax: the Node suites load this.
 */

const T = {
  ground: 'var(--sp-ground, #07110A)',
  surface: 'var(--sp-surface, #0D1A11)',
  raised: 'var(--sp-raised, #13241A)',
  selected: 'var(--sp-selected, #0F2215)',
  line: 'var(--sp-line, #1F3326)',
  lineStrong: 'var(--sp-line-strong, #24452F)',
  text: 'var(--sp-text, #EAF5EC)',
  muted: 'var(--sp-muted, #9AB1A0)',
  bodySoft: 'var(--sp-body-soft, #D4E3D7)',
  accent: 'var(--sp-accent, #5CE57D)',
  accentHover: 'var(--sp-accent-hover, #8BF0A2)',
  accentInk: 'var(--sp-accent-ink, #04210E)',
  amber: 'var(--sp-amber, #F2B740)',
  factory: 'var(--sp-factory, #7DBEFF)',
  cursor: 'var(--sp-cursor, #BDA4FF)',
  danger: 'var(--sp-danger, #FF8A7A)',
  placeholder: 'var(--sp-placeholder, #7F9785)',
  radioOff: 'var(--sp-radio-off, #5A7562)',
  dash: 'var(--sp-dash, #3C5A45)',
  display: "var(--sp-font-display, 'Bricolage Grotesque', Georgia, serif)",
  ui: "var(--sp-font-ui, 'Instrument Sans', 'Helvetica Neue', Helvetica, sans-serif)",
  mono: "var(--sp-font-mono, 'JetBrains Mono', Menlo, monospace)",
} as const

export const SETUP_STYLE_ID = 'sf-styles'

export const SETUP_CSS = `
.sf-root [hidden]{display:none!important}
.sf-chooser{display:flex;flex-direction:column;gap:18px}
.sf-root{background:${T.ground};color:${T.text};font-family:${T.ui}}
.sf-screen{box-sizing:border-box;min-height:100vh;min-height:100dvh;width:100%;background:${T.ground};color:${T.text};font-family:${T.ui};display:flex;flex-direction:column}
.sf-screen--welcome{padding:28px 22px 26px;gap:22px}
.sf-screen--pair{padding:18px 22px 26px;gap:20px}
.sf-screen--paired,.sf-screen--repo{padding:18px 22px 26px;gap:18px}
.sf-screen--ready{padding:34px 22px 26px;gap:22px}
.sf-screen--move{padding:14px 22px 26px;gap:20px}
.sf-screen a{color:${T.accent}}
.sf-screen a:hover{color:${T.accentHover}}
.sf-screen button{cursor:pointer}
.sf-screen button:disabled{cursor:default}
.sf-screen svg{display:block}

.sf-top{display:flex;align-items:center;justify-content:space-between}
.sf-brand{font-family:${T.display};font-weight:700;font-size:20px;letter-spacing:-0.01em}

.sf-hero{display:flex;flex-direction:column;align-items:center;gap:6px;padding-top:6px}
.sf-circle{background:${T.surface};border:1px solid ${T.line};display:flex;align-items:center;justify-content:center;box-sizing:content-box}
.sf-circle--168{width:168px;height:168px;border-radius:84px}
.sf-circle--176{width:176px;height:176px;border-radius:88px}
.sf-circle--72{width:72px;height:72px;flex:0 0 72px;border-radius:36px}

.sf-copy{display:flex;flex-direction:column;gap:8px}
.sf-h1{margin:0;font-family:${T.display};font-weight:700;line-height:1.1;letter-spacing:-0.02em}
.sf-h1--30{font-size:30px}
.sf-h1--28{font-size:28px}
.sf-h1--26{font-size:26px}
.sf-lead{margin:0;line-height:1.45;color:${T.muted}}
.sf-lead--16{font-size:16px}
.sf-lead--15{font-size:15px}

.sf-options{display:flex;flex-direction:column;gap:10px}
.sf-option{box-sizing:border-box;width:100%;margin:0;text-decoration:none;color:${T.text};background:${T.surface};border:1px solid ${T.line};border-radius:16px;padding:16px;display:flex;gap:14px;align-items:flex-start;text-align:left;font-family:${T.ui}}
.sf-option--best{background:${T.selected};border:1.5px solid ${T.accent}}
.sf-icontile{width:40px;height:40px;flex:0 0 40px;border-radius:12px;background:${T.raised};display:flex;align-items:center;justify-content:center}
.sf-icontile--accent{background:${T.accent};color:${T.accentInk}}
.sf-icontile--factory{color:${T.factory}}
.sf-icontile--cursor{color:${T.cursor}}
.sf-option-body{display:flex;flex-direction:column;gap:4px;flex:1}
.sf-option-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sf-option-title{font-size:16px;font-weight:600}
.sf-option-desc{font-size:14px;line-height:1.4;color:${T.muted}}
.sf-badge{font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${T.accentInk};background:${T.accent};border-radius:6px;padding:2px 6px}

.sf-foot-note{margin-top:auto;display:flex;align-items:center;gap:10px;color:${T.muted};font-size:13px;line-height:1.4}
.sf-foot-note svg{flex:0 0 18px}

.sf-stephead{display:flex;align-items:center;gap:8px}
.sf-back{box-sizing:border-box;width:44px;height:44px;flex:0 0 44px;display:flex;align-items:center;justify-content:center;color:${T.text};margin:0 0 0 -10px;padding:0;background:transparent;border:0}
.sf-steps{flex:1;display:flex;gap:6px}
.sf-step{flex:1;height:4px;border-radius:2px;background:${T.line}}
.sf-step--on{background:${T.accent}}
.sf-steplabel{font-size:13px;color:${T.muted};padding-left:8px}

.sf-cmd{background:${T.surface};border:1px solid ${T.line};border-radius:14px;padding:6px 6px 6px 16px;display:flex;align-items:center;gap:10px}
.sf-cmd-text{font-family:${T.mono};font-size:16px;font-weight:500;flex:1;color:${T.text};user-select:all;-webkit-user-select:all}
.sf-cmd-copy{min-height:44px;padding:0 16px;border-radius:10px;border:0;background:${T.raised};color:${T.text};font:600 14px ${T.ui};display:flex;align-items:center;gap:8px}
.sf-hint{display:flex;gap:8px;font-size:13px;color:${T.muted};line-height:1.4;margin-top:-10px}
.sf-hint a{font-weight:600}

.sf-codecard{display:flex;flex-direction:column;gap:12px;background:${T.surface};border:1px solid ${T.line};border-radius:18px;padding:18px}
.sf-label15{font-size:15px;font-weight:600;line-height:normal}
.sf-coderow{display:flex;gap:6px;align-items:center}
.sf-codebox{width:42px;height:54px;flex:0 1 42px;min-width:0;box-sizing:border-box;margin:0;padding:0;text-align:center;font:600 22px ${T.mono};color:${T.text};background:${T.ground};border:1px solid ${T.line};border-radius:10px;text-transform:uppercase;outline:none}
.sf-codebox--word{flex:1 1 0;min-width:0;width:auto}
.sf-codebox--num{flex:0 0 64px;width:64px}
.sf-codebox--filled{border:1.5px solid ${T.accent}}
.sf-codebox--next{border:1.5px solid ${T.muted}}
.sf-codedash{width:10px;height:2px;background:${T.dash};flex:0 0 10px}
.sf-outline-btn{min-height:44px;border-radius:10px;border:1px solid ${T.lineStrong};background:transparent;color:${T.text};font:600 14px ${T.ui};display:flex;align-items:center;justify-content:center;gap:8px}
.sf-error{margin:0;font-size:13px;line-height:1.4;font-weight:500;color:${T.danger}}
.sf-note{margin:0;font-size:13px;line-height:1.4;color:${T.muted}}
.sf-scan{display:flex;flex-direction:column;gap:8px}
.sf-scan video{width:100%;border-radius:10px;background:${T.ground}}

.sf-listen{display:flex;align-items:center;gap:12px;padding:4px 2px}
.sf-listen-text{display:flex;flex-direction:column;gap:3px}
.sf-listen-title{font-size:15px;font-weight:600}
.sf-listen-sub{font-size:13px;color:${T.muted};line-height:1.4}

.sf-actions{margin-top:auto;display:flex;flex-direction:column}
.sf-actions--10{gap:10px}
.sf-actions--6{gap:6px}
.sf-primary{box-sizing:border-box;width:100%;margin:0;min-height:52px;border-radius:14px;border:0;background:${T.accent};color:${T.accentInk};font-family:${T.ui};font-size:16px;font-weight:600;text-decoration:none;display:flex;align-items:center;justify-content:center}
.sf-primary:disabled{opacity:0.45}
.sf-primary[aria-busy="true"]{opacity:0.75}
.sf-secondary{min-height:44px;margin:0;display:flex;align-items:center;justify-content:center;background:transparent;border:0;color:${T.accent};font-family:${T.ui};font-size:14px;font-weight:600;text-decoration:none}
.sf-secondary:hover{color:${T.accentHover}}
.sf-footnote{font-size:12px;color:${T.muted};text-align:center;line-height:1.4}

.sf-paired-head{display:flex;gap:14px;align-items:center}
.sf-paired-title{display:flex;flex-direction:column;gap:4px}
.sf-sub14{font-size:14px;color:${T.muted}}
.sf-list{background:${T.surface};border:1px solid ${T.line};display:flex;flex-direction:column}
.sf-list--18{border-radius:18px}
.sf-list--16{border-radius:16px}
.sf-list--14{border-radius:14px}
.sf-review-row{display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:1px solid ${T.line}}
.sf-review-row:first-child,.sf-extra-row:first-child,.sf-repo-row:first-child{border-top:0}
.sf-mono-tile{width:36px;height:36px;flex:0 0 36px;border-radius:10px;background:${T.raised};display:flex;align-items:center;justify-content:center;font:700 13px ${T.ui}}
.sf-tint--factory{color:${T.factory}}
.sf-tint--accent{color:${T.accent}}
.sf-tint--text{color:${T.text}}
.sf-tint--amber{color:${T.amber}}
.sf-row-body{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.sf-row-name{font-size:15px;font-weight:600}
.sf-row-detail{font-size:13px;color:${T.muted};line-height:1.35}
.sf-found{display:flex;align-items:center;gap:4px;font-size:13px;font-weight:600;color:${T.accent}}
.sf-later{font-size:13px;font-weight:600;color:${T.muted}}

.sf-runon{display:flex;flex-direction:column;gap:10px}
.sf-runon-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.sf-runon-opt{box-sizing:border-box;margin:0;min-height:64px;border-radius:12px;border:1px solid ${T.line};background:${T.surface};color:${T.text};font:600 14px ${T.ui};display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;padding:10px 12px;text-align:left}
.sf-runon-opt[aria-checked="true"]{border:1.5px solid ${T.accent};background:${T.selected}}
.sf-runon-sub{font-size:12px;font-weight:500;color:${T.muted}}

.sf-keyblock{display:flex;flex-direction:column;gap:8px}
.sf-keylink{font-size:13px;font-weight:600;line-height:normal}
/* The boards' links are plain <a>: underlined (the app theme drops it elsewhere). */
.sf-screen .sf-hint a,.sf-screen a.sf-keylink{text-decoration:underline}
.sf-keyrow{display:flex;gap:8px}
.sf-input{flex:1;min-width:0;min-height:48px;box-sizing:border-box;margin:0;padding:0 14px;border-radius:12px;border:1px solid ${T.lineStrong};background:${T.surface};color:${T.text};font:16px ${T.mono}}
.sf-input::placeholder,.sf-search-input::placeholder{color:${T.placeholder}}
.sf-paste{min-height:48px;padding:0 14px;border-radius:12px;border:0;background:${T.raised};color:${T.text};font:600 14px ${T.ui}}
.sf-keylink{font-size:13px;font-weight:600}

.sf-radios{display:flex;flex-direction:column;gap:8px}
.sf-radio{box-sizing:border-box;width:100%;margin:0;border-radius:14px;border:1px solid ${T.line};background:${T.surface};color:${T.text};padding:14px 16px;display:flex;gap:12px;align-items:flex-start;text-align:left;font-family:inherit}
.sf-radio[aria-checked="true"]{border:1.5px solid ${T.accent};background:${T.selected}}
.sf-radio-dot{width:20px;height:20px;flex:0 0 20px;border-radius:10px;border:2px solid ${T.radioOff};box-sizing:border-box;display:flex;align-items:center;justify-content:center;margin-top:1px}
.sf-radio[aria-checked="true"] .sf-radio-dot{border-color:${T.accent}}
.sf-radio-dot-inner{width:10px;height:10px;border-radius:5px;background:${T.accent}}
.sf-radio[aria-checked="false"] .sf-radio-dot-inner{display:none}
.sf-radio-body{display:flex;flex-direction:column;gap:3px}
.sf-radio-title{font-size:15px;font-weight:600}
.sf-radio-desc{font-size:13px;color:${T.muted};line-height:1.4}

.sf-search{display:flex;flex-direction:column;gap:8px}
.sf-search-label{font-size:13px;font-weight:600;color:${T.muted}}
.sf-search-wrap{position:relative}
.sf-search-input{width:100%;min-height:48px;box-sizing:border-box;margin:0;padding:0 14px 0 42px;border-radius:12px;border:1px solid ${T.lineStrong};background:${T.surface};color:${T.text};font:16px ${T.ui}}
.sf-search-icon{position:absolute;left:14px;top:15px;color:${T.muted}}
.sf-repo-row{box-sizing:border-box;width:100%;margin:0;min-height:52px;padding:0 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:transparent;border:0;border-top:1px solid ${T.line};color:${T.text};font:15px ${T.ui};text-align:left}
.sf-repo-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.sf-repo-name{font-weight:500;overflow-wrap:anywhere}
.sf-repo-meta{font-size:12px;color:${T.muted}}
.sf-repo-mark{color:${T.muted};flex:0 0 18px}
.sf-repo-row[aria-pressed="true"] .sf-repo-mark{color:${T.accent}}
.sf-repo-note{padding:14px 16px;font-size:13px;line-height:1.4;color:${T.muted}}

.sf-ready-top{display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center}
.sf-extras{display:flex;flex-direction:column;gap:8px}
.sf-eyebrow{font-size:12px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:${T.muted}}
.sf-extra-row{display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:1px solid ${T.line}}
.sf-extra-cta{min-height:40px;min-width:76px;margin:0;padding:0 14px;border-radius:10px;border:1px solid ${T.lineStrong};background:transparent;color:${T.text};font:600 14px ${T.ui}}

.sf-movecard{background:${T.surface};border:1px solid ${T.line};border-radius:20px;padding:22px;display:flex;flex-direction:column;align-items:center;gap:16px}
.sf-qr{box-sizing:border-box;width:200px;height:200px;border-radius:14px;background:${T.text};color:${T.accentInk};display:flex;align-items:center;justify-content:center;padding:12px;font-size:13px;font-weight:600}
.sf-qr svg{width:176px;height:176px}
.sf-or{font-size:13px;color:${T.muted}}
.sf-movecode{font-family:${T.mono};font-size:26px;font-weight:500;letter-spacing:0.08em;text-align:center;white-space:nowrap}
.sf-expiry{font-size:13px;color:${T.amber};font-weight:600}
.sf-expiry--done{color:${T.accent}}
.sf-expiry--error{color:${T.danger}}
.sf-moves{display:flex;flex-direction:column;gap:10px}
.sf-moves-list{display:flex;flex-direction:column;gap:8px;font-size:14px;color:${T.bodySoft}}
.sf-moves-item{display:flex;gap:10px;align-items:center}
.sf-moves-item svg{color:${T.accent};flex:0 0 16px}
`
