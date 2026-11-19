import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Trophy = { id: number; name: string; description: string; tier: string; secret: boolean };
type Read = { at: string; slot?: string; players_tracked: number; rates: (number | null)[] };
type Case = {
  at: string;
  target: string;
  horizon_minutes: number;
  game: { release_date: string };
  trophies: Trophy[];
  history: Read[];
};
type Snapshot = { hour: number; players: number; rates: (number | null)[] };
type Observation = { hour: number; players: number; rate: number };

const hourMs = 3_600_000;
const levels = [0.05, 0.25, 0.5, 0.75, 0.95];
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, x));
const logit = (rate: number) => {
  const p = clamp(rate / 100, 0.0001, 0.9999);
  return Math.log(p / (1 - p));
};
const percent = (logOdds: number) => 100 / (1 + Math.exp(-logOdds));
const time = (hour: number) => Math.log1p(Math.max(0, hour) / 4);

function group(trophy: Trophy): string {
  const text = trophy.description.toLowerCase();
  if (trophy.tier === 'platinum' || text.includes('100% completion')) return 'completion';
  if (/^complete chapter 1\b/.test(text)) return 'early-story';
  if (/^complete chapter|^complete the final mission\.?$/.test(text)) return 'late-story';
  if (/^complete .* for |mission strands/.test(text)) return 'side-story';
  if (/collectible|every (?:spot|location)|discover \d+|at \d+ locations/.test(text)) return 'collection';
  if (/\b\d{2,}\s|\ball .*challenges/.test(text)) return 'grind';
  if (trophy.secret && /^complete /.test(text)) return 'story-mission';
  return trophy.secret ? 'hidden' : trophy.tier;
}

// Approximate time scales for new cohorts to reach different kinds of goals.
const progression: Record<string, { hours: number; lift: number; coldSlope: number }> = {
  completion: { hours: 70, lift: 1.15, coldSlope: 0.02 },
  collection: { hours: 42, lift: 0.74, coldSlope: 0.13 },
  grind: { hours: 40, lift: 0.68, coldSlope: 0.12 },
  'late-story': { hours: 34, lift: 0.75, coldSlope: 0.18 },
  'side-story': { hours: 26, lift: 0.48, coldSlope: 0.23 },
  'story-mission': { hours: 23, lift: 0.53, coldSlope: 0.34 },
  'early-story': { hours: 6, lift: 0.24, coldSlope: 0.95 },
};
const defaultProgression = { hours: 14, lift: 0.30, coldSlope: 0.42 };

function snapshots(history: Read[], launch: number, checkpoint: number): Snapshot[] {
  const unique: Snapshot[] = [];
  for (const read of history) {
    const stamp = Date.parse(read.slot ?? read.at);
    if (!Number.isFinite(stamp) || stamp > checkpoint) continue;
    const previous = unique.at(-1);
    const rates = read.rates;
    if (previous && previous.players === read.players_tracked && rates.length === previous.rates.length &&
        rates.every((rate, index) => rate === previous.rates[index])) continue;
    unique.push({ hour: (stamp - launch) / hourMs, players: read.players_tracked, rates });
  }
  return unique;
}

function observations(history: Snapshot[], index: number): Observation[] {
  const points: Observation[] = [];
  for (const read of history) {
    const rate = read.rates[index];
    if (typeof rate === 'number' && Number.isFinite(rate)) {
      points.push({ hour: read.hour, players: read.players, rate: clamp(rate, 0, 100) });
    }
  }
  return points;
}

function fit<T extends { hour: number }>(points: T[], anchor: T, transform: (point: T) => number, memory = 25) {
  const last = transform(anchor);
  let weight = 0;
  let cross = 0;
  let squares = 0;
  for (const point of points) {
    const age = anchor.hour - point.hour;
    const recency = Math.exp(-age / memory);
    const dx = time(point.hour) - time(anchor.hour);
    const dy = clamp(transform(point) - last, -5, 5);
    weight += recency * dx * dx;
    cross += recency * dx * dy;
    squares += recency * dy * dy;
  }
  const slope = clamp(cross / Math.max(weight, 0.000001), -6, 6);
  const noise = Math.sqrt(Math.max(0, squares - 2 * slope * cross + slope * slope * weight) /
    Math.max(1, points.length - 1));
  return { slope, weight, noise };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimatedEarners(point: Observation): number {
  const count = point.players * point.rate / 100;
  const rounding = point.players * 0.00005;
  const low = Math.max(0, Math.ceil(count - rounding));
  const high = Math.floor(count + rounding);
  return low === high ? low : count;
}

const logEarners = (point: Observation) => Math.log(0.35 + estimatedEarners(point));

function playerGrowth(history: Snapshot[], anchor: Observation, targetHour: number): number {
  const players = history.filter(point => point.players > 0 && point.hour <= anchor.hour);
  const last = players.at(-1);
  const hours = Math.max(0, targetHour - anchor.hour);
  if (!last || anchor.players <= 0) return 0;
  const distinct = players.filter((point, index) => !index || players[index - 1].players !== point.players);
  const fitPlayers = fit(distinct, last, point => Math.log(point.players));
  const recent = fit(distinct.filter(point => last.hour - point.hour <= 22), last, point => Math.log(point.players));
  const age = Math.max(0, anchor.hour);
  const coldGrowth = Math.log1p(0.85 * hours / (1 + age / 10));
  const localWeight = 0.8 * recent.weight / (recent.weight + 0.055);
  const slope = (1 - localWeight) * fitPlayers.slope + localWeight * recent.slope;
  const empiricalGrowth = clamp(slope, -0.12, 2.2) * 0.88 * (time(targetHour) - time(anchor.hour));
  const information = fitPlayers.weight / (fitPlayers.weight + 0.1);
  return information * empiricalGrowth + (1 - information) * coldGrowth;
}

function freezeChance(history: Snapshot[], checkpointHour: number, horizon: number): number {
  const last = history.at(-1);
  if (!last) return 0;
  const gaps = history.slice(1).map((point, i) => point.hour - history[i].hour).filter(gap => gap > 0);
  const typical = gaps.length ? clamp(1.2 * median(gaps), 0.45, 10) : 3.7;
  const stale = Math.max(0, checkpointHour - last.hour);
  return Math.exp(-horizon * (2 * stale + horizon) / (typical * typical));
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI) * t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x < 0 ? tail : 1 - tail;
}

function mixtureQuantiles(location: number, lowerSpread: number, upperSpread: number,
  lastRate: number, freeze: number): number[] {
  const old = logit(lastRate);
  const below = (1 - freeze) * normalCdf((old - location) / (old < location ? lowerSpread : upperSpread));
  return levels.map(level => {
    if (freeze > 0 && level >= below && level <= below + freeze) return lastRate;
    const weight = level <= below ? level : level - freeze;
    let low = -10;
    let high = 10;
    for (let i = 0; i < 32; i++) {
      const guess = (low + high) / 2;
      if ((1 - freeze) * normalCdf(guess) < weight) low = guess;
      else high = guess;
    }
    const z = (low + high) / 2;
    const candidate = Number(percent(location + (z < 0 ? lowerSpread : upperSpread) * z).toPrecision(5));
    if (freeze === 0) return candidate;
    return level < below ? Math.min(candidate, lastRate) : Math.max(candidate, lastRate);
  });
}

function forecast(input: Case) {
  const checkpoint = Date.parse(input.at);
  const target = Date.parse(input.target);
  const launch = Date.parse(input.game.release_date);
  const checkpointHour = (checkpoint - launch) / hourMs;
  const targetHour = Number.isFinite(target) ? (target - launch) / hourMs : checkpointHour + input.horizon_minutes / 60;
  const horizon = Math.max(0, targetHour - checkpointHour);
  const history = snapshots(input.history, launch, checkpoint);
  const freeze = freezeChance(history, checkpointHour, horizon);
  const models = input.trophies.map((trophy, index) => {
    const points = observations(history, index);
    const anchor = points.at(-1) ?? { hour: checkpointHour, rate: 0.01, players: 0 };
    const countPoints = points.filter(point => point.players > 0);
    const countFit = fit(countPoints, anchor, logEarners);
    const recentCountFit = fit(countPoints.filter(point => anchor.hour - point.hour <= 24), anchor, logEarners, 14);
    const rateFit = fit(points, anchor, point => logit(point.rate));
    return { trophy, anchor, kind: group(trophy), countFit, recentCountFit, rateFit, observed: points.length > 0 };
  });
  const slopePools = new Map<string, number[]>();
  const ratePools = new Map<string, number[]>();
  for (const model of models) {
    if (!model.observed || model.anchor.rate >= 98) continue;
    const rates = ratePools.get(model.kind) ?? [];
    rates.push(model.anchor.rate);
    ratePools.set(model.kind, rates);
    if (model.countFit.weight >= 0.015) {
      const slopes = slopePools.get(model.kind) ?? [];
      slopes.push(model.countFit.slope);
      slopePools.set(model.kind, slopes);
    }
  }
  const groupSlopes = new Map([...slopePools].filter(([, values]) => values.length >= 2)
    .map(([kind, values]) => [kind, median(values)]));
  const groupRates = new Map([...ratePools].map(([kind, values]) => [kind, median(values)]));
  const upperGroupRates = new Map([...ratePools].map(([kind, values]) => {
    const ordered = [...values].sort((a, b) => a - b);
    return [kind, ordered[Math.floor(0.75 * (ordered.length - 1))]];
  }));
  const allSlopes = [...slopePools.values()].flat();
  const globalSlope = allSlopes.length ? median(allSlopes) : undefined;
  const allRates = [...ratePools.values()].flat();
  const typicalRate = allRates.length ? median(allRates) : 0;
  const growthByHour = new Map<number, number>();
  return models.map(model => {
    const { trophy, anchor, kind, countFit, recentCountFit, rateFit, observed } = model;
    const stage = progression[kind] ?? defaultProgression;
    const prior = groupSlopes.get(kind) ?? globalSlope ?? stage.coldSlope;
    const information = countFit.weight / (countFit.weight + 0.15);
    const localWeight = 0.72 * recentCountFit.weight / (recentCountFit.weight + 0.045);
    const individual = (1 - localWeight) * countFit.slope + localWeight * recentCountFit.slope;
    const trend = clamp(information * individual + (1 - information) * prior, 0, 5);
    const elapsed = Math.max(0, time(targetHour) - time(anchor.hour));
    const last = logit(observed ? anchor.rate : groupRates.get(kind) ?? 0.03);
    if (anchor.players > 0 && !growthByHour.has(anchor.hour)) {
      growthByHour.set(anchor.hour, playerGrowth(history, anchor, targetHour));
    }
    const growth = growthByHour.get(anchor.hour) ?? 0;
    const maturity = (hour: number) => Math.log1p((Math.max(0, hour) / stage.hours) ** 2);
    const development = Math.max(0, maturity(targetHour) - maturity(anchor.hour));
    const lateGain = stage.lift * development * horizon / (horizon + 24) / (1 + trend);
    const gain = 2.2 * Math.log1p(0.78 * trend * elapsed / 2.2) + lateGain;
    const count = clamp(estimatedEarners(anchor), 0, anchor.players);
    const countOdds = Math.log((count + 0.35) / (anchor.players - count + 0.35));
    const extrapolatedShare = anchor.players > 0 ? percent(countOdds + gain - growth) : percent(last);
    // Peer attainment supplies a small late-unlock contribution when direct counts are sparse.
    const relatedRate = Math.max(upperGroupRates.get(kind) ?? 0, 0.2 * typicalRate,
      (groupRates.get('early-story') ?? 0) * (kind === 'late-story' ? 0.12 : 0.012));
    const latentShare = relatedRate * 0.16 * development / (1 + development) *
      (horizon / (horizon + 36)) ** 2 / (1 + trend);
    const share = extrapolatedShare + latentShare * (1 - extrapolatedShare / 100);
    const countLocation = logit(share);
    const rateLocation = last + 0.65 * rateFit.slope * elapsed;
    const location = anchor.rate >= 98 ? rateLocation : 0.88 * countLocation + 0.12 * rateLocation;
    const spread = Math.hypot(0.12, 0.55 * Math.sqrt(horizon / 24), 0.60 * countFit.noise,
      (1 - information) * (0.32 * elapsed + 0.20 * growth), observed ? 0 : 1.1);
    const upper = Math.hypot(spread, stage.lift * development * horizon / (horizon + 24));
    const q = mixtureQuantiles(location, spread, upper, anchor.rate, observed ? freeze : 0);
    return { id: trophy.id, q };
  });
}

function encode(rows: ReturnType<typeof forecast>): string {
  let result = JSON.stringify({ trophies: rows });
  for (const decimals of [4, 3, 2, 1, 0]) {
    if (Buffer.byteLength(result) <= 65_536) break;
    result = JSON.stringify({ trophies: rows.map(({ id, q }) => ({ id, q: q.map(rate => Number(rate.toFixed(decimals))) })) });
  }
  return result;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outputDir, { recursive: true });
for (const file of readdirSync(inputDir).filter(name => name.endsWith('.in')).sort()) {
  const input: Case = JSON.parse(readFileSync(join(inputDir, file), 'utf8'));
  writeFileSync(join(outputDir, `${file.slice(0, -3)}.out`), encode(forecast(input)));
}
