// @ts-nocheck
/**
 * src/services/VoiceService.ts
 * 本番対応版：ストリーム一本化（録音と中継の競合回避・PassThrough分岐機能搭載）
 */
import { 
  joinVoiceChannel, VoiceConnection, VoiceConnectionStatus, entersState, EndBehaviorType, NoSubscriberBehavior,
  createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, generateDependencyReport,
  getVoiceConnection
} from '@discordjs/voice';
import { VoiceBasedChannel, Client } from 'discord.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as prism from 'prism-media';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream'; // 🚨 追加：ストリーム分岐用
import { StateManager } from '../state/StateManager.js';
import { Logger } from '../utils/logger.js';
import { Mixer } from 'audio-mixer';
import { Readable } from 'node:stream';

export class VoiceService {
  private static connections = new Map<string, VoiceConnection>();
  private static readonly AUDIO_DIR = path.join(process.cwd(), 'data', 'audio');
  
  // 🚨 追加：中継先のコネクションとプレイヤーを記憶しておくマップ
  private static relayTargets = new Map<string, { conn: VoiceConnection, player: any }>();

  public static init() {
    if (!fs.existsSync(this.AUDIO_DIR)) fs.mkdirSync(this.AUDIO_DIR, { recursive: true });
    Logger.system(`\n=== 🎙️ Voice Dependency Report ===\n${generateDependencyReport()}\n==================================`);
  }

// ==========================================
// VoiceService.ts
// connectWithClient メソッドを上書き
// ==========================================

  public static async connectWithClient(client: Client, channel: VoiceBasedChannel, gameId: string, vcType: string, retryCount = 0): Promise<VoiceConnection> {
    const connectionKey = `${gameId}_${client.user?.id}`; 

    if (this.connections.has(connectionKey)) {
        const existing = this.connections.get(connectionKey)!;
        if (existing.state.status !== VoiceConnectionStatus.Destroyed) {
            if (existing.joinConfig.channelId === channel.id) return existing;
        }
    }

    Logger.info('VoiceService', `🔄 [${client.user?.tag}] が [${channel.name}] に接続(または移動)します...`, gameId);

    let adapterCreator: any;
    try {
      const myGuild = await client.guilds.fetch(channel.guild.id);
      adapterCreator = myGuild.voiceAdapterCreator;
    } catch (e) {
      Logger.error('VoiceService', `VoiceAdapterCreatorの取得に失敗しました`, e, gameId);
      throw e;
    }

    let connection: VoiceConnection;
    try {
      connection = joinVoiceChannel({
        channelId: channel.id, 
        guildId: channel.guild.id,
        adapterCreator: adapterCreator, 
        selfDeaf: false, selfMute: false, group: client.user?.id, 
      });
    } catch (err) {
      Logger.error('VoiceService', `❌ joinVoiceChannelエラー:`, err, gameId);
      throw err;
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.connections.set(connectionKey, connection);
      // ③ 自分がVCにいる状態になったので、サーバーミュートの残骸があれば解除する！
      try {
        const myGuild = await client.guilds.fetch(channel.guild.id);
        const myMember = myGuild.members.me;
        if (myMember?.voice.serverMute) {
          await myMember.voice.setMute(false);
          Logger.info('VoiceService', `🔊 過去の残骸を検知: [${client.user?.tag}] のサーバーミュートを強制解除しました。`, gameId);
        }
      } catch (e) {
        // 権限エラー等で失敗した場合はスキップ
      }
      // 👇 ========== ここから修正（デバッグモード時のみ有効化） ========== 👇
      try {
        const state = StateManager.getInstance().getState();
        if (state && state.isDebug) {
          connection.receiver.speaking.removeAllListeners('start');
          connection.receiver.speaking.on('start', (speakerId) => {
            if (speakerId !== client.user?.id) {
              Logger.info('AudioMonitor', `🎧 観測機[${client.user?.tag}] が ユーザー[${speakerId}] の音声パケット到達を検知しました！（死活監視: OK）`, gameId);
            }
          });
        }
      } catch (e) {
        // Stateがまだ初期化されていない場合はスキップ
      }
      return connection;
    } catch (error) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try { connection.destroy(); } catch (e) {}
      }
      this.connections.delete(connectionKey);
      
      if (retryCount < 2) {
        await new Promise(r => setTimeout(r, 2500));
        return this.connectWithClient(client, channel, gameId, vcType, retryCount + 1);
      }
      throw error;
    }
  }

public static async playAudio(connection: VoiceConnection, filePath: string, gameId: string, timeoutMs = 30000): Promise<void> {
    if (!filePath) {
      Logger.warn('VoiceService', '⚠️ 音声ファイルが存在しないため、再生をスキップして進行します。', gameId);
      return;
    }
  // 🚨 修正: Promiseのコールバックに async を追加
    return new Promise(async (resolve) => { 
      
// 🚨 強化：現在の状態を確認し、Disconnectedなら再接続を待つ
      if (connection.state.status === VoiceConnectionStatus.Disconnected) {
          try {
            connection.rejoin(); // 🚨 追加：Discordへ明示的に再接続を要求
            await entersState(connection, VoiceConnectionStatus.Connecting, 5000);
          } catch (e) {
              Logger.error('VoiceService', '再接続に失敗しました。', e, gameId);
          }
      }

      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });
      
      // 🚨 重要：resource生成時のエラーをキャッチできるようにする
      //const resource = createAudioResource(filePath, { inputType: StreamType.Arbitrary });
      const resource = createAudioResource(filePath);

      try {
        // 3秒から5秒へ延長し、失敗時はログを残して「とりあえず投げる」
        await entersState(connection, VoiceConnectionStatus.Ready, 5000).catch(() => {
            Logger.warn('VoiceService', 'Ready状態への遷移がタイムアウトしましたが、再生を強行します。', gameId);
        });
        
        connection.subscribe(player);
        player.play(resource);
      } catch (err) {
        Logger.error('VoiceService', '再生プロセスで致命的エラー', err, gameId);
        resolve();
        return;
      }
      
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
      
      // 前の再生機が残っていても、ここで上書きsubscribeされるため古いものは自動的に外れます
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

  // ===============================================
  // 🎧 修正：中継の「準備」だけを行い、ストリーム取得は startRecording に任せる
  // ===============================================
  public static setupRelay(sourceConnection: VoiceConnection, targetConnection: VoiceConnection, gameId: string) {
    const relayPlayer = createAudioPlayer();
    targetConnection.subscribe(relayPlayer);
    
    // 中継先情報をマップに登録（あとで startRecording がこれを見て分岐させます）
    this.relayTargets.set(gameId, { conn: targetConnection, player: relayPlayer });
    Logger.info('VoiceService', `🎧 中継ルートを登録しました（録音ストリームと同期します）`, gameId);
  }

  // ===============================================
  // 1. 録音：FFmpeg完全排除＆純粋なWAVダイレクト書き込み
  // ===============================================
  public static startRecording(connection: VoiceConnection, gameId: string) {
    if ((connection as any)._isListening) return;
    (connection as any)._isListening = true;

    const receiver = connection.receiver;
    const stateManager = StateManager.getInstance();
    
    receiver.speaking.on('start', (userId) => {
      let state;
      try { state = stateManager.getState(); } catch { return; }
      const player = state.players.find(p => p.userId === userId);
      if (!player || !player.isAlive) return;

      const rawOpusStream = receiver.subscribe(userId, { 
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } 
      });
      
      const timestamp = Date.now();
      // 🚨 拡張子を .ogg から .wav に変更
      const fileName = `${gameId}_${state.phase}_day${state.day}_${userId}_${timestamp}.wav`;
      const filePath = path.join(this.AUDIO_DIR, fileName);

      // C++ネイティブの超高速デコーダーでOpusを生のPCMに変換（CPU負荷ほぼゼロ）
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const outStream = fs.createWriteStream(filePath);
      
      let dataLength = 0;

      // 🚨 44バイトのWAVヘッダーを手動生成する関数
      const writeWavHeader = (length: number) => {
        const buffer = Buffer.alloc(44);
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + length, 4); // ファイルサイズ
        buffer.write('WAVE', 8);
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20); // PCMフォーマット
        buffer.writeUInt16LE(2, 22); // ステレオ(2ch)
        buffer.writeUInt32LE(48000, 24); // サンプリングレート
        buffer.writeUInt32LE(48000 * 2 * 2, 28); // バイトレート
        buffer.writeUInt16LE(4, 32); // ブロックアライン
        buffer.writeUInt16LE(16, 34); // 16-bit
        buffer.write('data', 36);
        buffer.writeUInt32LE(length, 40); // データサイズ
        return buffer;
      };
      
      // まずダミーのサイズ(0)でヘッダーを書き込む
      outStream.write(writeWavHeader(0));

      rawOpusStream.pipe(decoder);

      decoder.on('data', (chunk) => {
        dataLength += chunk.length;
        outStream.write(chunk);
      });

      decoder.on('end', () => {
        outStream.end();
      });

      outStream.on('close', () => {
        const durationMs = Date.now() - timestamp;
        if (durationMs > 1000) {
          try {
            // 🚨 録音完了後、ファイルを上書きモードで開き、先頭44バイトのヘッダーに「実際のファイルサイズ」を書き直す
            const fd = fs.openSync(filePath, 'r+');
            fs.writeSync(fd, writeWavHeader(dataLength), 0, 44, 0);
            fs.closeSync(fd);
            
            const currentState = stateManager.getState();
            stateManager.updateState({ 
              speechLogs: [...currentState.speechLogs, { userId, phase: currentState.phase, day: currentState.day, timestamp, durationMs, audioFilePath: filePath }] 
            });
            Logger.info('VoiceService', `✅ WAV録音完了: ${fileName}`, gameId);
          } catch(e) {
            Logger.error('VoiceService', 'WAVヘッダーの更新に失敗しました', e, gameId);
          }
        } else {
          // 1秒未満のノイズは削除
          fs.unlink(filePath, () => {});
        }
      });
    });
  }

  // 2. 中継：テストで成功した「ミキサー＋餓死防止＋重複防止」を本番用として実装
  public static setupMixerRelay(listenerConnection: VoiceConnection, targetConnection: VoiceConnection, gameId: string) {
    const relayPlayer = createAudioPlayer();
    targetConnection.subscribe(relayPlayer);

    const mixer = new Mixer({ channels: 2, bitDepth: 16, sampleRate: 48000, clearInterval: 250 });
    mixer.setMaxListeners(30); // 🚨 追加：13人村＋ダミー＋余裕分 で上限を20に引き上げ
    // 生命維持（餓死防止）
    //const dummyInput = mixer.input({ channels: 2, sampleRate: 48000, volume: 100 });
    //const silenceStream = new Readable({ read() { setTimeout(() => this.push(Buffer.alloc(3840, 0)), 20); }});
    //silenceStream.pipe(dummyInput);

    relayPlayer.on(AudioPlayerStatus.Idle, () => {
      relayPlayer.play(createAudioResource(mixer, { inputType: StreamType.Raw }));
    });

    relayPlayer.play(createAudioResource(mixer, { inputType: StreamType.Raw }));

    const activeUsers = new Set<string>();
    listenerConnection.receiver.speaking.removeAllListeners('start');

    listenerConnection.receiver.speaking.on('start', (userId) => {
      if (activeUsers.has(userId)) return;
      activeUsers.add(userId);

      const opusStream = listenerConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const mixerInput = mixer.input({ channels: 2, sampleRate: 48000, volume: 100 });

      opusStream.pipe(decoder).pipe(mixerInput);
      opusStream.on('end', () => {
        mixer.removeInput(mixerInput);
        activeUsers.delete(userId);
      });
    });
  }
  public static disconnectAll(gameId: string) {
    for (const [key, connection] of this.connections.entries()) {
      if (key.startsWith(gameId)) { connection.destroy(); this.connections.delete(key); }
    }
    // 中継ルートの記憶も綺麗にリセット
    this.relayTargets.delete(gameId);
  }
// ===============================================
  // 🎛️ ミキサーテスト用：複数人の声を合成して中継する
  // ===============================================
  public static setupMixerRelayTest(listenerConnection: VoiceConnection, assistantConnection: VoiceConnection, gameId: string) {
    const relayPlayer = createAudioPlayer();
    assistantConnection.subscribe(relayPlayer);

    Logger.info('VoiceService', `🎛️ ミキサーを起動しました。音声を合成します...`, gameId);

    const mixer = new Mixer({ channels: 2, bitDepth: 16, sampleRate: 48000, clearInterval: 250 });
    mixer.setMaxListeners(30); // 🚨 追加：13人村(13)＋ダミー(1)＋余裕分 で上限を20に引き上げ

    // 🚨 安全装置1：プレイヤーを「餓死」させないための永遠の無音ストリーム
    //const dummyInput = mixer.input({ channels: 2, sampleRate: 48000, volume: 100 });
    //const silenceStream = new Readable({
    //  read() {
        // 20msごとに無音データを一生ミキサーに流し込み続ける
    //    setTimeout(() => this.push(Buffer.alloc(3840, 0)), 20);
    //  }
    //});
    //silenceStream.pipe(dummyInput);

    // プレイヤーが何らかの理由で止まってしまった場合の自動復帰処理
    relayPlayer.on(AudioPlayerStatus.Idle, () => {
      Logger.warn('MixerDebug', `⚠️ PlayerがIdleになりました。ミキサーを再接続します...`, gameId);
      relayPlayer.play(createAudioResource(mixer, { inputType: StreamType.Raw }));
    });
    relayPlayer.on('error', (err) => Logger.error('MixerDebug', `❌ Player Error`, err, gameId));

    // 最初の再生スタート
    relayPlayer.play(createAudioResource(mixer, { inputType: StreamType.Raw }));

    listenerConnection.receiver.speaking.removeAllListeners('start');

    // 🚨 安全装置2：同じユーザーの入力端子増殖を防ぐための管理リスト
    const activeUsers = new Set<string>();

    listenerConnection.receiver.speaking.on('start', (userId) => {
      // 既にこのユーザーのストリームを処理中なら、重複して作らない（増殖防止）
      if (activeUsers.has(userId)) return;
      activeUsers.add(userId);

      Logger.info('MixerDebug', `➕ Input Added: ${userId} (現在のアクティブ人数: ${activeUsers.size})`, gameId);

      const opusStream = listenerConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const mixerInput = mixer.input({ channels: 2, sampleRate: 48000, volume: 100 });

      opusStream.pipe(decoder).pipe(mixerInput);

      opusStream.on('end', () => {
        mixer.removeInput(mixerInput);
        activeUsers.delete(userId); // 終わったらリストから削除
        Logger.info('MixerDebug', `➖ Input Removed: ${userId} (現在のアクティブ人数: ${activeUsers.size})`, gameId);
      });

      decoder.on('error', (err) => Logger.error('MixerDebug', `❌ Decoder Error (${userId})`, err, gameId));
    });

    mixer.on('error', (err) => Logger.error('MixerDebug', `❌ Mixer Fatal Error`, err, gameId));
  }
}

VoiceService.init();