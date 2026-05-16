/**
 * src/managers/VCWatcher.ts
 * 定期的にVCの状態を監視し、役割の逸脱があれば自動修復する（排他制御＆再接続一本化対応版）
 */
import { Client, Guild, VoiceBasedChannel } from 'discord.js';
import { StateManager } from '../state/StateManager.js';
import { WorkerManager } from './WorkerManager.js';
import { VoiceService } from '../services/VoiceService.js';
import { ActionQueue } from '../state/ActionQueue.js';
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

  public start(gmClient: Client, assistantClient: Client) {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.checkAndFix(gmClient, assistantClient), 10000);
    Logger.system('👁️ VC状態の定期監視(排他制御対応版)を開始しました。');
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      Logger.system('👁️ VC状態の定期監視を停止しました。');
    }
  }

  private async checkAndFix(gmClient: Client, assistantClient: Client) {
    try {
      const stateManager = StateManager.getInstance();
      let state;
      try {
        state = stateManager.getState();
      } catch {
        return; 
      }

      if (!state || state.phase === 'setup' || state.phase === 'finished') return;

      // 🚨 追加：今まさにフェーズ移行（引っ越し作業）中の場合は、監視を行わずスルーする！
      if (ActionQueue.getInstance().isBusy()) {
        Logger.debug('VCWatcher', '🚚 フェーズ移行（引っ越し作業）中のため、監視をスキップします。', state.gameId);
        return;
      }

      const guild = await gmClient.guilds.fetch(state.serverId).catch(()=>null);
      if (!guild) return;

      const expected = state.expectedVcIds || {};
      const workers = WorkerManager.getInstance().getWorkers();
      const assistantId = assistantClient.user?.id;

      const assistantIsStaff = (state.relayWorkerId === assistantId || state.recorderWorkerId === assistantId);

      // ==========================================
      // A. システムBotの監視 (GM, Assistant)
      // ==========================================
      const systemBots = [
        { client: gmClient, expectedId: state.mainVcId, name: 'GM Bot' },
        { 
          client: assistantClient, 
          expectedId: assistantIsStaff ? state.mainVcId : state.ghostVcId, 
          name: assistantIsStaff ? 'Assistant Bot (スタッフ兼任)' : 'Assistant Bot' 
        }
      ];

      for (const bot of systemBots) {
        if (!bot.expectedId) continue;
        const member = await guild.members.fetch(bot.client.user!.id).catch(() => null);
        if (member && member.voice.channelId !== bot.expectedId) {
          Logger.warn('VCWatcher', `⚠️ ${bot.name} の位置が不正です(${member.voice.channelId || '未接続'} -> ${bot.expectedId})。再接続します。`, state.gameId);
          await this.reconnectBot(bot.client, guild, bot.expectedId, state.gameId, bot.name);
        }
      }

      // ==========================================
      // B. 固定スタッフの監視 (マイク, 書記)
      // ==========================================
      const staffIds = [
        { id: state.relayWorkerId, expectedId: state.mainVcId, name: '中継スタッフ(マイク)' },
        { id: state.recorderWorkerId, expectedId: state.mainVcId, name: '録音スタッフ(書記)' }
      ];

      for (const staff of staffIds) {
        if (!staff.id || staff.id === assistantId) continue; 

        const worker = workers.find(w => w.user?.id === staff.id);
        const member = await guild.members.fetch(staff.id).catch(() => null);
        
        if (worker && member && member.voice.channelId !== staff.expectedId) {
          Logger.warn('VCWatcher', `⚠️ ${staff.name} の位置が不正です(${member.voice.channelId || '未接続'} -> ${staff.expectedId})。再接続します。`, state.gameId);
          await this.reconnectBot(worker, guild, staff.expectedId, state.gameId, staff.name);
        }
      }

      // ==========================================
      // C. プレイヤーの監視 (人間 ＆ バイト参加者)
      // ==========================================
      for (const player of state.players) {
        const expectedVcId = expected[player.userId];
        if (!expectedVcId) continue;

        const member = await guild.members.fetch(player.userId).catch(() => null);
        if (!member) continue;

        const currentVcId = member.voice.channelId;

        if (currentVcId !== expectedVcId) {
          const isWorker = workers.some(w => w.user?.id === player.userId);

          if (isWorker) {
            const worker = workers.find(w => w.user?.id === player.userId)!;
            await this.reconnectBot(worker, guild, expectedVcId, state.gameId, `プレイヤー役Worker`);
          } else {
            if (currentVcId) {
               await member.voice.setChannel(expectedVcId).catch(() => {});
            }
          }
        }
      }
    } catch (error) {
      Logger.error('VCWatcher', '監視・修復プロセス中にエラーが発生しました', error);
    }
  }

  // 🚨 修正：再接続の処理を「VoiceService」に一本化（接続不整合バグを防止）
  private async reconnectBot(client: Client, guild: Guild, channelId: string, gameId: string, roleName: string) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null) as VoiceBasedChannel;
      if (channel && channel.isVoiceBased()) {
        // VoiceServiceの正規ルートを使って接続し直す
        await VoiceService.connectWithClient(client, channel, gameId, `watcher_fix_${roleName}`);
        Logger.info('VCWatcher', `🤖 [${roleName}] を正規ルートで正しいVCへ再接続させました。`, gameId);
      }
    } catch (error) {
      Logger.error('VCWatcher', `[${roleName}] の再接続に失敗しました`, error, gameId);
    }
  }
}