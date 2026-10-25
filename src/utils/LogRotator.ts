/**
 * src/utils/LogRotator.ts
 * 2段階ログローテーション機構
 * 
 * ① Active ログ (bot.log): 直近1,000行 または 当日分
 * ② Archive ログ (bot-archive.log): 行数超過 or 日付変更で追記コピー後 truncate (平文集約・100MB)
 * ③ 圧縮世代管理 (bot-archive.log.1.zst 〜 10.zst): 100MB超過時に zstd (または gzip) 圧縮 & 最大10世代
 * ④ StdStreamTee: stdout / stderr をフックしてコンソールとファイル両方に漏れなく多重出力
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { execSync } from 'node:child_process';

export interface LogRotatorOptions {
  logDir?: string;
  baseName?: string;
  maxActiveLines?: number;     // デフォルト: 1,000行
  maxArchiveBytes?: number;    // デフォルト: 100MB
  maxGenerations?: number;     // デフォルト: 10世代
  autoCaptureStdStreams?: boolean; // デフォルト: true
}

export class LogRotator {
  private static instance: LogRotator;

  private readonly logDir: string;
  private readonly baseName: string;
  public readonly activeFile: string;
  public readonly archiveFile: string;

  private readonly maxActiveLines: number;
  private readonly maxArchiveBytes: number;
  private readonly maxGenerations: number;

  private currentDate: string;
  private currentLineCount: number = 0;
  private fd: number | null = null;
  private isRotating: boolean = false;
  private hasZstd: boolean = false;

  private origStdoutWrite: ((chunk: any, ...args: any[]) => boolean) | null = null;
  private origStderrWrite: ((chunk: any, ...args: any[]) => boolean) | null = null;

  private constructor(options: LogRotatorOptions = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.baseName = options.baseName || 'bot';
    this.maxActiveLines = options.maxActiveLines || 1000;
    this.maxArchiveBytes = options.maxArchiveBytes || 100 * 1024 * 1024; // 100MB
    this.maxGenerations = options.maxGenerations || 10;

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.activeFile = path.join(this.logDir, `${this.baseName}.log`);
    this.archiveFile = path.join(this.logDir, `${this.baseName}-archive.log`);

    this.currentDate = this.getTodayDateString();
    this.hasZstd = this.checkZstdAvailable();

    // 既存ログの確認と初期化
    this.initActiveFile();

    if (options.autoCaptureStdStreams !== false) {
      this.captureStdStreams();
    }
  }

  public static init(options?: LogRotatorOptions): LogRotator {
    if (!LogRotator.instance) {
      LogRotator.instance = new LogRotator(options);
    }
    return LogRotator.instance;
  }

  public static getInstance(): LogRotator {
    if (!LogRotator.instance) {
      LogRotator.instance = new LogRotator();
    }
    return LogRotator.instance;
  }

  private getTodayDateString(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private checkZstdAvailable(): boolean {
    try {
      execSync('zstd --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 起動時のActiveログの確認 & 初期行カウント
   * 既存ログが1000行を超えている場合は即座にArchiveへ安全に退避
   */
  private initActiveFile(): void {
    if (fs.existsSync(this.activeFile)) {
      const lineCount = this.countLines(this.activeFile);
      if (lineCount > this.maxActiveLines) {
        // 既存の肥大化ログをArchiveへ退避
        try {
          const content = fs.readFileSync(this.activeFile);
          fs.appendFileSync(this.archiveFile, content);
          fs.truncateSync(this.activeFile, 0);
          this.currentLineCount = 0;
        } catch {
          this.currentLineCount = lineCount;
        }
      } else {
        this.currentLineCount = lineCount;
      }
    } else {
      fs.writeFileSync(this.activeFile, '', 'utf-8');
      this.currentLineCount = 0;
    }

    try {
      this.fd = fs.openSync(this.activeFile, 'a');
    } catch (err) {
      console.error('LogRotator: failed to open active file', err);
    }
  }

  private countLines(filePath: string): number {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content) return 0;
      let count = 0;
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) count++; // '\n'
      }
      return count;
    } catch {
      return 0;
    }
  }

  /**
   * ログテキストの書き込み（行数・日付チェック付き）
   */
  public write(text: string): void {
    if (this.isRotating) return;

    try {
      const today = this.getTodayDateString();
      // 1. 日付変更 または 行数超過で Active -> Archive
      if (today !== this.currentDate || this.currentLineCount >= this.maxActiveLines) {
        this.rotateToArchive();
      }

      if (this.fd !== null) {
        try {
          fs.writeSync(this.fd, text);
        } catch (err) {
          // fdが閉じていた場合は再オープンを試みる
          try {
            this.fd = fs.openSync(this.activeFile, 'a');
            fs.writeSync(this.fd, text);
          } catch {}
        }
      }

      // 行数を加算
      let addedLines = 0;
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) addedLines++;
      }
      if (addedLines === 0 && text.length > 0) addedLines = 1;
      this.currentLineCount += addedLines;

      if (this.currentLineCount >= this.maxActiveLines) {
        this.rotateToArchive();
      }
    } catch {
      // ログ出力エラーによるメインプロセスの停止を防止
    }
  }

  /**
   * ① Active -> Archive への退避ローテーション
   */
  public rotateToArchive(): void {
    if (this.isRotating) return;
    this.isRotating = true;

    try {
      if (this.fd !== null) {
        try { fs.closeSync(this.fd); } catch {}
        this.fd = null;
      }

      if (fs.existsSync(this.activeFile)) {
        const stat = fs.statSync(this.activeFile);
        if (stat.size > 0) {
          // Activeファイルの内容をArchiveファイルの末尾にアペンド
          const data = fs.readFileSync(this.activeFile);
          fs.appendFileSync(this.archiveFile, data);
          // Activeファイルをサイズ0に切り詰め (truncate)
          fs.truncateSync(this.activeFile, 0);
        }
      }

      this.currentLineCount = 0;
      this.currentDate = this.getTodayDateString();

      // ファイルディスクリプタを再オープン
      this.fd = fs.openSync(this.activeFile, 'a');
    } catch (err) {
      console.error('LogRotator: rotation to archive error', err);
    } finally {
      this.isRotating = false;
      // ② Archive容量超過で圧縮世代交代をチェック
      this.checkArchiveCompression();
    }
  }

  /**
   * ② Archive容量超過時の圧縮・世代管理
   */
  public checkArchiveCompression(): void {
    if (!fs.existsSync(this.archiveFile)) return;

    try {
      const stat = fs.statSync(this.archiveFile);
      if (stat.size < this.maxArchiveBytes) return;

      const ext = this.hasZstd ? 'zst' : 'gz';

      // 最古世代の削除 (例: bot-archive.log.10.zst)
      const oldestFile = path.join(this.logDir, `${this.baseName}-archive.log.${this.maxGenerations}.${ext}`);
      if (fs.existsSync(oldestFile)) {
        try { fs.unlinkSync(oldestFile); } catch {}
      }

      // 世代のシフト (.9 -> .10, .8 -> .9, ...)
      for (let i = this.maxGenerations - 1; i >= 1; i--) {
        const src = path.join(this.logDir, `${this.baseName}-archive.log.${i}.${ext}`);
        const dst = path.join(this.logDir, `${this.baseName}-archive.log.${i + 1}.${ext}`);
        if (fs.existsSync(src)) {
          try { fs.renameSync(src, dst); } catch {}
        }
      }

      // Archiveファイルを第1世代として圧縮
      const gen1File = path.join(this.logDir, `${this.baseName}-archive.log.1.${ext}`);
      if (this.hasZstd) {
        // zstd コマンドによる高速圧縮
        try {
          execSync(`zstd -q -f -o "${gen1File}" "${this.archiveFile}"`, { stdio: 'ignore' });
        } catch {
          // zstd失敗時はフォールバックでgzip圧縮
          this.compressWithGzip(this.archiveFile, path.join(this.logDir, `${this.baseName}-archive.log.1.gz`));
        }
      } else {
        this.compressWithGzip(this.archiveFile, gen1File);
      }

      // 圧縮完了後、Archiveファイルをサイズ0に切り詰め
      fs.truncateSync(this.archiveFile, 0);
    } catch (err) {
      console.error('LogRotator: archive compression error', err);
    }
  }

  private compressWithGzip(srcPath: string, dstPath: string): void {
    const input = fs.readFileSync(srcPath);
    const compressed = zlib.gzipSync(input);
    fs.writeFileSync(dstPath, compressed);
  }

  /**
   * ③ 標準出力・標準エラーのキャプチャ (StdStreamTee)
   */
  private captureStdStreams(): void {
    if (this.origStdoutWrite || this.origStderrWrite) return;

    this.origStdoutWrite = process.stdout.write.bind(process.stdout);
    this.origStderrWrite = process.stderr.write.bind(process.stderr);

    // stdout フック
    process.stdout.write = (chunk: any, ...args: any[]): boolean => {
      try {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        this.write(str);
      } catch {}
      return this.origStdoutWrite!(chunk, ...args);
    };

    // stderr フック
    process.stderr.write = (chunk: any, ...args: any[]): boolean => {
      try {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        this.write(str);
      } catch {}
      return this.origStderrWrite!(chunk, ...args);
    };
  }

  /**
   * クリーンアップ（終了時）
   */
  public close(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
    if (this.origStdoutWrite) {
      process.stdout.write = this.origStdoutWrite;
      this.origStdoutWrite = null;
    }
    if (this.origStderrWrite) {
      process.stderr.write = this.origStderrWrite;
      this.origStderrWrite = null;
    }
  }

  public getStats() {
    return {
      activeLines: this.currentLineCount,
      activeBytes: fs.existsSync(this.activeFile) ? fs.statSync(this.activeFile).size : 0,
      archiveBytes: fs.existsSync(this.archiveFile) ? fs.statSync(this.archiveFile).size : 0,
      hasZstd: this.hasZstd,
      currentDate: this.currentDate,
    };
  }
}
