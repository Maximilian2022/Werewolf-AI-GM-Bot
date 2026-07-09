/**
 * src/managers/WorkerManager.ts
 * スピーカーの完全一括リネーム対応版
 */
import { Client, GatewayIntentBits, Events, VoiceBasedChannel } from 'discord.js';
import { Logger } from '../utils/logger.js';
import { VoiceService } from '../services/VoiceService.js';
import { StateManager } from '../state/StateManager.js';

export class WorkerManager {
  private static instance: WorkerManager;
  private workers: Client[] = [];

  private constructor() {}

  public static getInstance(): WorkerManager {
    if (!WorkerManager.instance) {
      WorkerManager.instance = new WorkerManager();
    }
    return WorkerManager.instance;
  }

  public async renameWorker(worker: Client, serverId: string, roleName: string | null): Promise<void> {
    try {
      const guild = await worker.guilds.fetch(serverId).catch(() => null);
      if (guild && guild.members.me) {
        const index = this.workers.findIndex(w => w.user?.id === worker.user?.id);
        if (index === -1) return;
        
        const num = String(index + 1).padStart(2, '0');
        const nickname = roleName ? `人狼ゲーム${roleName}${num}` : `人狼ゲームスタッフ${num}`;
        
        if (guild.members.me.nickname !== nickname) {
          await guild.members.me.setNickname(nickname).catch(() => {});
        }
      }
    } catch (e) {}
  }

  public async getFreeWorkers(serverId: string, playerIds: string[], neededCount: number): Promise<Client[]> {
    const freeWorkers: Client[] = [];
    let ghostVcId: string | null = null;
    try {
      const state = StateManager.getInstance().getState();
      if (state) ghostVcId = state.ghostVcId;
    } catch (e) {}

    for (const worker of this.workers) {
      if (freeWorkers.length >= neededCount) break;
      if (playerIds.includes(worker.user?.id || '')) continue; 

      try {
        const guild = await worker.guilds.fetch(serverId).catch(() => null);
        if (guild && guild.members.me) {
          const currentVcId = guild.members.me.voice.channelId;
          if (!currentVcId || currentVcId === ghostVcId) {
            freeWorkers.push(worker);
          }
        }
      } catch (e) {}
    }
    return freeWorkers;
  }

  public async adjustGhostWorkers(gameId: string, ghostVc: VoiceBasedChannel, targetCount: number, playerIds: string[]): Promise<void> {
    const guildId = ghostVc.guild.id;
    const currentWorkersInVc: Client[] = [];
    const availablePool: Client[] = [];

    for (const worker of this.workers) {
      if (playerIds.includes(worker.user?.id || '')) continue; 

      try {
        const guild = await worker.guilds.fetch(guildId).catch(() => null);
        if (guild && guild.members.me) {
          const currentVcId = guild.members.me.voice.channelId;
          if (currentVcId === ghostVc.id) {
            currentWorkersInVc.push(worker); 
          } else {
            availablePool.push(worker); 
          }
        }
      } catch (e) {}
    }

    const currentCount = currentWorkersInVc.length;

    // 🚨 修正：新しく追加するBotだけでなく、すでに霊界にいる全Botに対して「スピーカー」リネームを徹底！
    for (const worker of currentWorkersInVc) {
        await this.renameWorker(worker, guildId, 'スピーカー');
    }

    if (currentCount < targetCount) {
      const needCount = targetCount - currentCount;
      Logger.info('WorkerManager', `📈 霊界VCのWorkerが不足しています（現在: ${currentCount}/${targetCount}体）。${needCount} 体を補充します...`, gameId);
      
      for (let i = 0; i < needCount; i++) {
        if (availablePool.length === 0) break;
        const workerToJoin = availablePool.shift()!;
        try {
          await VoiceService.connectWithClient(workerToJoin, ghostVc, gameId, `relay_ghost_add_${i}`);
          await this.renameWorker(workerToJoin, guildId, 'スピーカー');
          await new Promise(resolve => setTimeout(resolve, 1000));
          Logger.success('WorkerManager', `➕ ${workerToJoin.user?.tag} が霊界VC [${ghostVc.name}] に入室しました`, gameId);
        } catch (e) {
          Logger.error('WorkerManager', `${workerToJoin.user?.tag} の霊界VC入室に失敗しました`, e, gameId);
        }
      }
    } 
    else if (currentCount > targetCount) {
      const surplusCount = currentCount - targetCount;
      Logger.info('WorkerManager', `📉 霊界VCのWorkerが過剰です（現在: ${currentCount}/${targetCount}体）。${surplusCount} 体を退出させます...`, gameId);
      
      for (let i = 0; i < surplusCount; i++) {
        const workerToLeave = currentWorkersInVc.pop()!;
        try {
          const wGuild = await workerToLeave.guilds.fetch(guildId);
          await wGuild.members.me?.voice.disconnect();
          await this.renameWorker(workerToLeave, guildId, null);
          Logger.success('WorkerManager', `➖ ${workerToLeave.user?.tag} が霊界から退出しました`, gameId);
        } catch (e) {}
      }
    }
  }

  public async init(tokens: string[]): Promise<void> {
    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers];
    Logger.info('WorkerManager', `${tokens.length}体のバイト（Worker）Botの起動シーケンスを開始します...`);

    const loginPromises = tokens.map(async (token, index) => {
      const client = new Client({ intents });
      try {
        await client.login(token);
        this.workers.push(client);
      } catch (error) {
        Logger.error('WorkerManager', `[Worker ${index + 1}] のログインに失敗しました。`, error);
      }
    });

    await Promise.all(loginPromises);
    Logger.success('WorkerManager', `合計 ${this.workers.length} 体のバイトBotが出勤（待機状態）しました。`);
  }

  public getWorkers(): Client[] { return this.workers; }
  public getWorkerCount(): number { return this.workers.length; }
  public getWorkerByIndex(index: number): Client | null {
    if (this.workers.length === 0) return null;
    return this.workers[index % this.workers.length];
  }

  public destroyAll(): void {
    for (const worker of this.workers) {
      try { worker.destroy(); } catch (e) {}
    }
    this.workers = [];
  }
}