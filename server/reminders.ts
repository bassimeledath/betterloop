import { z } from "zod";
export const reminderPolicy = z
  .array(z.number().int().min(1).max(168))
  .max(3)
  .refine(
    (a) => new Set(a).size === a.length,
    "Choose different reminder times.",
  );
export const offsets = (json?: string): number[] =>
  json ? JSON.parse(json) : [48];
export const reminderTime = (deadline: number, hours?: number) =>
  hours === undefined ? Number.MAX_SAFE_INTEGER : deadline - hours * 3600000;
