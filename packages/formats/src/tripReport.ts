/**
 * Printable trip report: a single self-contained HTML document (inline CSS,
 * no scripts, no external resources) laid out for A4 paper. All user content
 * is HTML-escaped. Labels are Czech.
 */
import { escapeXml, formatDistance, formatDuration, formatElevation, formatWeight } from '@trailpack/shared';

export interface TripReportDay {
  /** 1-based day number. */
  index: number;
  /** ISO date YYYY-MM-DD. */
  date?: string;
  /** Start place name. */
  start?: string;
  /** End place name. */
  end?: string;
  /** meters */
  distanceM: number;
  /** meters */
  ascentM: number;
  /** meters */
  descentM: number;
  /** Estimated moving time in minutes. */
  movingTimeMin?: number;
  /** Planned campsite / accommodation. */
  campsite?: string;
  /** Planned schedule, e.g. ["07:00 vyrazit", "12:30 oběd u pramene"]. */
  schedule?: string[];
  /** Short weather summary. */
  weather?: string;
  /** Water sources / refill points on the day. */
  water?: string;
  notes?: string;
}

export interface TripReportGearGroup {
  category: string;
  items: Array<{ name: string; quantity: number; /** grams per piece */ weightG: number; worn?: boolean; consumable?: boolean }>;
}

export interface TripReportData {
  title: string;
  subtitle?: string;
  /** ISO dates. */
  startDate?: string;
  endDate?: string;
  participants?: string[];
  activityLabel?: string;
  region?: string;
  summary: {
    distanceM: number;
    ascentM: number;
    descentM: number;
    days: number;
    movingTimeMin?: number;
    highestPointM?: number;
    notes?: string;
  };
  days: TripReportDay[];
  gear?: TripReportGearGroup[];
  food?: {
    totalKcal?: number;
    totalWeightG?: number;
    perDay?: Array<{ day: number; kcal: number; weightG: number }>;
    notes?: string;
  };
  checklist?: Array<{ category: string; items: Array<{ text: string; done?: boolean }> }>;
  risks?: Array<{ severity: 'info' | 'warning' | 'danger'; title: string; description?: string; mitigation?: string }>;
  emergency?: {
    contacts?: Array<{ name: string; phone: string; relation?: string }>;
    /** Extra numbers; the European emergency numbers are always listed. */
    numbers?: Array<{ label: string; number: string }>;
    /** Free text, e.g. nearest hospital, evacuation points. */
    notes?: string;
  };
  /** Data attributions, e.g. "Mapové podklady © přispěvatelé OpenStreetMap". */
  attribution?: string[];
  /** ISO date-time. */
  generatedAt: string;
}

const esc = (s: string | undefined | null): string => (s === undefined || s === null ? '' : escapeXml(String(s)));
const fmtDate = (iso?: string): string => {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : iso;
};
const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', dateStyle: 'long', timeStyle: 'short' });
};
const dash = (s: string | undefined): string => (s && s.trim() ? esc(s) : '–');

const CSS = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1c2a1f; font-size: 10pt; line-height: 1.4; margin: 0; background: #fff; }
.page { max-width: 186mm; margin: 0 auto; padding: 8mm 0; }
h1 { font-size: 22pt; margin: 0 0 2mm; color: #2f6b3a; }
h2 { font-size: 13pt; margin: 7mm 0 2mm; padding-bottom: 1mm; border-bottom: 2px solid #2f6b3a; color: #1f4a28; break-after: avoid; }
h3 { font-size: 10.5pt; margin: 4mm 0 1mm; break-after: avoid; }
.subtitle { color: #4a5a4d; font-size: 11pt; margin: 0 0 3mm; }
.meta { display: flex; flex-wrap: wrap; gap: 2mm 8mm; color: #3a4a3d; margin-bottom: 3mm; }
.meta span b { color: #1c2a1f; }
.stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3mm; margin: 3mm 0; }
.stat { border: 1px solid #c9d6cb; border-radius: 3mm; padding: 2mm 3mm; background: #f4f8f4; }
.stat .v { font-size: 14pt; font-weight: 700; color: #2f6b3a; }
.stat .l { font-size: 8pt; text-transform: uppercase; letter-spacing: .04em; color: #5a6a5d; }
table { width: 100%; border-collapse: collapse; margin: 2mm 0; font-size: 9pt; }
th, td { border: 1px solid #c9d6cb; padding: 1.2mm 2mm; text-align: left; vertical-align: top; }
th { background: #e6efe7; font-weight: 600; }
td.n, th.n { text-align: right; white-space: nowrap; }
tr { break-inside: avoid; }
tfoot td { font-weight: 700; background: #f4f8f4; }
ul { margin: 1mm 0; padding-left: 5mm; }
.box { border: 1px solid #c9d6cb; border-radius: 2mm; padding: 2mm 3mm; margin: 2mm 0; break-inside: avoid; }
.sev-danger { border-left: 4px solid #b3261e; background: #fdf1f0; }
.sev-warning { border-left: 4px solid #c77700; background: #fff7ea; }
.sev-info { border-left: 4px solid #2d6cdf; background: #eff4fd; }
.check li { list-style: none; margin-left: -4mm; }
.check li::before { content: "\\2610\\00a0"; }
.check li.done::before { content: "\\2611\\00a0"; }
.emergency { border: 2px solid #b3261e; border-radius: 2mm; padding: 2mm 3mm; break-inside: avoid; }
.muted { color: #5a6a5d; font-size: 8.5pt; }
footer { margin-top: 8mm; padding-top: 2mm; border-top: 1px solid #c9d6cb; }
.pb { break-before: page; }
@media print { .page { padding: 0; } }
`;

function stat(value: string, label: string): string {
  return `<div class="stat"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
}

function daysTable(days: TripReportDay[]): string {
  if (days.length === 0) return '<p class="muted">Plán nemá žádné etapy.</p>';
  const rows = days
    .map(
      (d) => `<tr>
<td class="n">${d.index}</td>
<td>${dash(fmtDate(d.date))}</td>
<td>${dash(d.start)}</td>
<td>${dash(d.end)}</td>
<td class="n">${esc(formatDistance(d.distanceM))}</td>
<td class="n">+${esc(formatElevation(d.ascentM))}</td>
<td class="n">−${esc(formatElevation(d.descentM))}</td>
<td class="n">${d.movingTimeMin !== undefined ? esc(formatDuration(d.movingTimeMin)) : '–'}</td>
<td>${dash(d.campsite)}</td>
</tr>`,
    )
    .join('\n');
  const total = days.reduce(
    (a, d) => ({ dist: a.dist + d.distanceM, up: a.up + d.ascentM, down: a.down + d.descentM, time: a.time + (d.movingTimeMin ?? 0) }),
    { dist: 0, up: 0, down: 0, time: 0 },
  );
  const table = `<table>
<thead><tr><th class="n">Den</th><th>Datum</th><th>Start</th><th>Cíl</th><th class="n">Vzdál.</th><th class="n">Stoupání</th><th class="n">Klesání</th><th class="n">Čas</th><th>Nocleh</th></tr></thead>
<tbody>
${rows}
</tbody>
<tfoot><tr><td colspan="4">Celkem</td><td class="n">${esc(formatDistance(total.dist))}</td><td class="n">+${esc(formatElevation(total.up))}</td><td class="n">−${esc(formatElevation(total.down))}</td><td class="n">${total.time > 0 ? esc(formatDuration(total.time)) : '–'}</td><td></td></tr></tfoot>
</table>`;
  const details = days
    .filter((d) => (d.schedule && d.schedule.length) || d.weather || d.water || d.notes)
    .map((d) => {
      const sched = d.schedule?.length ? `<li><b>Harmonogram:</b> ${d.schedule.map(esc).join(' &rarr; ')}</li>` : '';
      return `<div class="box"><h3>Den ${d.index}${d.date ? ` – ${esc(fmtDate(d.date))}` : ''}</h3><ul>
${sched}
${d.weather ? `<li><b>Počasí:</b> ${esc(d.weather)}</li>` : ''}
${d.water ? `<li><b>Voda:</b> ${esc(d.water)}</li>` : ''}
${d.notes ? `<li><b>Poznámky:</b> ${esc(d.notes)}</li>` : ''}
</ul></div>`;
    })
    .join('\n');
  return table + details;
}

function gearSection(groups: TripReportGearGroup[]): string {
  if (groups.length === 0) return '';
  let base = 0;
  let worn = 0;
  let consumable = 0;
  const body = groups
    .map((g) => {
      const rows = g.items
        .map((it) => {
          const total = it.weightG * it.quantity;
          if (it.worn) worn += total;
          else if (it.consumable) consumable += total;
          else base += total;
          const flag = it.worn ? ' (na sobě)' : it.consumable ? ' (spotřební)' : '';
          return `<tr><td>${esc(it.name)}${flag}</td><td class="n">${it.quantity}</td><td class="n">${esc(formatWeight(it.weightG))}</td><td class="n">${esc(formatWeight(total))}</td></tr>`;
        })
        .join('\n');
      return `<tr><th colspan="4">${esc(g.category)}</th></tr>\n${rows}`;
    })
    .join('\n');
  return `<h2>Vybavení</h2>
<table>
<thead><tr><th>Položka</th><th class="n">Ks</th><th class="n">Hmotnost/ks</th><th class="n">Celkem</th></tr></thead>
<tbody>
${body}
</tbody>
<tfoot>
<tr><td colspan="3">Základní hmotnost (bez spotřebního a oblečení na sobě)</td><td class="n">${esc(formatWeight(base))}</td></tr>
<tr><td colspan="3">Oblečení na sobě</td><td class="n">${esc(formatWeight(worn))}</td></tr>
<tr><td colspan="3">Spotřební (jídlo, voda, palivo)</td><td class="n">${esc(formatWeight(consumable))}</td></tr>
<tr><td colspan="3">Celková hmotnost</td><td class="n">${esc(formatWeight(base + worn + consumable))}</td></tr>
</tfoot>
</table>`;
}

function foodSection(food: NonNullable<TripReportData['food']>): string {
  const parts: string[] = [];
  if (food.totalKcal !== undefined) parts.push(`<li><b>Energie celkem:</b> ${Math.round(food.totalKcal).toLocaleString('cs-CZ')} kcal</li>`);
  if (food.totalWeightG !== undefined) parts.push(`<li><b>Hmotnost jídla:</b> ${esc(formatWeight(food.totalWeightG))}</li>`);
  const perDay = food.perDay?.length
    ? `<table><thead><tr><th class="n">Den</th><th class="n">Energie</th><th class="n">Hmotnost</th></tr></thead><tbody>${food.perDay
        .map((d) => `<tr><td class="n">${d.day}</td><td class="n">${Math.round(d.kcal).toLocaleString('cs-CZ')} kcal</td><td class="n">${esc(formatWeight(d.weightG))}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  return `<h2>Jídlo</h2><ul>${parts.join('')}</ul>${perDay}${food.notes ? `<p>${esc(food.notes)}</p>` : ''}`;
}

const SEV_LABEL = { danger: 'Vysoké riziko', warning: 'Pozor', info: 'Informace' } as const;

function riskSection(risks: NonNullable<TripReportData['risks']>): string {
  return `<h2>Rizika a upozornění</h2>${risks
    .map(
      (r) => `<div class="box sev-${r.severity}"><b>${SEV_LABEL[r.severity]}: ${esc(r.title)}</b>${r.description ? `<div>${esc(r.description)}</div>` : ''}${
        r.mitigation ? `<div><b>Opatření:</b> ${esc(r.mitigation)}</div>` : ''
      }</div>`,
    )
    .join('\n')}`;
}

function emergencySection(e: NonNullable<TripReportData['emergency']>): string {
  const numbers = [
    { label: 'Evropské tísňové volání', number: '112' },
    { label: 'Horská služba ČR', number: '1210' },
    { label: 'Záchranná služba', number: '155' },
    { label: 'Policie ČR', number: '158' },
    ...(e.numbers ?? []),
  ];
  const contacts = e.contacts?.length
    ? `<h3>Kontakty v nouzi</h3><table><thead><tr><th>Jméno</th><th>Vztah</th><th>Telefon</th></tr></thead><tbody>${e.contacts
        .map((c) => `<tr><td>${esc(c.name)}</td><td>${dash(c.relation)}</td><td>${esc(c.phone)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  return `<h2>Nouzové kontakty a čísla</h2><div class="emergency">
<table><tbody>${numbers.map((n) => `<tr><td>${esc(n.label)}</td><td class="n"><b>${esc(n.number)}</b></td></tr>`).join('')}</tbody></table>
${contacts}
${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
<p class="muted">V horách lze použít aplikaci Záchranka (poloha pro záchranáře). Při volání uveďte přesnou polohu, počet osob a povahu problému.</p>
</div>`;
}

/**
 * Renders the trip report as a complete HTML5 document (A4, print-ready).
 * The output contains no scripts and no external resources.
 */
export function renderTripReportHtml(data: TripReportData): string {
  const s = data.summary;
  const range =
    data.startDate && data.endDate && data.startDate !== data.endDate
      ? `${fmtDate(data.startDate)} – ${fmtDate(data.endDate)}`
      : fmtDate(data.startDate ?? data.endDate);
  const meta: string[] = [];
  if (range) meta.push(`<span><b>Termín:</b> ${esc(range)}</span>`);
  if (data.activityLabel) meta.push(`<span><b>Aktivita:</b> ${esc(data.activityLabel)}</span>`);
  if (data.region) meta.push(`<span><b>Oblast:</b> ${esc(data.region)}</span>`);
  if (data.participants?.length) meta.push(`<span><b>Účastníci:</b> ${data.participants.map(esc).join(', ')}</span>`);

  const stats = [
    stat(formatDistance(s.distanceM), 'Vzdálenost'),
    stat(`+${formatElevation(s.ascentM)}`, 'Stoupání'),
    stat(`−${formatElevation(s.descentM)}`, 'Klesání'),
    stat(String(s.days), s.days === 1 ? 'Den' : s.days >= 2 && s.days <= 4 ? 'Dny' : 'Dní'),
    stat(s.movingTimeMin !== undefined ? formatDuration(s.movingTimeMin) : s.highestPointM !== undefined ? formatElevation(s.highestPointM) : '–', s.movingTimeMin !== undefined ? 'Čistý čas' : 'Nejvyšší bod'),
  ].join('');

  const checklist = data.checklist?.length
    ? `<h2>Kontrolní seznam</h2>${data.checklist
        .map(
          (c) =>
            `<div class="box"><h3>${esc(c.category)}</h3><ul class="check">${c.items.map((i) => `<li${i.done ? ' class="done"' : ''}>${esc(i.text)}</li>`).join('')}</ul></div>`,
        )
        .join('\n')}`
    : '';

  const attribution = data.attribution?.length ? `<p class="muted">${data.attribution.map(esc).join(' · ')}</p>` : '';

  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)} – plán výletu</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<header>
<h1>${esc(data.title)}</h1>
${data.subtitle ? `<p class="subtitle">${esc(data.subtitle)}</p>` : ''}
<div class="meta">${meta.join('')}</div>
</header>
<h2>Shrnutí</h2>
<div class="stats">${stats}</div>
${s.highestPointM !== undefined && s.movingTimeMin !== undefined ? `<p>Nejvyšší bod: <b>${esc(formatElevation(s.highestPointM))}</b></p>` : ''}
${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
<h2>Etapy</h2>
${daysTable(data.days)}
${data.gear?.length ? gearSection(data.gear) : ''}
${data.food ? foodSection(data.food) : ''}
${checklist}
${data.risks?.length ? riskSection(data.risks) : ''}
${emergencySection(data.emergency ?? {})}
<footer>
${attribution}
<p class="muted">Vytvořeno aplikací TrailPack · ${esc(fmtDateTime(data.generatedAt))}. Plán je orientační; před výletem ověřte aktuální podmínky, počasí a místní předpisy.</p>
</footer>
</div>
</body>
</html>
`;
}
