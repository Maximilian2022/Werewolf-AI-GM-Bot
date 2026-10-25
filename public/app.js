/**
 * public/app.js
 * Werewolf GM Bot - WebUI Application Logic
 */

// CSRF 保護（XSRF-TOKEN クッキーを読み取って x-xsrf-token ヘッダーに自動付与）
(function setupCsrfFetch() {
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
    return match ? decodeURIComponent(match[3]) : null;
  }

  const originalFetch = window.fetch;
  window.fetch = function(input, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      const token = getCookie('XSRF-TOKEN');
      if (token) {
        init.headers = {
          ...init.headers,
          'x-xsrf-token': token
        };
      }
    }
    return originalFetch.call(this, input, init);
  };
})();

// アプリケーションの状態
const state = {

  roles: [],
  regulations: [],
  currentRegulation: {
    id: '',
    name: '',
    description: '',
    isPreset: false,
    playerCount: 0,
    roles: {},
    rules: {
      firstNightDivination: 'white_npc',
      consecutiveGuard: false,
      runoffTieBreaker: 'random_execution',
      hasMediumResult: true,
      wolfVoiceChat: true
    }
  },
  currentUser: null,
  monitorPollingInterval: null
};

// ==========================================
// 初期化
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  const isAuthenticated = await checkAuth();
  if (isAuthenticated) {
    await loadRoles();
    await loadRegulations();
    await loadAiModels();
    await loadGameSettings();
    if (state.currentUser?.isAdmin) {
      await loadTunnelConfig();
    }
    await loadZoomProfiles();
    setupZoomHandlers();
    startMonitorPolling();
  }
});

// ==========================================
// タブ切り替えナビゲーション
// ==========================================
function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetPaneId = `pane-${tab.dataset.tab}`;
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const pane = document.getElementById(targetPaneId);
      if (pane) pane.classList.add('active');
    });
  });
}

// ==========================================
// ユーザー認証 (Discord OAuth2) & ゲート制御
// ==========================================
async function checkAuth() {
  const gateScreen = document.getElementById('login-gate-screen');
  const appWrapper = document.getElementById('app-wrapper');
  const tunnelTab = document.getElementById('tab-tunnel');

  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    state.currentUser = data.user;

    // 未ログイン時：ログインゲートを表示し、アプリ本体を非表示にする
    if (!data.authenticated || !state.currentUser) {
      if (gateScreen) gateScreen.style.display = 'flex';
      if (appWrapper) appWrapper.style.display = 'none';

      // OAuth設定が済んでいるか確認
      fetch('/api/auth/config').then(r => r.json()).then(conf => {
        const notice = document.getElementById('gate-oauth-notice');
        if (notice && !conf.configured) {
          notice.style.display = 'block';
        }
      }).catch(() => {});

      return false;
    }

    // ログイン済み：ゲートを隠し、アプリ本体を表示
    if (gateScreen) gateScreen.style.display = 'none';
    if (appWrapper) appWrapper.style.display = 'block';

    const profileArea = document.getElementById('user-profile-area');
    const avatarUrl = state.currentUser.avatar 
      ? `https://cdn.discordapp.com/avatars/${state.currentUser.id}/${state.currentUser.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';

    const adminBadgeHtml = state.currentUser.isAdmin 
      ? '<span class="user-admin-badge">👑 管理者</span>' 
      : '';

    profileArea.innerHTML = `
      <div class="user-info-badge">
        <img src="${avatarUrl}" class="user-avatar" alt="Avatar">
        <span style="font-size: 0.85rem; font-weight: 600;">${escapeHtml(state.currentUser.username)}</span>
        ${adminBadgeHtml}
      </div>
      <button class="btn btn-secondary" id="btn-logout" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">ログアウト</button>
    `;

    document.getElementById('btn-logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.reload();
    });

    // 管理者権限の有無でTunnelタブの表示を制御
    if (tunnelTab) {
      if (state.currentUser.isAdmin) {
        tunnelTab.style.display = 'inline-flex';
      } else {
        tunnelTab.style.display = 'none';
      }
    }

    return true;
  } catch (e) {
    console.error('Auth check error:', e);
    if (gateScreen) gateScreen.style.display = 'flex';
    if (appWrapper) appWrapper.style.display = 'none';
    return false;
  }
}

// ==========================================
// 役職 & レギュレーション管理 (1列 + アコーディオン)
// ==========================================
async function loadRoles() {
  try {
    const res = await fetch('/api/roles');
    if (!res.ok) return;
    state.roles = await res.json();
    renderRoleCards();
    updateDistributionSummary();
  } catch (e) {
    console.error('Failed to load roles:', e);
  }
}

function getRoleIcon(roleId) {
  const icons = {
    villager: '🧑',
    werewolf: '🐺',
    seer: '🔮',
    apprentice_seer: '🔰',
    reckless_seer: '⚡',
    medium: '🕯️',
    knight: '🛡️',
    madman: '🤪',
    fox: '🦊',
    fox_possessed: '🎭',
    fanatic: '👁️',
    mason: '🤝',
    nekomata: '🐱',
    baker: '🍞',
    fool: '🤡',
    undertaker: '⚰️',
    // 新規役職
    hunter: '🏹',
    dictator: '👑',
    tough_guy: '🥊',
    trapper: '🪤',
    counselor: '🩺',
    lone_wolf: '🐺',
    lovers: '💕',
    god: '👁️',
    spy: '🕵️',
    informant: '🕯️',
    wolf_cub: '🐾',
    apprentice_diviner: '🔮',
    targeted_civilian: '🎯',
    black_cat: '🐈‍⬛',
    cupid: '💘',
    femme_fatale: '💋',
    queen: '👑',
    living_spirit: '👻',
    wolf_minion: '🐕',
    berserk_wolf: '🩸'
  };
  return icons[roleId] || '🎭';
}

function renderRoleCards() {
  const container = document.getElementById('roles-selector-container');
  if (!container) return;
  container.innerHTML = '';

  const teamNames = {
    villager: '村人陣営',
    werewolf: '人狼陣営',
    fox: '妖狐陣営',
    third: '第三陣営',
    lovers: '恋人陣営'
  };

  const countTypeNames = {
    human: '人間判定',
    werewolf: '人狼判定',
    fox: '妖狐判定',
    none: '勝敗カウント対象外'
  };

  state.roles.forEach(role => {
    const count = state.currentRegulation.roles[role.id] || 0;
    const card = document.createElement('div');
    card.className = `role-row-card role-team-${role.team}${count > 0 ? ' active-assigned' : ''}`;
    card.id = `role-row-${role.id}`;

    card.innerHTML = `
      <div class="role-row-main">
        <div class="role-row-left">
          <div class="role-icon-small">${getRoleIcon(role.id)}</div>
          <div class="role-title-box">
            <span class="role-name-bold">${escapeHtml(role.name)}</span>
            <span class="role-team-badge badge-${role.team}">${teamNames[role.team] || role.team}</span>
            <button class="btn-accordion-toggle" id="toggle-${role.id}">
              <span class="toggle-icon">▼</span> 説明を見る
            </button>
          </div>
        </div>
        <div class="role-row-right">
          <div class="role-counter">
            <button class="btn-counter btn-minus" data-role="${role.id}">−</button>
            <span class="role-count-val font-mono" id="count-${role.id}">${count}</span>
            <button class="btn-counter btn-plus" data-role="${role.id}">＋</button>
          </div>
        </div>
      </div>
      <!-- アコーディオン説明部 (デフォルト非表示) -->
      <div class="role-desc-accordion" id="accordion-${role.id}">
        <p>${escapeHtml(role.description)}</p>
        <div class="role-meta-tags">
          <span class="meta-tag">勝敗カウント: ${countTypeNames[role.countType] || role.countType}</span>
          ${role.nightAction ? `<span class="meta-tag">夜の行動: ${role.nightAction.name}</span>` : ''}
        </div>
      </div>
    `;

    // アコーディオン開閉
    const toggleBtn = card.querySelector(`#toggle-${role.id}`);
    const accordion = card.querySelector(`#accordion-${role.id}`);
    const toggleIcon = card.querySelector('.toggle-icon');

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = accordion.classList.contains('show');
      if (isOpen) {
        accordion.classList.remove('show');
        toggleIcon.textContent = '▼';
        toggleBtn.innerHTML = '<span class="toggle-icon">▼</span> 説明を見る';
      } else {
        accordion.classList.add('show');
        toggleIcon.textContent = '▲';
        toggleBtn.innerHTML = '<span class="toggle-icon">▲</span> 説明を隠す';
      }
    });

    // カウンター増減
    card.querySelector('.btn-minus').addEventListener('click', () => updateRoleCount(role.id, -1));
    card.querySelector('.btn-plus').addEventListener('click', () => updateRoleCount(role.id, 1));

    container.appendChild(card);
  });

  updateTotalCountDisplay();
  updateDistributionSummary();
}

function updateRoleCount(roleId, delta) {
  const current = state.currentRegulation.roles[roleId] || 0;
  const next = Math.max(0, current + delta);
  if (next === 0) {
    delete state.currentRegulation.roles[roleId];
  } else {
    state.currentRegulation.roles[roleId] = next;
  }

  const countEl = document.getElementById(`count-${roleId}`);
  if (countEl) countEl.textContent = next;

  const card = document.getElementById(`role-row-${roleId}`);
  if (card) {
    if (next > 0) card.classList.add('active-assigned');
    else card.classList.remove('active-assigned');
  }

  updateTotalCountDisplay();
  updateDistributionSummary();
}

function updateTotalCountDisplay() {
  let total = 0;
  for (const c of Object.values(state.currentRegulation.roles)) {
    total += c;
  }
  state.currentRegulation.playerCount = total;
  const totalEl = document.getElementById('total-player-count');
  if (totalEl) totalEl.textContent = total;

  const summaryTotalEl = document.getElementById('summary-total-count');
  if (summaryTotalEl) summaryTotalEl.textContent = `${total}人`;
}

// ==========================================
// 📊 右端で縦に並ぶ配分サマリーの更新
// ==========================================
function updateDistributionSummary() {
  const summaryContainer = document.getElementById('distribution-summary-list');
  if (!summaryContainer) return;

  const assigned = Object.entries(state.currentRegulation.roles)
    .filter(([_, count]) => count > 0)
    .map(([roleId, count]) => {
      const roleDef = state.roles.find(r => r.id === roleId);
      return {
        id: roleId,
        name: roleDef ? roleDef.name : roleId,
        count
      };
    });

  if (assigned.length === 0) {
    summaryContainer.innerHTML = `
      <div class="summary-empty-text">
        <span>まだ役職が割り振られていません</span>
      </div>
    `;
    return;
  }

  summaryContainer.innerHTML = '';
  assigned.forEach(item => {
    const row = document.createElement('div');
    row.className = 'summary-row-item';
    row.innerHTML = `
      <div class="summary-row-left">
        <span class="summary-role-icon">${getRoleIcon(item.id)}</span>
        <span class="summary-role-name">${escapeHtml(item.name)}</span>
      </div>
      <span class="summary-count-badge">${item.count}人</span>
    `;
    summaryContainer.appendChild(row);
  });
}

async function loadRegulations() {
  try {
    const res = await fetch('/api/regulations');
    state.regulations = await res.json();
    renderPresetDropdown();
    renderSavedRegulationsList();

    // デフォルトで標準13人村をセット
    if (!state.currentRegulation.id && state.regulations.length > 0) {
      applyRegulation(state.regulations[0]);
    }
  } catch (e) {
    console.error('Failed to load regulations:', e);
  }
}

function renderPresetDropdown() {
  const select = document.getElementById('preset-select');
  select.innerHTML = '<option value="">-- プリセット / 登録一覧から選ぶ --</option>';
  state.regulations.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} (${r.playerCount}人)${r.isPreset ? ' [公式]' : ''}`;
    select.appendChild(opt);
  });

  select.addEventListener('change', (e) => {
    const selected = state.regulations.find(r => r.id === e.target.value);
    if (selected) applyRegulation(selected);
  });
}

function applyRegulation(reg) {
  state.currentRegulation = JSON.parse(JSON.stringify(reg));
  document.getElementById('reg-name').value = reg.name;
  document.getElementById('reg-desc').value = reg.description || '';

  // 基本進行ルール
  document.getElementById('rule-first-night').value = reg.rules?.firstNightDivination || 'white_npc';
  document.getElementById('rule-guard').value = String(reg.rules?.consecutiveGuard);
  document.getElementById('rule-runoff').value = reg.rules?.runoffTieBreaker || 'random_execution';
  document.getElementById('rule-medium').value = String(reg.rules?.hasMediumResult !== false);
  document.getElementById('rule-wolf-vc').value = String(reg.rules?.wolfVoiceChat !== false);

  // 制限時間設定 (このレギュレーション独自)
  const times = reg.times || {};
  document.getElementById('reg-time-day1').value = times.day1DiscussionMin ?? 5;
  document.getElementById('reg-time-day2').value = times.day2DiscussionMin ?? 4;
  document.getElementById('reg-time-day-dec').value = times.dayDecreaseMin ?? 1;
  document.getElementById('reg-time-action').value = times.actionTimeoutMin ?? 1;
  document.getElementById('reg-time-runoff-def').value = times.runoffDefenseMin ?? 1;
  document.getElementById('reg-time-runoff-vote').value = times.runoffVoteTimeoutMin ?? 1;
  document.getElementById('reg-time-last-word').value = times.lastWordMin ?? 1;

  // システム演出 & AI総評設定 (このレギュレーション独自)
  const sys = reg.system || {};
  document.getElementById('reg-sys-gm-voice').value = sys.gmVoice || 'ja-JP-Neural2-D';
  if (sys.aiModel) document.getElementById('reg-sys-ai-model').value = sys.aiModel;
  document.getElementById('reg-sys-ai-tone').value = sys.aiTone || 'normal';
  document.getElementById('reg-sys-mvp-mode').value = sys.mvpMode || 'compare';
  document.getElementById('reg-enable-ai-recording').checked = sys.enableAIRecording !== false;
  const regAnnounceEl = document.getElementById('reg-enable-reg-announce');
  if (regAnnounceEl) {
    regAnnounceEl.checked = sys.enableRegulationAnnouncement !== false;
  }

  renderRoleCards();
}

function renderSavedRegulationsList() {
  const container = document.getElementById('saved-regulations-list');
  container.innerHTML = '';

  state.regulations.forEach(reg => {
    const item = document.createElement('div');
    item.className = 'regulation-item';

    let roleBadges = '';
    for (const [rId, count] of Object.entries(reg.roles)) {
      const rObj = state.roles.find(r => r.id === rId);
      const name = rObj ? rObj.name : rId;
      roleBadges += `<span class="reg-role-tag">${name}×${count}</span>`;
    }

    item.innerHTML = `
      <div>
        <div class="reg-item-header">
          <span class="reg-item-title">${escapeHtml(reg.name)}</span>
          <span class="badge badge-intent">${reg.playerCount}人</span>
        </div>
        <p class="reg-item-desc">${escapeHtml(reg.description || '説明なし')}</p>
        <div class="reg-roles-tags">${roleBadges}</div>
      </div>
      <div class="reg-actions">
        <button class="btn btn-secondary btn-load-reg" data-id="${reg.id}">読み込む</button>
        ${!reg.isPreset ? `<button class="btn btn-danger btn-del-reg" data-id="${reg.id}">削除</button>` : ''}
      </div>
    `;

    item.querySelector('.btn-load-reg').addEventListener('click', () => applyRegulation(reg));
    const delBtn = item.querySelector('.btn-del-reg');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (confirm(`レギュレーション「${reg.name}」を削除してもよろしいですか？`)) {
          await fetch(`/api/regulations/${reg.id}`, { method: 'DELETE' });
          await loadRegulations();
        }
      });
    }

    container.appendChild(item);
  });
}

// レギュレーション保存
document.getElementById('btn-save-regulation').addEventListener('click', async () => {
  const name = document.getElementById('reg-name').value.trim();
  const desc = document.getElementById('reg-desc').value.trim();

  if (!name) {
    alert('レギュレーション名を入力してください。');
    return;
  }

  const payload = {
    ...state.currentRegulation,
    name,
    description: desc,
    rules: {
      firstNightDivination: document.getElementById('rule-first-night').value,
      consecutiveGuard: document.getElementById('rule-guard').value === 'true',
      runoffTieBreaker: document.getElementById('rule-runoff').value,
      hasMediumResult: document.getElementById('rule-medium').value === 'true',
      wolfVoiceChat: document.getElementById('rule-wolf-vc').value === 'true'
    },
    times: {
      day1DiscussionMin: parseFloat(document.getElementById('reg-time-day1').value),
      day2DiscussionMin: parseFloat(document.getElementById('reg-time-day2').value),
      dayDecreaseMin: parseFloat(document.getElementById('reg-time-day-dec').value),
      actionTimeoutMin: parseFloat(document.getElementById('reg-time-action').value),
      runoffDefenseMin: parseFloat(document.getElementById('reg-time-runoff-def').value),
      runoffVoteTimeoutMin: parseFloat(document.getElementById('reg-time-runoff-vote').value),
      lastWordMin: parseFloat(document.getElementById('reg-time-last-word').value)
    },
    system: {
      gmVoice: document.getElementById('reg-sys-gm-voice').value,
      aiModel: document.getElementById('reg-sys-ai-model').value,
      aiTone: document.getElementById('reg-sys-ai-tone').value,
      mvpMode: document.getElementById('reg-sys-mvp-mode').value,
      enableAIRecording: document.getElementById('reg-enable-ai-recording').checked,
      enableRegulationAnnouncement: document.getElementById('reg-enable-reg-announce') ? document.getElementById('reg-enable-reg-announce').checked : true
    }
  };

  try {
    const res = await fetch('/api/regulations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert(`レギュレーション「${payload.name}」を保存しました。`);
      await loadRegulations();
      const updated = state.regulations.find(r => r.id === data.regulation.id);
      if (updated) applyRegulation(updated);
    } else {
      alert('保存に失敗しました: ' + (data.error || '不明なエラー'));
    }
  } catch (e) {
    alert('エラーが発生しました: ' + e.message);
  }
});

// 新規作成ボタン
document.getElementById('btn-new-regulation').addEventListener('click', () => {
  state.currentRegulation = {
    id: `custom_${Date.now()}`,
    name: '新規カスタムレギュレーション',
    description: '',
    isPreset: false,
    playerCount: 0,
    roles: {},
    rules: {
      firstNightDivination: 'white_npc',
      consecutiveGuard: false,
      runoffTieBreaker: 'random_execution',
      hasMediumResult: true,
      wolfVoiceChat: true
    }
  };
  applyRegulation(state.currentRegulation);
});

// ==========================================
// リアルタイムゲームモニター (ゲーム単位ロック対応)
// ==========================================
state.selectedGameId = null;

async function loadActiveGames() {
  try {
    const res = await fetch('/api/game/games');
    if (!res.ok) return;
    const games = await res.json();
    const select = document.getElementById('select-active-game');
    if (!select) return;

    if (games.length === 0) {
      select.style.display = 'none';
      state.selectedGameId = null;
      return;
    }

    select.innerHTML = '';
    games.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.gameId;
      const pIcon = g.platform === 'zoom' ? '🎥 Zoom' : '🐺 Discord';
      const lockIcon = g.isLocked ? '🔒 ' : '';
      opt.textContent = `${lockIcon}${pIcon} (${g.playerCount}人) #${g.gameId.slice(-6)}`;
      select.appendChild(opt);
    });

    if (games.length > 1) {
      select.style.display = 'inline-block';
    } else {
      select.style.display = 'none';
    }

    // 選択中のゲームが一覧になければ先頭を選択
    if (!state.selectedGameId || !games.some(g => g.gameId === state.selectedGameId)) {
      state.selectedGameId = games[0].gameId;
      select.value = state.selectedGameId;
    } else {
      select.value = state.selectedGameId;
    }
  } catch (err) {
    console.error('Failed to load active games:', err);
  }
}

function startMonitorPolling() {
  const select = document.getElementById('select-active-game');
  if (select) {
    select.addEventListener('change', (e) => {
      state.selectedGameId = e.target.value;
      updateMonitor();
    });
  }

  loadActiveGames().then(updateMonitor);
  state.monitorPollingInterval = setInterval(() => {
    loadActiveGames();
    updateMonitor();
  }, 3000);
  document.getElementById('btn-refresh-monitor').addEventListener('click', () => {
    loadActiveGames().then(updateMonitor);
  });
}

async function updateMonitor() {
  try {
    const q = state.selectedGameId ? `?gameId=${encodeURIComponent(state.selectedGameId)}` : '';
    const res = await fetch(`/api/game/state${q}`);
    const data = await res.json();

    const emptyState = document.getElementById('monitor-empty-state');
    const lockScreen = document.getElementById('monitor-lock-screen');
    const fullScreen = document.getElementById('monitor-full-screen');

    // 1. ゲーム非開催
    if (!data.hasActiveGame) {
      emptyState.style.display = 'block';
      lockScreen.style.display = 'none';
      fullScreen.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';

    // 2. ロック画面（参加プレイヤー、または未認証・未解除アクセス）
    if (data.locked) {
      fullScreen.style.display = 'none';
      lockScreen.style.display = 'flex';
      document.getElementById('btn-relock-monitor').style.display = 'none';

      const lockTitle = document.getElementById('lock-title');
      const lockMsg = document.getElementById('lock-message');
      const lockFooter = document.getElementById('lock-footer-action');

      if (data.lockReason === 'participant_locked') {
        lockTitle.textContent = '⚠️ 参加者情報保護ロック中';
        lockMsg.textContent = data.message;
        lockFooter.innerHTML = `
          <div style="font-size: 0.9rem; color: var(--text-muted);">
            ゲームID: <strong>${escapeHtml(data.gameId || '-')}</strong> (${data.day}日目 ${data.phase})
          </div>
        `;
      } else {
        // 案A: GMパスコード認証解除画面 (Discordログイン前提)
        lockTitle.textContent = '🔒 ゲーム進行中（情報保護ロック）';

        // ログイン状態の判定
        if (!state.user) {
          lockMsg.textContent = `${data.message}\n※不正防止のため、GMパスコード解除にはDiscordアカウントでのログインが必要です。`;
          lockFooter.innerHTML = `
            <div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 8px;">
              ゲームID: <strong>${escapeHtml(data.gameId || '-')}</strong> (${data.day}日目 ${data.phase})
            </div>
            <button class="btn btn-discord" onclick="window.location.href='/api/auth/discord/login'">
              Discordでログインしてパスコード解除
            </button>
          `;
        } else {
          const userServerName = state.user.displayName || state.user.username;
          lockMsg.textContent = `${data.message}\n※パスコードを解除すると、「${userServerName} さんがゲームモニターを解除しました」とZoom全体チャット等に通知されます。`;
          lockFooter.innerHTML = `
            <div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 4px;">
              ゲームID: <strong>${escapeHtml(data.gameId || '-')}</strong> (${data.day}日目 ${data.phase})
            </div>
            <div style="font-size: 0.85rem; color: var(--accent); margin-bottom: 8px;">
              👤 ログイン中: <strong>${escapeHtml(userServerName)}</strong>
            </div>
            <div style="display: flex; gap: 8px; justify-content: center; margin-top: 10px; width: 100%; max-width: 340px;">
              <input type="password" id="monitor-passcode-input" class="form-control" placeholder="GMパスコード (初期値: 1234)" style="text-align: center;">
              <button class="btn btn-primary" id="btn-unlock-monitor">🔑 解除</button>
            </div>
            <div id="unlock-error" style="color: var(--danger); font-size: 0.85rem; margin-top: 6px; display: none;"></div>
          `;

          const btnUnlock = document.getElementById('btn-unlock-monitor');
          const inputPasscode = document.getElementById('monitor-passcode-input');
          if (btnUnlock && inputPasscode) {
            const handleUnlock = async () => {
              const passcode = inputPasscode.value.trim();
              if (!passcode) return;
              try {
                const uRes = await fetch('/api/game/unlock', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ gameId: data.gameId, passcode })
                });
                const uData = await uRes.json();
                if (uData.success) {
                  updateMonitor();
                } else {
                  const errEl = document.getElementById('unlock-error');
                  if (errEl) {
                    errEl.textContent = uData.error || 'パスコードが正しくありません';
                    errEl.style.display = 'block';
                  }
                }
              } catch (err) {
                console.error('Failed to unlock monitor:', err);
              }
            };
            btnUnlock.onclick = handleUnlock;
            inputPasscode.onkeydown = (e) => {
              if (e.key === 'Enter') handleUnlock();
            };
          }
        }
      }
      return;
    }

    // 3. フル表示（GM / 観戦者 / ゲーム終了後）
    lockScreen.style.display = 'none';
    fullScreen.style.display = 'block';

    const s = data.state;
    const btnRelock = document.getElementById('btn-relock-monitor');
    if (btnRelock) {
      btnRelock.style.display = data.isGmUnlocked ? 'inline-block' : 'none';
      btnRelock.onclick = async () => {
        await fetch('/api/game/relock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gameId: s.gameId })
        });
        updateMonitor();
      };
    }

    document.getElementById('m-game-id').textContent = s.gameId || '-';
    document.getElementById('m-phase').textContent = s.phase || '-';
    document.getElementById('m-day').textContent = `${s.day}日目`;
    
    const aliveCount = s.players.filter(p => p.isAlive).length;
    document.getElementById('m-alive-count').textContent = `${aliveCount} / ${s.players.length}人`;
    document.getElementById('m-paused').textContent = s.isPaused ? '⏸️ 一時停止中' : '進行中';

    // プレイヤーテーブル
    const tbody = document.getElementById('m-players-table-body');
    tbody.innerHTML = '';
    s.players.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${p.userId}</code></td>
        <td><strong>${escapeHtml(p.role || '未配役')}</strong></td>
        <td>${p.isAlive ? '<span class="alive-badge">🟢 生存</span>' : '<span class="dead-badge">💀 死亡</span>'}</td>
      `;
      tbody.appendChild(tr);
    });

    // ログボックス
    const logsBox = document.getElementById('m-event-logs');
    logsBox.innerHTML = '';
    const logs = s.eventLogs || [];
    logs.forEach(l => {
      const div = document.createElement('div');
      div.textContent = l;
      logsBox.appendChild(div);
    });
    logsBox.scrollTop = logsBox.scrollHeight;

  } catch (e) {
    console.error('Monitor update error:', e);
  }
}

// ==========================================
// Cloudflare Tunnel 設定
// ==========================================
async function loadTunnelConfig() {
  try {
    const res = await fetch('/api/tunnel');
    const data = await res.json();

    document.getElementById('tunnel-fqdn').value = data.config.fqdn || '';
    document.getElementById('tunnel-autostart').checked = Boolean(data.config.autoStart);
    document.getElementById('discord-client-id').value = data.config.discordClientId || '';
    if (data.config.hasToken) {
      document.getElementById('tunnel-token').placeholder = '•••••••••••••••••••••••• (設定済み)';
    }

    updateTunnelStatusUI(data);

    // インストラクション内のRedirect URLを動的更新
    const fqdn = data.config.fqdn || '<FQDN>';
    document.getElementById('inst-redirect-url').textContent = `https://${fqdn}/api/auth/discord/callback`;
  } catch (e) {
    console.error('Failed to load tunnel config:', e);
  }
}

function updateTunnelStatusUI(data) {
  const badge = document.getElementById('tunnel-status-badge');
  const btnStart = document.getElementById('btn-start-tunnel');
  const btnStop = document.getElementById('btn-stop-tunnel');
  const urlBox = document.getElementById('tunnel-url-box');
  const link = document.getElementById('tunnel-public-link');

  badge.className = `status-pill status-${data.status}`;
  badge.textContent = data.status.toUpperCase();

  if (data.status === 'running') {
    btnStart.style.display = 'none';
    btnStop.style.display = 'inline-flex';
    if (data.publicUrl) {
      urlBox.style.display = 'block';
      link.href = data.publicUrl;
      link.textContent = data.publicUrl;
    }
  } else {
    btnStart.style.display = 'inline-flex';
    btnStop.style.display = 'none';
    urlBox.style.display = 'none';
  }
}

document.getElementById('btn-save-tunnel').addEventListener('click', async () => {
  const fqdn = document.getElementById('tunnel-fqdn').value.trim();
  const token = document.getElementById('tunnel-token').value.trim();
  const autoStart = document.getElementById('tunnel-autostart').checked;
  const discordClientId = document.getElementById('discord-client-id').value.trim();
  const discordClientSecret = document.getElementById('discord-client-secret').value.trim();

  const payload = { fqdn, autoStart, discordClientId };
  if (token) payload.token = token;
  if (discordClientSecret) payload.discordClientSecret = discordClientSecret;

  try {
    const res = await fetch('/api/tunnel/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert('Tunnel設定を保存しました。');
      loadTunnelConfig();
    }
  } catch (e) {
    alert('設定保存に失敗しました。');
  }
});

document.getElementById('btn-start-tunnel').addEventListener('click', async () => {
  const btn = document.getElementById('btn-start-tunnel');
  btn.disabled = true;
  btn.textContent = '起動中...';
  try {
    const res = await fetch('/api/tunnel/start', { method: 'POST' });
    const data = await res.json();
    alert(data.message);
    loadTunnelConfig();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-stop-tunnel').addEventListener('click', async () => {
  const res = await fetch('/api/tunnel/stop', { method: 'POST' });
  const data = await res.json();
  alert(data.message);
  loadTunnelConfig();
});

// ==========================================
// AIモデル動的取得
// ==========================================
async function loadAiModels() {
  try {
    const res = await fetch('/api/ai/models');
    if (!res.ok) return;
    const models = await res.json();
    const selects = [
      document.getElementById('sys-ai-model'),
      document.getElementById('reg-sys-ai-model')
    ].filter(Boolean);

    selects.forEach(select => {
      const currentVal = select.value;
      select.innerHTML = '';
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        select.appendChild(opt);
      });
      if (currentVal) {
        select.value = currentVal;
      }
    });
  } catch (e) {
    console.error('Failed to load AI models:', e);
  }
}

// ==========================================
// ゲーム設定 (時間・AI・音声)
// ==========================================
async function loadGameSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();

    const n = data.normal;
    document.getElementById('s-day1-min').value = n.day1DiscussionMin;
    document.getElementById('s-day2-min').value = n.day2DiscussionMin;
    document.getElementById('s-day-dec').value = n.dayDecreaseMin;
    document.getElementById('s-action-min').value = n.actionTimeoutMin;
    document.getElementById('s-runoff-defense').value = n.runoffDefenseMin;
    document.getElementById('s-runoff-vote').value = n.runoffVoteTimeoutMin;
    document.getElementById('s-last-word').value = n.lastWordMin;

    const d = data.debug;
    document.getElementById('sd-day1-min').value = d.day1DiscussionMin;
    document.getElementById('sd-day2-min').value = d.day2DiscussionMin;
    document.getElementById('sd-action-min').value = d.actionTimeoutMin;
    document.getElementById('sd-runoff-defense').value = d.runoffDefenseMin;
    document.getElementById('sd-runoff-vote').value = d.runoffVoteTimeoutMin;
    document.getElementById('sd-last-word').value = d.lastWordMin;

    const sys = data.system;
    document.getElementById('sys-gm-voice').value = sys.gmVoice;
    document.getElementById('sys-ai-model').value = sys.aiModel;
    document.getElementById('sys-ai-tone').value = sys.aiTone;
    document.getElementById('sys-mvp-mode').value = sys.mvpMode;
    document.getElementById('sys-data-retention').value = n.dataDeletionDays;
    const announceEl = document.getElementById('sys-enable-reg-announce');
    if (announceEl) {
      announceEl.checked = sys.enableRegulationAnnouncement !== false;
    }
    const passcodeEl = document.getElementById('sys-gm-passcode');
    if (passcodeEl) {
      passcodeEl.value = sys.gmPasscode || '1234';
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const normal = {
    day1DiscussionMin: parseFloat(document.getElementById('s-day1-min').value),
    day2DiscussionMin: parseFloat(document.getElementById('s-day2-min').value),
    dayDecreaseMin: parseFloat(document.getElementById('s-day-dec').value),
    actionTimeoutMin: parseFloat(document.getElementById('s-action-min').value),
    runoffDefenseMin: parseFloat(document.getElementById('s-runoff-defense').value),
    runoffVoteTimeoutMin: parseFloat(document.getElementById('s-runoff-vote').value),
    lastWordMin: parseFloat(document.getElementById('s-last-word').value),
    dataDeletionDays: parseInt(document.getElementById('sys-data-retention').value)
  };

  const debug = {
    day1DiscussionMin: parseFloat(document.getElementById('sd-day1-min').value),
    day2DiscussionMin: parseFloat(document.getElementById('sd-day2-min').value),
    actionTimeoutMin: parseFloat(document.getElementById('sd-action-min').value),
    runoffDefenseMin: parseFloat(document.getElementById('sd-runoff-defense').value),
    runoffVoteTimeoutMin: parseFloat(document.getElementById('sd-runoff-vote').value),
    lastWordMin: parseFloat(document.getElementById('sd-last-word').value)
  };

  const passcodeEl = document.getElementById('sys-gm-passcode');
  const announceEl = document.getElementById('sys-enable-reg-announce');
  const system = {
    gmVoice: document.getElementById('sys-gm-voice').value,
    aiModel: document.getElementById('sys-ai-model').value,
    aiTone: document.getElementById('sys-ai-tone').value,
    mvpMode: document.getElementById('sys-mvp-mode').value,
    enableRegulationAnnouncement: announceEl ? announceEl.checked : true,
    gmPasscode: passcodeEl ? passcodeEl.value.trim() || '1234' : '1234'
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normal, debug, system })
    });
    const data = await res.json();
    if (data.success) {
      alert('ゲーム設定を保存しました。');
    }
  } catch (e) {
    alert('設定の保存に失敗しました。');
  }
});

// ユーティリティ
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// 🎥 Zoom 連携 UI ロジック
// ==========================================
state.zoomProfiles = [];
state.zoomPollingInterval = null;

async function loadZoomProfiles() {
  try {
    const res = await fetch('/api/zoom/profiles');
    if (!res.ok) return;
    state.zoomProfiles = await res.json();
    renderZoomProfileOptions();
    renderZoomProfilesTable();
  } catch (err) {
    console.error('Zoomプロファイル読み込みエラー:', err);
  }
}

function renderZoomProfileOptions() {
  const select = document.getElementById('zoom-profile-select');
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = '<option value="">-- プロファイルを選択してください --</option>';
  state.zoomProfiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.clientId.slice(0, 8)}...)`;
    select.appendChild(opt);
  });
  if (currentVal && state.zoomProfiles.some(p => p.id === currentVal)) {
    select.value = currentVal;
  }
}

function renderZoomProfilesTable() {
  const tbody = document.getElementById('zoom-profiles-tbody');
  if (!tbody) return;
  if (!state.zoomProfiles || state.zoomProfiles.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">プロファイルがまだ登録されていません</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  state.zoomProfiles.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(p.name)}</strong></td>
      <td><code>${escapeHtml(p.clientId)}</code></td>
      <td><code>${escapeHtml(p.clientSecretMasked)}</code></td>
      <td>${p.defaultHostKey ? `<code>${escapeHtml(p.defaultHostKey)}</code>` : '<span class="text-muted">-</span>'}</td>
      <td>
        <button class="btn btn-secondary btn-sm btn-edit-zoom-profile" data-id="${p.id}">編集</button>
        <button class="btn btn-danger btn-sm btn-delete-zoom-profile" data-id="${p.id}">削除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 編集ボタン
  tbody.querySelectorAll('.btn-edit-zoom-profile').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const profile = state.zoomProfiles.find(p => p.id === id);
      if (!profile) return;
      document.getElementById('zoom-profile-form-title').textContent = '✏️ プロファイル編集';
      document.getElementById('zoom-form-profile-id').value = profile.id;
      document.getElementById('zoom-form-name').value = profile.name;
      document.getElementById('zoom-form-client-id').value = profile.clientId;
      document.getElementById('zoom-form-client-secret').value = '';
      document.getElementById('zoom-form-client-secret').placeholder = '変更しない場合は空欄のまま';
      document.getElementById('zoom-form-host-key').value = profile.defaultHostKey || '';
      const cancelBtn = document.getElementById('btn-cancel-zoom-profile-edit');
      if (cancelBtn) cancelBtn.style.display = 'inline-block';
    });
  });

  // 削除ボタン
  tbody.querySelectorAll('.btn-delete-zoom-profile').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const profile = state.zoomProfiles.find(p => p.id === id);
      if (!profile || !confirm(`プロファイル「${profile.name}」を削除しますか？`)) return;
      try {
        const res = await fetch(`/api/zoom/profiles/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          await loadZoomProfiles();
        } else {
          alert('削除に失敗しました');
        }
      } catch (err) {
        alert('削除エラー: ' + err.message);
      }
    });
  });
}

function setupZoomHandlers() {
  // プロファイル選択時にデフォルトホストキーを自動入力
  const profileSelect = document.getElementById('zoom-profile-select');
  if (profileSelect) {
    profileSelect.addEventListener('change', () => {
      const selected = state.zoomProfiles.find(p => p.id === profileSelect.value);
      if (selected && selected.defaultHostKey) {
        const hostKeyInput = document.getElementById('zoom-host-key');
        if (hostKeyInput && !hostKeyInput.value) {
          hostKeyInput.value = selected.defaultHostKey;
        }
      }
    });
  }

  // 招待URLの自動パース
  const urlInput = document.getElementById('zoom-url-input');
  const parseBtn = document.getElementById('btn-parse-zoom-url');
  const handleParse = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    try {
      const res = await fetch('/api/zoom/parse-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (data.parsed) {
        document.getElementById('zoom-meeting-number').value = data.parsed.meetingNumber;
        document.getElementById('zoom-passcode').value = data.parsed.passcode;
        urlInput.style.borderColor = '#34d399';
        setTimeout(() => { urlInput.style.borderColor = ''; }, 2000);
      } else {
        alert('Zoom招待URLの形式が認識できませんでした。手動で番号とパスコードを入力してください。');
      }
    } catch (err) {
      console.error('URLパースエラー:', err);
    }
  };
  if (urlInput) urlInput.addEventListener('change', handleParse);
  if (parseBtn) parseBtn.addEventListener('click', handleParse);

  // プロファイルモーダル開閉
  const modal = document.getElementById('modal-zoom-profiles');
  const openBtn = document.getElementById('btn-open-zoom-profiles-modal');
  const closeBtn = document.getElementById('btn-close-zoom-profiles-modal');
  const cancelEditBtn = document.getElementById('btn-cancel-zoom-profile-edit');

  const resetForm = () => {
    document.getElementById('zoom-profile-form-title').textContent = '➕ 新規プロファイル登録';
    document.getElementById('zoom-form-profile-id').value = '';
    document.getElementById('zoom-form-name').value = '';
    document.getElementById('zoom-form-client-id').value = '';
    document.getElementById('zoom-form-client-secret').value = '';
    document.getElementById('zoom-form-client-secret').placeholder = 'Zoom MarketplaceのClient Secret';
    document.getElementById('zoom-form-host-key').value = '';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
  };

  if (openBtn) openBtn.addEventListener('click', () => { resetForm(); modal.style.display = 'flex'; });
  if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', resetForm);

  // プロファイル保存
  const saveProfileBtn = document.getElementById('btn-save-zoom-profile');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', async () => {
      const id = document.getElementById('zoom-form-profile-id').value.trim() || undefined;
      const name = document.getElementById('zoom-form-name').value.trim();
      const clientId = document.getElementById('zoom-form-client-id').value.trim();
      const clientSecret = document.getElementById('zoom-form-client-secret').value.trim() || undefined;
      const defaultHostKey = document.getElementById('zoom-form-host-key').value.trim() || undefined;

      if (!name || !clientId) {
        alert('プロファイル名とClient IDは必須です');
        return;
      }
      if (!id && !clientSecret) {
        alert('新規登録時はClient Secretが必須です');
        return;
      }

      try {
        const res = await fetch('/api/zoom/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name, clientId, clientSecret, defaultHostKey })
        });
        const data = await res.json();
        if (data.success) {
          resetForm();
          await loadZoomProfiles();
        } else {
          alert('保存に失敗しました: ' + (data.error || '不明なエラー'));
        }
      } catch (err) {
        alert('通信エラー: ' + err.message);
      }
    });
  }

  // Zoom Bot 召喚
  const joinBtn = document.getElementById('btn-zoom-join');
  if (joinBtn) {
    joinBtn.addEventListener('click', async () => {
      const profileId = document.getElementById('zoom-profile-select').value;
      const meetingNumber = document.getElementById('zoom-meeting-number').value.trim();
      const passcode = document.getElementById('zoom-passcode').value.trim();
      const hostKey = document.getElementById('zoom-host-key').value.trim();
      const enableAIRecording = document.getElementById('zoom-enable-ai-recording').checked;

      if (!profileId) {
        alert('主催者プロファイルを選択してください');
        return;
      }
      if (!meetingNumber) {
        alert('ミーティング番号を入力してください');
        return;
      }

      joinBtn.disabled = true;
      joinBtn.textContent = '🔄 接続中...';

      try {
        const res = await fetch('/api/zoom/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId, meetingNumber, passcode, hostKey, enableAIRecording })
        });
        const data = await res.json();
        if (data.success) {
          await fetchZoomStatus();
        } else {
          alert('召喚に失敗しました: ' + (data.message || data.error));
        }
      } catch (err) {
        alert('通信エラー: ' + err.message);
      } finally {
        joinBtn.disabled = false;
        joinBtn.textContent = '🚀 Zoom に Bot を召喚する';
      }
    });
  }

  // Zoom 退出
  const leaveBtn = document.getElementById('btn-zoom-leave');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', async () => {
      if (!confirm('ZoomミーティングからBotを退出させますか？')) return;
      leaveBtn.disabled = true;
      try {
        await fetch('/api/zoom/leave', { method: 'POST' });
        await fetchZoomStatus();
      } catch (err) {
        alert('退出エラー: ' + err.message);
      } finally {
        leaveBtn.disabled = false;
      }
    });
  }

  // チャット送信
  const chatInput = document.getElementById('zoom-chat-input');
  const chatSendBtn = document.getElementById('btn-send-zoom-chat');
  const sendChat = async () => {
    const message = chatInput.value.trim();
    if (!message) return;
    try {
      await fetch('/api/zoom/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
      chatInput.value = '';
      await fetchZoomStatus();
    } catch (err) {
      console.error('チャット送信エラー:', err);
    }
  };
  if (chatSendBtn) chatSendBtn.addEventListener('click', sendChat);
  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendChat();
    });
  }

  // ゲーム開始
  const startGameBtn = document.getElementById('btn-zoom-start-game');
  if (startGameBtn) {
    startGameBtn.addEventListener('click', async () => {
      const regId = document.getElementById('zoom-game-reg-select').value;
      if (!confirm('Zoom人狼ゲームを開始しますか？')) return;
      try {
        await fetch('/api/zoom/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '!開始' })
        });
        alert('ゲーム開始コマンドを送信しました！');
      } catch (err) {
        alert('開始エラー: ' + err.message);
      }
    });
  }

  // 仮想シミュレータ (Mockモード) 制御
  const startMockBtn = document.getElementById('btn-start-zoom-mock');
  const stopMockBtn = document.getElementById('btn-stop-zoom-mock');
  if (startMockBtn) {
    startMockBtn.addEventListener('click', async () => {
      const count = document.getElementById('zoom-mock-count').value;
      startMockBtn.disabled = true;
      try {
        const res = await fetch('/api/zoom/mock/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count })
        });
        const data = await res.json();
        if (data.success) {
          await fetchZoomStatus();
        } else {
          alert('シミュレータ起動エラー: ' + data.message);
        }
      } catch (err) {
        alert('通信エラー: ' + err.message);
      } finally {
        startMockBtn.disabled = false;
      }
    });
  }

  if (stopMockBtn) {
    stopMockBtn.addEventListener('click', async () => {
      stopMockBtn.disabled = true;
      try {
        await fetch('/api/zoom/mock/stop', { method: 'POST' });
        await fetchZoomStatus();
      } catch (err) {
        alert('停止エラー: ' + err.message);
      } finally {
        stopMockBtn.disabled = false;
      }
    });
  }

  const sendMockCmd = async (message) => {
    try {
      await fetch('/api/zoom/mock/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderUserId: 'mock_user_1', message })
      });
      await fetchZoomStatus();
    } catch (err) {
      console.error('Mock command error:', err);
    }
  };

  const btnCmdStart = document.getElementById('btn-mock-cmd-start');
  if (btnCmdStart) btnCmdStart.addEventListener('click', () => sendMockCmd('!開始'));
  const btnCmdPause = document.getElementById('btn-mock-cmd-pause');
  if (btnCmdPause) btnCmdPause.addEventListener('click', () => sendMockCmd('!一時停止'));
  const btnCmdResume = document.getElementById('btn-mock-cmd-resume');
  if (btnCmdResume) btnCmdResume.addEventListener('click', () => sendMockCmd('!再開'));
  const btnCmdHelp = document.getElementById('btn-mock-cmd-help');
  if (btnCmdHelp) btnCmdHelp.addEventListener('click', () => sendMockCmd('!ヘルプ'));

  // タブ切り替え時のZoomステータスポーリング制御
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'zoom') {
        fetchZoomStatus();
        populateZoomRegulations();
        if (!state.zoomPollingInterval) {
          state.zoomPollingInterval = setInterval(fetchZoomStatus, 4000);
        }
      } else {
        if (state.zoomPollingInterval) {
          clearInterval(state.zoomPollingInterval);
          state.zoomPollingInterval = null;
        }
      }
    });
  });
}

function populateZoomRegulations() {
  const select = document.getElementById('zoom-game-reg-select');
  if (!select) return;
  select.innerHTML = '';
  state.regulations.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} (${r.playerCount}人)`;
    select.appendChild(opt);
  });
}

async function fetchZoomStatus() {
  try {
    const res = await fetch('/api/zoom/status');
    if (!res.ok) return;
    const data = await res.json();
    renderZoomStatus(data);
  } catch (err) {
    console.error('Zoomステータス取得エラー:', err);
  }
}

function renderZoomStatus(status) {
  const badge = document.getElementById('zoom-status-badge');
  const joinBtn = document.getElementById('btn-zoom-join');
  const leaveBtn = document.getElementById('btn-zoom-leave');
  const meetingSpan = document.getElementById('zoom-current-meeting');
  const hostSpan = document.getElementById('zoom-host-status');
  const roomSpan = document.getElementById('zoom-current-room');
  const countSpan = document.getElementById('zoom-participant-count');
  const startGameBtn = document.getElementById('btn-zoom-start-game');

  // シミュレータバッジとコントロール
  const mockBadge = document.getElementById('zoom-mock-badge');
  const btnStartMock = document.getElementById('btn-start-zoom-mock');
  const btnStopMock = document.getElementById('btn-stop-zoom-mock');
  const mockControls = document.getElementById('zoom-mock-controls');

  if (status.isMockMode) {
    if (mockBadge) mockBadge.style.display = 'inline-block';
    if (btnStartMock) btnStartMock.style.display = 'none';
    if (btnStopMock) btnStopMock.style.display = 'inline-block';
    if (mockControls) mockControls.style.display = 'block';
  } else {
    if (mockBadge) mockBadge.style.display = 'none';
    if (btnStartMock) btnStartMock.style.display = 'inline-block';
    if (btnStopMock) btnStopMock.style.display = 'none';
    if (mockControls) mockControls.style.display = 'none';
  }

  if (status.isConnected) {
    badge.textContent = status.isMockMode ? '🧪 仮想シミュレーション中' : '接続中 (入室完了)';
    badge.className = status.isMockMode ? 'badge badge-warning' : 'badge badge-success';
    joinBtn.style.display = 'none';
    leaveBtn.style.display = status.isMockMode ? 'none' : 'inline-block';
    meetingSpan.textContent = status.meetingNumber || '接続中';
    hostSpan.innerHTML = status.isHostOrCoHost
      ? '<span style="color:#34d399;">🛡️ 共同ホスト (操作可能)</span>'
      : '<span style="color:#fbbf24;">⚠️ 一般参加者 (主催者が共同ホストにしてください)</span>';
    roomSpan.textContent = status.currentRoom || 'メインルーム';
    countSpan.textContent = `${status.participants ? status.participants.length : 0} 人`;
    if (startGameBtn) startGameBtn.disabled = false;
  } else if (status.isConnecting) {
    badge.textContent = '接続試行中...';
    badge.className = 'badge badge-warning';
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = true;
    leaveBtn.style.display = 'none';
    if (startGameBtn) startGameBtn.disabled = true;
  } else {
    badge.textContent = '未接続';
    badge.className = 'badge badge-secondary';
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = false;
    leaveBtn.style.display = 'none';
    meetingSpan.textContent = '未接続';
    hostSpan.textContent = '未取得';
    roomSpan.textContent = 'メインルーム';
    countSpan.textContent = '0 人';
    if (startGameBtn) startGameBtn.disabled = true;
  }

  // 参加者一覧
  const pList = document.getElementById('zoom-participant-list');
  if (pList) {
    if (!status.participants || status.participants.length === 0) {
      pList.innerHTML = '<div class="text-muted text-center py-3">Botがミーティングに参加すると一覧が表示されます</div>';
    } else {
      pList.innerHTML = '';
      status.participants.forEach(p => {
        const item = document.createElement('div');
        item.className = 'zoom-participant-item';
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '8px 12px';
        item.style.marginBottom = '4px';
        item.style.background = 'rgba(255, 255, 255, 0.03)';
        item.style.borderRadius = '6px';

        const roomBadge = p.currentRoomName ? `<span class="badge badge-secondary" style="font-size: 0.75rem; margin-left: 6px;">${escapeHtml(p.currentRoomName)}</span>` : '';

        item.innerHTML = `
          <div>
            ${p.isHost ? '👑 ' : (p.isCoHost ? '🛡️ ' : '👤 ')}
            <strong>${escapeHtml(p.userName)}</strong>
            ${roomBadge}
          </div>
          <div>
            <span class="text-xs" style="color: ${p.isMuted ? 'var(--danger)' : 'var(--accent)'};">
              ${p.isMuted ? '🔇 ミュート' : '🎙️ 通話中'}
            </span>
          </div>
        `;
        pList.appendChild(item);
      });
    }
  }

  // チャットログ
  const chatBox = document.getElementById('zoom-chat-box');
  if (chatBox && status.chatLogs) {
    if (status.chatLogs.length === 0) {
      chatBox.innerHTML = '<div class="text-muted text-center py-3">チャットログがここにリアルタイム表示されます</div>';
    } else {
      chatBox.innerHTML = '';
      status.chatLogs.forEach(c => {
        const msgDiv = document.createElement('div');
        const isCmd = c.message.startsWith('!') || c.message.startsWith('/');
        msgDiv.className = `zoom-chat-msg${isCmd ? ' is-command' : ''}`;
        msgDiv.innerHTML = `
          <div class="zoom-chat-sender">
            ${escapeHtml(c.sender)}
            <span class="zoom-chat-time">${escapeHtml(c.timestamp)}</span>
          </div>
          <div>${escapeHtml(c.message)}</div>
        `;
        chatBox.appendChild(msgDiv);
      });
    }
  }
}
