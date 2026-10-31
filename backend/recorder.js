import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import opus from "@discordjs/opus";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";
import { EndBehaviorType, VoiceConnectionStatus } from "@discordjs/voice";

// Discord voice is 48kHz Opus; we decode straight to mono signed 16-bit PCM (plenty for speech)
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const BYTES_PER_FRAME = 2 * CHANNELS; // one sample for every channel
// Only pad silence when the gap is bigger than ~60ms, so network jitter doesn't add clicks
const SILENCE_THRESHOLD = Math.floor(SAMPLE_RATE * 0.06) * BYTES_PER_FRAME;
const SILENCE_CHUNK = Buffer.alloc(SAMPLE_RATE * BYTES_PER_FRAME); // 1 second

// Default: <user home>/Documents/MicCheck Recordings (e.g. C:\Users\<name>\Documents\MicCheck Recordings)
const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR ||
    path.join(os.homedir(), "Documents", "MicCheck Recordings")
);

const sessions = new Map(); // guildId -> session

function sanitize(name) {
  return (
    String(name)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/[. ]+$/, "")
      .trim()
      .slice(0, 60) || "unknown"
  );
}

// Folder name: 2026-10-31_21-30-05_Ten-room (local time)
function folderName(date, channel) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const time = `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
  return `${day}_${time}_${sanitize(channel.name)}`;
}

function writeSilence(track, bytes) {
  let remaining = bytes;
  while (remaining > 0) {
    const n = Math.min(remaining, SILENCE_CHUNK.length);
    track.out.write(SILENCE_CHUNK.subarray(0, n));
    remaining -= n;
  }
  track.bytesWritten += bytes;
}

function subscribeUser(session, userId) {
  const existing = session.tracks.get(userId);
  if (existing) {
    // The receive stream dies if a packet fails to decrypt; reattach on the next speech
    if (existing.opusStream.destroyed) attachStream(session, existing);
    return;
  }
  const member = session.channel.guild.members.cache.get(userId);
  if (member?.user?.bot) return;

  const name = member?.displayName || member?.user?.username || userId;
  const file = path.join(session.dir, `${sanitize(name)}_${userId}.mp3`);
  // Encode to mp3 while recording, so stopping doesn't have to process the whole session at once
  const encoder = startFfmpeg([...PCM_INPUT, "-i", "pipe:0", ...MP3_OUTPUT, file]);
  encoder.proc.stdin.on("error", (err) =>
    console.warn(`Encoder input error for ${name}:`, err.message)
  );
  const track = {
    userId,
    name,
    file,
    out: encoder.proc.stdin,
    encoded: encoder.done,
    bytesWritten: 0,
    packets: 0,
    decodeErrors: 0,
    decoder: new opus.OpusEncoder(SAMPLE_RATE, CHANNELS),
  };
  session.tracks.set(userId, track);
  console.log(`🎙️ Recording track for ${name} (${userId})`);
  attachStream(session, track);
}

function attachStream(session, track) {
  track.opusStream = session.connection.receiver.subscribe(track.userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  track.opusStream.on("data", (packet) => {
    let pcm;
    track.packets++;
    try {
      pcm = track.decoder.decode(packet);
    } catch (err) {
      // Skip corrupt packet; log only the first one per user to avoid flooding
      if (track.decodeErrors++ === 0) {
        console.warn(`Opus decode error for ${track.name}:`, err.message);
      }
      return;
    }
    // Keep every track on the same timeline: pad silence for the time this user wasn't talking
    const elapsedFrames = Math.floor(
      ((Date.now() - session.startedAt) / 1000) * SAMPLE_RATE
    );
    const gap = elapsedFrames * BYTES_PER_FRAME - pcm.length - track.bytesWritten;
    if (gap > SILENCE_THRESHOLD) {
      writeSilence(track, gap - (gap % BYTES_PER_FRAME));
    }
    track.out.write(pcm);
    track.bytesWritten += pcm.length;
  });
  track.opusStream.on("error", (err) =>
    console.warn(`Receive stream error for ${track.name}:`, err.message)
  );
}

function startFfmpeg(args) {
  const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`))
    );
  });
  return { proc, done };
}

const PCM_INPUT = ["-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS)];
// Mono 64kbps is plenty for speech and keeps ~20 min under Discord's 10MB upload limit
const MP3_OUTPUT = ["-codec:a", "libmp3lame", "-b:a", "64k"];

export function isRecording(guildId) {
  return sessions.has(guildId);
}

export function startRecording(connection, channel) {
  const guildId = channel.guild.id;
  if (sessions.has(guildId)) return sessions.get(guildId);

  const startedAt = new Date();
  const dir = path.join(RECORDINGS_DIR, folderName(startedAt, channel));
  fs.mkdirSync(dir, { recursive: true });

  const session = {
    dir,
    channel,
    connection,
    startedAt: startedAt.getTime(),
    tracks: new Map(),
  };
  session.onSpeaking = (userId) => subscribeUser(session, userId);
  session.onStateChange = (_old, state) => {
    if (state.status === VoiceConnectionStatus.Destroyed) {
      stopRecording(guildId).catch((err) =>
        console.error("Failed to finalize recording:", err)
      );
    }
  };
  connection.receiver.speaking.on("start", session.onSpeaking);
  connection.on("stateChange", session.onStateChange);

  sessions.set(guildId, session);
  console.log("🔴 Recording started:", dir);
  return session;
}

// Stops recording, finishes one mp3 per person, mixes them into mixed.mp3 and zips everything.
// Everything up to the first await runs synchronously, so the session is detached immediately.
export async function stopRecording(guildId) {
  const session = sessions.get(guildId);
  if (!session) return null;
  sessions.delete(guildId);

  session.connection.receiver.speaking.off("start", session.onSpeaking);
  session.connection.off("stateChange", session.onStateChange);

  const tracks = [...session.tracks.values()];
  for (const t of tracks) {
    t.opusStream.destroy();
    console.log(`Track ${t.name}: ${t.packets} packets, ${t.decodeErrors} decode errors`);
    t.out.end();
  }

  const files = [];
  for (const t of tracks) {
    try {
      await t.encoded;
      if (t.bytesWritten > 0) files.push(t.file);
      else fs.rmSync(t.file, { force: true });
    } catch (err) {
      console.error(`Failed to encode track for ${t.name}:`, err.message);
    }
  }

  if (files.length > 1) {
    const mixed = path.join(session.dir, "mixed.mp3");
    const inputs = files.flatMap((f) => ["-i", f]);
    const filter = ["-filter_complex", `amix=inputs=${files.length}:duration=longest:normalize=0`];
    const mixStart = Date.now();
    await startFfmpeg([...inputs, ...filter, ...MP3_OUTPUT, mixed]).done;
    console.log(`Mixed ${files.length} tracks in ${Math.round((Date.now() - mixStart) / 1000)}s`);
    files.push(mixed);
  }

  if (files.length === 0) fs.rmSync(session.dir, { recursive: true, force: true });

  const zip =
    files.length > 0
      ? await zipFiles(files, path.join(session.dir, `${path.basename(session.dir)}.zip`))
      : null;

  const durationSec = Math.round((Date.now() - session.startedAt) / 1000);
  console.log(`⏹️ Recording stopped (${durationSec}s):`, session.dir);
  return { dir: session.dir, files, zip, durationSec };
}

// MP3s are already compressed, so just store them (no point spending CPU on deflate)
async function zipFiles(files, zipPath) {
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { store: true });
  const closed = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
  });
  archive.pipe(output);
  for (const file of files) archive.file(file, { name: path.basename(file) });
  await archive.finalize();
  await closed;
  return zipPath;
}

export async function stopAllRecordings() {
  await Promise.all([...sessions.keys()].map((id) => stopRecording(id)));
}
