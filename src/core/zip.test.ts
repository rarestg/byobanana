import { describe, expect, test, vi } from "vitest";

import {
  createStoredZip,
  createStoredZipStream,
  MAX_STORED_ZIP_ENTRIES,
  type StoredZipEntry,
} from "./zip";

const decoder = new TextDecoder();

// A pinned archive moment. DOS fields use the Date's LOCAL calendar fields, so the
// expected encodings hold in any timezone: 12:34:56 → 0x645c, 2026-07-23 → 0x5cf7.
const PINNED_DATE = new Date(2026, 6, 23, 12, 34, 56);
const PINNED_DOS = { time: 0x645c, date: 0x5cf7 };

interface ParsedEntry {
  bytes: Uint8Array;
  centralCrc32: number;
  centralOffset: number;
  localCrc32: number;
  name: string;
}

// The DOS (time, date) pair from the FIRST entry's local file header.
function dosFields(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  return { time: view.getUint16(10, true), date: view.getUint16(12, true) };
}

function parseZip(bytes: Uint8Array, dos = PINNED_DOS) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = bytes.length - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
  expect(view.getUint16(endOffset + 4, true)).toBe(0);
  expect(view.getUint16(endOffset + 6, true)).toBe(0);
  const entryCount = view.getUint16(endOffset + 8, true);
  expect(view.getUint16(endOffset + 10, true)).toBe(entryCount);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  expect(view.getUint16(endOffset + 20, true)).toBe(0);
  expect(centralOffset + centralSize).toBe(endOffset);

  const entries: ParsedEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(view.getUint16(offset + 4, true)).toBe(0x0314);
    expect(view.getUint16(offset + 6, true)).toBe(20);
    expect(view.getUint16(offset + 8, true)).toBe(0x0800);
    expect(view.getUint16(offset + 10, true)).toBe(0);
    expect(view.getUint16(offset + 12, true)).toBe(dos.time);
    expect(view.getUint16(offset + 14, true)).toBe(dos.date);
    const centralCrc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    expect(view.getUint32(offset + 24, true)).toBe(compressedSize);
    const nameLength = view.getUint16(offset + 28, true);
    expect(view.getUint16(offset + 30, true)).toBe(0);
    expect(view.getUint16(offset + 32, true)).toBe(0);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(view.getUint16(localOffset + 6, true)).toBe(0x0800);
    expect(view.getUint16(localOffset + 8, true)).toBe(0);
    expect(view.getUint16(localOffset + 10, true)).toBe(dos.time);
    expect(view.getUint16(localOffset + 12, true)).toBe(dos.date);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    expect(view.getUint32(localOffset + 18, true)).toBe(compressedSize);
    expect(view.getUint32(localOffset + 22, true)).toBe(compressedSize);
    const localNameLength = view.getUint16(localOffset + 26, true);
    expect(view.getUint16(localOffset + 28, true)).toBe(0);
    expect(
      decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)),
    ).toBe(name);
    const dataOffset = localOffset + 30 + localNameLength;
    entries.push({
      bytes: bytes.slice(dataOffset, dataOffset + compressedSize),
      centralCrc32,
      centralOffset: offset,
      localCrc32,
      name,
    });
    offset += 46 + nameLength;
  }
  expect(offset).toBe(endOffset);
  return entries;
}

describe("stored ZIP writer (deterministic for a given entries + date)", () => {
  test("preserves ordered UTF-8 names and bytes with the supplied timestamp and valid CRC-32", () => {
    const entries = [
      { name: "01-icon.png", bytes: new Uint8Array() },
      { name: "nested/02-éclair.webp", bytes: new TextEncoder().encode("123456789") },
    ];
    // CRC-32 of "" is 0x00000000; CRC-32 of "123456789" is the canonical 0xcbf43926.
    const expectedCrc32 = [0x00000000, 0xcbf43926];

    const first = createStoredZip(entries, PINNED_DATE);
    const second = createStoredZip(entries, PINNED_DATE);
    expect(first).toEqual(second);

    const parsed = parseZip(first);
    expect(parsed.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    expect(parsed.map((entry) => entry.bytes)).toEqual(entries.map((entry) => entry.bytes));
    expect(parsed[0].centralOffset).toBeLessThan(parsed[1].centralOffset);
    for (const [index, entry] of parsed.entries()) {
      expect(entry.localCrc32).toBe(expectedCrc32[index]);
      expect(entry.centralCrc32).toBe(expectedCrc32[index]);
    }
    expect(parsed[1].centralCrc32).toBe(0xcbf43926);
  });

  test("streams byte-identical output in bounded chunks", async () => {
    const entries = [
      { name: "large.bin", bytes: new Uint8Array(150 * 1024).fill(7) },
      { name: "small.txt", bytes: new TextEncoder().encode("small") },
    ];
    // The same pinned date for both calls — the default is "now", which could straddle the
    // DOS format's 2-second resolution between the two builds.
    const expected = createStoredZip(entries, PINNED_DATE);
    const streamed = createStoredZipStream(entries, PINNED_DATE);
    const reader = streamed.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }

    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(64 * 1024);
    expect(streamed.byteLength).toBe(expected.length);
    const actual = new Uint8Array(streamed.byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.length;
    }
    expect(actual).toEqual(expected);
  });

  test("encodes DOS date/time at 2-second resolution and clamps to the format's range", () => {
    const entry = [{ name: "a.png", bytes: new Uint8Array() }];
    // Odd seconds + milliseconds floor to the same 2-second slot.
    expect(dosFields(createStoredZip(entry, new Date(2026, 6, 23, 12, 34, 57, 999)))).toEqual(
      PINNED_DOS,
    );
    // Pre-1980 clamps to the DOS epoch (1980-01-01 00:00:00)...
    expect(dosFields(createStoredZip(entry, new Date(1979, 11, 31, 23, 59, 59)))).toEqual({
      time: 0x0000,
      date: 0x0021,
    });
    // ...and post-2107 to the format's ceiling (2107-12-31 23:59:58).
    expect(dosFields(createStoredZip(entry, new Date(2108, 0, 1)))).toEqual({
      time: 0xbf7d,
      date: 0xff9f,
    });
    expect(() => createStoredZip(entry, new Date(Number.NaN))).toThrow("date is invalid");
  });

  test("stamps the default (archive-build) moment, not the 1980 DOS epoch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_DATE);
    try {
      expect(dosFields(createStoredZip([{ name: "a.png", bytes: new Uint8Array() }]))).toEqual(
        PINNED_DOS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects empty archives, duplicate names, and invalid entry bytes", () => {
    expect(() => createStoredZip([])).toThrow("at least one entry");
    expect(() =>
      createStoredZip([
        { name: "same.png", bytes: new Uint8Array() },
        { name: "same.png", bytes: new Uint8Array([1]) },
      ]),
    ).toThrow("Duplicate ZIP entry name");
    expect(() =>
      createStoredZip([{ name: "invalid.png", bytes: null } as unknown as StoredZipEntry]),
    ).toThrow("Uint8Array");
  });

  test("rejects unsafe, malformed, and overlong names", () => {
    for (const name of [
      "",
      "/absolute.png",
      "C:/absolute.png",
      "C:drive-relative.png",
      "../escape.png",
      "nested/../escape.png",
      "nested/./file.png",
      "nested//file.png",
      "nested/",
      "back\\slash.png",
      "nul\0byte.png",
      "bad-\ud800.png",
    ]) {
      expect(() => createStoredZip([{ name, bytes: new Uint8Array() }])).toThrow(
        "safe relative UTF-8 path",
      );
    }
    expect(() => createStoredZip([{ name: "x".repeat(0x10000), bytes: new Uint8Array() }])).toThrow(
      "too long",
    );
  });

  test("rejects entry counts that require Zip64", () => {
    const entries = Array.from({ length: MAX_STORED_ZIP_ENTRIES + 1 }, (_unused, index) => ({
      name: `${index}.png`,
      bytes: new Uint8Array(),
    }));
    expect(() => createStoredZip(entries)).toThrow(`at most ${MAX_STORED_ZIP_ENTRIES}`);
  });
});
