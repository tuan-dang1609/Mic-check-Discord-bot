import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import OpusScript from "opusscript";
import ffmpegPath from "ffmpeg-static";
import { EndBehaviorType, VoiceConnectionStatus } from "@discordjs/voice";

// Discord voice is 48kHz stereo Opus; we decode to signed 16-bit PCM
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
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
  if (session.tracks.has(userId)) return;
  const member = session.channel.guild.members.cache.get(userId);
  if (member?.user?.bot) return;

  const name = member?.displayName || member?.user?.username || userId;
  const pcmPath = path.join(session.dir, `${userId}.pcm`);
  const track = {
    userId,
    name,
    pcmPath,
    out: fs.createWriteStream(pcmPath),
    bytesWritten: 0,
    decoder: new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO),
    opusStream: session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    }),
  };
  session.tracks.set(userId, track);
  console.log(`🎙️ Recording track for ${name} (${userId})`);

  track.opusStream.on("data", (packet) => {
    let pcm;
    try {
      pcm = track.decoder.decode(packet);
    } catch (err) {
      return; // skip corrupt packet
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
    console.warn(`Receive stream error for ${userId}:`, err)
  );
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`))
    );
  });
}

const PCM_INPUT = ["-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS)];
// Mono 64kbps is plenty for speech and keeps ~20 min under Discord's 10MB upload limit
const MP3_OUTPUT = ["-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k"];

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

// Stops recording, writes one mp3 per person plus mixed.mp3, and removes the raw .pcm files
export async function stopRecording(guildId) {
  const session = sessions.get(guildId);
  if (!session) return null;
  sessions.delete(guildId);

  session.connection.receiver.speaking.off("start", session.onSpeaking);
  session.connection.off("stateChange", session.onStateChange);

  const tracks = [...session.tracks.values()];
  await Promise.all(
    tracks.map(
      (t) =>
        new Promise((resolve) => {
          t.opusStream.destroy();
          t.decoder.delete();
          t.out.end(resolve);
        })
    )
  );

  const files = [];
  const usable = tracks.filter((t) => t.bytesWritten > 0);
  for (const t of usable) {
    const file = path.join(session.dir, `${sanitize(t.name)}_${t.userId}.mp3`);
    await runFfmpeg([...PCM_INPUT, "-i", t.pcmPath, ...MP3_OUTPUT, file]);
    files.push(file);
  }

  if (usable.length > 0) {
    const mixed = path.join(session.dir, "mixed.mp3");
    const inputs = usable.flatMap((t) => [...PCM_INPUT, "-i", t.pcmPath]);
    const filter =
      usable.length > 1
        ? ["-filter_complex", `amix=inputs=${usable.length}:duration=longest:normalize=0`]
        : [];
    await runFfmpeg([...inputs, ...filter, ...MP3_OUTPUT, mixed]);
    files.push(mixed);
  }

  for (const t of tracks) fs.rmSync(t.pcmPath, { force: true });
  if (files.length === 0) fs.rmSync(session.dir, { recursive: true, force: true });

  const durationSec = Math.round((Date.now() - session.startedAt) / 1000);
  console.log(`⏹️ Recording stopped (${durationSec}s):`, session.dir);
  return { dir: session.dir, files, durationSec };
}

export async function stopAllRecordings() {
  await Promise.all([...sessions.keys()].map((id) => stopRecording(id)));
}
