// player.js
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } from "@discordjs/voice";
import ytdl from "ytdl-core";
import prism from "prism-media";

function formatTime(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function makeBar(percent, length=20) {
  const filled = Math.round(percent * length);
  const empty = length - filled;
  return "▮".repeat(filled) + "▯".repeat(Math.max(0, empty));
}

export class Player {
  constructor(client) {
    this.client = client;
    this.queues = new Map();
    this.audioPlayers = new Map();
    this.current = new Map();
    this.updateIntervals = new Map();
  }

  async enqueue(url, { textChannel, voiceChannel, requester }) {
    const guildId = voiceChannel.guild.id;
    if (!ytdl.validateURL(url)) {
      await textChannel.send("無効なYouTubeURLです！");
      return;
    }

    const info = await ytdl.getInfo(url);
    const durationSec = parseInt(info.videoDetails.lengthSeconds || 0, 10);
    const title = info.videoDetails.title;

    const track = { url, title, duration: durationSec, requester: requester.tag };

    if (!this.queues.has(guildId)) this.queues.set(guildId, []);
    const q = this.queues.get(guildId);
    q.push(track);

    await textChannel.send(`🎶 キューに追加: **${title}** (${formatTime(durationSec)}) — キュー #${q.length}`);

    const existingConnection = getVoiceConnection(guildId);
    if (!this.audioPlayers.has(guildId)) {
      await this.startPlayer(guildId, voiceChannel, textChannel);
    }

    const curr = this.current.get(guildId);
    if (!curr || curr.state !== "playing") {
      this.playNext(guildId, textChannel);
    }
  }

  async startPlayer(guildId, voiceChannel, textChannel) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.audioPlayers.set(guildId, player);

    player.on("stateChange", (oldState, newState) => {
    });

    player.on(AudioPlayerStatus.Idle, () => {
      this._clearCurrent(guildId);
      setTimeout(() => {
        const text = textChannel;
        this.playNext(guildId, text).catch(console.error);
      }, 500);
    });

    player.on("error", error => {
      console.error("AudioPlayer error:", error);
      this._clearCurrent(guildId);
    });

    connection.subscribe(player);

  }

  async playNext(guildId, textChannel) {
    const q = this.queues.get(guildId) || [];
    if (q.length === 0) {
      await textChannel.send("キューが空です。ボイスチャンネルをチェックして15秒後に切断します（誰もいなければ）。");
      this._startEmptyDisconnectCheck(guildId, textChannel);
      return;
    }

    const track = q.shift();
    const stream = ytdl(track.url, { filter: "audioonly", highWaterMark: 1 << 25 });

    const ffmpeg = new prism.FFmpeg({
      args: [
        "-analyzeduration", "0",
        "-loglevel", "0",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2"
      ]
    });

    const pcm = stream.pipe(ffmpeg);

    const resource = createAudioResource(pcm, { inputType: "converted" });

    const audioPlayer = this.audioPlayers.get(guildId);
    if (!audioPlayer) {
      await textChannel.send("音声プレイヤーが準備できていません！もう一度 `!play` してみてください！");
      return;
    }

    audioPlayer.play(resource);

    const now = Date.now();
    this.current.set(guildId, {
      resource,
      info: track,
      startTime: now,
      state: "playing",
      textChannel,
      progressMessage: null,
    });

    this._startProgressInterval(guildId);

    await textChannel.send(`▶️ 再生開始: **${track.title}** (${formatTime(track.duration)})`);
  }

  async skip(guildId) {
    const player = this.audioPlayers.get(guildId);
    if (player) {
      player.stop(true);
    }
  }

  async stop(guildId) {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
    }
    const player = this.audioPlayers.get(guildId);
    if (player) {
      player.stop();
      this.audioPlayers.delete(guildId);
    }
    this.queues.delete(guildId);
    this._clearProgressInterval(guildId);
    this.current.delete(guildId);
  }

  nowPlaying(guildId) {
    const c = this.current.get(guildId);
    if (!c) return "現在再生中の曲はありません！";
    const elapsed = ((Date.now() - c.startTime) / 1000);
    const total = c.info.duration;
    const percent = Math.min(1, elapsed / Math.max(1, total));
    return `🎵 **${c.info.title}** — ${formatTime(Math.floor(elapsed))} / ${formatTime(total)}\n${makeBar(percent)} ${Math.round(percent*100)}%`;
  }

  queueText(guildId) {
    const q = this.queues.get(guildId) || [];
    if (q.length === 0) return "キューは空です！";
    return q.map((t,i) => `${i+1}. ${t.title} (${formatTime(t.duration)})`).slice(0,10).join("\n");
  }

  _startProgressInterval(guildId) {
    this._clearProgressInterval(guildId);

    const iv = setInterval(async () => {
      const c = this.current.get(guildId);
      if (!c) return;
      const elapsed = ((Date.now() - c.startTime) / 1000);
      const total = c.info.duration || 0;
      const percent = Math.min(1, elapsed / Math.max(1, total || 1));
      const bar = makeBar(percent, 20);
      const text = `**Now Playing**: ${c.info.title}\n${bar} ${Math.round(percent*100)}% — ${formatTime(Math.floor(elapsed))} / ${formatTime(total)}`;

      try {
        if (!c.progressMessage) {
          const sent = await c.textChannel.send(text);
          c.progressMessage = sent;
          this.current.set(guildId, c);
        } else {
          await c.progressMessage.edit(text);
        }
      } catch (err) {
        console.error("progress update error:", err);
      }
    }, 5000);

    this.updateIntervals.set(guildId, iv);
  }

  _clearProgressInterval(guildId) {
    const iv = this.updateIntervals.get(guildId);
    if (iv) {
      clearInterval(iv);
      this.updateIntervals.delete(guildId);
    }
    const c = this.current.get(guildId);
    if (c && c.progressMessage) {
      try {
        c.progressMessage.edit(`再生終了: ${c.info.title}`).catch(()=>{});
      } catch(e){}
    }
  }

  _clearCurrent(guildId) {
    this._clearProgressInterval(guildId);
    this.current.delete(guildId);
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const guildId = (oldState.guild || newState.guild).id;
    const conn = getVoiceConnection(guildId);
    if (!conn) return;

    const channelId = conn.joinConfig.channelId;
    const chan = oldState.guild.channels.cache.get(channelId);
    if (!chan || !chan.isVoiceBased()) return;

    const nonBotCount = chan.members.filter(m => !m.user.bot).size;
    if (nonBotCount === 0) {
      const curr = this.current.get(guildId) || {};
      if (curr.timeoutForEmptyChannel) return;
      const textChannel = (curr.textChannel) ? curr.textChannel : null;
      if (textChannel) textChannel.send("チャンネルにユーザーがいません！15秒後に切断します！");

      const to = setTimeout(() => {
        const chan2 = this.client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
        const countNow = chan2 ? chan2.members.filter(m => !m.user.bot).size : 0;
        if (countNow === 0) {
          try {
            const connectionNow = getVoiceConnection(guildId);
            if (connectionNow) connectionNow.destroy();
            this.queues.delete(guildId);
            this._clearCurrent(guildId);
            if (textChannel) textChannel.send("誰もいないので切断しました！");
          } catch (e) { console.error(e); }
        } else {
          if (textChannel) textChannel.send("誰かが戻ってきたので切断をキャンセルしました！");
        }
        const c2 = this.current.get(guildId);
        if (c2) { c2.timeoutForEmptyChannel = null; this.current.set(guildId, c2); }
      }, 15000);

      const c = this.current.get(guildId) || {};
      c.timeoutForEmptyChannel = to;
      this.current.set(guildId, c);
    } else {
      const c = this.current.get(guildId);
      if (c && c.timeoutForEmptyChannel) {
        clearTimeout(c.timeoutForEmptyChannel);
        c.timeoutForEmptyChannel = null;
        this.current.set(guildId, c);
        if (c.textChannel) c.textChannel.send("誰かが戻ってきたので切断をキャンセルしました！");
      }
    }
  }
}
