/**
 * src/utils/logger.ts
 * アプリケーション全体の標準化されたロギングユーティリティ
 */

export class Logger {
  /**
   * ログのプレフィックス（タイムスタンプ＋モジュール名＋GameID）を生成する
   */
  private static getPrefix(moduleName: string, gameId?: string): string {
    // タイムスタンプを生成 (例: 14:30:45)
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    
    if (gameId) {
      return `[${time}][${moduleName}][${gameId}]`;
    }
    return `[${time}][${moduleName}]`;
  }

  /**
   * 一般的な情報ログ
   */
  public static info(moduleName: string, message: string, gameId?: string): void {
    console.log(`${this.getPrefix(moduleName, gameId)} ℹ️ ${message}`);
  }

  /**
   * 処理の成功ログ
   */
  public static success(moduleName: string, message: string, gameId?: string): void {
    console.log(`${this.getPrefix(moduleName, gameId)} ✅ ${message}`);
  }

  /**
   * 警告ログ
   */
  public static warn(moduleName: string, message: string, gameId?: string): void {
    console.warn(`${this.getPrefix(moduleName, gameId)} ⚠️ ${message}`);
  }

  /**
   * エラーログ（スタックトレース等の詳細情報も併せて出力）
   */
  public static error(moduleName: string, message: string, error?: any, gameId?: string): void {
    console.error(`${this.getPrefix(moduleName, gameId)} ❌ ${message}`);
    if (error) {
      // エラーオブジェクトが存在する場合は詳細を出力
      console.error(error);
    }
  }

  /**
   * システム・インフラレベルのログ（起動時や終了時など）
   */
  public static system(message: string): void {
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    console.log(`[${time}][System] ⚙️ ${message}`);
  }

  /**
   * デバッグログ（開発環境でのみ出力）
   */
  public static debug(moduleName: string, message: string, gameId?: string): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`${this.getPrefix(moduleName, gameId)} 🐛 ${message}`);
    }
  }
}