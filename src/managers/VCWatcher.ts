/**
 * src/managers/VCWatcher.ts
 * 定期的にVCの状態を監視し、役割の逸脱があれば自動修復する（スタッフ優先度プロテクション対応完全版）
 */
import { Client, Guild, VoiceBasedChannel } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { StateManager } from '../state/StateManager.js';
import { WorkerManager } from './WorkerManager.js';
import { VoiceService } from '../services/VoiceService.js';
import { Logger } from '../utils/logger.js';

export class VCWatcher {
  private static instance: VCWatcher;
  private intervalId: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): VCWatcher {
    if (!VCWatcher.instance) {
      VCWatcher.instance = new VCWatcher();
    }
    return VCWatcher.instance;
  }

  /**
   * 定期監視の開始（10秒ごとにサーバー全体のVC状態をスキャン）
   */
  public start(gmClient: Client, assistantClient: Client) {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.checkAndFix(gmClient, assistantClient), 10000);
    Logger.system('👁️ VC状態の定期監視を開始しました。');
  }

  /**
   * 定期監視の停止
   */
  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      Logger.system('👁️ VC状態の定期監視を停止しました。');
    }
  }

  private async checkAndFix(gmClient: Client, assistantClient: Client) {
    const stateManager = StateManager.getInstance();
    let state;
    try {
      state = stateManager.getState();
    } catch {
      return; // ゲーム開始前またはStateがない場合は即エスケープ
    }

    // 準備中、または終了時は監視をスキップ
    if (!state || state.phase === 'setup' || state.phase === 'finished') return;

    try {
      const guild = await gmClient.guilds.fetch(state.serverId).catch(() => null);
      if (!guild) return;

      const workers = WorkerManager.getInstance().getWorkers();
      const expected = state.expectedVcIds || {};

      // ===============================================
      // 1. プレイヤー（人間 ＆ プレイヤー役Worker）の監視・修復
      // ===============================================
      for (const player of state.players) {
        const expectedVcId = expected[player.userId];
        if (!expectedVcId) continue;

        const member = await guild.members.fetch(player.userId).catch(() => null);
        if (!member) continue;

        const currentVcId = member.voice.channelId;

        if (currentVcId !== expectedVcId) {
          const isWorker = workers.some(w => w.user?.id === player.userId);

          if (isWorker) {
            // プレイヤーを演じているWorkerが落ちていたら正規ルートで再接続
            const worker = workers.find(w => w.user?.id === player.userId)!;
            await this.reconnectBot(worker, guild, expectedVcId, state.gameId, `player_worker`);
          } else {
            // 人間のプレイヤーが意図せず部屋を出ていたら、VCに接続している場合のみ強制送還
            if (currentVcId) {
               await member.voice.setChannel(expectedVcId).catch(() => {});
            }
          }
        }
      }

      // ===============================================
      // 2. アシスタントBot（霊界でのシステム音声転送専任）の監視・修復
      // ===============================================
      const astGuild = await assistantClient.guilds.fetch(state.serverId).catch(() => null);
      if (astGuild && astGuild.members.me) {
        const astCurrentVcId = astGuild.members.me.voice.channelId;
        
        if (astCurrentVcId !== state.ghostVcId) {
          Logger.warn('VCWatcher', `⚠️ アシスタントBotが霊界VCから逸脱しています。再接続を実行します。`, state.gameId);
          await this.reconnectBot(assistantClient, astGuild, state.ghostVcId, state.gameId, `assistant_ghost`);
        }
      }

      // ===============================================
      // 3. 中継用WorkerBot（霊界スピーカープール）の監視・セルフヒーリング
      // ===============================================
      const playerIds = state.players.map(p => p.userId);
      const currentGhostWorkers: Client[] = [];
      const availableWorkersPool: Client[] = [];

      // 全Workerの状態をスキャン
      for (const worker of workers) {
        const workerId = worker.user?.id;
        if (!workerId) continue;

        if (playerIds.includes(workerId)) continue; 
        if (workerId === state.recorderWorkerId) continue; 

        // 🚨 【再生保護】音声再生中（または待機中）のBotも対象外（保護）にする
        const conn = VoiceService.getConnection(state.gameId, workerId);
        if (conn && (conn as any)._isBusy) continue;

        const wGuild = await worker.guilds.fetch(state.serverId).catch(() => null);
        if (wGuild && wGuild.members.me) {
          const currentVcId = wGuild.members.me.voice.channelId;
          if (currentVcId === state.ghostVcId) {
            currentGhostWorkers.push(worker); // 正常に霊界で待機・稼働中
          } else {
            // 🚨 ここで前夜の役職待機部屋に取り残されたBot、あるいは完全フリーなBotが
            // 「安全に回収・再利用可能なプール」として集約されます（優先度設計の準拠）
            availableWorkersPool.push(worker); 
          }
        }
      }

      // 本来、現在の生存者数に応じて霊界に配備されているべき目標数（最大8体キャップ）
      const alivePlayersCount = state.players.filter(p => p.isAlive).length;
      const targetWorkerCount = Math.min(alivePlayersCount, 8);

      // 霊界VCの中継スタッフが不足していたら、保護リスト外のプールから安全に補充
      if (currentGhostWorkers.length < targetWorkerCount) {
        const neededCount = targetWorkerCount - currentGhostWorkers.length;
        Logger.warn('VCWatcher', `⚠️ 霊界VCの中継Workerが不足しています（現在: ${currentGhostWorkers.length}/${targetWorkerCount}体）。プロテクション保護外のスタッフから自動修復を開始します。`, state.gameId);

        for (let i = 0; i < neededCount; i++) {
          if (availableWorkersPool.length === 0) break;
          const workerToRestore = availableWorkersPool.shift()!;
          try {
            const wGuild = await workerToRestore.guilds.fetch(state.serverId);
            const ghostVc = await wGuild.channels.fetch(state.ghostVcId).catch(() => null) as VoiceBasedChannel;
            
            if (ghostVc && ghostVc.isVoiceBased()) {
              await VoiceService.connectWithClient(workerToRestore, ghostVc, state.gameId, `watcher_fix_relay_${i}`);
              Logger.success('VCWatcher', `🤖 [${workerToRestore.user?.tag}] を霊界VC [${ghostVc.name}] へ安全に再配備しました（マイク・書記は保護されています）。`, state.gameId);
            }
          } catch (e) {
            Logger.error('VCWatcher', `中継Workerの復旧に失敗しました`, e, state.gameId);
          }
        }
      }

      // ===============================================
      // 4. 昼議論中の重要管理Bot（GM Bot, マイクBot, 書記Bot）の監視・修復
      // ===============================================
      if (state.phase === 'day_discussion') {
        const mainVc = await guild.channels.fetch(state.mainVcId).catch(() => null) as VoiceBasedChannel | null;
        if (mainVc && mainVc.isVoiceBased()) {
          // A. GM Botの接続監視と修復
          const gmConnection = VoiceService.getConnection(state.gameId, gmClient.user?.id || '');
          const isGmDisconnected = !gmConnection || 
                                   gmConnection.state.status === VoiceConnectionStatus.Disconnected || 
                                   gmConnection.state.status === VoiceConnectionStatus.Destroyed;
          if (isGmDisconnected) {
            Logger.warn('VCWatcher', `⚠️ GM BotがメインVCから切断されています。再接続および録音再開(書記不在時)を試みます。`, state.gameId);
            const newConn = await this.reconnectBot(gmClient, guild, state.mainVcId, state.gameId, 'gm');
            if (newConn && !state.recorderWorkerId) {
              VoiceService.startRecording(newConn, state.gameId);
            }
          }

          // B. 書記Botの接続監視と修復
          if (state.recorderWorkerId) {
            const recorderClient = workers.find(w => w.user?.id === state.recorderWorkerId);
            if (recorderClient) {
              const recConnection = VoiceService.getConnection(state.gameId, state.recorderWorkerId);
              const isRecDisconnected = !recConnection || 
                                       recConnection.state.status === VoiceConnectionStatus.Disconnected || 
                                       recConnection.state.status === VoiceConnectionStatus.Destroyed;
              if (isRecDisconnected) {
                Logger.warn('VCWatcher', `⚠️ 書記BotがメインVCから切断されています。再接続および録音の再開を行います。`, state.gameId);
                const newConn = await this.reconnectBot(recorderClient, guild, state.mainVcId, state.gameId, 'recorder');
                if (newConn) {
                  VoiceService.startRecording(newConn, state.gameId);
                }
              }
            }
          }

          // マイクBotの接続監視・修復処理は廃止されました
        }
      }

    } catch (error) {
      Logger.error('VCWatcher', '監視・修復プロセス中にエラーが発生しました', error);
    }
  }

  private async reconnectBot(client: Client, guild: Guild, channelId: string, gameId: string, roleName: string): Promise<any> {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null) as VoiceBasedChannel;
      if (channel && channel.isVoiceBased()) {
        const conn = await VoiceService.connectWithClient(client, channel, gameId, `watcher_fix_${roleName}`);
        Logger.info('VCWatcher', `🤖 [${client.user?.tag}] を [${channel.name}] へ自動修復接続しました。`, gameId);
        return conn;
      }
    } catch (e) {
      Logger.error('VCWatcher', `Bot [${client.user?.id}] の再接続に失敗しました`, e, gameId);
    }
    return null;
  }
}