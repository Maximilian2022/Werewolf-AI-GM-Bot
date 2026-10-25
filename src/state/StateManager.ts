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
  private state: GameState | null = null; // 最新ゲームへの後方互換参照
  private states: Map<string, GameState> = new Map(); // gameId -> GameState 並行管理
  private activeGameId: string | null = null;
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
    this.states.set(initialState.gameId, initialState);
    this.activeGameId = initialState.gameId;
    this.state = initialState;
    Logger.info('StateManager', '新しいゲームのStateを初期化しました', this.state.gameId);
    this.saveToFileAsync(initialState.gameId).catch(()=>{}); // 非同期保存
  }

  public getState(gameId?: string): GameState {
    const targetId = gameId || this.activeGameId;
    const s = targetId ? this.states.get(targetId) || (this.state?.gameId === targetId ? this.state : null) : this.state;
    if (!s) {
      throw new Error(`State is not initialized${gameId ? ` for ${gameId}` : ''}`);
    }
    return s;
  }

  public getStateSafe(gameId?: string): GameState | null {
    const targetId = gameId || this.activeGameId;
    if (targetId && this.states.has(targetId)) {
      return this.states.get(targetId)!;
    }
    return this.state || null;
  }

  /**
   * 現在アクティブ（未終了）なゲーム一覧を取得
   */
  public getAllActiveGames(): GameState[] {
    const list: GameState[] = [];
    const seen = new Set<string>();

    // 1. メモリ上のゲーム
    for (const s of this.states.values()) {
      if (s.phase !== 'finished') {
        list.push(s);
        seen.add(s.gameId);
      }
    }
    if (this.state && this.state.phase !== 'finished' && !seen.has(this.state.gameId)) {
      list.push(this.state);
      seen.add(this.state.gameId);
    }

    // 2. ディスク上のセーブファイルから未終了のものを探索
    if (fs.existsSync(this.saveDir)) {
      try {
        const files = fs.readdirSync(this.saveDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
        for (const file of files) {
          const gId = file.replace('.json', '');
          if (seen.has(gId)) continue;
          try {
            const content = fs.readFileSync(path.join(this.saveDir, file), 'utf-8');
            const data = JSON.parse(content) as GameState;
            if (data && data.gameId && data.phase && data.phase !== 'finished') {
              this.states.set(data.gameId, data);
              list.push(data);
              seen.add(data.gameId);
            }
          } catch {}
        }
      } catch {}
    }

    return list;
  }

  public updateState(newState: Partial<GameState>, gameId?: string): void {
    const targetId = gameId || this.activeGameId;
    let current = targetId ? this.states.get(targetId) : this.state;
    if (!current && this.state) current = this.state;
    if (!current) return;

    const updated = { ...current, ...newState };
    this.states.set(updated.gameId, updated);
    if (!targetId || targetId === this.activeGameId || !this.state) {
      this.state = updated;
    }

    // 同期書き込みを廃止し、裏側でこっそり保存させる（音声を止めない）
    this.saveToFileAsync(updated.gameId).catch(e => Logger.error('StateManager', '保存エラー', e));
  }

  public nextPhase(newPhase: Phase, gameId?: string): void {
    const targetId = gameId || this.activeGameId;
    let current = targetId ? this.states.get(targetId) : this.state;
    if (!current) return;

    current.phase = newPhase;
    this.states.set(current.gameId, current);
    if (!targetId || targetId === this.activeGameId) {
      this.state = current;
    }

    Logger.info('StateManager', `フェーズが移行しました: ${newPhase}`, current.gameId);
    this.saveToFileAsync(current.gameId).catch(()=>{});
  }

  // 音声処理を邪魔しない「非同期バックグラウンド保存」
  private async saveToFileAsync(gameId?: string): Promise<void> {
    const targetId = gameId || this.activeGameId;
    const targetState = targetId ? this.states.get(targetId) || this.state : this.state;
    if (!targetState) return;
    
    // 現在保存中なら、「あとでもう1回保存する」という予約だけして終わる
    if (this.isSaving) {
      this.pendingSave = true;
      return;
    }

    this.isSaving = true;
    this.pendingSave = false;
    const filePath = path.join(this.saveDir, `${targetState.gameId}.json`);
    const tempFilePath = path.join(this.saveDir, `${targetState.gameId}.json.tmp`);
    const data = JSON.stringify(targetState, null, 2);

    try {
      await fs.promises.writeFile(tempFilePath, data, 'utf-8');
      await fs.promises.rename(tempFilePath, filePath);
    } catch (error) {
      Logger.error('StateManager', `Stateの保存に失敗しました: ${targetState.gameId}.json`, error, targetState.gameId);
      // 万が一一時ファイルが残っていた場合のクリーンアップ
      try { await fs.promises.unlink(tempFilePath); } catch {}
    } finally {
      this.isSaving = false;
      // 予約があれば再度実行する
      if (this.pendingSave) {
        this.saveToFileAsync(targetState.gameId).catch(()=>{});
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

  public findLatestActiveGame(): string | null {
    if (!fs.existsSync(this.saveDir)) return null;
    try {
      const files = fs.readdirSync(this.saveDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
      let latestActiveGameId: string | null = null;
      let latestMtime = 0;

      for (const file of files) {
        const filePath = path.join(this.saveDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(content) as GameState;
          if (data && data.gameId && data.phase && data.phase !== 'finished') {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs > latestMtime) {
              latestMtime = stat.mtimeMs;
              latestActiveGameId = data.gameId;
            }
          }
        } catch {
          // ignore
        }
      }

      return latestActiveGameId;
    } catch {
      return null;
    }
  }
}