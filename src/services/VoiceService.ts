// @ts-nocheck
/**
 * src/services/VoiceService.ts
 * 超高速ハイブリッド音声ルーター（残骸キュー隔離退避 ＆ 独立並行バッチ再生 搭載版）
 */
import { 
  joinVoiceChannel, VoiceConnection, VoiceConnectionStatus, entersState, EndBehaviorType, NoSubscriberBehavior,
  createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, generateDependencyReport
} from '@discordjs/voice';
import { VoiceBasedChannel, Client } from 'discord.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as prism from 'prism-media';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream'; 
import { StateManager } from '../state/StateManager.js';
import { Logger } from '../utils/logger.js';
import { WorkerManager } from '../managers/WorkerManager.js';

// 中継キュー用データ構造
interface AudioQueueItem {
  userId: string;
  filePath: string; 
  durationMs: number;
}

// 霊界ルーターの状態管理
class RelayRouter {
  public gameId: string;
  public ghostVcId: string;
  public queue: AudioQueueItem[] = [];          // 本口座：現行フェーズ用キュー
  public oldQueue: AudioQueueItem[] = [];       // 🚨 退避口座：旧フェーズ残骸用キュー
  public activeDirectStreams = new Set<string>();
  public flushTimer: NodeJS.Timeout | null = null;

  constructor(gameId: string, ghostVcId: string) {
    this.gameId = gameId;
    this.ghostVcId = ghostVcId;
  }
}

export class VoiceService {
  private static connections = new Map<string, VoiceConnection>();
  private static readonly AUDIO_DIR = path.join(process.cwd(), 'data', 'audio'); 
  private static readonly TMP_DIR = '/tmp/werewolf_relay'; 
  private static routers = new Map<string, RelayRouter>();

  public static getConnection(gameId: string, clientId: string): VoiceConnection | undefined {
    return this.connections.get(`${gameId}_${clientId}`);
  }

  public static init() {
    if (!fs.existsSync(this.AUDIO_DIR)) fs.mkdirSync(this.AUDIO_DIR, { recursive: true });
    if (!fs.existsSync(this.TMP_DIR)) fs.mkdirSync(this.TMP_DIR, { recursive: true }); 
    Logger.system(`\n=== 🎙️ Voice Dependency Report ===\n${generateDependencyReport()}\n==================================`);
  }

  public static async connectWithClient(client: Client, channel: VoiceBasedChannel, gameId: string, vcType: string, retryCount = 0): Promise<VoiceConnection> {
    const connectionKey = `${gameId}_${client.user?.id}`; 
    if (this.connections.has(connectionKey)) {
        const existing = this.connections.get(connectionKey)!;
        if (existing.state.status !== VoiceConnectionStatus.Destroyed && 
            existing.state.status !== VoiceConnectionStatus.Disconnected && 
            existing.joinConfig.channelId === channel.id) {
            return existing;
        }
    }
    Logger.info('VoiceService', `🔄 [${client.user?.tag}] が [${channel.name}] に接続(または移動)します...`, gameId);

    let adapterCreator: any;
    try {
      const myGuild = await client.guilds.fetch(channel.guild.id);
      adapterCreator = myGuild.voiceAdapterCreator;
    } catch (e) { throw e; }

    let connection: VoiceConnection;
    try {
      connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator, selfDeaf: false, selfMute: false, group: client.user?.id });
    } catch (err) { throw err; }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.connections.set(connectionKey, connection);
      try {
        const myGuild = await client.guilds.fetch(channel.guild.id);
        const myMember = myGuild.members.me;
        if (myMember?.voice.serverMute) await myMember.voice.setMute(false);
      } catch (e) {}
      return connection;
    } catch (error) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) try { connection.destroy(); } catch (e) {}
      this.connections.delete(connectionKey);
      if (retryCount < 2) {
        await new Promise(r => setTimeout(r, 2500));
        return this.connectWithClient(client, channel, gameId, vcType, retryCount + 1);
      }
      throw error;
    }
  }

  public static async playAudio(connection: VoiceConnection, filePath: string, gameId: string, timeoutMs = 45000): Promise<void> {
    if (!filePath) return;
    return new Promise(async (resolve) => {      
      if (connection.state.status === VoiceConnectionStatus.Disconnected) {
          try { 
            connection.rejoin(); 
            await entersState(connection, VoiceConnectionStatus.Connecting, 5000); 
            (connection as any)._hasPlayedOnce = false;
          } catch (e) {}
      }
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      
      // 途切れ対策 (CPU負荷軽減): inlineVolume を false にして変換のオーバーヘッドを無くす
      const resource = createAudioResource(filePath, { inlineVolume: false });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 5000).catch(() => {});
        connection.subscribe(player);
        (connection as any)._isBusy = true;
        
        // 初回接続時のみクライアント同期待ち(500ms)、安定接続時は安全マージン(300ms)として頭切れを完全防止しつつ快適なテンポを両立
        const waitMs = (connection as any)._hasPlayedOnce ? 300 : 500;
        await new Promise(r => setTimeout(r, waitMs));
        (connection as any)._hasPlayedOnce = true;
        
        player.play(resource);
      } catch (err) { 
        (connection as any)._isBusy = false;
        try { player.removeAllListeners(); } catch {}
        resolve(); 
        return; 
      }
      
      let isResolved = false;
      const finish = () => {
        if (!isResolved) {
          isResolved = true;
          (connection as any)._isBusy = false;
          clearTimeout(timeout);
          try { player.removeAllListeners(); } catch {}
          resolve();
        }
      };
      const timeout = setTimeout(() => {
          if (!isResolved) { 
            isResolved = true; 
            (connection as any)._isBusy = false; 
            try { player.stop(); } catch (e) {}
            try { player.removeAllListeners(); } catch {}
            resolve(); 
          }
      }, timeoutMs);
      player.on(AudioPlayerStatus.Idle, finish);
      player.on('error', finish);
    });
  }

  public static async broadcastAudio(connections: VoiceConnection[], filePath: string, gameId: string): Promise<void> {
    const validConnections = connections.filter(c => c && c.state.status !== VoiceConnectionStatus.Destroyed);
    const promises = validConnections.map(conn => this.playAudio(conn, filePath, gameId));
    await Promise.all(promises);
  }

  // ===============================================
  // 🎙️ 録音処理（生中継 ＆ tmpfs同時バックグラウンドWAV書き込み）
  // ===============================================
  public static startRecording(connection: VoiceConnection, gameId: string) {
    if ((connection as any)._isListening) return;
    (connection as any)._isListening = true;

    const receiver = connection.receiver;
    const stateManager = StateManager.getInstance();
    
    receiver.speaking.on('start', (userId) => {
      let state;
      try { state = stateManager.getState(); } catch { return; }
      
      const currentListeningVcId = connection.joinConfig.channelId;
      if (currentListeningVcId && currentListeningVcId !== state.mainVcId) return; 

      const player = state.players.find(p => p.userId === userId);
      if (!player || !player.isAlive) return;

      const rawOpusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      const router = this.routers.get(gameId);

      // --- [A. リアルタイム生中継の直結チェック] ---
      let assignedDirectWorker: Client | null = null;
      let assignedDirectConn: VoiceConnection | null = null;
      let directStream: PassThrough | null = null;

      // 🚨 修正：isFlushing によるインプット全体のロックを完全撤廃
      if (router) {
         const availableWorkers = WorkerManager.getInstance().getWorkers().filter(w => {
            const connKey = `${gameId}_${w.user?.id}`;
            const conn = this.connections.get(connKey);
            return conn && conn.joinConfig.channelId === router.ghostVcId && !(conn as any)._isBusy;
         });

         if (availableWorkers.length > 2) {
             assignedDirectWorker = availableWorkers[0];
             assignedDirectConn = this.connections.get(`${gameId}_${assignedDirectWorker.user?.id}`)!;
             (assignedDirectConn as any)._isBusy = true; 
             router.activeDirectStreams.add(userId);
             
             Logger.info('VoiceRelay', `🟢 リアルタイム中継開始: ${state.players.find(p=>p.userId===userId)?.role || userId} -> ${assignedDirectWorker.user?.tag} を直結 (空きBot残り: ${availableWorkers.length - 1}体)`, gameId);

             const directPlayer = createAudioPlayer();
             assignedDirectConn.subscribe(directPlayer);
             directStream = new PassThrough(); 
             directPlayer.play(createAudioResource(directStream, { inputType: StreamType.Raw }));

             rawOpusStream.on('end', () => {
                 setTimeout(() => { 
                     if (assignedDirectConn) (assignedDirectConn as any)._isBusy = false;
                     router.activeDirectStreams.delete(userId);
                     Logger.info('VoiceRelay', `🔀 ${userId} が話し終えたため ${assignedDirectWorker?.user?.tag} が解放されました。`, gameId);
                     this.processOldRelayQueue(gameId); // 解放時は常に旧口座から優先消化
                     this.processRelayQueue(gameId); 
                 }, 1000);
             });
         } else if (availableWorkers.length <= 2 && availableWorkers.length > 0) {
             Logger.warn('VoiceRelay', `⚠️ 空きBotが残り ${availableWorkers.length}体 となったため、防衛モード（キュー録音）を発動します。`, gameId);
         }
      }

      if (router && !directStream) {
         Logger.info('VoiceRelay', `📥 発言を検知: ${userId} -> リアルタイム中継を保留し、裏側(tmpfs)でバッファ録音を開始します。`, gameId);
      }

      // --- [B. 録音処理 (常にtmpfsの一時メモリ領域へ)] ---
      const timestamp = Date.now();
      const fileNameWav = `${gameId}_${state.phase}_day${state.day}_${userId}_${timestamp}.wav`;
      const fileNameMp3 = `${gameId}_${state.phase}_day${state.day}_${userId}_${timestamp}.mp3`;
      const tmpFilePath = path.join(this.TMP_DIR, fileNameWav); 
      const permFilePath = path.join(this.AUDIO_DIR, fileNameMp3); 
      
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const outStream = fs.createWriteStream(tmpFilePath);
      let dataLength = 0;

      const writeWavHeader = (length: number) => {
        const buffer = Buffer.alloc(44);
        buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length, 4); buffer.write('WAVE', 8);
        buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); 
        buffer.writeUInt16LE(2, 22); buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(48000 * 2 * 2, 28); 
        buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(length, 40);
        return buffer;
      };
      
      outStream.write(writeWavHeader(0));
      rawOpusStream.pipe(decoder);

      decoder.on('data', (chunk) => { 
        dataLength += chunk.length; 
        outStream.write(chunk); 
        if (directStream) directStream.write(chunk); 
      });
      
      decoder.on('end', () => {
        outStream.end();
        if (directStream) directStream.end(); 
      });

      outStream.on('close', () => {
        const durationMs = Date.now() - timestamp;
        if (durationMs > 1000) {
          try {
            const fd = fs.openSync(tmpFilePath, 'r+');
            fs.writeSync(fd, writeWavHeader(dataLength), 0, 44, 0);
            fs.closeSync(fd);
            
            this.convertWavToMp3(tmpFilePath, permFilePath).then(() => {
                stateManager.updateState({ 
                  speechLogs: [...stateManager.getState().speechLogs, { 
                    userId, phase: state.phase, day: state.day, timestamp, durationMs, audioFilePath: permFilePath 
                  }] 
                });
                if (directStream) fs.unlink(tmpFilePath, () => {});
            }).catch(e => {
                Logger.error('VoiceService', 'MP3への圧縮変換に失敗したため、WAVフォールバックを行います。', e, gameId);
                const permWavPath = permFilePath.replace('.mp3', '.wav');
                fs.promises.copyFile(tmpFilePath, permWavPath).then(() => {
                    stateManager.updateState({ 
                      speechLogs: [...stateManager.getState().speechLogs, { 
                        userId, phase: state.phase, day: state.day, timestamp, durationMs, audioFilePath: permWavPath 
                      }] 
                    });
                    if (directStream) fs.unlink(tmpFilePath, () => {});
                }).catch(err => Logger.error('VoiceService', 'フォールバックWAVコピーにも失敗', err, gameId));
            });
            
            // 🚨 修正：防衛モード時は、現行の本口座(queue)に確実にプッシュ
            if (router && !directStream) {
               router.queue.push({ userId, filePath: tmpFilePath, durationMs });
               const totalQueueMs = router.queue.reduce((acc, i) => acc + i.durationMs, 0);
               Logger.info('VoiceRelay', `📥 録音完了(tmpfs): ${userId} (長さ: ${(durationMs/1000).toFixed(1)}秒) -> キューに追加しました (現在滞留: ${(totalQueueMs/1000).toFixed(1)}秒)`, gameId);
               this.processOldRelayQueue(gameId); // 古い残骸の処理があれば優先駆動
               this.processRelayQueue(gameId);
            }
          } catch(e) { Logger.error('VoiceService', 'WAVヘッダー修復エラー', e, gameId); }
        } else { fs.unlink(tmpFilePath, () => {}); if (directStream) directStream.end(); }
      });
    });
  }

  public static setupDynamicRelay(ghostVcId: string, gameId: string) {
    if (!this.routers.has(gameId)) {
        this.routers.set(gameId, new RelayRouter(gameId, ghostVcId));
        Logger.info('VoiceService', `🎧 ハイブリッド中継ルーターをセットアップしました`, gameId);
    }
  }

  // ===============================================
  // 🎛️ 本口座（現行フェーズ用）キューのおまとめバッチ再生
  // ===============================================
  private static processRelayQueue(gameId: string) {
    const router = this.routers.get(gameId);
    if (!router || router.queue.length === 0) return;

    // 旧口座（残骸）にまだ未処理のものがある場合は、優先順位設計に基づき、そちらの処理に譲る
    if (router.oldQueue.length > 0) {
        this.processOldRelayQueue(gameId);
        return;
    }

    const availableWorkers = WorkerManager.getInstance().getWorkers().filter(w => {
        const connKey = `${gameId}_${w.user?.id}`;
        const conn = this.connections.get(connKey);
        return conn && conn.joinConfig.channelId === router.ghostVcId && !(conn as any)._isBusy;
    });

    if (availableWorkers.length === 0) return; 

    const workerToUse = availableWorkers[0];
    const workerConn = this.connections.get(`${gameId}_${workerToUse.user?.id}`)!;
    (workerConn as any)._isBusy = true; 

    const itemsToConcat: AudioQueueItem[] = [];
    while (router.queue.length > 0) {
        itemsToConcat.push(router.queue.shift()!);
    }

    const totalQueueMs = itemsToConcat.reduce((acc, i) => acc + i.durationMs, 0);
    let speed = 1.0;
    if (totalQueueMs > 40000) { speed = 1.5; } 
    else if (totalQueueMs > 20000) { speed = 1.25; }

    if (speed > 1.0) {
       Logger.warn('RelayQueue', `⚠️ キュー滞留が20秒を超えました(${(totalQueueMs/1000).toFixed(1)}秒)。${speed}倍速でおまとめキャッチアップ再生を開始します。`, gameId);
    }

    const listFileName = `list_${gameId}_${Date.now()}.txt`;
    const listFilePath = path.join(this.TMP_DIR, listFileName);
    const listContent = itemsToConcat.map(item => `file '${item.filePath}'`).join('\n');
    fs.writeFileSync(listFilePath, listContent, 'utf-8');

    Logger.info('RelayQueue', `🤖 ${workerToUse.user?.tag} が現フェーズの発言 ${itemsToConcat.length}件 (計 ${(totalQueueMs/1000).toFixed(1)}秒) を1本のストリームにまとめて ${speed}倍速 で再生開始します。`, gameId);

    const ffmpeg = spawn('ffmpeg', [
        '-f', 'concat',
        '-safe', '0',
        '-i', listFilePath,
        '-filter:a', `atempo=${speed}`,
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);

    const player = createAudioPlayer();
    workerConn.subscribe(player);
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        try {
            if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
            for (const item of itemsToConcat) {
                if (fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
            }
        } catch (e) { Logger.error('RelayQueue', 'tmpfsのクリーンアップ中にエラー', e, gameId); }

        setTimeout(() => { 
            (workerConn as any)._isBusy = false; 
            this.processOldRelayQueue(gameId);
            this.processRelayQueue(gameId); 
        }, 1000); 
    });
    
    player.on('error', (err) => { 
        Logger.error('RelayQueue', 'FFmpegおまとめ再生中にプレイヤーエラー', err, gameId);
        (workerConn as any)._isBusy = false; 
        this.processOldRelayQueue(gameId);
        this.processRelayQueue(gameId); 
    });
  }

  // ===============================================
  // 🚨 🎛️ 退避口座（旧フェーズの残骸用）の独立並行バッチ再生
  // ===============================================
  private static processOldRelayQueue(gameId: string) {
    const router = this.routers.get(gameId);
    if (!router || router.oldQueue.length === 0) return;

    const availableWorkers = WorkerManager.getInstance().getWorkers().filter(w => {
        const connKey = `${gameId}_${w.user?.id}`;
        const conn = this.connections.get(connKey);
        return conn && conn.joinConfig.channelId === router.ghostVcId && !(conn as any)._isBusy;
    });

    if (availableWorkers.length === 0) return; 

    const workerToUse = availableWorkers[0];
    const workerConn = this.connections.get(`${gameId}_${workerToUse.user?.id}`)!;
    (workerConn as any)._isBusy = true; 

    // 退避口座に残っているアイテムをすべて全引き抜き
    const itemsToConcat = [...router.oldQueue];
    router.oldQueue = []; 

    const totalQueueMs = itemsToConcat.reduce((acc, i) => acc + i.durationMs, 0);
    let speed = 1.0;
    if (totalQueueMs > 40000) { speed = 1.5; } 
    else if (totalQueueMs > 20000) { speed = 1.25; }

    const listFileName = `list_old_${gameId}_${Date.now()}.txt`;
    const listFilePath = path.join(this.TMP_DIR, listFileName);
    const listContent = itemsToConcat.map(item => `file '${item.filePath}'`).join('\n');
    fs.writeFileSync(listFilePath, listContent, 'utf-8');

    Logger.info('RelayQueue', `🤖 [古い残骸処理] ${workerToUse.user?.tag} が旧フェーズの残存バッファ ${itemsToConcat.length}件 (計 ${(totalQueueMs/1000).toFixed(1)}秒) を ${speed}倍速 で裏側並行再生します。`, gameId);

    const ffmpeg = spawn('ffmpeg', [
        '-f', 'concat',
        '-safe', '0',
        '-i', listFilePath,
        '-filter:a', `atempo=${speed}`,
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);

    const player = createAudioPlayer();
    workerConn.subscribe(player);
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    player.play(resource);

    player.on(AudioPlayerStatus.Idle, () => {
        try {
            if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
            for (const item of itemsToConcat) {
                if (fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
            }
        } catch (e) {}

        setTimeout(() => { 
            (workerConn as any)._isBusy = false; 
            this.processOldRelayQueue(gameId); // 自分が空いたら旧口座➔新口座の順でキック
            this.processRelayQueue(gameId); 
        }, 1000); 
    });
    
    player.on('error', (err) => { 
        Logger.error('RelayQueue', 'FFmpeg旧口座バッチ再生中にプレイヤーエラー', err, gameId);
        (workerConn as any)._isBusy = false; 
        this.processOldRelayQueue(gameId);
        this.processRelayQueue(gameId); 
    });
  }

  // ===============================================
  // 🧹 フェーズ移行時の制御（移行前残骸キューの隔離退避）
  // ===============================================
  public static handlePhaseTransition(gameId: string, newPhase: string) {
    const router = this.routers.get(gameId);
    if (!router) return;

    Logger.info('PhaseHandler', `🚚 フェーズが [${newPhase}] に移行しました。現行中継キューを別口座へ隔離退避し、90秒猶予タイマーを開始します。`, gameId);
    
    if (router.flushTimer) clearTimeout(router.flushTimer);

    // 🚨 【口座の分離】現在のキューに溜まっている残骸を一瞬で oldQueue に隔離
    if (router.queue.length > 0) {
        this.cleanupOldQueue(router); // 前々回の残骸が万が一残っていれば大掃除
        
        router.oldQueue = [...router.queue];
        router.queue = []; // 本口座は即座にゼロになり、新フェーズのインプット受付を即時開始！
        
        this.processOldRelayQueue(gameId); // 隔離した残骸の再生タスクを即座にキック
    }

    // 90秒の時限爆弾は「退避口座(oldQueue)」だけを標的にして起爆する（本口座には指一本触れない）
    router.flushTimer = setTimeout(() => {
        const remainingQueue = router.oldQueue.length;
        const remainingMs = router.oldQueue.reduce((acc, i) => acc + i.durationMs, 0);
        
        if (remainingQueue > 0) {
            this.cleanupOldQueue(router);
            Logger.info('RelayQueue', `🧹 90秒が経過しました。未再生の古いフェーズ残存バッファ(${remainingQueue}件 / ${(remainingMs/1000).toFixed(1)}秒)をtmpfsから強制破棄しました（現行新フェーズの中継には一切干渉しません）。`, gameId);
        }
        router.flushTimer = null;
    }, 90000);
  }

  /**
   * 退避口座の物理ファイル削除ヘルパー
   */
  private static cleanupOldQueue(router: RelayRouter) {
    for (const item of router.oldQueue) {
        if (fs.existsSync(item.filePath)) {
            try { fs.unlinkSync(item.filePath); } catch(e) {}
        }
    }
    router.oldQueue = [];
  }

  //特定のクライアントのVoiceConnectionを名指しで強制破壊し、盗聴(リスナー)を完全リセットする
  public static disconnectClient(client: Client, gameId: string) {
    const connectionKey = `${gameId}_${client.user?.id}`;
    if (this.connections.has(connectionKey)) {
        this.connections.get(connectionKey)!.destroy();
        this.connections.delete(connectionKey);
        Logger.debug('VoiceService', `🔌 ${client.user?.tag} の音声コネクションを強制破棄し、リスナーをリセットしました。`, gameId);
    }
  }

  public static disconnectAll(gameId: string) {
    for (const [key, connection] of this.connections.entries()) {
      if (key.startsWith(gameId)) { connection.destroy(); this.connections.delete(key); }
    }
    const router = this.routers.get(gameId);
    if (router) {
        if (router.flushTimer) clearTimeout(router.flushTimer);
        for (const item of router.queue) {
            if (fs.existsSync(item.filePath)) try { fs.unlinkSync(item.filePath); } catch(e) {}
        }
        this.cleanupOldQueue(router); // 退避口座も一掃
    }
    this.routers.delete(gameId);
  }

  private static async convertWavToMp3(wavPath: string, mp3Path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('nice', [
        '-n', '10',
        'ffmpeg',
        '-y',
        '-i', wavPath,
        '-codec:a', 'libmp3lame',
        '-b:a', '32k',
        '-ac', '1',
        '-ar', '24000',
        mp3Path
      ]);
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      ffmpeg.on('error', (err) => reject(err));
    });
  }
}
VoiceService.init();