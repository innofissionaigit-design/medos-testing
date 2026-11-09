import { Decimal } from "@medos/shared";

export type ObsType =
  | "SYSTOLIC_BP" | "DIASTOLIC_BP" | "PULSE" | "RESPIRATORY_RATE" | "TEMPERATURE" | "SPO2"
  | "WEIGHT" | "HEIGHT" | "BMI" | "BLOOD_GLUCOSE";

export interface ObsMeta { unit: string; min: number; max: number; label: string }

/** Canonical units and hard physiological limits (mirrored by a CHECK constraint in the database). */
export const OBS_META: Record<ObsType, ObsMeta> = {
  SYSTOLIC_BP: { unit: "mmHg", min: 40, max: 300, label: "Systolic BP" },
  DIASTOLIC_BP: { unit: "mmHg", min: 20, max: 200, label: "Diastolic BP" },
  PULSE: { unit: "bpm", min: 20, max: 250, label: "Pulse" },
  RESPIRATORY_RATE: { unit: "/min", min: 4, max: 80, label: "Respiratory rate" },
  TEMPERATURE: { unit: "°C", min: 30, max: 45, label: "Temperature" },
  SPO2: { unit: "%", min: 30, max: 100, label: "SpO2" },
  WEIGHT: { unit: "kg", min: 0.3, max: 400, label: "Weight" },
  HEIGHT: { unit: "cm", min: 20, max: 260, label: "Height" },
  BMI: { unit: "kg/m²", min: 5, max: 120, label: "BMI" },
  BLOOD_GLUCOSE: { unit: "mg/dL", min: 10, max: 1500, label: "Blood glucose" },
};

export const WRITABLE_TYPES = [
  "SYSTOLIC_BP", "DIASTOLIC_BP", "PULSE", "RESPIRATORY_RATE", "TEMPERATURE", "SPO2", "WEIGHT", "HEIGHT", "BLOOD_GLUCOSE",
] as const;

export const fahrenheitToCelsius = (f: number | string): Decimal => new Decimal(f).minus(32).times(5).div(9).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** BMI = kg / m², half-up to 1 decimal place; null when inputs make no sense. */
export function bmi(weightKg: Decimal.Value, heightCm: Decimal.Value): Decimal | null {
  const w = new Decimal(weightKg);
  const h = new Decimal(heightCm).div(100);
  if (!w.isPositive() || !h.isPositive()) return null;
  const v = w.div(h.times(h)).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
  return v.gte(OBS_META.BMI.min) && v.lte(OBS_META.BMI.max) ? v : null;
}

export function inRange(type: ObsType, v: Decimal.Value): boolean {
  const d = new Decimal(v);
  return d.gte(OBS_META[type].min) && d.lte(OBS_META[type].max);
}
