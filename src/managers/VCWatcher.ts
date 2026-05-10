/**
 * src/managers/VCWatcher.ts
 * 定期的にVCの状態を監視し、台帳(Expected)と乖離があれば自動修復するクラス
 */
import { Client, Guild } from 'discord.js';
import { StateManager } from '../state/StateManager';
import { WorkerManager } from './WorkerManager';
import { Logger } from '../utils/logger';

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

  public start(gmClient: Client) {
    if (this.intervalId) return;
    // 10秒ごとに監視を実行
    this.intervalId = setInterval(() => this.checkAndFix(gmClient), 10000);
    Logger.system('👁️ VC状態の定期監視(Watcher)を開始しました。');
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      Logger.system('👁️ VC状態の定期監視を停止しました。');
    }
  }

  private async checkAndFix(gmClient: Client) {
    try {
      const stateManager = StateManager.getInstance();
      let state;
      
      // 🚨 修正: まだゲームが始まっていない場合はエラーを握りつぶしてスキップする
      try {
        state = stateManager.getState();
      } catch {
        return; 
      }

      if (!state || state.phase === 'setup' || state.phase === 'finished') return;

      const guild = await gmClient.guilds.fetch(state.serverId);
      if (!guild) return;

      const expected = state.expectedVcIds || {};
      const workers = WorkerManager.getInstance().getWorkers();

      for (const player of state.players) {
        const expectedVcId = expected[player.userId];
        if (!expectedVcId) continue;

        const member = await guild.members.fetch(player.userId).catch(() => null);
        if (!member) continue;

        const currentVcId = member.voice.channelId;

        if (currentVcId !== expectedVcId) {
          Logger.warn('VCWatcher', `乖離検知: ${member.user.tag} (現在: ${currentVcId || '未接続'} -> 目標: ${expectedVcId})`, state.gameId);

          const isWorker = workers.some(w => w.user?.id === player.userId);

          if (isWorker) {
            const worker = workers.find(w => w.user?.id === player.userId)!;
            const workerGuild = await worker.guilds.fetch(guild.id);
            const workerChannel = await workerGuild.channels.fetch(expectedVcId);
            
            if (workerChannel && workerChannel.isVoiceBased()) {
              const { joinVoiceChannel } = require('@discordjs/voice');
              joinVoiceChannel({
                channelId: workerChannel.id,
                guildId: workerGuild.id,
                adapterCreator: workerGuild.voiceAdapterCreator,
                group: worker.user?.id,
                selfDeaf: false,
                selfMute: false
              });
              Logger.info('VCWatcher', `🤖 Workerを正しいVCへ再接続させました: ${member.user.tag}`, state.gameId);
            }
          } else {
            if (currentVcId) {
               await member.voice.setChannel(expectedVcId).catch(() => {});
               Logger.info('VCWatcher', `👤 プレイヤーを正しいVCへ移動させました: ${member.user.tag}`, state.gameId);
            }
          }
        }
      }
    } catch (error) {
      Logger.error('VCWatcher', '監視・修復プロセス中にエラーが発生しました', error);
    }
  }
}