import express from "express";
import http from "http";
import https from "https";
import { Server as SocketServer } from "socket.io";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  NoSubscriberBehavior,
  generateDependencyReport,
  getVoiceConnection,
} from "@discordjs/voice";
import {
  startRecording,
  stopRecording,
  stopAllRecordings,
  isRecording,
} from "./recorder.js";

const app = express();
const server = http.createServer(app);
// Keep-alive endpoint for internal pings
app.get("/_keepalive", (_req, res) => res.send("ok"));
dotenv.config();

// Print dependency report for @discordjs/voice to help debug missing native deps
try {
  const report = generateDependencyReport();
  console.log("@discordjs/voice dependency report:\n", report);
} catch (err) {
  console.warn("Could not generate @discordjs/voice dependency report:", err);
}

// Log unhandled errors so process doesn't silently exit
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

const io = new SocketServer(server, {
  cors: { origin: "*" },
});

// Note: video start/stop signaling removed - overlay does not track video state here

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment (.env)");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register a guild slash command `/joinroom` for each guild the bot is in
  try {
    for (const [, guild] of client.guilds.cache) {
      // Register only /joinroom (camera toggles removed)
      await guild.commands.create({
        name: "joinroom",
        description: "Ask the bot to join your voice channel",
      });
      // Also register /leaveroom so users can explicitly make the bot leave
      await guild.commands.create({
        name: "leaveroom",
        description: "Ask the bot to leave its current voice channel",
      });
      await guild.commands.create({
        name: "startrecord",
        description: "Start recording everyone in your voice channel",
      });
      await guild.commands.create({
        name: "stoprecord",
        description: "Stop recording and save the audio files",
      });
      console.log(
        `Registered /joinroom, /leaveroom, /startrecord, /stoprecord for guild ${guild.id}`
      );
    }
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

client.on("error", (err) => console.error("Discord client error:", err));
client.on("warn", (info) => console.warn("Discord client warn:", info));

client.on("voiceStateUpdate", async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member) return;

  // Lấy danh sách người trong cùng channel
  const channel = newState.channel || oldState.channel;
  if (!channel) return;

  // video toggle detection removed - we no longer emit videoState from the bot

  const members = channel.members
    .filter((m) => !m.user.bot) // Filter out bots
    .map((m) => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName ?? m.user.username,
      avatar: m.user.displayAvatarURL({ size: 128 }),
      speaking: false,
      selfMute: m.voice.selfMute,
      selfDeaf: m.voice.selfDeaf,
    }));

  io.emit("voiceMembers", members);
});

// Helper: join a voice channel and keep a silent player subscribed so connection stays
async function joinChannelIfNotIn(channel) {
  if (!channel) return;
  const meVoiceChannelId = channel.guild.members.me?.voice?.channelId;
  if (meVoiceChannelId === channel.id) {
    console.log("Already in channel", channel.id);
    return;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    console.log("✅ Bot joined voice channel:", channel.id);

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    connection.subscribe(player);

    // Attach receiver speaking events so we can emit who is talking
    try {
      const receiver = connection.receiver;
      if (receiver && receiver.speaking) {
        receiver.speaking.on("start", (userId) => {
          // Try to resolve username from the channel's guild
          const member = channel.guild.members.cache.get(userId);
          const username = member?.user?.username || userId;
          const displayName = member?.displayName || username;

          io.emit("speaking", {
            id: userId,
            username,
            displayName,
            speaking: true,
          });
        });

        receiver.speaking.on("end", (userId) => {
          const member = channel.guild.members.cache.get(userId);
          const username = member?.user?.username || userId;
          const displayName = member?.displayName || username;

          io.emit("speaking", {
            id: userId,
            username,
            displayName,
            speaking: false,
          });
        });
      } else {
        console.warn(
          "Voice receiver or receiver.speaking not available on this connection"
        );
      }
    } catch (err) {
      console.error("Error attaching receiver speaking handlers:", err);
    }

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
        // reconnecting
      } catch (err) {
        connection.destroy();
      }
    });

    return connection;
  } catch (err) {
    console.error("Failed to join voice channel:", err);
  }
}

// Helper: leave a voice channel if the bot is currently in it
async function leaveChannelIfIn(channel) {
  if (!channel) return;
  try {
    const me = channel.guild.members.me;
    const currentChannel = me?.voice?.channel;
    if (!currentChannel || currentChannel.id !== channel.id) {
      console.log("Bot is not in the specified channel, nothing to leave");
      return;
    }
    try {
      const { getVoiceConnection } = await import("@discordjs/voice");
      const conn = getVoiceConnection(channel.guild.id);
      if (conn) {
        conn.destroy();
        console.log("Bot left voice channel:", channel.id);
      } else {
        console.log(
          "No active voice connection found to destroy for guild",
          channel.guild.id
        );
      }
    } catch (e) {
      console.warn("Error while attempting to leave voice channel:", e);
    }
  } catch (err) {
    console.error("leaveChannelIfIn error:", err);
  }
}

// NOTE: client-level 'speakingStart'/'speakingStop' do not exist.
// To detect who is speaking in a voice channel, we must listen on the voice connection's receiver
// after joining. We'll attach receiver.speaking 'start'/'end' handlers in joinChannelIfNotIn.

io.on("connection", (socket) => {
  console.log("🟢 Client connected", socket.id);

  // --- WebRTC signaling minimal hub ---
  // Track one host and many publishers (keyed by socket.id and announced userId)
  let role = null;
  let announcedUserId = null;

  // Shared registry in memory
  if (!io.hostSocketId) io.hostSocketId = null;
  if (!io.publishers) io.publishers = new Map(); // socket.id -> { userId }

  socket.on("register-role", ({ role: r, userId }) => {
    try {
      role = r;
      announcedUserId = userId;
      if (role === "host") {
        io.hostSocketId = socket.id;
        console.log("RTC host registered:", socket.id);
      } else if (role === "publisher") {
        io.publishers.set(socket.id, { userId });
        console.log("RTC publisher registered:", socket.id, userId);
        if (io.hostSocketId) {
          io.to(io.hostSocketId).emit("publisher-joined", {
            socketId: socket.id,
            userId,
          });
        }
      }
    } catch (e) {
      console.warn("register-role error:", e);
    }
  });

  // Publisher -> Host: offer
  socket.on("webrtc-offer", ({ sdp, userId }) => {
    if (io.hostSocketId) {
      io.to(io.hostSocketId).emit("webrtc-offer", {
        fromSocketId: socket.id,
        userId,
        sdp,
      });
    }
  });
  // Host -> Publisher: answer
  socket.on("webrtc-answer", ({ toSocketId, sdp, userId }) => {
    io.to(toSocketId).emit("webrtc-answer", { sdp, userId });
  });
  // ICE candidates both ways
  socket.on("webrtc-ice-candidate", ({ toSocketId, candidate, userId }) => {
    try {
      if (toSocketId) {
        io.to(toSocketId).emit("webrtc-ice-candidate", {
          candidate,
          userId,
          fromSocketId: socket.id,
        });
        return;
      }
      // Allow implicit routing: publisher -> host if no toSocketId
      if (role === "publisher" && io.hostSocketId) {
        io.to(io.hostSocketId).emit("webrtc-ice-candidate", {
          candidate,
          userId,
          fromSocketId: socket.id,
        });
        return;
      }
      // Or host -> publisher by userId
      if (role === "host" && userId) {
        for (const [sid, info] of io.publishers || []) {
          if (info?.userId === userId) {
            io.to(sid).emit("webrtc-ice-candidate", {
              candidate,
              userId,
              fromSocketId: socket.id,
            });
            break;
          }
        }
      }
    } catch (e) {
      console.warn("webrtc-ice-candidate routing error:", e);
    }
  });

  // Send an initial snapshot: find a voice channel where the bot is currently present
  try {
    let sent = false;
    for (const [, guild] of client.guilds.cache) {
      const me = guild.members.me;
      const channel = me?.voice?.channel;
      if (channel) {
        const members = channel.members
          .filter((m) => !m.user.bot) // Filter out bots
          .map((m) => ({
            id: m.id,
            username: m.user.username,
            displayName: m.displayName ?? m.user.username,
            avatar: m.user.displayAvatarURL({ size: 128 }),
            speaking: false,
            selfMute: m.voice.selfMute,
            selfDeaf: m.voice.selfDeaf,
          }));
        socket.emit("voiceMembers", members);
        console.log(
          `Sent initial voiceMembers snapshot for guild ${guild.id}, channel ${channel.id}`
        );
        sent = true;
        break;
      }
    }
    if (!sent) {
      console.log("No bot voice channel found to send initial snapshot.");
    }
  } catch (err) {
    console.error("Error sending initial snapshot:", err);
  }

  // Allow client to request a fresh snapshot on demand
  socket.on("requestSnapshot", (data) => {
    try {
      // Optional: accept { guildId, channelId } to target a specific channel
      if (data && data.guildId && data.channelId) {
        const guild = client.guilds.cache.get(data.guildId);
        const channel = guild?.channels.cache.get(data.channelId);
        if (channel) {
          const members = channel.members
            .filter((m) => !m.user.bot) // Filter out bots
            .map((m) => ({
              id: m.id,
              username: m.user.username,
              displayName: m.displayName ?? m.user.username,
              avatar: m.user.displayAvatarURL({ size: 128 }),
              speaking: false,
              selfMute: m.voice.selfMute,
              selfDeaf: m.voice.selfDeaf,
            }));
          socket.emit("voiceMembers", members);
          return;
        }
      }

      // Fallback: send first found bot channel snapshot again
      for (const [, guild] of client.guilds.cache) {
        const me = guild.members.me;
        const channel = me?.voice?.channel;
        if (channel) {
          const members = channel.members
            .filter((m) => !m.user.bot) // Filter out bots
            .map((m) => ({
              id: m.id,
              username: m.user.username,
              displayName: m.displayName ?? m.user.username,
              avatar: m.user.displayAvatarURL({ size: 128 }),
              speaking: false,
              selfMute: m.voice.selfMute,
              selfDeaf: m.voice.selfDeaf,
            }));
          socket.emit("voiceMembers", members);
          return;
        }
      }

      socket.emit("voiceMembers", []);
    } catch (err) {
      console.error("requestSnapshot handler error:", err);
      socket.emit("voiceMembers", []);
    }
  });

  socket.on("disconnect", () => {
    try {
      if (io.hostSocketId === socket.id) {
        console.log("RTC host disconnected");
        io.hostSocketId = null;
      }
      if (io.publishers?.has(socket.id)) {
        const info = io.publishers.get(socket.id);
        io.publishers.delete(socket.id);
        if (io.hostSocketId) {
          io.to(io.hostSocketId).emit("publisher-left", {
            socketId: socket.id,
            userId: info?.userId,
          });
        }
      }
    } catch (e) {
      // ignore
    }
  });
});

// Optional: simple text command to ask bot join (safer than auto-join everywhere)
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content === "!join") {
    const channel = message.member?.voice?.channel;
    if (!channel) return message.reply("Bạn chưa ở trong voice channel.");
    await joinChannelIfNotIn(channel);
    return message.reply("Joined voice channel!");
  }
  if (message.content === "!leave") {
    const channel =
      message.member?.voice?.channel ||
      message.guild?.members.me?.voice?.channel;
    if (!channel)
      return message.reply("Bot không có ở trong voice channel nào.");
    await leaveChannelIfIn(channel);
    return message.reply("Left voice channel.");
  }
});

// Handle slash command /joinroom
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    if (interaction.commandName === "joinroom") {
      const member = interaction.member;
      const channel = member?.voice?.channel;
      if (!channel) {
        return interaction.reply({
          content: "Bạn chưa ở trong voice channel.",
          ephemeral: true,
        });
      }

      // Joining a voice channel can take longer than Discord's 3s interaction window.
      // Defer the reply so we can acknowledge and then edit the reply after joining.
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (err) {
        // If deferring fails, log but continue to attempt join; we'll try to reply later.
        console.warn("Failed to defer interaction reply:", err);
      }

      try {
        await joinChannelIfNotIn(channel);
        // If we successfully deferred, editReply; otherwise send a fallback reply.
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "Joined voice channel!" });
          } else {
            await interaction.reply({
              content: "Joined voice channel!",
              ephemeral: false,
            });
          }
        } catch (err) {
          console.warn(
            "Failed to send interaction response after joining:",
            err
          );
        }
      } catch (err) {
        console.error("Error joining channel for /joinroom:", err);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content: "Failed to join voice channel.",
            });
          } else {
            await interaction.reply({
              content: "Failed to join voice channel.",
              ephemeral: true,
            });
          }
        } catch (e) {
          console.warn("Also failed to notify user about join failure:", e);
        }
      }
      return;
    }

    if (interaction.commandName === "leaveroom") {
      const member = interaction.member;
      // Try to determine the channel to leave: prefer the guild's current bot channel
      const botChannel = interaction.guild?.members.me?.voice?.channel;
      if (!botChannel) {
        try {
          await interaction.reply({
            content: "Bot hiện không ở trong voice channel nào.",
            ephemeral: true,
          });
        } catch (e) {}
        return;
      }

      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (err) {
        console.warn("Failed to defer leaveroom reply:", err);
      }

      try {
        await leaveChannelIfIn(botChannel);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "Left voice channel." });
          } else {
            await interaction.reply({ content: "Left voice channel." });
          }
        } catch (e) {}
      } catch (err) {
        console.error("Error leaving channel for /leaveroom:", err);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content: "Failed to leave voice channel.",
            });
          } else {
            await interaction.reply({
              content: "Failed to leave voice channel.",
              ephemeral: true,
            });
          }
        } catch (e) {}
      }
      return;
    }

    if (interaction.commandName === "startrecord") {
      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        return interaction.reply({
          content: "Bạn chưa ở trong voice channel.",
          ephemeral: true,
        });
      }
      if (isRecording(interaction.guild.id)) {
        return interaction.reply({
          content: "Bot đang ghi âm rồi. Dùng /stoprecord để dừng.",
          ephemeral: true,
        });
      }

      // Public reply so everyone in the room knows they're being recorded
      await interaction.deferReply();
      try {
        await joinChannelIfNotIn(channel);
        const connection = getVoiceConnection(channel.guild.id);
        if (!connection) throw new Error("No voice connection after join");
        startRecording(connection, channel);
        await interaction.editReply(
          `🔴 Bắt đầu ghi âm room **${channel.name}**. Mọi người trong phòng đang được ghi âm.`
        );
      } catch (err) {
        console.error("Error starting recording:", err);
        await interaction.editReply("Không bắt đầu ghi âm được.");
      }
      return;
    }

    if (interaction.commandName === "stoprecord") {
      if (!isRecording(interaction.guild.id)) {
        return interaction.reply({
          content: "Bot không có đang ghi âm.",
          ephemeral: true,
        });
      }

      // Encoding with ffmpeg can take a while for long recordings
      await interaction.deferReply();
      try {
        const result = await stopRecording(interaction.guild.id);
        const minutes = Math.floor(result.durationSec / 60);
        const seconds = result.durationSec % 60;
        await interaction.editReply(
          result.files.length > 0
            ? `⏹️ Đã dừng ghi âm (${minutes}m${seconds}s). Đã lưu ${result.files.length} file.`
            : "⏹️ Đã dừng ghi âm. Không có ai nói nên không có file nào."
        );
      } catch (err) {
        console.error("Error stopping recording:", err);
        await interaction.editReply("Có lỗi khi lưu file ghi âm.");
      }
      return;
    }
  } catch (err) {
    console.error("interactionCreate handler error:", err);
    if (interaction && interaction.reply) {
      try {
        await interaction.reply({
          content: "Có lỗi khi xử lý lệnh.",
          ephemeral: true,
        });
      } catch (e) {
        // ignore
      }
    }
  }
});

client.login(DISCORD_TOKEN);
// Raw debug: log VOICE_STATE_UPDATE payloads to confirm if Discord sends self_video/self_stream
client.on("raw", (packet) => {
  try {
    if (packet?.t === "VOICE_STATE_UPDATE") {
      const d = packet.d || {};
      console.log("RAW VOICE_STATE_UPDATE:", {
        user_id: d.user_id,
        channel_id: d.channel_id,
        self_mute: d.self_mute,
        self_deaf: d.self_deaf,
      });
    }
  } catch {}
});
// Save any in-progress recording before the process exits (e.g. Ctrl+C)
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    console.log(`${signal} received, saving recordings...`);
    try {
      await stopAllRecordings();
    } catch (err) {
      console.error("Failed to save recordings on exit:", err);
    }
    process.exit(0);
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log("⚡ Server running on port", PORT));

// Periodic self-ping to prevent some hosters or renderers from idle-shutting the process
setInterval(() => {
  try {
    const keepaliveUrl = `https://miccheck-bot-backend.onrender.com/_keepalive`;
    console.log("keepalive: pinging", keepaliveUrl);
    let client = http;
    let urlObj = null;
    try {
      urlObj = new URL(keepaliveUrl);
      client = urlObj.protocol === "https:" ? https : http;
      console.log("keepalive: using client", urlObj.protocol);
    } catch (urlErr) {
      console.warn(
        "keepalive: malformed URL, falling back to http",
        urlErr && urlErr.message ? urlErr.message : urlErr
      );
      // keep client as http and use keepaliveUrl string
    }

    const req = client.get(urlObj || keepaliveUrl, (res) => {
      console.log(`keepalive: received ${res.statusCode}`);
      // consume response to avoid memory leaks
      res.on("data", () => {});
      res.on("end", () => {
        console.log("keepalive: response end");
      });
    });
    req.on("error", (err) => {
      console.warn(
        "keepalive: request error:",
        err && err.message ? err.message : err
      );
    });
  } catch (e) {
    console.warn("keepalive: unexpected error:", e);
  }
}, 10 * 1000);
