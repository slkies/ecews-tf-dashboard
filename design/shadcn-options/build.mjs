// Generates the three Overview design options as design-canvas artboards.
//
//   node build.mjs      -> writes DirectionDefault.dc.html, Main.dc.html,
//                          DirectionBrand.dc.html and canvas.json beside this file
//
// All three are built from shadcn/ui's own tokens and component anatomy
// (ui.shadcn.com, new-york-v4 registry), keeping IBM Plex and brand green.
// Figures are illustrative aggregates, internally consistent, not the live
// cohort. One generator so the three differ only where the options differ.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FONT = "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
const MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace"

// ── icons: stroke-based, 24px grid, one weight ─────────────────────────
const ICON = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"></rect><rect x="14" y="3" width="7" height="5" rx="1"></rect><rect x="14" y="12" width="7" height="9" rx="1"></rect><rect x="3" y="16" width="7" height="5" rx="1"></rect>',
  cascade: '<path d="M3 4h18l-7 8v6l-4 2v-8z"></path>',
  deep: '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>',
  dtc: '<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"></path><path d="M16 4.5a3.5 3.5 0 0 1 0 7"></path><path d="M18 14.8c1.9.7 3.1 2.5 3.5 5.2"></path>',
  time: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  compare: '<path d="M7 4v13"></path><path d="M3 13l4 4 4-4"></path><path d="M17 20V7"></path><path d="M13 11l4-4 4 4"></path>',
  plans: '<rect x="5" y="4" width="14" height="17" rx="2"></rect><path d="M9 4V3h6v1"></path><path d="M9 11h6M9 15h4"></path>',
  adv: '<path d="M3 3v18h18"></path><path d="M7 15l4-4 3 3 5-6"></path>',
  dq: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"></path><path d="M8.5 12l2.5 2.5 4.5-5"></path>',
  guide: '<path d="M12 6c-2-1.5-5-2-8-1.5v14c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-14c-3-.5-6 0-8 1.5z"></path><path d="M12 6v14"></path>',
  method: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 17h6"></path>',
  admin: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"></path><circle cx="16" cy="6" r="2"></circle><circle cx="10" cy="12" r="2"></circle><circle cx="18" cy="18" r="2"></circle>',
  chevron: '<path d="M6 9l6 6 6-6"></path>',
  good: '<circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.7 2.7L16 9.8"></path>',
  warn: '<path d="M12 3.5L2.5 20h19z"></path><path d="M12 10v4.5"></path><path d="M12 17.5v.01"></path>',
  bad: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path><path d="M12 16.5v.01"></path>',
  moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"></path>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path>',
  x: '<path d="M6 6l12 12M18 6L6 18"></path>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path>',
}
const ic = (name, size = 16, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;${extra}">${ICON[name]}</svg>`

// ── illustrative data (internally consistent) ─────────────────────────
const NAV = [
  ['Programme', [['dashboard', 'Overview', true], ['cascade', 'Cascade'], ['deep', 'Deep dive'],
                 ['dtc', 'DTC review'], ['time', 'Time metrics'], ['compare', 'Line list changes']]],
  ['Action', [['plans', 'Treatment plans'], ['adv', 'Advanced analytics']]],
  ['Reference', [['dq', 'Data quality'], ['guide', 'Guidelines'], ['method', 'Methodology'], ['admin', 'Admin']]],
]
const FILTERS = [['Fiscal year', 'All'], ['Enrolment quarter', 'All'], ['Month', 'All'],
  ['State', 'Delta, Osun'], ['LGA (service)', 'All'], ['LGA (residence)', 'All'], ['Facility', 'All'],
  ['Sex', 'All'], ['Age band', 'All'], ['Treatment plan', 'All']]
const TILES = [
  { k: 'Index cohort', v: '4,548', note: '4,101 clients · 447 repeat unsuppression episodes' },
  { k: 'Commenced EAC', v: '86.0%', note: '3,912 of 4,548 · 636 never started', tone: 'good', tl: 'Above 70%' },
  { k: 'Completed EAC', v: '53.8%', note: '2,104 of 3,912 commenced', tone: 'good', tl: 'Above 50%' },
  { k: 'Post-EAC VL sample', v: '61.3%', note: '1,290 of 2,104 who completed EAC', tone: 'good', tl: 'Above 60%' },
  { k: 'Follow-up VL done', v: '41.3%', note: '2,671 episodes with no later VL', tone: 'bad', tl: 'Below 50%' },
  { k: 'Re-suppressed', v: '74.7%', note: '1,402 of 1,877 with a follow-up VL', tone: 'good', tl: 'Above 70%' },
  { k: 'Awaiting DTC review', v: '123', note: 'of 475 still ≥ 1,000 · 42 prior-switch · 310 switched', tone: 'bad', tl: 'Action needed' },
]
const TIMES = [
  { k: 'Median time to EAC', v: '25 d', note: 'Index result → session 1 · IQR 9–61', tone: 'good', tl: 'Within 30 d' },
  { k: 'EAC lead time', v: '131 d', note: 'Session 1 → follow-up sample · IQR 80–210', tone: 'warn', tl: 'Over 120 d' },
  { k: 'Time to re-suppression', v: '160 d', note: 'Session 1 → suppressed VL · IQR 100–250' },
  { k: 'Months unsuppressed', v: '7.2', note: 'Index VL → line-list date · IQR 3.1–13.4', tone: 'warn', tl: 'Watch' },
]
const COHORT = [['Female', '61.6%', '2,800'], ['Adolescents 10–19', '9.0%', '410'], ['Children under 10', '4.0%', '180'],
  ['Median on ART', '48 mo', '4.0 yr'], ['First-line', '85.8%', '3,900'], ['Second-line', '13.2%', '600']]
const QUARTERS = [
  ['FY25Q4', '812', ['731', '90.0%'], ['498', '68.1%'], ['506', '62.3%'], ['389', '76.9%']],
  ['FY26Q1', '1,046', ['930', '88.9%'], ['602', '64.7%'], ['541', '51.7%'], ['402', '74.3%']],
  ['FY26Q2', '1,118', ['972', '86.9%'], ['551', '56.7%'], ['470', '42.0%'], ['348', '74.0%']],
  ['FY26Q3', '1,021', ['858', '84.0%'], ['371', '43.2%'], ['290', '28.4%'], ['214', '73.8%']],
  ['FY26Q4', '551', ['421', '76.4%'], ['82', '19.5%'], ['70', '12.7%'], ['49', '70.0%']],
]
const MONTHS = ['Jul-25', 'Aug-25', 'Sep-25', 'Oct-25', 'Nov-25', 'Dec-25', 'Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26', 'Jun-26', 'Jul-26', 'Aug-26']
const FEM = [120, 128, 131, 139, 147, 144, 156, 151, 163, 159, 171, 168, 176, 182]
const MAL = [72, 77, 80, 84, 90, 88, 95, 92, 99, 97, 104, 102, 107, 111]

// ── tokens: shadcn neutral (oklch resolved to hex), ECEWS status + brand ──
const NEUTRAL_LIGHT = {
  bg: '#ffffff', fg: '#0a0a0a', fgsoft: '#404040', card: '#ffffff', muted: '#f5f5f5', mutedfg: '#737373',
  border: '#e5e5e5', input: '#e5e5e5', controlbg: '#ffffff',
  sidebar: '#fafafa', sidebarfg: '#404040', sidebarstrong: '#0a0a0a', sidebarlabel: '#737373',
  sidebaraccent: '#f0f0f0', sidebaraccentfg: '#0a0a0a', sidebarborder: '#e5e5e5',
  brandmark: '#08684E', brandmarkfg: '#ffffff',
  good: '#08684E', warn: '#9C6B08', bad: '#B83B2A', goodsoft: '#e8f3ef', warnsoft: '#fdf3e0', badsoft: '#fbece9',
  s1: '#2a78d6', s2: '#eb6834', grid: '#ededed',
  onbg: '#e8f3ef', onborder: '#08684E', onfg: '#05402F',
  shadowxs: '0 1px 2px 0 rgba(0,0,0,.05)', shadowsm: '0 1px 3px 0 rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)',
  ring10: 'rgba(10,10,10,.10)', tilegrad: 'rgba(8,104,78,.05)', narr: '#ffffff',
  hero: '#08684E', herofg: '#ffffff', herofgmuted: 'rgba(255,255,255,.78)', headbg: '#f5f5f5',
}
const NEUTRAL_DARK = {
  bg: '#0a0a0a', fg: '#fafafa', fgsoft: '#d4d4d4', card: '#171717', muted: '#262626', mutedfg: '#a1a1a1',
  border: 'rgba(255,255,255,.10)', input: 'rgba(255,255,255,.15)', controlbg: 'rgba(255,255,255,.045)',
  sidebar: '#171717', sidebarfg: '#d4d4d4', sidebarstrong: '#fafafa', sidebarlabel: '#a1a1a1',
  sidebaraccent: '#262626', sidebaraccentfg: '#fafafa', sidebarborder: 'rgba(255,255,255,.10)',
  brandmark: '#2BD39C', brandmarkfg: '#052e22',
  good: '#2BD39C', warn: '#E7B23C', bad: '#F2705A',
  goodsoft: 'rgba(43,211,156,.12)', warnsoft: 'rgba(231,178,60,.12)', badsoft: 'rgba(242,112,90,.12)',
  s1: '#3987e5', s2: '#d95926', grid: 'rgba(255,255,255,.08)',
  onbg: 'rgba(43,211,156,.10)', onborder: 'rgba(43,211,156,.55)', onfg: '#2BD39C',
  shadowxs: 'none', shadowsm: 'none', ring10: 'rgba(255,255,255,.10)', tilegrad: 'transparent', narr: '#171717',
  hero: '#0d4a38', herofg: '#ffffff', herofgmuted: 'rgba(255,255,255,.72)', headbg: '#262626',
}
const BRAND_LIGHT = {
  ...NEUTRAL_LIGHT,
  bg: '#fafaf9', fgsoft: '#44403c', muted: '#f2f1ee', mutedfg: '#78716c', border: '#e7e5e4', input: '#e7e5e4',
  sidebar: '#0b3b2e', sidebarfg: 'rgba(255,255,255,.78)', sidebarstrong: '#ffffff', sidebarlabel: 'rgba(255,255,255,.55)',
  sidebaraccent: 'rgba(255,255,255,.10)', sidebaraccentfg: '#ffffff', sidebarborder: 'rgba(255,255,255,.10)',
  brandmark: '#ffffff', brandmarkfg: '#0b3b2e', narr: '#f1f7f4', grid: '#eeece9', headbg: '#f2f1ee',
}
const BRAND_DARK = {
  ...NEUTRAL_DARK,
  bg: '#0c0a09', fgsoft: '#d6d3d1', card: '#1c1917', muted: '#292524', mutedfg: '#a8a29e',
  sidebar: '#06241c', sidebarfg: 'rgba(255,255,255,.75)', sidebarstrong: '#ffffff', sidebarlabel: 'rgba(255,255,255,.50)',
  sidebaraccent: 'rgba(255,255,255,.08)', sidebaraccentfg: '#ffffff',
  brandmark: '#2BD39C', brandmarkfg: '#06241c', narr: 'rgba(43,211,156,.06)', headbg: '#292524',
}

// ── the three options ─────────────────────────────────────────────────
const OPTIONS = [
  {
    file: 'DirectionDefault.dc.html', title: 'Option A — shadcn default', light: NEUTRAL_LIGHT, dark: NEUTRAL_DARK,
    sidebarW: 256, headerH: 56, pad: 24, gap: 24, r: { card: 14, control: 8 },
    controlH: 36, controlPadX: 12, controlFont: 14, navH: 32, navFont: 14, labelH: 32, groupGap: 8,
    card: 'border:1px solid var(--border);box-shadow:var(--shadowsm)',
    tiles: 'grid4', times: 'cards', badge: 'outline', filterCard: false,
    table: { headH: 40, padY: 8, padX: 8, font: 14, headBg: false }, cardPad: 24, titleSize: 16, h: 2060,
  },
  {
    file: 'Main.dc.html', title: 'Option B — Sharp & dense', light: NEUTRAL_LIGHT, dark: NEUTRAL_DARK,
    sidebarW: 224, headerH: 48, pad: 20, gap: 16, r: { card: 8, control: 5 },
    controlH: 32, controlPadX: 10, controlFont: 13, navH: 30, navFont: 13, labelH: 28, groupGap: 6,
    card: 'box-shadow:0 0 0 1px var(--ring10)',
    tiles: 'row7', times: 'strip', badge: 'inline', filterCard: true,
    table: { headH: 36, padY: 6, padX: 12, font: 13, headBg: false }, cardPad: 16, titleSize: 14, h: 1560,
  },
  {
    file: 'DirectionBrand.dc.html', title: 'Option C — Brand-tinted', light: BRAND_LIGHT, dark: BRAND_DARK,
    sidebarW: 256, headerH: 56, pad: 24, gap: 20, r: { card: 14, control: 8 },
    controlH: 36, controlPadX: 12, controlFont: 14, navH: 34, navFont: 14, labelH: 32, groupGap: 10,
    card: 'border:1px solid var(--border)',
    tiles: 'hero', times: 'band', badge: 'soft', filterCard: false,
    table: { headH: 40, padY: 9, padX: 12, font: 14, headBg: true }, cardPad: 24, titleSize: 16, h: 1940,
  },
]

// ── pieces ────────────────────────────────────────────────────────────
const cardBox = (c, inner, extra = '') =>
  `<div style="background:var(--card);color:var(--fg);border-radius:${c.r.card}px;${c.card};${extra}">${inner}</div>`

function badge(c, tone, label) {
  if (!tone) return ''
  const col = `var(--${tone})`
  if (c.badge === 'outline') {
    return `<span style="display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--border);border-radius:999px;font-size:12px;font-weight:500;color:var(--fg);white-space:nowrap"><span style="display:flex;color:${col}">${ic(tone, 12)}</span>${label}</span>`
  }
  if (c.badge === 'inline') {
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:${col};white-space:nowrap">${ic(tone, 12)}${label}</span>`
  }
  return `<span style="display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;background:var(--${tone}soft);font-size:12px;font-weight:500;color:${col};white-space:nowrap">${ic(tone, 12)}${label}</span>`
}

const btn = (c, inner, square = false) =>
  `<div style="display:inline-flex;align-items:center;gap:6px;height:${c.controlH}px;${square ? `width:${c.controlH}px;justify-content:center;` : 'padding:0 12px;'}border:1px solid var(--input);border-radius:${c.r.control}px;background:var(--controlbg);box-shadow:var(--shadowxs);font-size:${c.controlFont}px;font-weight:500;color:var(--fg);white-space:nowrap">${inner}</div>`

function sidebar(c) {
  const groups = NAV.map(([g, items]) => `<div style="display:flex;flex-direction:column;gap:1px">
<div style="height:${c.labelH}px;display:flex;align-items:center;padding:0 8px;font-size:12px;font-weight:500;color:var(--sidebarlabel)">${g}</div>
${items.map(([icon, label, active]) => `<div style="display:flex;align-items:center;gap:8px;height:${c.navH}px;padding:0 8px;border-radius:${c.r.control}px;font-size:${c.navFont}px;${active ? 'background:var(--sidebaraccent);color:var(--sidebaraccentfg);font-weight:500' : 'color:var(--sidebarfg)'}">${ic(icon, 16)}<span>${label}</span></div>`).join('\n')}
</div>`).join('\n')
  return `<aside style="width:${c.sidebarW}px;flex-shrink:0;background:var(--sidebar);border-right:1px solid var(--sidebarborder);display:flex;flex-direction:column;padding:8px">
<div style="display:flex;align-items:center;gap:10px;height:48px;padding:0 8px">
<div style="width:32px;height:32px;border-radius:${c.r.control}px;background:var(--brandmark);color:var(--brandmarkfg);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600">EC</div>
<div style="display:flex;flex-direction:column;line-height:1.2"><span style="font-size:14px;font-weight:600;color:var(--sidebarstrong)">TF Monitor</span><span style="font-size:12px;color:var(--sidebarlabel)">ECEWS SPEED</span></div>
</div>
<div style="display:flex;flex-direction:column;gap:${c.groupGap}px;margin-top:8px">${groups}</div>
<div style="margin-top:auto;padding:12px 8px 4px;border-top:1px solid var(--sidebarborder);display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--sidebarlabel)">
<span>Line list · 5 Sep 2026</span><span>4,548 episodes · 4,101 clients</span><span style="font-family:${MONO};font-size:11px">v1.0</span>
</div>
</aside>`
}

function header(c) {
  return `<header style="height:${c.headerH}px;flex-shrink:0;display:flex;align-items:center;gap:12px;padding:0 ${c.pad}px;border-bottom:1px solid var(--border);background:var(--bg)">
<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:var(--fg)">${ic('panel', 16)}</div>
<div style="width:1px;height:16px;background:var(--border)"></div>
<div style="display:flex;flex-direction:column;line-height:1.25"><span style="font-size:14px;font-weight:600;color:var(--fg)">Overview</span><span style="font-size:12px;color:var(--mutedfg)">Treatment failure monitoring · Delta · Osun · Ekiti</span></div>
<div style="margin-left:auto;display:flex;align-items:center;gap:8px">
<div style="display:flex;flex-direction:column;align-items:flex-end;line-height:1.25;margin-right:4px"><span style="font-size:13px;font-weight:500;color:var(--fg)">Programme admin</span><span style="font-size:12px;color:var(--mutedfg)">admin</span></div>
${btn(c, ic('moon', 16), true)}
${btn(c, `${ic('logout', 16)}<span>Sign out</span>`)}
</div>
</header>`
}

function filters(c) {
  const items = FILTERS.map(([label, value]) => {
    const on = value !== 'All'
    return `<div style="display:flex;flex-direction:column;gap:6px;flex:1 1 0;min-width:0">
<span style="font-size:12px;font-weight:500;color:var(--mutedfg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</span>
<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;height:${c.controlH}px;padding:0 ${c.controlPadX}px;border:1px solid ${on ? 'var(--onborder)' : 'var(--input)'};border-radius:${c.r.control}px;background:${on ? 'var(--onbg)' : 'var(--controlbg)'};box-shadow:var(--shadowxs);font-size:${c.controlFont}px;color:${on ? 'var(--onfg)' : 'var(--fg)'};font-weight:${on ? 500 : 400}"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${value}</span>${ic('chevron', 14, 'opacity:.6')}</div>
</div>`
  }).join('\n')
  const reset = `<div style="display:flex;flex-direction:column;gap:6px;flex:0 0 auto"><span style="font-size:12px;line-height:18px;color:transparent">Reset</span><div style="display:inline-flex;align-items:center;gap:6px;height:${c.controlH}px;padding:0 10px;border-radius:${c.r.control}px;font-size:${c.controlFont}px;font-weight:500;color:var(--fg)">${ic('x', 14)}<span>Reset</span></div></div>`
  const row = `<div style="display:flex;align-items:flex-end;gap:8px">${items}\n${reset}</div>`
  return c.filterCard ? cardBox(c, row, 'padding:10px 12px') : row
}

function tiles(c) {
  if (c.tiles === 'grid4') {
    // shadcn dashboard-01 SectionCards: description, large figure, badge in
    // the action slot, footer carrying the denominator.
    const one = (t) => cardBox(c, `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:0 24px;align-items:start">
<div style="display:flex;flex-direction:column;gap:8px"><span style="font-size:14px;color:var(--mutedfg)">${t.k}</span><span style="font-size:30px;line-height:36px;font-weight:600;letter-spacing:-.02em;color:var(--fg)">${t.v}</span></div>
<div>${badge(c, t.tone, t.tl)}</div>
</div>
<div style="padding:0 24px;font-size:14px;line-height:20px;color:var(--mutedfg)">${t.note}</div>`,
    'display:flex;flex-direction:column;gap:24px;padding:24px 0;background:linear-gradient(to top,var(--tilegrad),var(--card))')
    return `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">${TILES.map(one).join('\n')}</div>`
  }
  if (c.tiles === 'row7') {
    const one = (t) => cardBox(c, `<span style="font-size:12px;font-weight:500;color:var(--mutedfg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.k}</span>
<span style="font-size:24px;line-height:30px;font-weight:600;letter-spacing:-.02em;color:var(--fg)">${t.v}</span>
<div style="min-height:16px;display:flex">${badge(c, t.tone, t.tl)}</div>
<span style="font-size:12px;line-height:16px;color:var(--mutedfg)">${t.note}</span>`,
    'display:flex;flex-direction:column;gap:4px;padding:12px 14px 14px')
    return `<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px">${TILES.map(one).join('\n')}</div>`
  }
  // hero: the index cohort as a solid brand tile, spanning two columns
  const hero = `<div style="grid-column:span 2;background:var(--hero);color:var(--herofg);border-radius:${c.r.card}px;padding:24px;display:flex;flex-direction:column;justify-content:space-between;gap:16px">
<span style="font-size:14px;color:var(--herofgmuted)">${TILES[0].k}</span>
<div style="display:flex;flex-direction:column;gap:4px"><span style="font-size:44px;line-height:48px;font-weight:600;letter-spacing:-.03em">${TILES[0].v}</span><span style="font-size:14px;color:var(--herofgmuted)">${TILES[0].note}</span></div>
</div>`
  const one = (t) => cardBox(c, `<span style="font-size:14px;color:var(--mutedfg)">${t.k}</span>
<span style="font-size:28px;line-height:34px;font-weight:600;letter-spacing:-.02em;color:var(--fg)">${t.v}</span>
<div style="display:flex">${badge(c, t.tone, t.tl)}</div>
<span style="font-size:13px;line-height:18px;color:var(--mutedfg)">${t.note}</span>`,
  'display:flex;flex-direction:column;gap:8px;padding:20px')
  return `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">${hero}\n${TILES.slice(1).map(one).join('\n')}</div>`
}

function times(c) {
  if (c.times === 'cards') {
    const one = (t) => cardBox(c, `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:0 24px;align-items:start">
<div style="display:flex;flex-direction:column;gap:8px"><span style="font-size:14px;color:var(--mutedfg)">${t.k}</span><span style="font-size:30px;line-height:36px;font-weight:600;letter-spacing:-.02em;color:var(--fg)">${t.v}</span></div>
<div>${badge(c, t.tone, t.tl)}</div>
</div>
<div style="padding:0 24px;font-size:14px;line-height:20px;color:var(--mutedfg)">${t.note}</div>`,
    'display:flex;flex-direction:column;gap:24px;padding:24px 0')
    return `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px">${TIMES.map(one).join('\n')}</div>`
  }
  if (c.times === 'strip') {
    const cells = TIMES.map((t, i) => `<div style="display:flex;flex-direction:column;gap:4px;padding:12px 16px;${i ? 'border-left:1px solid var(--border)' : ''}">
<span style="font-size:12px;font-weight:500;color:var(--mutedfg)">${t.k}</span>
<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span style="font-size:20px;line-height:26px;font-weight:600;letter-spacing:-.02em;color:var(--fg)">${t.v}</span>${badge(c, t.tone, t.tl)}</div>
<span style="font-size:12px;line-height:16px;color:var(--mutedfg)">${t.note}</span>
</div>`).join('\n')
    return cardBox(c, `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr))">${cells}</div>`)
  }
  const cells = TIMES.map((t) => `<div style="display:flex;flex-direction:column;gap:6px">
<span style="font-size:12px;font-weight:500;color:var(--mutedfg)">${t.k}</span>
<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.02em;color:var(--fg)">${t.v}</span>${badge(c, t.tone, t.tl)}</div>
<span style="font-size:12px;line-height:16px;color:var(--mutedfg)">${t.note}</span>
</div>`).join('\n')
  return `<div style="background:var(--muted);border-radius:${c.r.card}px;padding:18px 24px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px">${cells}</div>`
}

const cardHead = (c, title, desc) =>
  `<div style="display:flex;flex-direction:column;gap:6px"><span style="font-size:${c.titleSize}px;line-height:1;font-weight:600;color:var(--fg)">${title}</span><span style="font-size:${c.titleSize === 14 ? 12 : 14}px;line-height:1.45;color:var(--mutedfg)">${desc}</span></div>`

function narrative(c) {
  // Plain prose: no inline emphasis anywhere.
  const body = `${cardHead(c, 'Treatment-failure cohort, Jul-25 to Aug-26', 'Programme narrative')}
<div style="display:flex;flex-direction:column;gap:10px;font-size:${c.titleSize === 14 ? 14 : 15}px;line-height:1.7;color:var(--fgsoft);text-wrap:pretty">
<p style="margin:0">Between Jul-25 and Aug-26, 4,548 treatment-failure episodes were recorded across 4,101 clients (389 unsuppressed more than once). The cohort is 61.6% female (2,800) and 38.4% male (1,748); 9.0% are adolescents (10–19, 410) and 4.0% are children under 10 (180). Median time on ART is 48 months (4.0 years), and 85.8% are on a first-line regimen with 13.2% (600) already on second-line.</p>
<p style="margin:0">86.0% (3,912) have commenced EAC, and 53.8% (2,104) of those have completed it. Median time to EAC commencement is 25 days. Among episodes with a follow-up viral load the re-suppression rate is 74.7%, and 123 episodes remain at or above 1,000 copies/ml awaiting DTC review. The clearest gap is coverage, not efficacy: only 41.3% of episodes have any follow-up VL on record, leaving 2,671 untested.</p>
</div>`
  const bg = c.tiles === 'hero' ? 'background:var(--narr);' : ''
  return cardBox(c, body, `${bg}display:flex;flex-direction:column;gap:16px;padding:${c.cardPad}px`)
}

function chartSvg() {
  const X0 = 40, X1 = 610, Y0 = 216
  const xs = (i) => (X0 + i * (X1 - X0) / 13).toFixed(1)
  const ys = (v) => (Y0 - v).toFixed(1)
  const grid = [0, 50, 100, 150, 200].map((v) => `<line x1="${X0}" x2="${X1}" y1="${ys(v)}" y2="${ys(v)}" style="stroke:var(--grid);stroke-width:1"></line><text x="${X0 - 8}" y="${(Y0 - v + 4).toFixed(1)}" text-anchor="end" style="fill:var(--mutedfg);font-size:12px;font-variant-numeric:tabular-nums">${v}</text>`).join('')
  const xl = [0, 2, 4, 6, 8, 10, 12].map((i) => `<text x="${xs(i)}" y="240" text-anchor="middle" style="fill:var(--mutedfg);font-size:12px">${MONTHS[i]}</text>`).join('')
  const line = (arr, v) => `<polyline points="${arr.map((n, i) => `${xs(i)},${ys(n)}`).join(' ')}" style="fill:none;stroke:var(${v});stroke-width:2;stroke-linejoin:round;stroke-linecap:round"></polyline>`
  const end = (arr, v, label) => `<circle cx="${xs(13)}" cy="${ys(arr[13])}" r="4" style="fill:var(${v});stroke:var(--card);stroke-width:2"></circle><text x="${X1 + 12}" y="${(Y0 - arr[13] + 4).toFixed(1)}" style="fill:var(--fg);font-size:12px;font-weight:500">${label} ${arr[13]}</text>`
  return `<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="Line chart of new unsuppressed results by month for female and male clients, July 2025 to August 2026" style="display:block;height:auto">${grid}${xl}${line(FEM, '--s1')}${line(MAL, '--s2')}${end(FEM, '--s1', 'Female')}${end(MAL, '--s2', 'Male')}</svg>`
}

function chartCard(c) {
  const legend = `<div style="display:flex;align-items:center;gap:16px;font-size:12px;color:var(--fg)">
<span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:2px;background:var(--s1)"></span>Female</span>
<span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:2px;background:var(--s2)"></span>Male</span>
</div>`
  const foot = `<div style="display:flex;flex-wrap:wrap;gap:20px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--mutedfg);font-variant-numeric:tabular-nums">
<span>Female <span style="color:var(--fg);font-weight:500">2,135</span> (62.2%)</span><span>Male <span style="color:var(--fg);font-weight:500">1,298</span> (37.8%)</span><span>Mean per month <span style="color:var(--fg);font-weight:500">245</span></span><span>Peak <span style="color:var(--fg);font-weight:500">293</span> (Aug-26)</span>
</div>`
  return cardBox(c, `${cardHead(c, 'New unsuppressed results by month, by sex', 'Dated by result received at facility — the same clock the fiscal quarters use.')}
${legend}
${chartSvg()}
${foot}`, `grid-column:span 2;display:flex;flex-direction:column;gap:14px;padding:${c.cardPad}px`)
}

function cohortCard(c) {
  const rows = COHORT.map(([l, v, e], i) => `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 0;${i < COHORT.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
<span style="font-size:14px;color:var(--fgsoft)">${l}</span>
<span style="display:flex;align-items:baseline;gap:6px"><span style="font-size:16px;font-weight:600;color:var(--fg)">${v}</span><span style="font-size:12px;color:var(--mutedfg);font-variant-numeric:tabular-nums">${e}</span></span>
</div>`).join('\n')
  return cardBox(c, `${cardHead(c, 'Cohort at a glance', 'Demographics of the index cohort')}
<div style="display:flex;flex-direction:column">${rows}</div>`, `display:flex;flex-direction:column;gap:10px;padding:${c.cardPad}px`)
}

function tableCard(c) {
  const t = c.table
  const th = (label, right) => `<th style="height:${t.headH}px;padding:0 ${t.padX}px;text-align:${right ? 'right' : 'left'};font-size:${t.font}px;font-weight:500;color:var(--fg);white-space:nowrap;${t.headBg ? 'background:var(--headbg);' : ''}border-bottom:1px solid var(--border)">${label}</th>`
  const cell = (inner, right, last) => `<td style="padding:${t.padY}px ${t.padX}px;text-align:${right ? 'right' : 'left'};font-size:${t.font}px;white-space:nowrap;font-variant-numeric:tabular-nums;${last ? '' : 'border-bottom:1px solid var(--border)'}">${inner}</td>`
  const pair = ([n, p]) => `<span style="color:var(--fg)">${n}</span> <span style="font-size:12px;color:var(--mutedfg)">${p}</span>`
  const body = QUARTERS.map((q, i) => {
    const last = i === QUARTERS.length - 1
    return `<tr>${cell(`<span style="color:var(--fg);font-weight:500">${q[0]}</span>`, false, last)}${cell(`<span style="color:var(--fg)">${q[1]}</span>`, true, last)}${q.slice(2).map((p) => cell(pair(p), true, last)).join('')}</tr>`
  }).join('\n')
  const table = `<table style="width:100%;border-collapse:collapse">
<thead><tr>${th('Quarter')}${th('Episodes', 1)}${th('EAC commenced', 1)}${th('EAC completed', 1)}${th('Follow-up VL', 1)}${th('Re-suppressed', 1)}</tr></thead>
<tbody>
${body}
</tbody>
</table>`
  return cardBox(c, `${cardHead(c, 'EAC cascade by enrolment quarter', 'Episodes by the quarter their index result reached the facility, and how far each has moved through EAC.')}
${table}`, `display:flex;flex-direction:column;gap:14px;padding:${c.cardPad}px`)
}

// ── assemble ──────────────────────────────────────────────────────────
const tokens = (sel, t) => `${sel}{${Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';')}}`

function artboard(c) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap">
<style>
${tokens('.t-light', c.light)}
${tokens('.t-dark', c.dark)}
*{box-sizing:border-box}
body{margin:0;background:${c.light.bg}}
body:has(.t-dark){background:${c.dark.bg}}
a{color:#08684E}
a:hover{color:#05402F}
.t-dark a{color:#2BD39C}
.t-dark a:hover{color:#7fe6c2}
</style>
</helmet>
<div class="{{themeClass}}" style="display:flex;min-height:${c.h}px;background:var(--bg);color:var(--fg);font-family:${FONT};-webkit-font-smoothing:antialiased">
${sidebar(c)}
<div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column">
${header(c)}
<main style="display:flex;flex-direction:column;gap:${c.gap}px;padding:${c.pad}px">
${filters(c)}
${tiles(c)}
${times(c)}
${narrative(c)}
<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:${c.gap}px">
${chartCard(c)}
${cohortCard(c)}
</div>
${tableCard(c)}
</main>
</div>
</div>
</x-dc>
<script data-dc-script data-props='{"dark":{"editor":"boolean","default":false}}'>
class Component extends DCLogic {
  renderVals() {
    return { themeClass: (this.props.dark ?? false) ? 't-dark' : 't-light' };
  }
}
</script>
</body>
</html>
`
}

for (const c of OPTIONS) writeFileSync(join(here, c.file), artboard(c))

const W = 1440, GAP = 100
const canvas = {
  artboards: OPTIONS.map((c, i) => ({ file: c.file, title: c.title, x: i * (W + GAP), y: 0, w: W, h: c.h })),
  annotations: [
    { id: 'about', x: 0, y: -660, w: 900,
      text: 'Three directions for the React Overview, all built from shadcn/ui\'s own tokens and component anatomy, keeping IBM Plex and brand green #08684E.\nFigures are illustrative, not the live cohort. Each artboard has a Dark toggle above it.\nThe chart colours are new: the current app\'s female/male pair fails colour-vision checks in both themes. Blue #2a78d6 / orange #eb6834 (dark #3987e5 / #d95926) pass.' },
    { id: 'option-a', x: 0, y: -420, w: 900,
      text: 'Option A — shadcn default\nshadcn/ui as it ships: Neutral base, 0.625rem radius, bordered cards with a light shadow, KPI tiles in its dashboard pattern (label, large figure, outline status badge, denominator beneath).\nWhy: the most familiar modern look; every piece is an off-the-shelf component.\nTradeoff: roomy. The seven tiles take two rows and the time metrics a third, so the chart sits well below the fold on a laptop.\nReact: shadcn/ui (Tailwind v4 + Radix) — Sidebar, Card, Badge, Select with Command for multi-select, Table, Chart.' },
    { id: 'option-b', x: W + GAP, y: -420, w: 900,
      text: 'Option B — Sharp & dense (leading)\nThe same shadcn tokens and components, tightened: 0.375rem radius, a hairline ring instead of shadows, small controls, all seven tiles on one row, time metrics as one divided strip, compact table rows.\nWhy: closest to "professional and sharp", and the most of the programme on one screen.\nTradeoff: smaller type; tile denominators wrap to two lines, and it asks more of a small screen.\nReact: shadcn/ui with --radius 0.375rem, Card size="sm", Button and Select size="sm", Table rows at h-9.' },
    { id: 'option-c', x: 2 * (W + GAP), y: -420, w: 900,
      text: 'Option C — Brand-tinted\nshadcn with ECEWS green carried into the frame: deep-green sidebar, warm Stone neutrals, the index cohort as a green hero tile, soft tinted status badges, a green-washed narrative card.\nWhy: unmistakably ECEWS rather than a generic admin template.\nTradeoff: the green sidebar and hero sit close to the green that means "on track", so status leans on its icon and label; dark mode needs its own tuned greens.\nReact: shadcn/ui with custom --sidebar-* tokens, the Stone base colour, and one extra Card variant for the hero tile.' },
  ],
  launch: { view: 'canvas' },
}
writeFileSync(join(here, 'canvas.json'), JSON.stringify(canvas, null, 2) + '\n')
console.log(`wrote ${OPTIONS.map((c) => c.file).join(', ')}, canvas.json`)
