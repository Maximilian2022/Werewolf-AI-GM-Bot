// @ts-nocheck
/**
 * src/services/VoiceService.ts
 */
import { 
  joinVoiceChannel, VoiceConnection, VoiceConnectionStatus, entersState, EndBehaviorType,
  createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, generateDependencyReport,
  getVoiceConnection // 🚨 追加
} from '@discordjs/voice';
import { VoiceBasedChannel, Client } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import * as prism from 'prism-media';
import { spawn } from 'child_process';
import { StateManager } from '../state/StateManager';
import { Logger } from '../utils/logger';

export class VoiceService {
  private static connections = new Map<string, VoiceConnection>();
  private static readonly AUDIO_DIR = path.join(process.cwd(), 'data', 'audio');

  public static init() {
    if (!fs.existsSync(this.AUDIO_DIR)) fs.mkdirSync(this.AUDIO_DIR, { recursive: true });
    Logger.system(`\n=== 🎙️ Voice Dependency Report ===\n${generateDependencyReport()}\n==================================`);
  }

  public static async connectWithClient(client: Client, channel: VoiceBasedChannel, gameId: string, vcType: string, retryCount = 0): Promise<VoiceConnection> {
    const connectionKey = `${gameId}_${client.user?.id}`; 
    
    // 🚨 ゾンビキラー: Discord上に残っている古い接続を強制破棄
    const zombieConn = getVoiceConnection(channel.guild.id, client.user?.id);
    if (zombieConn && zombieConn.joinConfig.channelId !== channel.id) {
        Logger.warn('VoiceService', `[${client.user?.tag}] 古いゾンビコネクションを検知。強制破棄します。`, gameId);
        zombieConn.destroy();
    }

    if (this.connections.has(connectionKey)) {
        const existing = this.connections.get(connectionKey)!;
        if (existing.state.status !== VoiceConnectionStatus.Destroyed) {
            if (existing.joinConfig.channelId === channel.id) return existing;
        }
    }

    Logger.info('VoiceService', `🔄 [${client.user?.tag}] が [${channel.name}] に接続します...`, gameId);

    let connection: VoiceConnection;
    try {
      connection = joinVoiceChannel({
        channelId: channel.id, guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false, selfMute: false, group: client.user?.id, 
      });
    } catch (err) {
      Logger.error('VoiceService', `❌ joinVoiceChannelエラー:`, err, gameId);
      throw err;
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.connections.set(connectionKey, connection);
      return connection;
    } catch (error) {
      connection.destroy();
      this.connections.delete(connectionKey);
      if (retryCount < 2) {
        await new Promise(r => setTimeout(r, 2500));
        return this.connectWithClient(client, channel, gameId, vcType, retryCount + 1);
      }
      throw error;
    }
  }

  public static async playAudio(connection: VoiceConnection, filePath: string, gameId: string, timeoutMs = 30000): Promise<void> {
    return new Promise((resolve) => {
      const player = createAudioPlayer();
      const resource = createAudioResource(filePath, { inputType: StreamType.Arbitrary });
      
      let isResolved = false;
      const timeout = setTimeout(() => {
          if (!isResolved) {
              isResolved = true;
              Logger.warn('VoiceService', `⚠️ 音声再生がタイムアウトしました(${timeoutMs}ms)。強制的に進行します。`, gameId);
              player.stop();
              resolve();
          }
      }, timeoutMs);

      player.play(resource);
      connection.subscribe(player);
      
      player.on(AudioPlayerStatus.Idle, () => { 
          if (!isResolved) { isResolved = true; clearTimeout(timeout); resolve(); }
      });
      player.on('error', (err) => {
          if (!isResolved) {
              isResolved = true; clearTimeout(timeout);
              Logger.error('VoiceService', '音声再生エラー。進行を継続します。', err, gameId);
              resolve();
          }
      });
    });
  }

  public static async broadcastAudio(connections: VoiceConnection[], filePath: string, gameId: string): Promise<void> {
    const promises = connections.map(conn => this.playAudio(conn, filePath, gameId));
    await Promise.all(promises);
  }

  public static startRecording(connection: VoiceConnection, gameId: string) {
    const receiver = connection.receiver;
    const stateManager = StateManager.getInstance();
    
    receiver.speaking.on('start', (userId) => {
      let state;
      try { state = stateManager.getState(); } catch { return; }

      const player = state.players.find(p => p.userId === userId);
      if (!player || !player.isAlive) return;

      const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      const timestamp = Date.now();
      const fileName = `${gameId}_${state.phase}_day${state.day}_${userId}_${timestamp}.ogg`;
      const filePath = path.join(this.AUDIO_DIR, fileName);
      
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const ffmpeg = spawn('ffmpeg', [
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '64k', '-y', filePath
      ]);

      opusStream.pipe(decoder).pipe(ffmpeg.stdin);

      ffmpeg.on('close', (code) => {
        const durationMs = Date.now() - timestamp;
        if (durationMs > 1000 && code === 0) {
          try {
            const currentState = stateManager.getState();
            stateManager.updateState({ 
              speechLogs: [...currentState.speechLogs, { userId, phase: currentState.phase, day: currentState.day, timestamp, durationMs, audioFilePath: filePath }] 
            });
          } catch {}
        }
      });
    });
  }
public static setupRelay(sourceConnection: VoiceConnection, targetConnection: VoiceConnection, gameId: string) {
    const relayPlayer = createAudioPlayer();
    targetConnection.subscribe(relayPlayer);
    
    sourceConnection.receiver.speaking.on('start', (userId) => {
      const opusStream = sourceConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      opusStream.on('error', () => {});
      try {
        const resource = createAudioResource(opusStream, { inputType: StreamType.Opus });
        relayPlayer.play(resource);
      } catch (error) {}
    });
  }

  public static disconnectAll(gameId: string) {
    for (const [key, connection] of this.connections.entries()) {
      if (key.startsWith(gameId)) { connection.destroy(); this.connections.delete(key); }
    }
  }
}

VoiceService.init();