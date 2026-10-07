// One chart language for the whole product (reads the same tokens as CSS).
export const C = {
  accent: '#20c7b7',
  data: '#20c7b7',
  forecast: '#5b8cff',
  forecastSoft: '#5b8cff',
  inventory: '#61c77a',
  pricing: '#d68ac0',
  bone: '#f3f5f4',
  text: '#f3f5f4',
  muted: '#aab2b7',
  subtle: '#7f8990',
  grid: '#1d242a',
  rule: '#303a42',
  danger: '#ef6262',
  warning: '#e6a34a',
  success: '#4ccb83',
  neutralBar: '#3a454d',
};

export const axisProps = {
  axisLine: false,
  tickLine: false,
  tick: { fontSize: 11.5, fill: C.subtle, fontFamily: 'var(--font-sans)' },
};

export const gridProps = { stroke: C.grid, vertical: false };

export const cursorProps = { stroke: C.rule, strokeWidth: 1 };

export const fmtShortDate = s => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
