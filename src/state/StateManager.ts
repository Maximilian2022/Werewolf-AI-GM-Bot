/**
 * src/state/StateManager.ts
 * ゲームの状態（State）を管理するシングルトンクラス
 * - ゲームの進行に伴う状態の更新と、定期的なファイルへの保存を担当
 * - 音声処理を邪魔しないよう、保存は非同期で行い、連続保存の競合を防止する仕組み
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GameState, Phase } from '../types.js';
import { Logger } from '../utils/logger.js';

export class StateManager {
  private static instance: StateManager;
  private state: GameState | null = null;
  private readonly saveDir = path.join(process.cwd(), 'data', 'games');
  
  // 連続保存によるファイルの競合（破損）を防ぐためのキュー制御フラグ
  private isSaving = false;
  private pendingSave = false;

  private constructor() {
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

  public initState(initialState: GameState): void {
    this.state = initialState;
    Logger.info('StateManager', '新しいゲームのStateを初期化しました', this.state.gameId);
    this.saveToFileAsync().catch(()=>{}); // 非同期保存
  }

  public getState(): GameState {
    if (!this.state) {
      throw new Error('State is not initialized');
    }
    return this.state;
  }

  public updateState(newState: Partial<GameState>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...newState };
    // 同期書き込みを廃止し、裏側でこっそり保存させる（音声を止めない）
    this.saveToFileAsync().catch(e => Logger.error('StateManager', '保存エラー', e));
  }

  public nextPhase(newPhase: Phase): void {
    if (!this.state) return;
    this.state.phase = newPhase;
    Logger.info('StateManager', `フェーズが移行しました: ${newPhase}`, this.state.gameId);
    this.saveToFileAsync().catch(()=>{});
  }

  // 音声処理を邪魔しない「非同期バックグラウンド保存」
  private async saveToFileAsync(): Promise<void> {
    if (!this.state) return;
    
    // 現在保存中なら、「あとでもう1回保存する」という予約だけして終わる
    if (this.isSaving) {
      this.pendingSave = true;
      return;
    }

    this.isSaving = true;
    this.pendingSave = false;
    const filePath = path.join(this.saveDir, `${this.state.gameId}.json`);
    const tempFilePath = path.join(this.saveDir, `${this.state.gameId}.json.tmp`);
    const data = JSON.stringify(this.state, null, 2);

    try {
      await fs.promises.writeFile(tempFilePath, data, 'utf-8');
      await fs.promises.rename(tempFilePath, filePath);
    } catch (error) {
      Logger.error('StateManager', `Stateの保存に失敗しました: ${this.state.gameId}.json`, error, this.state.gameId);
      // 万が一一時ファイルが残っていた場合のクリーンアップ
      try { await fs.promises.unlink(tempFilePath); } catch {}
    } finally {
      this.isSaving = false;
      // 予約があれば再度実行する
      if (this.pendingSave) {
        this.saveToFileAsync().catch(()=>{});
      }
    }
  }

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

  public deleteSaveFile(gameId: string): void {
    const filePath = path.join(this.saveDir, `${gameId}.json`);
    const tempFilePath = path.join(this.saveDir, `${gameId}.json.tmp`);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  }
}