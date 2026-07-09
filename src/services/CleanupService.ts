/**
 * src/services/CleanupService.ts
 * 古いセーブデータと関連する音声ファイルを定期的にクリーンアップするサービス
 * - ゲームの終了日時から一定期間が経過したセーブデータを削除し、関連する音声ファイルも一掃することで、ストレージの肥大化を防止
 * - クリーンアップの対象期間は設定から取得し、柔軟に変更可能（例: 7日間）
 * - クリーンアップ処理はアプリケーション起動時や定期的なスケジュールで実行される想定
 * - セーブデータの読み込みに失敗した場合は警告ログを出力し、処理を継続することで、クリーンアップの安定性を確保
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../utils/logger.js';
import { SettingsManager } from '../managers/SettingsManager.js';

export class CleanupService {
  private static readonly GAMES_DIR = path.join(process.cwd(), 'data', 'games');
  private static readonly AUDIO_DIR = path.join(process.cwd(), 'data', 'audio');

  public static run() {
    // 🚨 設定値から保存期間（日数）を取得
    const normalSettings = SettingsManager.getInstance().get(false);
    const deletionDays = normalSettings.dataDeletionDays || 7;
    // 日数をミリ秒に変換 (日数 * 24時間 * 60分 * 60秒 * 1000)
    const deletionMs = deletionDays * 24 * 60 * 60 * 1000;

    Logger.info('Cleanup', `🧹 古いセーブデータと音声ファイルのクリーンアップを開始します（保持期間: ${deletionDays}日）...`);
    if (!fs.existsSync(this.GAMES_DIR)) return;

    let deletedCount = 0;
    const now = Date.now();
    const files = fs.readdirSync(this.GAMES_DIR);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.GAMES_DIR, file);
      
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const endedAt = data.endedAt || fs.statSync(filePath).mtimeMs; // 互換性のためタイムスタンプも確認

        if (now - endedAt > deletionMs) {
          const gameId = data.gameId;
          // セーブデータを削除
          fs.unlinkSync(filePath);
          
          // 関連する音声ファイルを一掃
          if (fs.existsSync(this.AUDIO_DIR)) {
            const audioFiles = fs.readdirSync(this.AUDIO_DIR);
            for (const audioFile of audioFiles) {
              if (audioFile.startsWith(`${gameId}_`)) {
                fs.unlinkSync(path.join(this.AUDIO_DIR, audioFile));
              }
            }
          }
          deletedCount++;
        }
      } catch (e) {
        Logger.warn('Cleanup', `ファイルの読み込みに失敗しました: ${file}`);
      }
    }
    Logger.success('Cleanup', `✅ クリーンアップ完了: ${deletedCount} 件の古いゲーム環境を削除しました。`);
  }
}