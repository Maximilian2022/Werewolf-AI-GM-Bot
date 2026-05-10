/**
 * state/StateManager.ts
 * ゲームのState（状態）管理とJSONファイルへの簡易永続化を担うクラス
 */
import * as fs from 'fs';
import * as path from 'path';
import { GameState, Phase } from '../types';
import { Logger } from '../utils/logger';

export class StateManager {
  private static instance: StateManager;
  private state: GameState | null = null;
  private readonly saveDir = path.join(process.cwd(), 'data', 'games');

  private constructor() {
    // 保存用ディレクトリの作成
    if (!fs.existsSync(this.saveDir)) {
      fs.mkdirSync(this.saveDir, { recursive: true });
      Logger.system(`State保存用ディレクトリを作成しました: ${this.saveDir}`);
    }
  }

  public static getInstance(): StateManager {
    if (!StateManager.instance) {
      StateManager.instance = new StateManager();
    }
    return StateManager.instance;
  }

  /**
   * 新しいゲームStateを初期化
   */
  public initState(initialState: GameState): void {
    this.state = initialState;
    Logger.info('StateManager', '新しいゲームのStateを初期化しました', this.state.gameId);
    this.saveToFile();
  }

  /**
   * 現在のStateを取得
   */
  public getState(): GameState {
    if (!this.state) {
      const errorMsg = 'ゲームStateが初期化される前に取得されようとしました。';
      Logger.error('StateManager', errorMsg);
      throw new Error(errorMsg);
    }
    // 参照渡しによる予期せぬ書き換えを防ぐため、簡易的なクローンを返す
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * 特定のプロパティを更新し、自動的に保存する
   */
  public updateState(partialState: Partial<GameState>): void {
    if (!this.state) {
      Logger.warn('StateManager', 'Stateが未初期化のため、updateStateがスキップされました');
      return;
    }

    this.state = {
      ...this.state,
      ...partialState,
    };

    // Stateの更新自体は頻繁に行われるため、ここでのログはdebugレベルに留める
    Logger.debug('StateManager', `Stateの一部が更新されました: [${Object.keys(partialState).join(', ')}]`, this.state.gameId);

    // フェーズ移行や重要な更新時に保存
    this.saveToFile();
  }

  /**
   * フェーズのみを更新
   */
  public nextPhase(phase: Phase): void {
    if (!this.state) return;
    
    Logger.info('StateManager', `🔄 フェーズが移行しました: [${this.state.phase}] -> [${phase}]`, this.state.gameId);
    this.updateState({ phase });
  }

  /**
   * JSONファイルへ保存
   */
  private saveToFile(): void {
    if (!this.state) return;

    const filePath = path.join(this.saveDir, `${this.state.gameId}.json`);
    try {
      const data = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(filePath, data, 'utf-8');
      Logger.success('StateManager', `Stateをファイルに保存しました: ${this.state.gameId}.json`, this.state.gameId);
    } catch (error) {
      Logger.error('StateManager', `Stateの保存に失敗しました: ${this.state.gameId}.json`, error, this.state.gameId);
    }
  }

  /**
   * 指定したGameIDのJSONからStateを復元（/再開 コマンド用）
   */
  public loadFromFile(gameId: string): boolean {
    const filePath = path.join(this.saveDir, `${gameId}.json`);
    
    Logger.info('StateManager', `セーブファイルからのState復元を試行します: ${gameId}.json`, gameId);

    if (!fs.existsSync(filePath)) {
      Logger.warn('StateManager', `セーブファイルが見つかりません: ${gameId}.json`, gameId);
      return false;
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      this.state = JSON.parse(data) as GameState;
      Logger.success('StateManager', `Stateの復元に成功しました`, gameId);
      return true;
    } catch (error) {
      Logger.error('StateManager', `Stateファイルの読み込み・パースに失敗しました`, error, gameId);
      return false;
    }
  }

  /**
   * ゲーム終了時のクリーンアップ（ファイルを削除する場合）
   */
  public deleteSaveFile(gameId: string): void {
    const filePath = path.join(this.saveDir, `${gameId}.json`);
    
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        Logger.success('StateManager', `セーブファイルを削除しました: ${gameId}.json`, gameId);
      } catch (error) {
        Logger.error('StateManager', `セーブファイルの削除に失敗しました: ${gameId}.json`, error, gameId);
      }
    } else {
      Logger.warn('StateManager', `削除対象のセーブファイルが存在しませんでした: ${gameId}.json`, gameId);
    }
  }
}