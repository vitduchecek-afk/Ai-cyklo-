/**
 * Power planning for electronics on multi-day trips.
 *
 * Model: every device draws `dailyWh` per day (use + standby). The device's
 * own battery covers the first part (between its start charge and the
 * minimum end charge); the rest is delivered by power banks with a
 * charging efficiency (default 0.65 – cable and conversion losses). Cold
 * reduces usable battery capacity (see {@link coldCapacityFactor}).
 * Outlet days recharge devices and power banks.
 */
import type { Advisory, DeviceType } from '@trailpack/shared';
import { advisory, interpolate, r, requireInt, requireNumber } from './internal';

/** Convert mAh at a voltage to Wh. @param mah capacity, mAh @param voltage nominal voltage, V (default 3.7) */
export function mahToWh(mah: number, voltage = 3.7): number {
  requireNumber('mah', mah);
  requireNumber('voltage', voltage, 0.1, 100);
  return (mah * voltage) / 1000;
}

/**
 * Usable fraction of Li-ion capacity at a temperature (documented
 * orientational table: 20 °C → 1.0, 10 °C → 0.95, 0 °C → 0.9, −10 °C → 0.8,
 * −20 °C → 0.65, −30 °C → 0.5; linear in between).
 * @param tempC ambient/battery temperature, °C
 */
export function coldCapacityFactor(tempC: number): number {
  return interpolate(
    [
      [-30, 0.5],
      [-20, 0.65],
      [-10, 0.8],
      [0, 0.9],
      [10, 0.95],
      [20, 1],
    ],
    tempC,
  );
}

export interface PowerDevice {
  name: string;
  type: DeviceType;
  capacityWh?: number;
  capacityMah?: number;
  /** Nominal voltage, V (default 3.7). */
  nominalVoltage?: number;
  /** Battery percent consumed per hour of use. */
  drainPctPerHour?: number;
  /** Average draw in use, W. */
  drawW?: number;
  hoursPerDay: number;
  /** Standby drain, percent of battery per day. */
  standbyPctPerDay?: number;
  /** Charge at the start of the trip, percent (default 100). */
  startChargePct?: number;
  /** Minimum charge to keep at the end, percent (default 20). */
  minEndChargePct?: number;
}

export interface Powerbank {
  name: string;
  capacityMah?: number;
  capacityWh?: number;
  nominalVoltage?: number;
}

export interface PowerPlanInput {
  days: number;
  devices: PowerDevice[];
  powerbanks: Powerbank[];
  /** Power bank → device energy efficiency (default 0.65). */
  chargingEfficiency?: number;
  /** Expected minimum temperature, °C (activates cold derating). */
  minTempC?: number;
  /** Zero-based day indexes with access to an outlet (evening recharge of devices and power banks). */
  outletDays?: number[];
}

export interface PowerPerDevice {
  name: string;
  /** Energy needed per day, Wh. */
  dailyWh: number;
  /** Energy needed for the trip, Wh. */
  tripWh: number;
  /** Covered by the device's own battery, Wh. */
  fromOwnBatteryWh: number;
  /** To be delivered by power banks (device side), Wh. */
  fromPowerbankWh: number;
}

export interface PowerPlanResult {
  /** Energy required from power banks (bank side, incl. charging losses; worst stretch between outlets), Wh. */
  neededWh: number;
  /** Usable power bank energy after cold derating, Wh. */
  availableWh: number;
  reserveWh: number;
  /** Reserve relative to the need, percent (100 when nothing is needed). */
  reservePct: number;
  sufficient: boolean;
  perDevice: PowerPerDevice[];
  /** Recommended total power bank capacity at 3.7 V, mAh (0 when none is needed). */
  recommendedPowerbankMah: number;
  /** Power bank energy left at the end of each day (zero-based `day`), Wh; may be negative when the plan runs short. */
  dayByDay: Array<{ day: number; powerbankRemainingWh: number }>;
  advisories: Advisory[];
  /** Czech tips for saving energy. */
  savingTips: string[];
}

const POWERBANK_SIZES_MAH = [5000, 10000, 15000, 20000, 26800];

interface DeviceModel {
  dev: PowerDevice;
  capWh: number | undefined;
  dailyWh: number;
  ownWh: number;
}

/**
 * Build a power plan. Devices without capacity and consumption data (no
 * `drawW` and no capacity with a drain figure) cannot be computed and are
 * reported through an advisory with zero consumption.
 */
export function calculatePowerPlan(input: PowerPlanInput): PowerPlanResult {
  const days = requireInt('days', input.days, 1, 365);
  const eff = requireNumber('chargingEfficiency', input.chargingEfficiency ?? 0.65, 0.3, 1);
  const derate = input.minTempC !== undefined ? coldCapacityFactor(requireNumber('minTempC', input.minTempC, -80, 60)) : 1;
  const outlets = new Set((input.outletDays ?? []).map((d) => requireInt('outletDays', d, 0, 365)));
  const advisories: Advisory[] = [];

  const models: DeviceModel[] = input.devices.map((dev) => {
    const hours = requireNumber(`${dev.name}.hoursPerDay`, dev.hoursPerDay, 0, 24);
    const v = dev.nominalVoltage ?? 3.7;
    const capWh = dev.capacityWh ?? (dev.capacityMah !== undefined ? mahToWh(dev.capacityMah, v) : undefined);
    const startPct = requireNumber(`${dev.name}.startChargePct`, dev.startChargePct ?? 100, 0, 100);
    const minEnd = requireNumber(`${dev.name}.minEndChargePct`, dev.minEndChargePct ?? 20, 0, 100);
    let useWh: number | undefined;
    if (dev.drawW !== undefined) useWh = requireNumber(`${dev.name}.drawW`, dev.drawW) * hours;
    else if (dev.drainPctPerHour !== undefined && capWh !== undefined) useWh = (requireNumber(`${dev.name}.drainPctPerHour`, dev.drainPctPerHour, 0, 100) / 100) * capWh * hours;
    const standby = capWh !== undefined && dev.standbyPctPerDay !== undefined ? (requireNumber(`${dev.name}.standbyPctPerDay`, dev.standbyPctPerDay, 0, 100) / 100) * capWh : 0;
    if (useWh === undefined) {
      advisories.push(
        advisory('power_device_data_missing', 'warning', `U zařízení „${dev.name}“ chybí údaj o spotřebě (příkon ve W, nebo kapacita se spotřebou v %/h) – do plánu se nezapočítalo.`, {
          params: { device: dev.name },
          action: 'Doplňte příkon nebo kapacitu baterie a spotřebu.',
        }),
      );
      useWh = 0;
    }
    const ownWh = capWh !== undefined ? capWh * derate * (Math.max(0, startPct - minEnd) / 100) : 0;
    return { dev, capWh, dailyWh: useWh + standby, ownWh };
  });

  const bankFullWh = input.powerbanks.reduce((acc, b) => {
    const v = b.nominalVoltage ?? 3.7;
    const wh = b.capacityWh ?? (b.capacityMah !== undefined ? mahToWh(b.capacityMah, v) : 0);
    if (wh > 100) {
      advisories.push(
        advisory('powerbank_over_100wh', 'warning', `Powerbanka „${b.name}“ má ${r(wh)} Wh – nad limit 100 Wh pro přepravu v letadle (ruční zavazadlo).`, {
          params: { powerbank: b.name, wh: r(wh) },
          action: 'Při letu zvolte powerbanku do 100 Wh.',
        }),
      );
    }
    return acc + wh;
  }, 0);
  const availableWh = bankFullWh * derate;

  // Segments between outlets: outlet at the evening of day d recharges everything for day d+1.
  const segments: Array<{ start: number; len: number }> = [];
  let segStart = 0;
  for (let d = 0; d < days; d++) {
    if (outlets.has(d) || d === days - 1) {
      segments.push({ start: segStart, len: d - segStart + 1 });
      segStart = d + 1;
    }
  }

  const perDevice: PowerPerDevice[] = models.map((m) => ({ name: m.dev.name, dailyWh: r(m.dailyWh, 1), tripWh: r(m.dailyWh * days, 1), fromOwnBatteryWh: 0, fromPowerbankWh: 0 }));
  let neededWh = 0;
  const dayRemaining: number[] = new Array<number>(days).fill(0);
  const fromOwn = models.map(() => 0);
  const fromBank = models.map(() => 0);
  for (const seg of segments) {
    let segDraw = 0;
    models.forEach((m, i) => {
      const segWh = m.dailyWh * seg.len;
      const own = Math.min(segWh, m.ownWh);
      fromOwn[i]! += own;
      fromBank[i]! += segWh - own;
      segDraw += (segWh - own) / eff;
    });
    neededWh = Math.max(neededWh, segDraw);
    for (let k = 1; k <= seg.len; k++) {
      let cumDraw = 0;
      for (const m of models) cumDraw += Math.max(0, m.dailyWh * k - m.ownWh) / eff;
      dayRemaining[seg.start + k - 1] = availableWh - cumDraw;
    }
  }
  perDevice.forEach((p, i) => {
    p.fromOwnBatteryWh = r(fromOwn[i]!, 1);
    p.fromPowerbankWh = r(fromBank[i]!, 1);
  });
  // Outlet evening: power banks are full again at the end of that day.
  const dayByDay = dayRemaining.map((rem, day) => ({ day, powerbankRemainingWh: r(outlets.has(day) && day < days - 1 ? availableWh : rem, 1) }));

  const reserveWh = availableWh - neededWh;
  const reservePct = neededWh > 0 ? (reserveWh / neededWh) * 100 : 100;
  const sufficient = reserveWh >= 0;
  const requiredRatedWh = neededWh / derate;
  const requiredMah = (requiredRatedWh * 1.15 * 1000) / 3.7;
  let recommended = 0;
  if (requiredMah > 0) {
    recommended = POWERBANK_SIZES_MAH.find((s) => s >= requiredMah) ?? Math.ceil(requiredMah / 26800) * 26800;
  }

  if (!sufficient) {
    const runOut = dayByDay.find((d) => d.powerbankRemainingWh < 0);
    advisories.push(
      advisory('power_shortfall', 'danger', `Kapacita powerbank nestačí: chybí ${r(-reserveWh, 1)} Wh${runOut ? `, energie dojde zhruba v ${runOut.day + 1}. dni` : ''}.`, {
        params: { shortfallWh: r(-reserveWh, 1) },
        basis: [`potřeba ${r(neededWh, 1)} Wh`, `k dispozici ${r(availableWh, 1)} Wh`, `účinnost nabíjení ${eff}`],
        action: `Vezměte powerbanku s celkovou kapacitou alespoň ${recommended} mAh (při 3,7 V), snižte používání nebo plánujte dobíjení.`,
        uncertainty: 'Skutečná spotřeba závisí na signálu, jasu displeje a teplotě.',
      }),
    );
  } else if (neededWh > 0 && reservePct < 20) {
    advisories.push(
      advisory('power_low_reserve', 'warning', `Rezerva energie je jen ${r(reservePct)} % – při chladu nebo intenzivnějším používání může dojít.`, {
        params: { reservePct: r(reservePct) },
        action: 'Přibalte větší powerbanku nebo omezte spotřebu.',
        uncertainty: 'Odhad spotřeby může být ±30 %.',
      }),
    );
  }
  if (derate < 1) {
    advisories.push(
      advisory('power_cold_derating', derate <= 0.8 ? 'warning' : 'info', `Při ${r(input.minTempC ?? 0)} °C je použitelná kapacita baterií cca ${r(derate * 100)} % jmenovité.`, {
        params: { factor: r(derate, 2), minTempC: input.minTempC ?? null },
        action: 'Noste baterie a telefon blízko těla, v noci je dejte do spacáku.',
        uncertainty: 'Tabulka je orientační; skutečný pokles závisí na typu článků.',
      }),
    );
  }

  const savingTips = [
    'Zapněte režim v letadle nebo omezte síť, když nemáte signál – hledání sítě vybíjí telefon nejvíc.',
    'Stáhněte offline mapy a snižte jas displeje; mapu zapínejte jen při orientaci.',
    'Záznam GPS nastavte na interval 3–5 s a vypněte nepoužívané funkce (Bluetooth, Wi-Fi).',
    'Používejte čelovku v nižším režimu a displej hodinek v úsporném režimu.',
    'Za chladu držte baterie a telefon v teple (vnitřní kapsa, spacák).',
  ];
  if (outlets.size === 0 && days > 2) savingTips.push('Využijte zásuvku v chatě, kempu nebo hospodě k dobití powerbanky.');

  return {
    neededWh: r(neededWh, 1),
    availableWh: r(availableWh, 1),
    reserveWh: r(reserveWh, 1),
    reservePct: r(reservePct, 1),
    sufficient,
    perDevice,
    recommendedPowerbankMah: recommended,
    dayByDay,
    advisories,
    savingTips,
  };
}
