/**
 * state/ActionQueue.ts
 * Discord APIのレートリミットを回避するための直列タスク実行キュー
 */
import { DiscordTask } from '../types.js';
import { Logger } from '../utils/logger.js';

export class ActionQueue {
  private static instance: ActionQueue;
  private queue: DiscordTask[] = [];
  private isProcessing: boolean = false;
  
  // 仕様に基づき、リクエスト間のインターバルを設定（200ms - 500ms）
  private readonly INTERVAL_MS = 300;
  private readonly MAX_RETRIES = 3;

  private constructor() {}

  public static getInstance(): ActionQueue {
    if (!ActionQueue.instance) {
      ActionQueue.instance = new ActionQueue();
    }
    return ActionQueue.instance;
  }

  /**
   * 新しいタスクをキューに追加
   */
  public add(execute: () => Promise<void>, id: string = 'task'): void {
    const task: DiscordTask = {
      id,
      execute,
      retryCount: 0
    };
    this.queue.push(task);
    
    // タスク追加の証跡（大量に出るため debug レベルとする）
    Logger.debug('ActionQueue', `タスク追加: [${id}] (待機中: ${this.queue.length}件)`);
    
    // 処理が動いていなければ開始
    if (!this.isProcessing) {
      Logger.debug('ActionQueue', '停止中のキューワーカーを起動します');
      this.process();
    }
  }

  /**
   * キューを順番に処理
   */
  private async process(): Promise<void> {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      Logger.debug('ActionQueue', 'キュー内の全てのタスクの処理が完了し、ワーカーが待機状態に入りました');
      return;
    }

    this.isProcessing = true;
    const task = this.queue.shift();

    if (task) {
      try {
        Logger.debug('ActionQueue', `実行開始: [${task.id}]`);
        await task.execute();
        Logger.success('ActionQueue', `完了: [${task.id}]`);
      } catch (error) {
        Logger.error('ActionQueue', `タスク実行エラー: [${task.id}]`, error);
        
        // リトライ処理
        if (task.retryCount < this.MAX_RETRIES) {
          task.retryCount++;
          Logger.warn('ActionQueue', `タスクを再試行します [${task.id}] (${task.retryCount}/${this.MAX_RETRIES})`);
          this.queue.unshift(task); // 先頭に戻して再試行
        } else {
          // 最大試行回数を超えた場合は破棄
          Logger.error('ActionQueue', `最大再試行回数に達しました。タスクを破棄して次の処理へ進みます: [${task.id}]`);
        }
      }
    }

    // 次のタスクまで待機（レートリミット回避）
    await this.sleep(this.INTERVAL_MS);
    await this.process();
  }

  /**
   * 指定ミリ秒待機するヘルパー
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 現在のキューが空になるまで待機する（フェーズ遷移の同期用）
   */
  public async waitForEmpty(): Promise<void> {
    while (this.isProcessing || this.queue.length > 0) {
      await this.sleep(100);
    }
  }
  public isBusy(): boolean {
    return this.isProcessing || this.queue.length > 0;
  }
}