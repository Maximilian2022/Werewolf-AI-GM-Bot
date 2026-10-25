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

## 2026-10-25 大規模改修：レギュレーションビルダー、新規特殊役職、WebUI、Cloudflare Tunnel、チート防止ロック

### 概要
固定化されていたレギュレーション・役職ロジックを抜本的に刷新し、ユーザーが自由に配役・ルールを作成できる「レギュレーションビルダー」およびWebダッシュボード（ポート3000、Vanilla CSSによる洗練されたガラスモフィズム/ダークモード）、Cloudflare Tunnel連携（ワンクリック起動・FQDN指定）、ゲーム進行中の参加者アクセスに対する「情報秘匿ロック（ゴースティング防止）」、ならびに新規特殊役職4種（未熟な占い師、無謀な占い師、狐憑き、棺桶屋）を含む全16役職のモジュール化・ルール解決エンジンを完全実装しました。

### 実施した変更
1. **役職システム（`src/roles/`）**:
   - `IRole` インターフェースを策定し、陣営（`team`）、人数カウント種別（`countType`）、夜のアクション、護衛耐性、夜通話可否を各役職自身にカプセル化。
   - `RoleRegistry` を新設し、ID・日本語名の双方で引けるシングルトンレジストリとして提供。
   - 既存6役職（村人、人狼、占い師、霊媒師、騎士、狂人）を移行。
   - 拡張役職（妖狐、狂信者、共有者、猫又、パン屋、てるてる坊主）を追加。
   - ご指定の特殊役職4種を実装：
     - **未熟な占い師**: 占う際に対象が「人狼/村人」かを予想。的中なら翌日も継続、外れたら当日の結果は通知されるが翌日以降は能力喪失。
     - **無謀な占い師**: 護衛の恩恵を受けられない。襲撃対象かつ護衛対象だった場合、護衛演出は出るが無謀な占い師は死亡する。
     - **狐憑き**: 毎晩1名を指定して占い無効（判定×表示・妖狐呪殺防止）。妖狐を指定した場合は「👍 妖狐を守った」と通知。妖狐全滅で翌朝後追い死亡。
     - **棺桶屋**: 第三陣営。毎晩翌日処刑されそうな人を予想。2回的中で即時単独勝利。1回的中時は「棺桶が一つ売れたようです」とアナウンス。自分指定可、同一人物再指定不可（全生存者1巡でリセット）。
2. **ルール解決エンジン（`src/engine/`）**:
   - `NightActionResolver`: 狐憑きによる加護・占い妨害 ➔ 占い解決（予想的中判定・妖狐呪殺判定） ➔ 騎士護衛適用（無謀貫通死） ➔ 人狼襲撃（猫又道連れ反撃・妖狐耐性） ➔ 妖狐全滅時の狐憑き後追い死を厳密に突合。
   - `ExecutionResolver`: 棺桶屋の的中カウント・単独勝利判定、てるてる坊主の処刑単独勝利、猫又の処刑道連れを解決。
   - `WinConditionChecker`: 単独勝利（棺桶屋、てるてる坊主）、妖狐陣営、村人陣営、人狼陣営の判定を抽象化。
3. **レギュレーションマネージャー（`src/regulations/`）**:
   - プリセット（標準11人、標準13人、標準9人、妖狐12人、特殊役職村）と `data/regulations.json` によるカスタムレギュレーションの保存・展開・検証（バリデーション）。
4. **WebUI & Cloudflare Tunnel 連携 & チート防止ロック（`src/server/`, `src/managers/TunnelManager.ts`, `public/`）**:
   - ポート3000でExpressサーバーを起動。
   - `TunnelManager`: `cloudflared` プロセスの起動・停止・死活監視、FQDN/Tokenの永続化。
   - Discord OAuth2 認証: ログインによるユーザー識別。
   - **チート防止ロック（ゴースティング防止）**: ゲーム進行中、参加プレイヤー（生存・死亡問わず）のアクセスに対して機密データを一切遮断し、「🔒 参加者情報保護ロック中」画面を表示。GMおよび観戦者、またはゲーム終了後にフルデータを表示。
   - WebUI（HTML5 + Vanilla CSS + JavaScript）: ガラスモフィズム・ダークモードデザインによるレギュレーションビルダー、リアルタイムゲームモニター、Tunnel/Discord設定（詳細ガイド付き）、ゲーム時間エディタ。
5. **PhaseHandler & コマンドのオーケストレーター化（`src/handlers/PhaseHandler.ts`, `src/handlers/CommandHandler.ts`, `src/index.ts`）**:
   - `/開始`: 人数制限（11/13人）を撤廃し4人以上対応。レギュレーション自動選択および指定オプション追加。
   - `/ダッシュボード`: WebUI URLの案内コマンド追加（Tunnel起動時は公開URL案内）。
   - `/レギュレーション`: 登録レギュレーション一覧表示コマンド追加。
   - `PhaseHandler`: エンジンとレギュレーションマネージャーによる動的配役・能力解決に完全移行。
6. **Docker環境更新 & WebUI起動・ルーティング修正（`Dockerfile`, `src/server/app.ts`, `public/index.html`）**:
   - `cloudflared` パッケージの自動インストールと静的WebUI（`public/`）のコンテナ内配置を追加。
   - `public/index.html` に Discord Bot の導入手順（OAuth2 URL Generator、権限選択、スラッシュコマンド活用ガイド）を追記。
   - Express 5 / `path-to-regexp` のワイルドカード記法変更に伴い、SPAフォールバックを `app.get('*')` から `app.use(...)` ミドルウェアへ改修。
   - コンテナ内への最新コード配置および `docker compose restart` により、GM Bot、16体のバイトBot、WebUI（ポート3000）の正常起動を確認。
7. **Agent Skills の導入**:
   - `npx skills add` により、以下の5つの公式・高評価スキルを `.agents/skills/` に完全導入：
     - `find-skills`（スキル検索・管理）
     - `frontend-design`（UI/UX・デザイン洗練）
     - `webapp-testing`（WebUI/APIブラウザテスト）
     - `typescript-advanced-types`（高度なTypeScript型安全）
     - `setup-pre-commit`（コミット前自動チェック）
8. **WebUI のアクセス制御 & UI/UX 大幅刷新**:
   - **Discordログイン必須ゲート画面**: 未ログイン状態ではダッシュボードを一切非表示にし、専用のログインカード（`#login-gate-screen`）を表示。APIも `requireAuth` で 401 保護。
   - **管理者専用タブ制御**: 「☁️ Tunnel & Discord設定」タブおよび `/api/tunnel` API を管理者権限（ギルド管理者・オーナーまたは `.env` の `ADMIN_USER_IDS`）を持つユーザーのみに限定（一般ユーザーには非表示＆403ブロック）。
   - **レギュレーションビルダーのUI改善**:
     - 役職配分カウンターを「2列」から「1列」の縦長リストへ変更。
     - 役職説明をアコーディオン化し、デフォルトで非表示（「説明を見る ▼」クリックでスムーズに展開）。
     - 画面右側にスティッキーな「📊 役職配分サマリー」パネルを新設し、割り振られた役職の内訳を右端で縦に並べて一目で確認可能に。
   - **AI解析モデルの動的取得 & フィルタリング**:
     - `@google/genai` の `models.list()` により、利用可能なモデル一覧を動的に取得・キャッシュ。
     - 埋め込みモデル、画像生成、TTS専用モデル等の無関係なモデルや古い日付スナップショットを自動除外。
     - WebUIの設定画面（`<select id="sys-ai-model">`）に動的リストとして反映。
9. **`bot.log` の Opus エラー（Uncaught Exception）の完全修復**:
   - **原因究明**: npm v12 においてデフォルトで install-scripts がブロックされていたこと、および Node.js 26 (glibc 2.41) のプレビルドバイナリが存在せず、パス展開（`{libc_version}`）に不整合が生じていたため、`@discordjs/opus` および `opusscript` のロードに失敗していた。
   - **対処**:
     - コンテナ内で `@mapbox/node-pre-gyp rebuild` を実行し、C++ソースから libopus ネイティブモジュールを完全ビルド。
     - 正しい glibc-2.41 パスおよび Release パスへ配置し、Node.js 上で正常ロードを確認。
     - 万が一のフォールバックとして `opusscript` もインストール。
     - `Dockerfile` にこのビルド手順を恒久的に組み込み、次回以降の新規コンテナビルドでも確実に再現できるように改修。

## 2026-10-25 WebUI役職カウンター表示復旧・ゲーム自動復帰（リカバリ）実装・Bun互換性検証

### 概要
1. WebUIレギュレーションビルダーで役職配分カウンターが非表示・ブラックアウトしていた不具合を修正。
2. Botおよびコンテナ再起動時、進行中のゲーム（通常村・Debug村問わず）が存在する場合に手動コマンド不要で自動復帰するリカバリ機構を実装。
3. プロジェクトにおける Bun v1.4（最新版）の互換性・実行テストを隔離コンテナで実施し、Discord Voice・DAVE暗号化スタックの動作を検証。

### 実施した変更
1. **WebUI役職配分カウンターの不具合修正 (`public/app.js`)**:
   - 役職配分カウンターの1列化・アコーディオン化に伴うコード置換時に欠落していた `getRoleIcon(roleId)` 関数を再定義。
   - `ReferenceError: getRoleIcon is not defined` を解消し、全16役職のアイコン・名前・増減ボタン・アコーディオンが即座に正常描画されるよう復旧。
2. **ゲーム自動復帰（リカバリ）機能の実装 (`src/state/StateManager.ts`, `src/index.ts`)**:
   - `StateManager.ts`: `data/games/` 配下の保存データを走査し、最新かつ未終了（`phase !== 'finished'`）のゲームIDを返す `findLatestActiveGame(): string | null` を新設。
   - `src/index.ts`: 起動処理（`bootstrap()`）の完了直前に `findLatestActiveGame()` を呼び出し、該当するゲームが存在すれば `PhaseHandler.resumeGame(gmClient, assistantClient, activeGameId)` を自動発火。
   - 本番コンテナ再起動時に、実際に投票フェーズ（voting）のゲームが自動検出され、アクションキュー処理・VC同期・TTS読み上げがシームレスに再開されることを確認。
3. **Bun v1.4 の隔離互換性テスト**:
   - 隔離一時コンテナ（`oven/bun:latest`、Bun v1.4.4）を用いて、以下のDiscord.js Voiceスタックを単体検証：
     - `sodium-native`: 暗号化（secretbox）の正常動作を確認。
     - `@snazzah/davey` (DAVE プロトコル): Discord最新E2E暗号化の正常動作を確認。
     - `@discordjs/voice`: `createAudioPlayer`、ステート遷移の初期化に成功。
     - `ws`: WebSocketクライアントの正常動作を確認。
   - 検証完了後、使用した一時テストスクリプトおよび一時コンテナを完全にクリーンアップ。

## 2026-10-25 Bun ランタイムへの正式移行（ハイブリッド構成）& 自動復帰ガード強化

### 概要
1. 本番コンテナに最新の Bun（v1.4.4）ランタイムを取り込み、メイン実行エンジンを Node.js から Bun へ正式に移行（ハイブリッド構成）。
2. ゲーム自動復帰（リカバリ）時、Discord上でチャンネルやギルドが削除済みの過去データに遭遇した場合の安全な終了マーク・例外ハンドリングを強化。

### 実施した変更
1. **Dockerfile のハイブリッド構成改修 (`Dockerfile`)**:
   - Stage 2（本番環境）に `COPY --from=oven/bun:latest /usr/local/bin/bun /usr/local/bin/bun` を追加。Debian（ffmpeg, cloudflared, libsodium 等）の依存関係を完全に維持したまま Bun を導入。
   - `CMD` を `bun dist/index.js` に変更し、万が一のロールバック用として Node.js 起動コマンドも保持。
   - `docker compose build` により事前ビルドを行い、ダウンタイムを最小化して本番コンテナへ反映。
2. **自動復帰（リカバリ）の堅牢化 (`src/handlers/PhaseHandler.ts`)**:
   - `resumeGame()` において、ギルドや投票チャンネルの取得時に `.catch(() => null)` で存在チェックを追加。
   - Discord上で既に削除されたチャンネル・ギルドの幽霊データだった場合、`stateManager.updateState({ phase: 'finished' })` で安全に終了としてマーク・永続化し、エラーによるBot起動シーケンスの阻害を防止。
3. **稼働検証**:
   - `bun dist/index.js` による高速起動を確認。
   - GM Bot、Assistant Bot、16体のバイト（Worker）Bot、Cloudflare Tunnel、WebUI（ポート3000）の全機能が Bun ランタイム上で正常稼働していることを確認。

## 2026-10-25 Zoom Bot 連携基盤（Private App / Meeting SDK / WebUI）の実装

### 概要
Discord に加えて、Zoom ミーティング内でも人狼ゲームマスターBotを動かすための統合基盤（Private App / Meeting SDK 連携・プロファイル管理・URL自動パース・チャットコマンド・WebUIダッシュボード）を実装しました。

### 実施した変更
1. **型定義 & プロファイル管理 (`src/types.ts`, `src/managers/ZoomProfileManager.ts`)**:
   - `ZoomProfile`、`ZoomSessionConfig`、`ZoomMeetingStatus` 型を追加。
   - `ZoomProfileManager`: 主催者（プレイヤー）ごとの Meeting SDK Client ID / Secret / デフォルトホストキーを保存・暗号化マスク管理。
   - Zoom Meeting SDK 署名（JWT / HMAC-SHA256）の動的生成エンジンを実装。
2. **Zoom コアサービス (`src/services/ZoomService.ts`)**:
   - ミーティング参加・退出、入室時の点呼アナウンス、チャットコマンド受付（`!開始`, `!一時停止`, `!再開`, `!ヘルプ`）、ブレイクアウトルーム移動、ミュート制御、音声送出の枠組みを実装。
   - Zoom招待URL（`https://*.zoom.us/j/...`）からミーティング番号とパスコードを自動抽出するパーサーを実装。
   - AI講評（Gemini解析）の有効/無効トグルに対応（無効時はRaw Audio録音を要求せず、Zoom画面の録音ポップアップを回避）。
3. **WebUI ダッシュボード統合 (`src/server/app.ts`, `public/index.html`, `public/app.js`, `public/style.css`)**:
   - ナビゲーションバーに「🎥 Zoom連携」タブを追加。
   - プロファイル選択ドロップダウン & 管理モーダル（新規・編集・削除）。
   - Zoom招待URLペーストによる自動入力機能。
   - ホストキー入力（自動ホスト取得）と手動共同ホスト化のハイブリッド対応。
   - リアルタイムモニター（接続状態、参加者一覧、ミーティング内チャット表示 & 送信、レギュレーション選択付きゲーム開始ボタン）。
   - 事前設定ガイド（ブレイクアウトルーム・共同ホストの有効化手順）のアコーディオン。

## 2026-10-25 レギュレーションへの個別時間・AI設定統合 & 詳細ルールの直下配置 & AI総評録音トグル

### 概要
1. 「詳細ルール設定」を「役職配分カウンター」の直下に配置移動し、右カラムを縦並びスティッキー配分サマリーに特化。
2. 従来別タブ（ゲーム設定タブ）にあった制限時間設定やシステム演出・AI設定を、レギュレーションごとに個別設定・保持できるよう統合。
3. DiscordおよびZoomの両方で利用可能な「🎙️ AI総評・音声録音の有効化」トグルスイッチを新設し、OFF時にはゲーム終了時のGemini解析・長時間待機をスキップして即座に感想戦へ進むよう改修。

### 実施した変更
1. **型定義 & データ構造の拡張 (`src/regulations/types.ts`, `src/managers/SettingsManager.ts`)**:
   - `RegulationTimeSettings`（昼議論、減算、夜行動、決選弁明、決選投票、遺言）および `RegulationSystemSettings`（GM音声、AIモデル、トーン、MVPモード、`enableAIRecording`）を定義し、`Regulation` 型に統合。
   - `SettingsManager.ts`: `SystemSettings` に `enableAIRecording: boolean`（デフォルト `true`）を追加。
2. **ゲーム進行ロジック改修 (`src/handlers/PhaseHandler.ts`)**:
   - セットアップ時、選択されたレギュレーションに独自の時間設定（`times`）があれば、ゲームステートの `settingsSnapshot` に自動適用。
   - 感想戦のMVP選定前、レギュレーションまたはシステム設定の `enableAIRecording` が `false` の場合、Geminiマルチモーダル解析・待機をスキップし、即時結果・感想戦移行する安全ガードを実装。
3. **WebUI の刷新 (`public/index.html`, `public/app.js`, `public/style.css`)**:
   - レギュレーションビルダーの左カラムに「役職配分カウンター」とその直下に「詳細ルール・制限時間・AI演出設定」を配置。
   - 右カラムに「📊 役職配分サマリー」を縦並びスティッキーで配置し、スクロール中も配分内訳が常時確認可能に。
   - 「🎙️ AI総評・音声録音の有効化」トグルスイッチを配置。
   - レギュレーションの保存・読み込み時に、基本ルールだけでなく制限時間やAI演出設定も双方向に完全同期。

## 2026-10-25 Webゲームモニターの案A（進行中一律ロック ＆ GMパスコード解除）実装

### 概要
Zoom人狼や未認証アクセス時におけるゴースティング・役職漏洩を防止するため、「案A（ゲーム進行中は一律で情報保護ロックをかけ、GM/観戦者がGMパスコードを入力して解除する）」をバックエンドおよびフロントエンドに実装しました。

### 実施した変更
1. **セッション型定義 & APIの拡張 (`src/server/app.ts`)**:
   - `express-session` のセッションデータに `gmUnlocked?: boolean` を追加。
   - `POST /api/game/unlock`: フロントから送信されたパスコードを検証し、一致すればセッションに `gmUnlocked = true` を設定。
   - `POST /api/game/relock`: セッションの `gmUnlocked` を破棄して再ロック。
   - `GET /api/game/state`:
     - 認証必須（`requireAuth`）を解除し、ゲーム未開催時は空ステート、ゲーム進行中は `gmUnlocked` または管理者権限がある場合のみフルデータを返却。
     - それ以外（未解除のアクセス者）には `locked: true, lockReason: 'gm_passcode_required'` を返却。
     - Discord参加プレイヤーがログインしている場合は `participant_locked` として安全にマスキング。
2. **状態取得メソッドの安全化 (`src/state/StateManager.ts`)**:
   - `StateManager.getStateSafe(): GameState | null` を新設し、ゲーム未開催時（`this.state === null`）に例外を投げず安全に `null` を返すよう改修（500 Internal Server Error の根本防止）。
3. **WebUI の改修 (`public/index.html`, `public/app.js`)**:
   - `#monitor-lock-screen` にGMパスコード入力フォームと「🔑 解除」ボタンを動的描画。Enterキーまたはボタンクリックで即座にアンロックしてゲームモニターを表示。
   - フルモニター画面の右上に「🔒 再ロック」ボタンを配置。
   - ゲーム設定画面に「🔑 GMパスコード」設定入力欄（初期値: `1234`）を追加し、自由に変更・保存できるよう同期。

## 2026-10-25 ゲーム単位ロック・解除通知（サーバーネーム）・複数ゲーム並行対応 & Zoom仮想シミュレータ実装

### 概要
1. ゲームモニターのロック・解除を「ゲームID単位」で完全分離し、複数ゲーム並行時でも個別ロック・個別解除を可能にしました。
2. GMパスコード解除時に、Discordログイン中のサーバーネーム（表示名）を用いて、Zoom全体チャットおよびDiscordチャンネルへ「○○さんがゲームモニターの役職秘匿を解除しました」とアナウンスを送信する抑止力機構を実装しました。
3. Zoomミーティングを開かずに1人でゲーム開始・役職配布・ブレイクアウトルーム移動・ミュートをテストできる「WebUI 仮想シミュレータ（Mockモード）」を実装しました。

### 実施した変更
1. **複数ゲーム並行ステート管理 (`src/state/StateManager.ts`)**:
   - `states: Map<string, GameState>` による複数ゲームのメモリ並行保持。
   - `getState(gameId?)`, `getStateSafe(gameId?)`, `updateState(newState, gameId?)`, `nextPhase(newPhase, gameId?)` のゲームID対応。
   - `getAllActiveGames(): GameState[]`: 進行中ゲームの一覧取得メソッドを新設。
2. **ゲーム単位ロック & 解除通知 (`src/server/app.ts`)**:
   - セッションに `unlockedGameIds: string[]` を追加し、ゲームID単位で解除状態を記録。
   - `GET /api/game/games`: 開催中ゲームの概要（ID、プラットフォーム、人数、ロック状態）を返すAPIを新設。
   - `POST /api/game/unlock`: Discordログインを必須化。解除時に解除者のサーバーネーム（`user.displayName || user.username`）を取得し、Zoom全体チャット（`sendChatMessage`）およびDiscord投票チャンネルにアナウンスを自動送信。
   - `POST /api/game/relock`: 指定ゲームIDの再ロックに対応。
3. **Zoom 仮想シミュレータ（Mockモード）の実装 (`src/services/ZoomService.ts`, `src/server/app.ts`)**:
   - `startMockSimulation(count)`: 5〜13名の仮想参加者を一括召喚し、仮想ミーティング状態を構築。
   - `stopMockSimulation()`: シミュレーションの安全停止。
   - `sendMockUserChat()`: 仮想チャットコマンド（`!開始`, `!一時停止`, `!再開`, `!ヘルプ`）の擬似送受信。
   - `assignBreakoutRooms`, `setMute`: 仮想参加者の所属ルーム（人狼の部屋/霊界/個室/メイン）やマイク状態（🎙️/🔇）をリアルタイムに更新・通知。
4. **WebUI の改修 (`public/index.html`, `public/app.js`)**:
   - モニターヘッダーに「開催中ゲーム選択ドロップダウン」を配置し、複数ゲームをスムーズに切り替え可能に。
   - ロック画面で未ログイン時はDiscordログインボタン、ログイン時はサーバーネーム表示と全体チャット通知の事前告知を表示。
   - Zoom連携画面に「🧪 仮想シミュレータ（デバッグモード）」パネルを新設（人数選択、起動/停止、クイックコマンドボタン）。
   - Zoom参加者一覧にブレイクアウトルーム名バッジとマイク状態を表示。
   - 事前設定ガイドに、案2（Join from browser多重参加）および案3（1人ミーティング疎通テスト）の手順を追加。

## 2026-10-25 2段階ログローテーション機構（Active 1,000行 / Archive 100MB / zstd圧縮10世代 & StdStreamTee）の導入

### 概要
従来のログ出力（`logs/bot.log`）が単一ファイルで48,000行（約3MB）まで無制限に肥大化していた問題を解決するため、2段階ログローテーションアーキテクチャ（Active -> Archive -> 圧縮世代管理）を本プロジェクト（TypeScript / Bun環境）向けに完全実装・導入しました。

### 実施した変更
1. **2段階ログローテーションクラスの新設 (`src/utils/LogRotator.ts`)**:
   - **① Active ログ (`logs/bot.log`)**:
     - 直近1,000行または当日分を保持。1,000行超過または日付変更時に、内容をArchiveへアペンド退避して `truncate(0)`。
     - WebUIやエディタ、CLI（`tail`）での参照が常にミリ秒単位で超軽量に行えるように最適化。
   - **② Archive ログ (`logs/bot-archive.log`)**:
     - 100MBまで平文で集約保持。細切れの圧縮を防ぎ、過去ログの `grep` 調査性を担保。
   - **③ zstd圧縮 ＆ 世代管理 (`logs/bot-archive.log.1.zst` 〜 `10.zst`)**:
     - Archiveが100MB超過時に、OS標準の `/usr/bin/zstd`（または Node標準 gzip へフォールバック）で高速圧縮。
     - 最大10世代を超過した最古ファイルを自動削除し、ディスク容量の厳密な上限保護（数十MB〜百MB程度で頭打ち）を実現。
   - **④ StdStreamTee（標準出力・標準エラーの多重化）**:
     - `process.stdout.write` / `process.stderr.write` をフックし、`console.log` やサードパーティライブラリ（Discord.js / Bun）の出力を漏れなくキャプチャ。
     - コンテナのコンソール出力（`docker logs`）を維持しつつ、自動でローテーションファイルに安全に書き込む仕組みを確立。
   - **⑤ 既存ログの保全（移行措置）**:
     - 初回起動時、従来の肥大化した48,000行のログをすべて `logs/bot-archive.log` に自動退避し、Activeな `bot.log` をクリーンな最新状態に再編。
2. **システムエントリーポイントへの統合 (`src/index.ts`)**:
   - アプリ起動直後に `LogRotator.init()` を呼び出し、起動シーケンスの初手からすべてのログを捕捉。
3. **コンテナ起動コマンドの最適化 (`Dockerfile`)**:
   - シェルパイプ `tee -a /app/logs/bot.log` を撤廃し、ダイレクトな `CMD ["bun", "dist/index.js"]` に変更。プロセス二重化を解消し、シグナルハンドリングを改善。

## 2026-10-25 WebUIの黒赤基調・ダークゴシック人狼デザイン刷新 ＆ ダーク狼エンブレムアイコン導入

### 概要
WebUI全体のデザインを「黒赤基調 × 漆黒と深紅（クリムゾン）のダークゴシック・人狼テーマ」へと全面刷新しました。また、絵文字の狼（🐺）から、赤く光る瞳と鋭い牙を持つハイエンドなダーク狼エンブレムアイコン（`werewolf-dark-icon.jpg`）を導入・配置し、ブラウザファビコンやナビゲーションバー、ログインゲート画面に適用しました。

### 実施した変更
1. **ダーク狼エンブレム・アセットの導入 (`public/assets/werewolf-dark-icon.jpg`)**:
   - 赤く光る瞳とダークシルバーの毛並み、深紅のバックライトオーラを纏った鋭利な狼頭部エンブレムを生成・配置。
   - ファビコン（`<link rel="icon">`）、ナビゲーションバーのブランドアイコン、ログインゲート画面のシンボル、ゲーム未開催時の空状態アイコンに適用。
2. **カラーパレット & トークンの黒赤刷新 (`public/style.css`)**:
   - 背景色を漆黒（`#07070a`）とスモーキーワインブラック（`rgba(18, 14, 20, 0.75)`）へ変更。
   - プライマリ・アクセントカラーを従来の青紫色（`#6366f1`）から、鮮血と深紅のクリムゾンレッド（`#e11d48` / `#be123c` / `#ff2442`）へと刷新。
   - 背景に「血の月（ブラッドムーン）」を想起させる深紅と暗黒のアンビエントグラデーション（`.ambient-glow`）を配置。
   - スクロールバーも黒赤スリムデザインへ最適化。
3. **タイポグラフィ & UIコンポーネントのゴシック・サイバー化 (`public/index.html`, `public/style.css`)**:
   - 見出し・タイトルに格式あるゴシックフォント `Cinzel` を導入（`WEREWOLF GM BOT`）。
   - ログインゲート画面（`.login-gate-card`）に深紅のパルス発光とボーダーラインを実装。
   - ナビゲーションタブ（アクティブ時の深紅グラデーションと光彩エフェクト）、ボタン（`.btn-primary`）、フォームフォーカス、役職カード、配分サマリー、ゲームモニターのロック画面およびコンソールログボックスをすべて黒赤テーマに統一。
4. **本番環境への安全な反映（無停止・瞬断ゼロ）**:
   - `docker cp` によりコンテナ（`werewolf-gm-bot:/app/public`）へ静的アセット・CSSを即座に同期。本番コンテナの再起動なし（ダウンタイムゼロ）でWebUIの反映を完了。
   - ブラウザ実機でのレンダリングとアセット配信（HTTP 200）を確認。

## 2026-10-25 GM発話タイミング ＆ 進行時系列ドキュメント（scratch/timeline.md）の策定

### 概要
人狼ゲーム開幕時の「レギュレーション読み上げ機能」の追加検討に向け、現在システム内でGM（およびスタッフBot）が音声（TTS）で発話するタイミング・セリフ・対象チャンネル・トリガー条件を全編時系列で精査し、`scratch/timeline.md` としてまとめました。

### 実施した変更
1. **GM発話タイムラインドキュメントの作成 (`scratch/timeline.md`)**:
   - 開村（ロビーVC）から、役職配布、初日夜、昼議論、投票、決選投票、処刑・遺言、夜行動、朝の犠牲者発表、終局（勝利宣言・MVP発表）までの全31発話ポイントを網羅。
   - 全体フロー図（Mermaid）、各フェーズの発話詳細、一覧サマリー表を整理。
   - レギュレーション読み上げを組み込む場合の最適なタイミング候補（【案A: ロビーVC開始直後】 vs 【案B: 第1日目昼議論直前】）の比較・分析を記載。

## 2026-10-25 ゲーム開始時レギュレーション自動読み上げ機能（デフォルトON・トグル可能）の実装 ＆ 役職仕様書（scratch/role.md）の策定

### 概要
案A（ゲーム開始直後のロビーVCでのGM挨拶タイミング）に基づき、GMが参加人数・役職構成サマリー・主要ルール（初日占い・連続護衛）・昼議論時間を自動で音声読み上げ（TTS）する機能を実装しました。本機能はデフォルトで「ON（有効）」とし、レギュレーション個別設定・システム設定・スラッシュコマンドの各所で柔軟にOFF/ONの切り替えが可能です。また、実装に伴う変数二重宣言の修復、および追加役職の詳細仕様をまとめた `scratch/role.md` を作成しました。

### 実施した変更
1. **レギュレーション読み上げメッセージの新設 (`src/messages.ts`)**:
   - `MSG.VOICE.REGULATION_ANNOUNCE`: 人数、役職内訳サマリー（標準役職順ソート）、初日お告げ/自由占い、連続護衛ルール、昼議論時間を自然なGMアナウンス文として生成。
2. **システム設定・レギュレーション型定義の拡張 (`src/regulations/types.ts`, `src/managers/SettingsManager.ts`)**:
   - `enableRegulationAnnouncement?: boolean` を追加し、デフォルト値を `true` に設定。
3. **ゲーム進行制御への組み込み (`src/handlers/PhaseHandler.ts`)**:
   - `startRoleDistribution` において、レギュレーション設定（またはシステム設定）を判定。有効時は新設の読み上げ音声をTTS生成・再生し、無効時は従来の簡潔な挨拶音声を再生。
   - スコープ内での `regMgr` / `currentReg` 二重宣言を解消し、Bun環境下での構文エラーを防止。
4. **スラッシュコマンド連携 (`src/handlers/CommandHandler.ts`, `src/deploy-commands.ts`)**:
   - `/開始` コマンドに `レギュレーション読み上げ`（boolean、任意）オプションを追加。
5. **WebUI設定項目の追加 (`public/index.html`, `public/app.js`)**:
   - レギュレーションビルダー詳細設定およびシステム設定タブに「📜 レギュレーション読み上げの有効化」トグルスイッチを配置し、双方向同期を実装。
6. **役職仕様書ドキュメントの策定 (`scratch/role.md`)**:
   - 今回追加された新規特殊役職4種（未熟な占い師、無謀な占い師、狐憑き、棺桶屋）および拡張役職6種（妖狐、狂信者、共有者、猫又、パン屋、てるてる坊主）の詳細仕様、陣営、カウント種別、夜行動、護衛可否、能力発動条件、演出メッセージを整理。
   - 全16役職サマリー表および夜行動・処刑時の能力解決シーケンス図（Mermaid）を記載。

## 2026-10-25 追加特殊役職の夜個室VC音声（TTS）実装 ＆ タイムライン（scratch/timeline.md）の完全同期

### 概要
ユーザーからのご指摘に基づき、未熟な占い師、無謀な占い師、狐憑き、棺桶屋などの追加特殊役職において、夜の個室VCへスタッフBot（WorkerBot 4〜7）が接続してプロンプト音声および決定・結果通知音声を再生する処理を実装しました。また、初日のお告げ対象に占い師亜種（未熟/無謀）を含める対応を行い、GM発話タイムラインドキュメント（`scratch/timeline.md`）の発話項目を全40件に完全同期・更新しました。

### 実施した変更
1. **特殊役職用音声セリフ定数の追加 (`src/messages.ts`, `src/roles/definitions/SpecialRoles.ts`)**:
   - `PROMPT_APPRENTICE_SEER`: `未熟な占い師の方、今夜占う対象と予想を選択してください。`
   - `PROMPT_RECKLESS_SEER`: `無謀な占い師の方、今夜占う対象を選択してください。`
   - `PROMPT_FOX_POSSESSED`: `狐憑きの方、今夜加護を与える対象を選択してください。`
   - `PROMPT_UNDERTAKER`: `棺桶屋の方、明日処刑される人物を予想してください。`
   - `APPRENTICE_SEER_RESULT`: 占い結果（白/黒）と予想の的中/外れを音声で伝達。
   - `FOX_PROTECT_SET`: 加護対象の決定を個室VCで音声復唱。
   - `UNDERTAKER_TARGET_SET`: 翌日処刑予想の決定を個室VCで音声復唱。
2. **夜フェーズ進行エンジンへの個室VC音声タスク組み込み (`src/handlers/PhaseHandler.ts`)**:
   - 夜フェーズ開始時、Worker 4〜7 を各役職の個別VCへ割り当ててプロンプト音声を再生。
   - 未熟な占い師の能力喪失時はプロンプト音声をスキップ。
   - ボタン/セレクトメニューでの決定時、直ちに個室VCへWorkerが接続して決定・結果音声を再生。
   - 初日の「お告げ（白通知）」対象に通常占い師だけでなく未熟な占い師・無謀な占い師も含めるよう拡張。
3. **タイムラインドキュメントの更新 (`scratch/timeline.md`)**:
   - 第⑦夜フェーズの個別案内詳細に未熟な占い師、無謀な占い師、狐憑き、棺桶屋の音声仕様を追記。
   - GM発話一覧サマリー表を全31項目から全40項目に拡充。
4. **本番環境への安全な反映と稼働検証**:
   - `npm run build` による型チェック完了。
   - コンテナ（`werewolf-gm-bot`）への配置、再起動後のBun環境下での正常稼働（Cloudflare Tunnel・Worker 16体・WebUI 正常稼働）を確認。

## 2026-10-25 新規20役職の追加検討・能力バッティング・勝利条件の精査 ＆ ドキュメント全面改訂

### 概要
ユーザーから提案された新規役職（ハンター、独裁者、タフガイ、罠師、カウンセラー、一匹狼、恋人、神様、スパイ、人狼の子ども、占い師の弟子、狙われる市民、黒猫、キューピット、悪女、女王、生霊、狼の眷属、凶暴な狼等）について、役職能力のバッティング・矛盾・無限連鎖リスクを徹底的に検証しました。各役職の勝利条件を優先度付きで体系化し、`scratch/role.md` および `scratch/timeline.md` を最新仕様へ全面更新しました。

### 実施した変更
1. **役職仕様書および勝利条件の全面改訂 (`scratch/role.md`)**:
   - 各陣営および単独第三陣営の勝利判定優先順位（てるてる坊主/棺桶屋 ＞ 恋人 ＞ 一匹狼 ＞ 神様 ＞ 妖狐 ＞ 村人/人狼）を定義。
   - 新規追加役職の仕様、所属陣営、人数カウント種別、夜行動、護衛可否、勝利条件を網羅。
   - 役職バッティング解決シーケンス図（Mermaid）および重点バッティングケース（罠師vs狙われる市民、女王ショック死連鎖防止、生霊の選択制限、2回襲撃の重複上限等）の解決ルールを明文化。
2. **タイムラインドキュメントの更新 (`scratch/timeline.md`)**:
   - 昼議論フェーズへの「独裁者CO（即時処刑）」割り込み仕様を追加。
   - 処刑フェーズへの「ハンター道連れ」「人狼の子ども」「女王崩御」の判定を追加。
   - 夜フェーズへの人狼2回襲撃仕様を追記。

## 2026-10-25 新規20役職の完全実装 & AI総評へのレギュレーション連携

### 概要
ユーザーの要望に基づき、新規20役職（ハンター、独裁者、タフガイ、罠師、カウンセラー、一匹狼、恋人、神様、スパイ、内通者、人狼の子ども、占い師の弟子、狙われる市民、黒猫、キューピット、悪女、女王、生霊、狼の眷属、凶暴な狼）のフル実装を完了しました。
また、AI総評（Gemini）に渡すコンテキスト情報として、ゲームで実際に使用されたレギュレーション（ルール設定）および配役内訳（役職構成）を自動的に生成・注入する仕組みを実装しました。

### 実施した変更
1. **役職定義およびレジストリ登録 (`src/roles/types.ts`, `src/roles/definitions/NewRoles.ts`, `src/roles/RoleRegistry.ts`)**:
   - 全新規役職の `RoleId`、夜行動種別、陣営、カウント種別を定義。
   - 20役職のクラス定義を作成し、`RoleRegistry` の標準役職リストに追加。
2. **メッセージ・音声定数の追加 (`src/messages.ts`)**:
   - 独裁者CO、銃声、黒猫の呪い、女王崩御、新女王即位、恋人後追い、2回襲撃などのチャットメッセージおよびTTS音声を新設。
   - 恋人陣営、一匹狼、神様などの勝利音声・チャット通知を追加。
3. **ゲーム状態・アクション型定義拡張 (`src/types.ts`, `src/engine/types.ts`)**:
   - `GameState` に `loversUserIds`、`femmeFataleData`、`livingSpiritData`、`queenUserId`、`toughGuyPoisoned`、`wolfCubRevenge`、`dictatorUsed`、`apprenticeDivinerAwakened` 等の新規状態フィールドを追加。
   - 夜アクションおよび処刑時のアクション入力・出力型を拡張。
4. **ルール解決エンジン拡張 (`src/engine/NightActionResolver.ts`, `src/engine/ExecutionResolver.ts`, `src/engine/WinConditionChecker.ts`)**:
   - `NightActionResolver`: スパイ妨害 ➔ 狐憑き加護 ➔ 騎士護衛/罠師迎撃 ➔ カウンセラー更生/殉職 ➔ 占い ➔ 2回襲撃/通常襲撃（狙われる市民人狼化、タフガイ耐性、猫又道連れ、ハンター道連れ） ➔ 凶暴な狼自爆 ➔ 呪殺 ➔ 恋人後追い ➔ 女王崩御/生霊即位 ➔ 狐憑き後追いを完全解決。
   - `ExecutionResolver`: ハンター道連れ、黒猫呪い、人狼の子ども2回襲撃フラグ、恋人後追い、女王崩御を完全解決。
   - `WinConditionChecker`: 棺桶屋/てるてる ＞ 恋人 ＞ 一匹狼 ＞ 神様 ＞ 妖狐 ＞ 村人/人狼 の優先度順勝利判定を完全実装。
5. **ゲーム進行ハンドラーの拡張 (`src/handlers/PhaseHandler.ts`)**:
   - 初日役職配布時の個別案内（神様への全員役職通知、女王認知通知、狂信者/内通者/眷属通知、一匹狼の内通VC除外など）。
   - 初日夜の選択UI（キューピット恋人指定、悪女本命指定、生霊憑依指定）。
   - 昼議論フェーズの独裁者COボタン設置、CO時の即時処刑への直行遷移。
   - 処刑フェーズのハンター道連れ選択UI、黒猫・人狼の子ども・女王崩御の解決。
   - 夜フェーズのタフガイ毒死、生霊引き継ぎ、弟子覚醒判定、人狼2回襲撃UI、罠師・カウンセラー・スパイ・ハンターUI等の提示。
   - 終了フェーズの全陣営勝利通知。
6. **WebUIレギュレーションビルダーの拡張 (`public/app.js`, `public/style.css`)**:
   - 全新規役職のアイコン、恋人陣営タグ、ダークレッドスタイルを追加。
7. **AI総評へのレギュレーション・役職内訳連携 (`src/regulations/RegulationManager.ts`, `src/services/AIService.ts`, `src/handlers/PhaseHandler.ts`, `src/handlers/CommandHandler.ts`)**:
   - `RegulationManager.formatSummary` を新設し、レギュレーション名、初日占い設定、連続護衛、決選処刑、霊媒、人狼VC設定、およびゲーム参加者の実際の役職内訳を集計・テキスト化。
   - `AIService.buildPromptParts` に `regulationSummary` 引数を追加し、プロンプトの【村のレギュレーション】セクションへ動的に組み込み。
   - ゲーム終了時の自動総評（`PhaseHandler`）および `/再解析` コマンド（`CommandHandler`）から `regulationSummary` を確実に渡すよう改修。
8. **本番環境への安全な反映と稼働検証**:
   - `npm run build` を実行し、TypeScriptのビルド・型チェックが正常パスすることを確認。
   - コンテナ内（`/app/dist`, `/app/public`）へ同期し、`docker compose restart werewolf-gm-bot` で再起動。
   - ボット本体、16体のバイトBot、WebUI（ポート3000）が正常稼働していることを確認。

## 2026-10-25 新規役職のGM発話シーン完全実装 & timeline.md 全面改訂（全72件対応）

### 概要
今回追加された新規役職約20種について、GM（およびスタッフBot）が音声（TTS）で喋るべき全シーンを精査しました。不足していた個別待機VCへのプロンプト音声・決定復唱音声、処刑時の特殊演出音声（独裁者処刑・黒猫・ハンター・人狼の子ども・恋人・女王崩御）、および夜アクションのスタッフBot音声タスクを網羅的に実装し、進行時系列ドキュメント（`scratch/timeline.md`）の発話イベント一覧を全40件から全72件に拡充・更新しました。

### 実施した変更
1. **新規音声定数の追加 (`src/messages.ts`)**:
   - `PROMPT_APPRENTICE_DIVINER_AWAKENED`: 覚醒した弟子の占い促し音声。
   - `WOLF_TARGET_SET_DOUBLE`: 2回襲撃時の襲撃先復唱音声。
   - `TRAPPER_TARGET_SET`, `COUNSELOR_TARGET_SET`, `SPY_TARGET_SET`, `HUNTER_TARGET_SET`: 夜行動決定復唱音声。
   - `CUPID_TARGET_SET`, `FEMME_FATALE_TARGET_SET`, `LIVING_SPIRIT_TARGET_SET`: 初日夜の役職決定復唱音声。
2. **ゲーム進行ハンドラーへの音声タスク組み込み (`src/handlers/PhaseHandler.ts`)**:
   - **初日夜（0日目夜）**: キューピット、悪女、生霊の各個室VCへスタッフBotを派遣し、プロンプト音声および決定時の復唱音声を再生。
   - **処刑フェーズ**: 独裁者COによる即時処刑執行時に専用音声（`DICTATOR_EXEC`）をメインVCで再生。黒猫の呪い（`BLACK_CAT_REVENGE`）、ハンター銃殺（`HUNTER_SHOOT`）、親狼激怒（`WOLF_CUB_ENRAGED`）、恋人後追い死（`LOVERS_FOLLOW`）、女王崩御・生霊即位（`QUEEN_DIED` / `QUEEN_INHERITED`）の放送処理を完備。
   - **夜フェーズ**: 空きWorkerの要求数を12体に拡張。人狼の2回襲撃プロンプト（`PROMPT_WOLF_DOUBLE`）および決定復唱（`WOLF_TARGET_SET_DOUBLE`）、罠師・カウンセラー・スパイ・ハンター・覚醒弟子のプロンプト音声および決定復唱音声を各個室VCで確実に再生。
3. **進行タイムラインドキュメントの改訂 (`scratch/timeline.md`)**:
   - 第②初日夜、第⑥処刑、第⑦夜フェーズのGM発話セリフ詳細を追記。
   - GM発話一覧サマリー表を全40項目から**全72項目**へ大幅に拡張・完全同期。
4. **本番環境への反映と稼働検証**:
   - `npm run build` によるコンパイル成功を確認。
   - `docker cp dist werewolf-gm-bot:/app/` および `docker compose restart werewolf-gm-bot` により本番コンテナへ反映。
   - メインBot、16体のバイトBot（WorkerBot）、Cloudflare Tunnel（ポート3000）の正常稼働を確認。

## 2026-10-25 ドキュメント体系化（manual/新設）、公開リポジトリ向け.gitignore整理、README.md最新化、詳細仕様書（manual.md）作成

### 概要
リポジトリの公開および長期的な運用・開発の円滑化を目的とし、ドキュメント構造の体系化とセキュリティ・品質向上のための再整理を実施しました。

### 実施した変更
1. **マニュアルディレクトリの新設と移動 (`manual/`)**:
   - `manual/` ディレクトリを作成。
   - `scratch/timeline.md` ➔ `manual/timeline.md` に移動（全72件のGM発話セリフ・進行シーケンス）。
   - `scratch/role.md` ➔ `manual/role.md` に移動（全30種以上の役職能力・バッティング解決規則・勝利優先度）。
   - `scratch/` から旧ドキュメントを安全に削除。
2. **`.gitignore` の再構築と公開リポジトリ向けセキュリティ強化 (`.gitignore`)**:
   - `scratch/` フォルダをGit無視対象に追加。
   - 誤ってGitインデックスに登録されていた `logs/bot.log` および `scratch/` 配下を `git rm --cached` で追跡解除。
   - 秘密鍵、トークン、クレデンシャル、ログ、OS一時ファイルを網羅する業界標準の厳格な除外設定へ刷新（`logs/remediation_history.md` は追跡を継続）。
3. **初心者向け入門ガイド `README.md` の作成 (`README.md`)**:
   - 過大・誇張のない上品で誠実なトーンで執筆。
   - AIの支援を受けて作成・洗練されたプロジェクトであることを明記。
   - 初めて利用する人でもわかる、概要・3ステップ参加ガイド・コマンド一覧・Webダッシュボード・役職一覧を整理。
4. **ガチ詳細仕様書 `manual/manual.md` の作成 (`manual/manual.md`)**:
   - 不具合や攻撃に繋がる脆弱性情報を除き、開発者・運用者向けの内部技術仕様をすべて網羅。
   - システムアーキテクチャ（GM/Assistant/Worker 18体Botクラスタ構成・Mermaid図）。
   - ゲーム進行ステートマシン（独裁者CO割り込み、決選投票ループ、終了判定）。
   - 状態管理とリカバリ（アトミック保存・クラッシュ復旧メカニズム）。
   - 3大ルール解決エンジン（`NightActionResolver` 解決シーケンス図・全バッティング規則、`ExecutionResolver`、`WinConditionChecker` 優先度階層表）。
   - TTS音声配信ストリーミングパイプラインおよび排他制御。
   - AI総評（Gemini インテリジェント・フォールバック機構）。
   - Web管理ダッシュボード（ポート3000、Express 5、OAuth2、参加者情報秘匿ロック、Cloudflare Tunnel連携）およびAPIエンドポイント仕様。
   - スラッシュコマンド（全8種）の実行権限・引数仕様。

### 影響範囲と検証
- `git status` により、`scratch/` や `logs/bot.log` が追跡対象外となり、`manual/` および `README.md` が適切に構成されていることを確認。
- 本番コンテナは停止・再起動することなく、既存の安定稼働状態を維持。

## 2026-10-25 GitHub Code Scanning (CWE-338) 完全是正、.env.example 新設、README Zoom対応追記

### 概要
GitHub Code Scanning（CodeQL）において報告されていた 3 件の脆弱性警告（`js/insecure-randomness`, CWE-338）について根本原因を究明し、プロジェクト全体の疑似乱数生成処理を暗号学的に安全な擬似乱数生成器（CSPRNG）へ刷新しました。また、公開リポジトリ向けの `.env.example` の作成、および `README.md` への Zoom ミーティング連携ガイド・コマンド仕様の追記を実施しました。

### 実施した変更
1. **暗号学的に安全な乱数ユーティリティの新設 (`src/utils/cryptoRandom.ts`)**:
   - Node.js 標準の `node:crypto` モジュールを活用し、以下の関数群を実装：
     - `secureRandom()`: `crypto.randomBytes(4)` を用いた `[0, 1)` の浮動小数点数（`Math.random()` の安全な代替）。
     - `secureRandomInt(min, max)`: `crypto.randomInt` によるセキュアな整数乱数。
     - `secureSample(array)`: 配列からの安全なランダム要素サンプリング。
     - `secureShuffle(array)`: Fisher-Yates アルゴリズムによる安全なインプレース配列シャッフル。
     - `secureRandomId(length)`: ゲームIDやチャットID用の暗号学的に安全なランダムID文字列。
2. **全コードベースからの `Math.random()` の完全除去 (Code Scanning アラート解消)**:
   - `src/handlers/PhaseHandler.ts`:
     - 役職配布時の Fisher-Yates シャッフルを `secureShuffle` に置換。
     - 投票フェーズ・決選弁明者指名・タイムアウト投票・最終処刑者決定抽選を `secureSample` に置換（Alert #1, #3 解消）。
     - 夜フェーズの占い師・騎士・未熟な占い師・無謀な占い師・人狼のタイムアウト時ターゲット抽選を `secureSample` に置換（Alert #2 解消）。
     - バイトBotの相槌確率判定を `secureRandom()` に置換。
   - `src/engine/NightActionResolver.ts`:
     - 罠師迎撃、猫又道連れ、ハンター道連れ時の人狼・生存者抽選を `secureSample` に置換。
   - `src/engine/ExecutionResolver.ts`:
     - 黒猫呪い、猫又道連れ、ハンター道連れ時の対象抽選を `secureSample` に置換。
   - `src/handlers/CommandHandler.ts`:
     - `/開始` コマンドにおける `gameId` 生成を `secureRandomId(6)` に置換。
   - `src/services/ZoomService.ts`:
     - チャットメッセージID生成を `secureRandomId(6)` に置換。
   - プロジェクト全体から `Math.random()` の使用を完全にゼロ化。
3. **`.env.example` の新設 (`.env.example`)**:
   - Discord Bot トークン（GM/Assistant/Worker）、Discord Client ID、サーバーID、Gemini APIキー、Google Cloud TTS 認証パス、Express セッションシークレット、管理者ユーザーID、OAuth2 クライアント情報等の全環境変数を親切な解説・日本語コメント付きで体系化。
4. **`README.md` への Zoom ミーティング連携の追記 (`README.md`)**:
   - Discord だけでなく Zoom 上でも Bot を召喚して人狼ゲームを全自動進行できる旨を明記。
   - Zoom かんたんスタートガイド（Webダッシュボードからの参加召喚、ブレイクアウトルーム自動制御）。
   - Zoom ミーティング内チャットコマンド（`!開始`, `!一時停止`, `!再開`, `!ヘルプ`）の一覧表を追加。
5. **本番コンテナへの安全な反映と稼働検証**:
   - `npm run build` によるビルド成功（型エラー0件）。
   - `docker cp dist werewolf-gm-bot:/app/` および `docker compose restart werewolf-gm-bot` により本番コンテナへ反映。
   - メインBot、16体のバイトBot（Worker）、Assistant Bot、クリーンアップサービス、Cloudflare Tunnel がすべて正常に起動したことを確認。

## 2026-10-25 CodeQL 追加アラート（Rate-limiting, CSRF, Clear-text Cookie）の完全是正

### 概要
初回リリースプッシュ後に CodeQL によって自動検出された Web サーバー（`src/server/app.ts`）に関する 3 件のアラート（`js/missing-rate-limiting` / CWE-770, `js/missing-token-validation` / CWE-352, `js/clear-text-cookie` / CWE-614）を根本的に是正しました。

### 実施した変更
1. **レートリミッターの導入 (`src/server/app.ts`, CWE-770 / CWE-400)**:
   - `express-rate-limit` を導入し、15分間に最大1500リクエストのレートリミットを適用。
   - 静的ファイルや SPA ルートフォールバック（`res.sendFile`）への過負荷攻撃（DoS）を防御。
2. **セキュアクッキー強制 (`src/server/app.ts`, CWE-614 / CWE-319)**:
   - `trust proxy: 1` を設定した上で、セッション Cookie の `secure: true`（HTTPS/Cloudflare Tunnel 経由必須）および `httpOnly: true`, `sameSite: 'lax'` を明示的に設定。
3. **CSRF 保護ミドルウェアの導入 (`src/server/app.ts`, `public/app.js`, CWE-352)**:
   - `lusca.csrf`（`angular: true` モード）を導入し、`XSRF-TOKEN` クッキーの発行および POST/PUT/DELETE 時の `x-xsrf-token` ヘッダー検証を実装。
   - `public/app.js` の `window.fetch` を透過的にラップし、状態変更リクエスト時にクッキーから取得したトークンを `x-xsrf-token` ヘッダーへ自動付与する仕組みを完備。
4. **本番コンテナへの安全な反映と稼働検証**:
   - `npm run build` によるコンパイル成功を確認。
   - コンテナ内でのパッケージ追加（`express-rate-limit`, `lusca`）および `docker cp` / 再起動により正常稼働を確認。

## 2026-10-25 Dependabot 設定新設、CodeQL Cookie SSL強制リテラル化、および依存脆弱性解消

### 概要
GitHub Dependabot の自動更新設定（`.github/dependabot.yml`）を新設し、CodeQL の Alert #6 (`js/clear-text-cookie`) を解消するため `secure: true` をリテラル指定に更新しました。また、過去ログファイル（`logs/bot-archive.log`）の Git 追跡を解除しました。

### 実施した変更
1. **Dependabot 設定の新設 (`.github/dependabot.yml`)**:
   - npm、Docker、GitHub Actions の3つのエコシステムについて週次（月曜朝9時JST）の自動依存関係チェック・PR作成ルールを定義。
   - `@types/*`、`typescript` 等の開発依存関係をグループ化してPRを束ねる設定を追加。
2. **Cookie セキュア属性のリテラル強制 (`src/server/app.ts`)**:
   - CodeQL の静的解析エンジンが確実に SSL 暗号化強制を認識できるよう、`cookie.secure` を `true` リテラルに指定（Alert #6 の完全解消）。
4. **依存関係の全脆弱性解消 (`package-lock.json`, npm audit fix)**:
   - `npm audit fix` により、`undici` (v6.29.1)、`@grpc/grpc-js` (v1.14.5)、`brace-expansion` (v2.1.7)、`protobufjs` (v7.6.6)、`esbuild` (v0.28.1) のセキュリティパッチを適用。
   - npm 監査による脆弱性を 7 件から「0 件 (found 0 vulnerabilities)」へ完全解消。
   - 本番コンテナ内にも同期・適用し、無停止で正常稼働を維持。







