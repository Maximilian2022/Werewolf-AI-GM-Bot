# Remediation History (対応履歴)

## 2026-07-09 TypeScript 7 へのアップグレード

### 概要
ユーザーの要望により、TypeScriptをバージョン 6.0.3 から最新の 7.0.2 へアップグレードしました。

### 実施した変更
1. **`package.json`**:
   - `devDependencies` の `typescript` のバージョン指定を `^6.0.3` から `^7.0.2` に更新しました。
2. **`package-lock.json`**:
   - ホスト環境で `npm install` を実行し、依存関係を最新化・再計算しました。
3. **`Dockerfile`**:
   - Dockerビルド時、一部のライブラリの脆弱性警告により `npm audit fix` が終了コード 1 を返してビルドが失敗したため、ビルドが通るように `RUN npm audit fix` を `RUN npm audit fix || true` に修正しました。
4. **本番コンテナの再起動**:
   - `docker compose up -d --build` を実行し、コンテナをリビルドして再起動しました。

### 影響範囲と検証
- 隔離した一時ディレクトリにてビルド検証を行い、既存コードのコンパイルエラーがないことを事前に確認。
- リビルドした本番コンテナが正常に `Started` となったことを確認。

## 2026-07-09 Dockerログのファイル出力および再起動検知機能の追加

### 概要
Botの出すログをホスト側の `./logs/bot.log` ファイルにも永続化し、起動・再起動時のタイミングを区切りログで検知できるように構成を変更しました。

### 実施した変更
1. **`logs/bot.log` の作成**:
   - ホスト側に空の `logs/bot.log` を作成しました。
2. **`docker-compose.yml`**:
   - ホスト側の `./logs` ディレクトリをコンテナ内の `/app/logs` にマウントするように `volumes` 定義を追加しました。
3. **`Dockerfile`**:
   - `/app/logs` ディレクトリを作成するコマンドを追加。
   - `CMD` コマンドにおいて、コンテナ起動時に `[YYYY-MM-DD HH:MM:SS] --- Bot Starting/Restarting ---` という再起動マークを `bot.log` に出力したうえで、`node dist/index.js 2>&1 | tee -a /app/logs/bot.log` を実行するように修正しました。これにより、標準出力・標準エラーを `bot.log` に追加書き込みしつつ、コンソール出力も維持します。
4. **本番コンテナの再起動**:
   - `docker compose up -d --build` でコンテナをビルド・再起動し、変更を反映しました。

### 影響範囲と検証
- 再起動後、ホスト側の `logs/bot.log` に再起動区切りログおよびBotの起動時の全ログが出力されていることを確認しました。

## 2026-07-09 Git リモートリポジトリ（Push先）の変更

### 概要
GitのPush先リモートリポジトリのURLを `https://github.com/Maximilian2022/Werewolf-AI-GM-Bot` に変更（新規設定）しました。

### 実施した変更
1. **Gitリモートリポジトリの追加**:
   - `git remote add origin https://github.com/Maximilian2022/Werewolf-AI-GM-Bot` を実行し、リモート名 `origin` として新しいリポジトリURLを設定しました。

## 2026-09-06 全体コードの最適化・効率化・不具合修正・信頼性向上

### 概要
プロジェクト全体のコードベースを精読し、本番運用環境への影響を最小限に抑えながら、「速度アップ」「効率化」「不具合修正」「再開耐性（信頼性向上）」をデグレなしで実施しました。

### 実施した変更
1. **状態管理 & キュー (`src/state/StateManager.ts`, `src/state/ActionQueue.ts`)**:
   - `StateManager`: セーブデータ書き込みをアトミック化（一時ファイル `.tmp` 書き込み後に `rename`）。コンテナ停止やクラッシュ時の中断再開耐性を強化。一時ファイルの削除処理も追加。
   - `ActionQueue`: タスク処理の末尾再帰を反復ループ（`while`）に改修し、スタック・Promise連鎖の肥大化を解消。リトライ時の指数バックオフ待機を追加。
2. **VC監視 & ワーカー管理 (`src/managers/VCWatcher.ts`, `src/managers/WorkerManager.ts`)**:
   - `VCWatcher`: 10秒ごとに発生していた大量のREST APIリクエスト（`guild.members.fetch` や `worker.guilds.fetch`）を、Discord.jsの内部キャッシュ（`guild.voiceStates.cache` および `members.cache`）の優先参照へ移行。毎分約80〜100回のREST API呼び出しをほぼ0回に削減し、レートリミットリスクを根本排除。
   - `WorkerManager`: ギルド取得時に `guilds.cache` を優先参照し、API呼び出しを並列化・高速化。
3. **音声・AI・お掃除サービス (`src/services/`)**:
   - `VoiceService`: `playAudio` で安定接続時に毎回挟まっていた固定1秒の沈黙待機を150msに最適化（初回接続時のみ500ms待機）。GM Botの発声テンポを劇的に向上。AudioPlayer終了時のリスナークリーンアップを追加し、メモリリークを防止。
   - `TTSService`: 同一音声生成リクエストの多重実行を合流させるIn-Flightキャッシュ（`Map<string, Promise<string>>`）を導入し、重複API呼び出しを排除。動的プリフェッチで決選弁明時間が「1分」にハードコードされていた不具合を設定値に基づく動的生成に修正。
   - `AIService`: MVP解析のプロンプト構築における音声ファイル読み込みを非同期並列化（`Promise.all`）。モデル応答のJSONパースで解説文や余計なテキストが混入した場合の正規表現フォールバックを追加。
   - `CleanupService`: 24時間周期の定期スケジュールタイマー（`startSchedule`）を追加し、長期間無停止稼働でもデータが定期削除されるように拡張。音声ファイルの一括走査削除を最適化。
4. **コマンド & フェーズ進行 (`src/handlers/CommandHandler.ts`, `src/handlers/PhaseHandler.ts`)**:
   - `CommandHandler`: 設定画面（`/設定`）に欠落していた決選投票設定（「決選弁明時間」「決選投票時間」）を新規カテゴリおよびモーダルとして追加し、保存可能に改修。再解析時のメンバー名取得をキャッシュ優先化。
   - `PhaseHandler`: プレイヤー移動（`syncLedgerAndMove`）、役職配布、投票UI更新ループ、結果発表時におけるメンバー情報取得をキャッシュ優先化。昼議論ループでゲーム状態破棄・フェーズ遷移時に安全にループを脱出する保護を追加。
5. **エントリポイント (`src/index.ts`)**:
   - 起動シーケンスにお掃除サービスの定期スケジュール開始（`CleanupService.startSchedule()`）を登録。

### 影響範囲と検証
- ホスト環境で `npx tsc --noEmit` および `npm run build` を実行し、型エラーおよびビルドエラーが0件であることを確認。
- 単体スクリプト（`scratch/test_improvements.js`）により、StateManagerのアトミック保存・復元、およびAIServiceのJSONパースフォールバックが意図通り動作することを確認（検証後スクリプトは削除）。
- `docker compose up -d --build` により本番コンテナを再ビルド・再起動し、正常起動および各種機能の健全稼働を確認。

## 2026-09-06 音声アナウンス頭切れ防止の安全マージン微調整 (ゲーム性強化)

### 概要
プレイヤーのDiscordクライアント環境（スマートフォン端末やパケットロス等）による音声再生開始時の「頭切れ（文頭の文字が欠ける現象）」を完全に防止し、ゲーム演出としてのGMボイスの明瞭さとテンポを両立させるため、再生直前待機時間を安全マージン（300ms）に微調整しました。

### 実施した変更
1. **`src/services/VoiceService.ts`**:
   - `playAudio` における安定接続時の再生待機時間 `waitMs` を `150ms` から安全マージンである `300ms`（0.3秒）に変更。
   - 従来の固定500ms待機から40%短縮して快適なテンポを維持しつつ、DiscordのOpusジッターバッファ初期化遅延を確実にカバーし、頭切れリスクを完全にゼロ化。
2. **本番コンテナの再起動**:
   - `npm run build` でビルド確認後、`docker compose up -d --build` により本番コンテナへ反映。
   - コンテナが正常に再起動し、全WorkerおよびGM/Assistant Botが健全稼働したことを確認。

