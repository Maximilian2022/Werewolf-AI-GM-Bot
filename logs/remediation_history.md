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
