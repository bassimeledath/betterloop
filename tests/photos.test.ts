import { describe, it, expect } from "vitest";
import { cleanJpeg } from "../server/photos";
const segment = (marker: number, body: number[]) => [
  255,
  marker,
  0,
  body.length + 2,
  ...body,
];
const image = (extra: number[] = []) =>
  new Uint8Array([
    255,
    216,
    ...segment(225, [69, 120, 105, 102, 0, 0, 71, 80, 83]),
    ...segment(192, [8, 0, 1, 0, 1, 1, 1, 17, 0]),
    ...segment(218, [1, 1, 0, 0, 63, 0]),
    12,
    13,
    ...extra,
    255,
    217,
  ]);
describe("JPEG validation and privacy", () => {
  it("removes metadata before and between image scans without changing dimensions", () => {
    const raw = image([
      ...segment(225, [69, 120, 105, 102, 0, 0, 71, 80, 83]),
      ...segment(254, [112, 114, 105, 118, 97, 116, 101]),
      ...segment(218, [1, 1, 0, 0, 63, 0]),
      15,
      16,
    ]);
    const clean = cleanJpeg(raw);
    expect(clean.width).toBe(1);
    expect(clean.height).toBe(1);
    expect(new TextDecoder().decode(clean.bytes)).not.toContain("Exif");
    expect(new TextDecoder().decode(clean.bytes)).not.toContain("private");
    expect(clean.bytes.byteLength).toBeLessThan(raw.byteLength);
  });
  it("rejects arbitrary uploads, broken lengths, and oversized dimensions", () => {
    expect(() =>
      cleanJpeg(new TextEncoder().encode("<svg onload=alert(1)>")),
    ).toThrow();
    expect(() => cleanJpeg(image().slice(0, -2))).toThrow();
    const raw = image();
    const marker = raw.findIndex((b, i) => b === 255 && raw[i + 1] === 192);
    raw[marker + 7] = 7;
    raw[marker + 8] = 208;
    expect(() => cleanJpeg(raw)).toThrow("1600");
  });
});
