/**
 * Read DSH session logs.
 *
 * A committed log is either plain JSONL or a Zstandard container holding **one
 * independent frame per append batch** — the host flushes each batch as its own
 * checksummed frame. Node's `zstdDecompressSync` decodes a single frame and
 * fails on the next frame's magic, so the container must be walked frame by
 * frame. {@link scanZstdFrames} does that structurally (block payloads are
 * skipped, never inflated), which keeps memory to one frame at a time and makes
 * a partially written tail frame harmless.
 *
 * @module dsh-session-path/zstd
 */

import { open } from "node:fs/promises";
import zlib from "node:zlib";

/** `ZSTD_MAGICNUMBER`, little-endian in the stream. */
const ZSTD_MAGIC = 0xfd2fb528;

/** How many compressed bytes are pulled from disk per read. */
const READ_CHUNK_BYTES = 1 << 20;

/**
 * Packed增量 rows: the host appends text/reasoning/tool-call deltas as these
 * types. They dominate a log's size and are meaningless to a reader, so parsed
 * records drop them before they can be materialised.
 */
const PACKED_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks", "text-delta", "reasoning-delta"]);

/**
 * Byte ranges of the complete Zstandard frames at the head of `buffer`.
 *
 * Parsing stops at the first byte that is not a frame start (an incomplete tail
 * frame, a corrupt region, or a skippable frame this plugin does not emit), so
 * a truncated log yields its intact prefix instead of throwing.
 *
 * @param buffer - raw container bytes.
 * @returns `{ start, end }[]` in stream order.
 */
export function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return frames;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames;
		offset += 4;
		if (offset === buffer.length) return frames;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) return frames; // reserved bits: structurally invalid
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return frames;
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return frames;
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) return frames; // reserved block type
			// An RLE block stores one byte regardless of its decompressed size.
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return frames;
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return frames;
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return frames;
}

/**
 * Parse one log line, dropping blanks, packed deltas and damaged lines.
 *
 * @param line - one JSONL line.
 * @returns the record, or null when it carries no information.
 */
export function parseRecordLine(line) {
	if (line.length === 0) return null;
	if (line.length > 8 * 1024 * 1024) return null; // giant packed row: skip before JSON.parse
	try {
		const record = JSON.parse(line);
		if (record === null || typeof record !== "object") return null;
		if (PACKED_TYPES.has(record.type)) return null;
		return record;
	} catch {
		return null; // best-effort replay: one damaged line must not kill the file
	}
}

/**
 * Turn a text slice into records, carrying the unfinished tail line forward.
 *
 * @param text - decoded chunk.
 * @param pending - leftover from the previous chunk.
 * @returns the new pending buffer.
 */
function consumeText(text, pending, out) {
	const lines = text.split("\n");
	lines[0] = pending + lines[0];
	const next = lines.pop() ?? "";
	for (const line of lines) {
		const record = parseRecordLine(line);
		if (record !== null) out.push(record);
	}
	return next;
}

/**
 * Walk one session log and yield its records.
 *
 * The file is read in chunks; complete frames found at the head of the working
 * buffer are inflated and released immediately, and everything after the last
 * complete frame stays in a tail buffer for the next chunk. `maxBytes` bounds
 * the compressed bytes read, which is how callers keep a title probe cheap on a
 * multi-hundred-megabyte log.
 *
 * @param file - `session.vN.jsonl.zstd` or `session.jsonl` path.
 * @param options - `{ maxBytes?, onFrame? }`.
 * @yields parsed records in log order.
 */
export async function* readSessionRecords(file, options = {}) {
	const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : Infinity;
	const onFrame = typeof options.onFrame === "function" ? options.onFrame : null;
	const handle = await open(file, "r");
	try {
		const compressed = file.endsWith(".zstd");
		let pending = "";
		let tail = Buffer.alloc(0);
		let read = 0;
		for (;;) {
			const chunk = await handle.read(Buffer.allocUnsafe(READ_CHUNK_BYTES), 0, READ_CHUNK_BYTES, null);
			if (chunk.bytesRead === 0) break;
			read += chunk.bytesRead;
			const slice = chunk.buffer.subarray(0, chunk.bytesRead);
			const data = tail.length > 0 ? Buffer.concat([tail, slice]) : Buffer.from(slice);
			tail = Buffer.alloc(0);
			if (!compressed) {
				const out = [];
				pending = consumeText(data.toString("utf8"), pending, out);
				if (out.length > 0) yield* out;
			} else {
				const frames = scanZstdFrames(data);
				for (const frame of frames) {
					const plain = inflateFrame(data, frame);
					if (plain === null) return;
					onFrame?.(frame.end - frame.start);
					const out = [];
					pending = consumeText(plain, pending, out);
					if (out.length > 0) yield* out;
				}
				const consumed = frames.length > 0 ? frames[frames.length - 1].end : 0;
				tail = Buffer.from(data.subarray(consumed));
				// A full chunk that still yields no frame means the container is
				// damaged; stop rather than buffer the rest of the file forever.
				if (frames.length === 0 && tail.length >= READ_CHUNK_BYTES * 2) return;
			}
			if (read >= maxBytes) break;
		}
		if (!compressed && pending.length > 0) {
			const record = parseRecordLine(pending);
			if (record !== null) yield record;
		}
	} finally {
		await handle.close();
	}
}

/**
 * Inflate one scanned frame, or null when the bytes are damaged.
 *
 * @param data - the working buffer.
 * @param frame - `{ start, end }` from {@link scanZstdFrames}.
 * @returns decoded UTF-8 text.
 */
function inflateFrame(data, frame) {
	try {
		return inflate(data.subarray(frame.start, frame.end));
	} catch {
		return null;
	}
}

/** Decode one complete Zstandard frame (absent on exotic runtimes). */
function inflate(bytes) {
	if (typeof zlib.zstdDecompressSync !== "function") throw new Error("zstd is unavailable on this runtime");
	return zlib.zstdDecompressSync(bytes).toString("utf8");
}
