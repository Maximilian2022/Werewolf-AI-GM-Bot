# ==========================================
# Stage 1: Build Environment
# ==========================================
FROM node:26.1.0-trixie-slim AS builder

WORKDIR /app
# 🚨 追加：GitHubからのパッケージ取得に必要な git をインストール
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    rm -rf /var/lib/apt/lists/*

# パッケージ定義をコピーして依存関係をインストール
COPY package*.json ./
RUN npm install -g npm
RUN npm install
RUN npm audit fix || true

# ソースコードをコピーしてTypeScriptをコンパイル
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ==========================================
# Stage 2: Production Environment
# ==========================================
FROM node:26.1.0-trixie-slim

WORKDIR /app

# 音声処理（@discordjs/voice, prism-media）およびCloudflare Tunnelに必要なシステムライブラリをインストール
# ※軽量化のため --no-install-recommends を付与し、キャッシュを削除
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libsodium23 build-essential python3 pkg-config libopus-dev curl ca-certificates && \
    curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && \
    dpkg -i /tmp/cloudflared.deb && \
    rm -f /tmp/cloudflared.deb && \
    rm -rf /var/lib/apt/lists/*

# 本番用のパッケージのみをインストール
COPY package*.json ./
RUN npm cache clean --force
RUN npm install -g npm
RUN npm install --omit=dev
# @discordjs/opus のネイティブビルドを確実に実行し、フォールバックとして opusscript も同梱
RUN npm install @discordjs/opus opusscript && \
    cd /app/node_modules/@discordjs/opus && \
    npx @mapbox/node-pre-gyp rebuild && \
    mkdir -p /app/node_modules/@discordjs/opus/prebuild/node-v147-napi-v3-linux-x64-glibc-2.41 /app/node_modules/@discordjs/opus/build/Release && \
    cp /app/node_modules/@discordjs/opus/build-tmp-napi-v3/Release/opus.node /app/node_modules/@discordjs/opus/prebuild/node-v147-napi-v3-linux-x64-glibc-2.41/opus.node && \
    cp /app/node_modules/@discordjs/opus/build-tmp-napi-v3/Release/opus.node /app/node_modules/@discordjs/opus/build/Release/opus.node

# Stage 1 でビルドしたコンパイル済みコードとWebUI静的アセットをコピー
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# Bun ランタイムを取り込み（ハイブリッド運用・高速実行）
COPY --from=oven/bun:latest /usr/local/bin/bun /usr/local/bin/bun

# Stateファイルや録音データ（OGG/TTS）を保存するディレクトリを作成
RUN mkdir -p /app/data
# 永続データ用ディレクトリの作成
RUN mkdir -p /app/data/games /app/data/audio /app/data/tts_cache /app/logs

# コンテナ起動時の実行コマンド（LogRotatorが自律的に2段階ローテーションするため、teeパイプ不要）
CMD ["bun", "dist/index.js"]
# フォールバック用（Node.js起動）:
# CMD ["node", "dist/index.js"]

