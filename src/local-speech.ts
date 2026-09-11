import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Reassemble Opus packets, including packets spanning Ogg pages. */
export function parseOggOpus(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let pending: Buffer[] = [];
  let offset = 0;
  let headers = 0;
  while (offset < data.length) {
    if (offset + 27 > data.length || data.toString("ascii", offset, offset + 4) !== "OggS")
      throw new Error("Invalid Ogg page");
    const count = data[offset + 26]!;
    if (offset + 27 + count > data.length) throw new Error("Truncated Ogg lacing");
    let cursor = offset + 27 + count;
    for (let i = 0; i < count; i++) {
      const size = data[offset + 27 + i]!;
      if (cursor + size > data.length) throw new Error("Truncated Ogg payload");
      pending.push(data.subarray(cursor, cursor + size));
      cursor += size;
      if (size < 255) {
        const packet = Buffer.concat(pending);
        pending = [];
        if (headers === 0) {
          if (packet.toString("ascii", 0, 8) !== "OpusHead" || packet[9] !== 1)
            throw new Error("Expected mono Opus stream");
          headers++;
        } else if (headers === 1) {
          if (packet.toString("ascii", 0, 8) !== "OpusTags") throw new Error("Missing Opus tags");
          headers++;
        } else {
          if (packet.length === 0 || packet.length > 1275) throw new Error("Invalid Opus packet size");
          packets.push(packet);
        }
      }
    }
    offset = cursor;
  }
  if (pending.length || !packets.length) throw new Error("Incomplete Opus stream");
  return packets;
}

export async function synthesizeLocalSpeech(text: string, sampleRate = 24000): Promise<Buffer[]> {
  const normalized = text.replace(/[`*_#]/g, "").trim().slice(0, 600);
  if (!normalized) throw new Error("播报内容不能为空");
  const directory = await mkdtemp(join(tmpdir(), "workbuddy-speech-"));
  try {
    const wave = join(directory, "speech.wav");
    const ogg = join(directory, "speech.ogg");
    const request = join(directory, "request.json");
    await writeFile(request, JSON.stringify({ text: normalized, output: wave, rate: sampleRate === 24000 ? 2 : 0 }), "utf8");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      resolve("scripts/synthesize-speech.ps1"), "-RequestFile", request], { windowsHide: true, timeout: 90000 });
    await run(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wave,
      "-ac", "1", "-ar", String(sampleRate), "-c:a", "libopus", "-b:a", "24k", "-application", "voip",
      "-frame_duration", "60", ogg], { windowsHide: true, timeout: 30000 });
    return parseOggOpus(await readFile(ogg));
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("workbuddy-speech-"))
      throw new Error("Unexpected speech temporary path");
    await rm(target, { recursive: true, force: true });
  }
}
