// Ported from nano-banana-2 @ 54e0224 — src/workbench/zip.ts
// Dependency-free stored ZIP (TextEncoder/DataView/Uint8Array). One local change from the
// source: entries are stamped with a real modified date (the source wrote the zeroed DOS
// epoch, so extracted files all read "Jan 1 1980").

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_VERSION_MADE_BY = 0x0314; // Unix, ZIP 2.0
const STREAM_CHUNK_SIZE = 64 * 1024;

// Encode a Date into the DOS (time, date) header pair: LOCAL time, 2-second resolution,
// years counted from 1980. Dates outside the format's range clamp to its bounds
// (1980-01-01 00:00:00 through 2107-12-31 23:59:58); an invalid Date is rejected.
function dosDateTime(value: Date): { time: number; date: number } {
  if (Number.isNaN(value.getTime())) throw new Error("ZIP archive date is invalid.");
  const year = value.getFullYear();
  if (year < 1980) return { time: 0x0000, date: 0x0021 };
  if (year > 2107) return { time: 0xbf7d, date: 0xff9f };
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | (value.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

export const MAX_STORED_ZIP_ENTRIES = MAX_UINT16 - 1;

export interface StoredZipEntry {
  name: string;
  bytes: Uint8Array;
}

interface PreparedEntry extends StoredZipEntry {
  crc32: number;
  localOffset: number;
  nameBytes: Uint8Array;
}

interface PreparedZip {
  archiveSize: number;
  centralSize: number;
  dosDate: number;
  dosTime: number;
  entries: PreparedEntry[];
  localSize: number;
}

const crc32Table = new Uint32Array(256);
for (let index = 0; index < crc32Table.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crc32Table[index] = value >>> 0;
}

function crc32(bytes: Uint8Array) {
  let value = MAX_UINT32;
  for (const byte of bytes) {
    value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ MAX_UINT32) >>> 0;
}

function invalidName(name: string) {
  if (name.length === 0 || !name.isWellFormed() || name.includes("\0") || name.includes("\\")) {
    return true;
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((part) => !part || part === "." || part === "..");
}

function addSize(total: number, amount: number) {
  const result = total + amount;
  if (!Number.isSafeInteger(result) || result >= MAX_UINT32) {
    throw new Error("ZIP archive exceeds the classic ZIP size limit.");
  }
  return result;
}

function prepareStoredZip(entries: readonly StoredZipEntry[], modifiedAt: Date): PreparedZip {
  const { time: dosTime, date: dosDate } = dosDateTime(modifiedAt);
  if (!entries.length) throw new Error("ZIP archive requires at least one entry.");
  if (entries.length > MAX_STORED_ZIP_ENTRIES) {
    throw new Error(`ZIP archive supports at most ${MAX_STORED_ZIP_ENTRIES} entries.`);
  }

  const encoder = new TextEncoder();
  const names = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let localSize = 0;
  let centralSize = 0;

  for (const entry of entries) {
    if (typeof entry?.name !== "string" || invalidName(entry.name)) {
      throw new Error("ZIP entry name must be a safe relative UTF-8 path.");
    }
    if (names.has(entry.name)) throw new Error(`Duplicate ZIP entry name: ${entry.name}`);
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new Error(`ZIP entry bytes must be a Uint8Array: ${entry.name}`);
    }

    const nameBytes = encoder.encode(entry.name);
    if (nameBytes.length > MAX_UINT16) {
      throw new Error(`ZIP entry name is too long: ${entry.name.slice(0, 80)}`);
    }
    if (entry.bytes.byteLength >= MAX_UINT32) {
      throw new Error(`ZIP entry exceeds the classic ZIP size limit: ${entry.name}`);
    }

    names.add(entry.name);
    prepared.push({
      ...entry,
      crc32: crc32(entry.bytes),
      localOffset: localSize,
      nameBytes,
    });
    localSize = addSize(localSize, LOCAL_FILE_HEADER_SIZE + nameBytes.length);
    localSize = addSize(localSize, entry.bytes.byteLength);
    centralSize = addSize(centralSize, CENTRAL_DIRECTORY_HEADER_SIZE + nameBytes.length);
  }

  return {
    archiveSize: addSize(addSize(localSize, centralSize), END_OF_CENTRAL_DIRECTORY_SIZE),
    centralSize,
    dosDate,
    dosTime,
    entries: prepared,
    localSize,
  };
}

function localHeader(entry: PreparedEntry, zip: PreparedZip) {
  const bytes = new Uint8Array(LOCAL_FILE_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, zip.dosTime, true);
  view.setUint16(12, zip.dosDate, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.bytes.byteLength, true);
  view.setUint32(22, entry.bytes.byteLength, true);
  view.setUint16(26, entry.nameBytes.length, true);
  view.setUint16(28, 0, true);
  return bytes;
}

function centralHeader(entry: PreparedEntry, zip: PreparedZip) {
  const bytes = new Uint8Array(CENTRAL_DIRECTORY_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, ZIP_VERSION_MADE_BY, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, zip.dosTime, true);
  view.setUint16(14, zip.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.bytes.byteLength, true);
  view.setUint32(24, entry.bytes.byteLength, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.localOffset, true);
  return bytes;
}

function endHeader(zip: PreparedZip) {
  const bytes = new Uint8Array(END_OF_CENTRAL_DIRECTORY_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, zip.entries.length, true);
  view.setUint16(10, zip.entries.length, true);
  view.setUint32(12, zip.centralSize, true);
  view.setUint32(16, zip.localSize, true);
  view.setUint16(20, 0, true);
  return bytes;
}

function* storedZipChunks(zip: PreparedZip) {
  for (const entry of zip.entries) {
    yield localHeader(entry, zip);
    yield entry.nameBytes;
    for (let offset = 0; offset < entry.bytes.length; offset += STREAM_CHUNK_SIZE) {
      yield entry.bytes.subarray(offset, offset + STREAM_CHUNK_SIZE);
    }
  }
  for (const entry of zip.entries) {
    yield centralHeader(entry, zip);
    yield entry.nameBytes;
  }
  yield endHeader(zip);
}

// `modifiedAt` stamps every entry's DOS date/time (default: the moment the archive is
// built). Output is fully deterministic for a given (entries, modifiedAt) pair.
export function createStoredZip(entries: readonly StoredZipEntry[], modifiedAt: Date = new Date()) {
  const zip = prepareStoredZip(entries, modifiedAt);
  const output = new Uint8Array(zip.archiveSize);
  let offset = 0;
  for (const chunk of storedZipChunks(zip)) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

export function createStoredZipStream(
  entries: readonly StoredZipEntry[],
  modifiedAt: Date = new Date(),
) {
  const zip = prepareStoredZip(entries, modifiedAt);
  const chunks = storedZipChunks(zip);
  return {
    byteLength: zip.archiveSize,
    stream: new ReadableStream<Uint8Array>({
      cancel() {
        chunks.return();
      },
      pull(controller) {
        const next = chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    }),
  };
}
