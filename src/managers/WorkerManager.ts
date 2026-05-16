/**
 * src/managers/WorkerManager.ts
 * 複数のバイト（Worker）Botを管理し、並列処理の基盤を提供するクラス
 */
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { Logger } from '../utils/logger.js';

export class WorkerManager {
  private static instance: WorkerManager;
  private workers: Client[] = [];

  private constructor() {}

  /**
   * 現在フリー（どのVCにも入っていない、かつプレイヤーでもない）なWorkerを必要な数だけ取得する
   * @param serverId 検索対象のサーバーID
   * @param playerIds このゲームに参加しているプレイヤーのIDリスト
   * @param neededCount 必要なWorkerの数
   */
  public async getFreeWorkers(serverId: string, playerIds: string[], neededCount: number): Promise<Client[]> {
    const freeWorkers: Client[] = [];
    
    for (const worker of this.workers) {
      if (freeWorkers.length >= neededCount) break;
      if (playerIds.includes(worker.user?.id || '')) continue; // プレイヤーとして参加している子は除外

      try {
        const guild = await worker.guilds.fetch(serverId).catch(() => null);
        // VCに入っていなければ「フリー」と判定
        if (guild && guild.members.me && !guild.members.me.voice.channelId) {
          freeWorkers.push(worker);
        }
      } catch (e) {}
    }
    
    return freeWorkers;
  }
  
  public static getInstance(): WorkerManager {
    if (!WorkerManager.instance) {
      WorkerManager.instance = new WorkerManager();
    }
    return WorkerManager.instance;
  }

  /**
   * .envから読み込んだトークン配列を使って、全Workerを一斉に起動する
   */
  public async init(tokens: string[]): Promise<void> {
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ];

    Logger.info('WorkerManager', `${tokens.length}体のバイト（Worker）Botの起動シーケンスを開始します...`);

    const loginPromises = tokens.map(async (token, index) => {
      const client = new Client({ intents });
      
      client.once(Events.ClientReady, (c) => {
        Logger.success('WorkerManager', `[Worker ${index + 1}] Ready! Logged in as ${c.user.tag}`);
      });

      try {
        await client.login(token);
        this.workers.push(client);
      } catch (error) {
        Logger.error('WorkerManager', `[Worker ${index + 1}] のログインに失敗しました。トークンが正しいか確認してください。`, error);
      }
    });

    // すべてのWorkerのログイン処理が完了するまで待機
    await Promise.all(loginPromises);
    Logger.success('WorkerManager', `合計 ${this.workers.length} 体のバイトBotが出勤（待機状態）しました。`);
  }

  /**
   * 起動中のすべてのWorkerを取得する
   */
  public getWorkers(): Client[] {
    return this.workers;
  }

  /**
   * Workerの稼働数を取得する
   */
  public getWorkerCount(): number {
    return this.workers.length;
  }

  /**
   * インデックスを指定して特定のWorkerを取得する（プレイヤーへの割り当て用）
   * ※ プレイヤー数よりWorker数が少ない場合は、ループして割り当てる
   */
  public getWorkerByIndex(index: number): Client | null {
    if (this.workers.length === 0) return null;
    return this.workers[index % this.workers.length];
  }

  /**
   * プロセス終了時に全Workerを安全にシャットダウンする
   */
  public destroyAll(): void {
    if (this.workers.length > 0) {
      Logger.info('WorkerManager', 'すべてのバイトBotをシャットダウンします...');
      for (const worker of this.workers) {
        try {
          worker.destroy();
        } catch (error) {
          Logger.error('WorkerManager', 'Workerのシャットダウン中にエラーが発生しました', error);
        }
      }
      this.workers = [];
    }
  }
}