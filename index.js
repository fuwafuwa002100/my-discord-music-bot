// index.js
import dotenv from "dotenv";
dotenv.config();

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { joinVoiceChannel } from "@discordjs/voice";
import { Player } from "./player.js";

const PREFIX = process.env.PREFIX || "!";
const token = process.env.TOKEN;
if (!token) {
  console.error("ERROR: TOKEN が .env に設定されていません");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const player = new Player(client);

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  try {
    if (cmd === "play") {
      const url = args[0];
      if (!url) {
        await message.reply("再生するYouTubeのURLを貼ってください！");
        return;
      }
      // voice channel
      const vc = message.member.voice.channel;
      if (!vc) {
        await message.reply("まずボイスチャンネルに参加してください！");
        return;
      }
      await player.enqueue(url, { textChannel: message.channel, voiceChannel: vc, requester: message.author });
      return;
    }

    if (cmd === "skip") {
      await player.skip(message.guild.id);
      await message.reply("スキップした！");
      return;
    }

    if (cmd === "stop") {
      await player.stop(message.guild.id);
      await message.reply("停止！");
      return;
    }

    if (cmd === "np" || cmd === "nowplaying") {
      const np = player.nowPlaying(message.guild.id);
      await message.reply(np);
      return;
    }

    if (cmd === "queue") {
      const qtext = player.queueText(message.guild.id);
      await message.reply(qtext);
      return;
    }
  } catch (err) {
    console.error(err);
    await message.reply("エラー発生！");
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  player.handleVoiceStateUpdate(oldState, newState);
});

client.login(token);
