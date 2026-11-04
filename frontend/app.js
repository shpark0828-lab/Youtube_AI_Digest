// ConstructIQ AI Video Summarizer Frontend Logic

let allSummaries = [];
let allVideos = [];
let allChannels = [];
let selectedChannelId = 'all'; // Defaults to Default Channel (1 = ConstructIQ), or 'all'
let currentViewingSummary = null;
let pollingTimer = null;
let currentStatusData = null;
let localSummarizingVideoIds = new Set();
let serverSummarizingVideoIds = new Set();
let allCustomCategories = [];
let selectedCustomCategory = 'all'; // 'all', '__uncategorized__', or category name
let videoSortField = null; // 'title', 'custom_category', 'published_date', 'discovered_at', 'duration', 'is_within_24h', 'has_summary'
let videoSortDirection = 'desc'; // 'asc' or 'desc'

function isVideoSummarizing(videoId) {
  return localSummarizingVideoIds.has(videoId) || serverSummarizingVideoIds.has(videoId);
}

function isCustomVideosChannelSelected() {
  if (selectedChannelId === 'all') return false;
  const ch = allChannels.find(c => c.id === selectedChannelId);
  return Boolean(ch && (ch.channel_url === 'custom' || ch.handle === '@custom_videos' || (ch.auto_sync == 0 && ch.channel_url === 'custom')));
}

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  const urlParams = new URLSearchParams(window.location.search);
  const paramCh = urlParams.get('channel_id');
  const paramTab = urlParams.get('tab');

  if (paramCh) {
    selectedChannelId = paramCh === 'all' ? 'all' : parseInt(paramCh);
  }

  await loadStatus();
  await Promise.all([
    loadVideosAndSummaries(),
    loadSettings(),
    loadLogs()
  ]);

  if (paramTab) {
    switchTab(paramTab);
  }
  
  // Periodically check status every 15 seconds
  setInterval(loadStatus, 15000);
}

// Channel Selection & Switcher UI
function renderChannelSelectorBar() {
  const bar = document.getElementById('channelSelectorBar');
  if (!bar) return;

  if (!allChannels || allChannels.length === 0) {
    const isAllActive = selectedChannelId === 'all';
    const allBtnClass = isAllActive
      ? "bg-indigo-600 text-white border-indigo-500 shadow-sm font-semibold"
      : "bg-slate-800/90 text-slate-300 hover:text-white border-slate-700 font-medium";
    bar.innerHTML = `
      <span class="text-[11px] font-semibold text-slate-400 mr-1 flex items-center gap-1 whitespace-nowrap">
        <i class="ph-bold ph-television text-blue-400"></i> 채널:
      </span>
      <button type="button" onclick="selectChannel('all')"
              class="px-3 py-1 rounded-lg text-xs border transition-all flex items-center gap-1.5 whitespace-nowrap ${allBtnClass}">
        <i class="ph-bold ph-globe"></i>
        <span>전체 채널</span>
        <span class="text-[10px] opacity-75 font-mono">(0)</span>
      </button>
      <button type="button" onclick="openChannelManagerModal()"
              class="px-2.5 py-1 rounded-lg text-xs border border-dashed border-slate-700 text-slate-400 hover:text-blue-400 hover:border-blue-500 transition-all flex items-center gap-1">
        <i class="ph-bold ph-plus"></i> 채널 추가
      </button>
    `;
    return;
  }

  const channelButtons = allChannels.map(ch => {
    const isActive = selectedChannelId === ch.id;
    const isDef = ch.is_default == 1;
    const activeClass = isActive
      ? "bg-blue-600 text-white border-blue-500 shadow-sm font-semibold"
      : "bg-slate-800/90 text-slate-300 hover:text-white border-slate-700 font-medium";

    return `
      <button type="button" onclick="selectChannel(${ch.id})"
              class="px-3 py-1 rounded-lg text-xs border transition-all flex items-center gap-1.5 whitespace-nowrap ${activeClass}">
        <i class="ph-bold ${isDef ? 'ph-hard-hat text-amber-400' : 'ph-youtube-logo text-red-400'}"></i>
        <span>${escapeHtml(ch.name)}</span>
        ${isDef ? `<span class="px-1 py-0.2 rounded text-[9px] ${isActive ? 'bg-blue-800 text-blue-200' : 'bg-amber-500/20 text-amber-300'}">기본</span>` : ''}
        <span class="text-[10px] opacity-75 font-mono">(${ch.total_videos || 0})</span>
      </button>
    `;
  }).join('');

  const isAllActive = selectedChannelId === 'all';
  const allBtnClass = isAllActive
    ? "bg-indigo-600 text-white border-indigo-500 shadow-sm font-semibold"
    : "bg-slate-800/90 text-slate-300 hover:text-white border-slate-700 font-medium";

  bar.innerHTML = `
    <span class="text-[11px] font-semibold text-slate-400 mr-1 flex items-center gap-1 whitespace-nowrap">
      <i class="ph-bold ph-television text-blue-400"></i> 채널:
    </span>
    ${channelButtons}
    <button type="button" onclick="selectChannel('all')"
            class="px-3 py-1 rounded-lg text-xs border transition-all flex items-center gap-1.5 whitespace-nowrap ${allBtnClass}">
      <i class="ph-bold ph-globe"></i>
      <span>전체 채널 모아보기 (${allChannels.length})</span>
    </button>
  `;
}

function updateHeaderForChannel() {
  const subEl = document.getElementById('headerChannelSubtitle');
  const linkEl = document.getElementById('headerChannelLink');
  const linkTxtEl = document.getElementById('headerChannelLinkText');
  const runBtn = document.getElementById('btnRunNow');

  if (selectedChannelId === 'all') {
    if (subEl) {
      if (!allChannels || allChannels.length === 0) {
        subEl.textContent = '등록된 유튜브 채널이 없습니다. [채널 관리]에서 채널을 등록해 주세요.';
      } else {
        subEl.textContent = `등록된 전체 유튜브 채널 (${allChannels.length}개) 24시간 신규 영상 통합 리포트`;
      }
    }
    const defCh = allChannels.find(c => c.is_default == 1) || allChannels[0];
    if (linkEl) {
      if (defCh && defCh.channel_url && defCh.channel_url !== 'custom') {
        linkEl.href = defCh.channel_url;
        linkEl.style.display = '';
      } else {
        linkEl.style.display = 'none';
      }
    }
    if (linkTxtEl) linkTxtEl.textContent = `채널 바로가기`;
    if (runBtn) runBtn.style.display = '';
  } else {
    const ch = allChannels.find(c => c.id === selectedChannelId) || allChannels[0];
    if (ch) {
      const isCustomChannel = ch.channel_url === 'custom' || ch.handle === '@custom_videos' || (ch.auto_sync == 0 && ch.channel_url === 'custom');
      
      if (isCustomChannel) {
        if (subEl) subEl.textContent = `직접 등록한 개별 동영상 모음 및 AI 심층 분석 리포트`;
        if (linkEl) linkEl.style.display = 'none';
        if (runBtn) runBtn.style.display = 'none';
      } else {
        if (subEl) subEl.textContent = `${ch.handle || ch.name} 채널 24시간 신규 영상 심층 분석 리포트`;
        if (linkEl) {
          linkEl.href = ch.channel_url;
          linkEl.style.display = '';
        }
        if (linkTxtEl) linkTxtEl.textContent = `${ch.name} 바로가기`;
        if (runBtn) runBtn.style.display = '';
      }
    }
  }
}

async function selectChannel(chId) {
  selectedChannelId = chId === 'all' ? 'all' : Number(chId);
  selectedCustomCategory = 'all';
  renderChannelSelectorBar();
  updateHeaderForChannel();
  await Promise.all([
    loadStatus(),
    loadVideosAndSummaries()
  ]);
}

// Tab Switching
function switchTab(tabId) {
  const tabs = ['dashboard', 'summaries', 'videos', 'logs', 'settings'];
  tabs.forEach(t => {
    const sec = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tabBtn-${t}`);
    if (t === tabId) {
      sec.classList.remove('hidden');
      btn.classList.add('active-tab');
    } else {
      sec.classList.add('hidden');
      btn.classList.remove('active-tab');
    }
  });

  if (tabId === 'logs') loadLogs();
  if (tabId === 'videos') renderVideosTable();
  if (tabId === 'summaries') renderArchive();
}

// Load System Status
async function loadStatus() {
  try {
    const q = selectedChannelId !== 'all' ? `?channel_id=${selectedChannelId}` : '';
    const res = await fetch('/api/status' + q);
    const data = await res.json();
    currentStatusData = data;
    
    if (data.custom_categories) {
      allCustomCategories = data.custom_categories;
    }

    if (data.channels) {
      allChannels = data.channels;
      if (selectedChannelId !== 'all' && !allChannels.some(c => c.id === selectedChannelId)) {
        const defCh = allChannels.find(c => c.is_default == 1) || allChannels[0];
        if (defCh) selectedChannelId = defCh.id;
      }
      renderChannelSelectorBar();
      updateHeaderForChannel();
    }
    
    // Quick Gemini Banner
    renderQuickGeminiBanner(data);

    // Schedule info
    const schedTime = data.scheduler.schedule_time || "09:00";
    document.getElementById('statScheduleTime').textContent = `매일 ${schedTime}`;
    document.getElementById('statAutoStatus').textContent = data.scheduler.auto_enabled ? "스케줄 가동중" : "자동 비활성";
    document.getElementById('statAutoStatus').className = data.scheduler.auto_enabled ? "text-xs text-emerald-400 font-medium" : "text-xs text-slate-500 font-medium";
    
    document.getElementById('statNextRun').textContent = data.scheduler.next_run_time || "설정 필요";
    document.getElementById('statRecentCount').textContent = data.recent_videos_count ?? 0;
    document.getElementById('statSummaryCount').textContent = data.completed_summaries_count ?? 0;
    document.getElementById('statFilterHours').textContent = `최근 ${data.time_filter_hours}시간`;

    // AI Provider & Detail Level
    const provider = data.ai_provider;
    const provName = provider === 'gemini' ? 'Google Gemini' : (provider === 'openai' ? 'OpenAI GPT' : '내장 스마트 요약기');
    document.getElementById('statAiProvider').textContent = provName;

    const hasKey = (provider === 'gemini' && data.has_gemini_key) || (provider === 'openai' && data.has_openai_key);
    const keyInd = document.getElementById('statAiKeyIndicator');
    const keyTxt = document.getElementById('statAiKeyText');
    if (provider === 'extractive') {
      keyInd.className = "inline-block w-2 h-2 rounded-full bg-blue-400";
      keyTxt.textContent = "내장 스마트 추출 모드";
    } else if (hasKey) {
      keyInd.className = "inline-block w-2 h-2 rounded-full bg-emerald-400";
      keyTxt.textContent = `초정밀 모드 (${data.gemini_model || 'gemini-2.5-flash'})`;
    } else {
      keyInd.className = "inline-block w-2 h-2 rounded-full bg-amber-400";
      keyTxt.textContent = "Key 미등록 (내장 엔진 자동 대체)";
    }

    // Busy / Running status
    const isBusy = data.scheduler.is_busy;
    const prevServerCount = serverSummarizingVideoIds.size;
    serverSummarizingVideoIds = new Set(data.summarizing_video_ids || []);
    if (prevServerCount !== serverSummarizingVideoIds.size) {
      if (prevServerCount > 0 && serverSummarizingVideoIds.size === 0) {
        await loadVideosAndSummaries();
      } else {
        renderVideosTable();
        renderSpotlight();
      }
    }

    const banner = document.getElementById('liveBanner');
    const runBtn = document.getElementById('btnRunNow');
    const runText = document.getElementById('btnRunText');
    const runIcon = document.getElementById('btnRunIcon');

    if (isBusy) {
      banner.classList.remove('hidden');
      runBtn.disabled = true;
      runBtn.classList.add('opacity-75', 'cursor-not-allowed');
      runText.textContent = "요약 작업 진행중...";
      runIcon.className = "ph-bold ph-spinner-gap animate-spin";
    } else {
      banner.classList.add('hidden');
      runBtn.disabled = false;
      runBtn.classList.remove('opacity-75', 'cursor-not-allowed');
      runText.textContent = "지금 24h 조사 및 요약";
      runIcon.className = "ph-bold ph-play";
    }

    const shouldPoll = isBusy || serverSummarizingVideoIds.size > 0 || localSummarizingVideoIds.size > 0;
    if (shouldPoll) {
      if (!pollingTimer) {
        pollingTimer = setInterval(async () => {
          await loadStatus();
          await loadVideosAndSummaries();
        }, 3000);
      }
    } else {
      if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
      }
    }

  } catch (err) {
    console.error("Status load error:", err);
  }
}

// Render Quick Gemini Key Banner
function renderQuickGeminiBanner(data) {
  const banner = document.getElementById('quickGeminiBanner');
  if (!banner) return;

  const dLevel = data.detail_level || 'ultra_detailed';
  const levelLabelMap = {
    'ultra_detailed': '🔍 초정밀 심층 (Ultra-Detailed)',
    'standard': '📋 표준 핵심 (Standard)',
    'brief': '⚡ 3분 핵심 브리핑 (Brief)'
  };
  const activeLevelLabel = levelLabelMap[dLevel] || levelLabelMap['ultra_detailed'];

  if (data.has_gemini_key) {
    banner.className = "bg-gradient-to-r from-emerald-950/30 via-slate-800/50 to-blue-950/30 border border-emerald-500/30 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm";
    banner.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 text-lg">
          <i class="ph-bold ph-seal-check"></i>
        </div>
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs font-bold text-white">Gemini AI 요약 엔진 활성화됨</span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              ${escapeHtml(data.gemini_model || 'gemini-3.8-flash')}
            </span>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">
              ${activeLevelLabel}
            </span>
          </div>
          <p class="text-[11px] text-slate-300 mt-0.5">
            설정된 상세도(${activeLevelLabel})와 채널별 요약 스타일에 맞춰 맞춤형 AI 리포트가 생성됩니다.
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2 self-end sm:self-auto">
        <button onclick="switchTab('settings')" class="px-3 py-1.5 rounded-xl text-xs font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 border border-slate-700 transition-colors flex items-center gap-1.5">
          <i class="ph ph-gear"></i> 상세도/모델 설정 변경
        </button>
      </div>
    `;
  } else {
    banner.className = "bg-gradient-to-r from-blue-950/50 via-indigo-950/40 to-purple-950/50 border border-blue-500/40 rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 shadow-xl";
    banner.innerHTML = `
      <div class="flex items-start gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 text-white flex items-center justify-center flex-shrink-0 text-xl shadow-lg shadow-blue-500/30">
          <i class="ph-bold ph-key"></i>
        </div>
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-sm font-bold text-white">내 Gemini API Key를 등록하여 "초정밀 심층 요약"을 활성화하세요</h3>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
              강력 추천
            </span>
          </div>
          <p class="text-xs text-slate-300 mt-1 leading-relaxed max-w-2xl">
            Google Gemini의 방대한 컨텍스트 윈도우를 활용해 <strong>분초 단위 타임라인 완전 해설</strong>, <strong>영상에 등장한 프롬프트 원문 복원</strong>, <strong>건설 적산(Take-off) 특화 분석</strong>을 완벽히 생성합니다.
          </p>
          <div class="flex items-center gap-4 mt-2">
            <a href="https://aistudio.google.com/app/apikey" target="_blank" class="text-xs text-blue-400 hover:text-blue-300 font-semibold hover:underline flex items-center gap-1">
              Google AI Studio에서 무료 API Key 발급받기 (30초 소요) <i class="ph ph-arrow-square-out"></i>
            </a>
          </div>
        </div>
      </div>
      <div class="w-full lg:w-auto flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-shrink-0">
        <input type="password" id="bannerGeminiKeyInput" placeholder="Gemini API Key 입력 (AIzaSy...)" 
               class="bg-slate-950/90 border border-blue-500/50 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-400 font-mono w-full sm:w-64 shadow-inner">
        <button onclick="saveQuickGeminiKey()" 
                class="px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-600/30 active:scale-95 transition-all whitespace-nowrap flex items-center justify-center gap-1.5">
          <i class="ph-bold ph-sparkle"></i> 키 등록 및 초정밀 켜기
        </button>
      </div>
    `;
  }
}

// Save Quick Gemini Key from Banner
async function saveQuickGeminiKey() {
  const input = document.getElementById('bannerGeminiKeyInput');
  const key = input ? input.value.trim() : '';

  if (!key) {
    showToast("Gemini API Key를 입력해주세요.", "warning");
    return;
  }

  showToast("Gemini API Key를 등록 및 검증하는 중입니다...", "info");
  try {
    const res = await fetch('/api/save_gemini_key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gemini_api_key: key,
        detail_level: "ultra_detailed",
        gemini_model: "gemini-3.8-flash"
      })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast("Gemini API Key 등록 완료! 초정밀 심층 요약 모드가 켜졌습니다.", "success");
      await loadStatus();
      await loadSettings();
    } else {
      showToast("등록 실패: " + data.message, "error");
    }
  } catch (err) {
    showToast("오류 발생: " + err.message, "error");
  }
}

// Fetch Videos and Summaries
async function loadVideosAndSummaries() {
  try {
    const q = selectedChannelId !== 'all' ? `?channel_id=${selectedChannelId}` : '';
    const [vidsRes, sumsRes] = await Promise.all([
      fetch('/api/videos' + q),
      fetch('/api/summaries' + q)
    ]);
    allVideos = await vidsRes.json();
    allSummaries = await sumsRes.json();

    renderSpotlight();
    renderSummariesFeed();
    renderArchive();
    renderVideosTable();
  } catch (err) {
    console.error("Data load error:", err);
  }
}

async function fetchVideosAndSummaries() {
  await syncVideos();
}

// Live Synchronize Videos directly from YouTube
async function syncVideos() {
  const btn = document.getElementById('btnSyncVideos');
  const icon = document.getElementById('btnSyncVideosIcon');
  if (btn) btn.disabled = true;
  if (icon) icon.className = "ph-bold ph-spinner-gap animate-spin";
  
  showToast("유튜브 채널에서 최신 동영상 목록을 실시간으로 가져오는 중입니다...", "info");
  try {
    const q = selectedChannelId !== 'all' ? `?channel_id=${selectedChannelId}` : '';
    const res = await fetch('/api/videos/sync' + q, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(data.message, "success");
      await loadVideosAndSummaries();
      await loadStatus();
    } else {
      showToast("동기화 실패: " + (data.message || "알 수 없는 오류"), "error");
    }
  } catch (err) {
    showToast("동기화 통신 오류: " + err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
    if (icon) icon.className = "ph-bold ph-arrows-clockwise";
  }
}

// Render Spotlight (24h Videos)
function renderSpotlight() {
  const container = document.getElementById('spotlightContainer');
  const badge = document.getElementById('spotlightCountBadge');
  const recentVideos = allVideos.filter(v => v.is_within_24h);

  badge.textContent = `${recentVideos.length}개`;

  if (recentVideos.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-8 text-center text-slate-400 bg-slate-900/40 rounded-xl border border-slate-800">
        <i class="ph ph-sparkle text-3xl text-slate-500 mb-2"></i>
        <p class="text-xs font-medium">최근 24시간 이내에 게시된 신규 영상이 아직 없습니다.</p>
        <p class="text-[11px] text-slate-500 mt-1">매일 아침 09:00 스케줄러가 새 영상이 업로드되는 즉시 자동으로 조사 및 요약합니다.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = recentVideos.map(video => {
    const summary = allSummaries.find(s => s.video_id === video.video_id);
    const hasSummary = Boolean(summary);
    const chName = video.channel_name || 'YouTube 채널';

    return `
      <div class="bg-gradient-to-br from-slate-800/80 to-slate-900/90 border border-amber-500/40 rounded-2xl p-4 flex flex-col sm:flex-row gap-4 shadow-xl relative overflow-hidden group hover:border-amber-400/70 transition-all">
        <div class="relative w-full sm:w-44 h-28 rounded-xl overflow-hidden flex-shrink-0 bg-slate-950">
          <img src="${video.thumbnail_url}" alt="${escapeHtml(video.title)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300">
          <span class="absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500 text-slate-950 uppercase tracking-wider shadow">
            24h 신규
          </span>
          <span class="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-mono text-white">
            ${video.duration_text || 'Video'}
          </span>
        </div>
        <div class="flex-1 flex flex-col justify-between">
          <div>
            <div class="flex items-center gap-2 text-[11px] text-slate-400 mb-1">
              ${renderVideoChannelSelector(video.video_id, video.channel_id, chName, true)}
              <span><i class="ph ph-clock"></i> ${video.published_time_text || '최근'}</span>
              <span>•</span>
              <span><i class="ph ph-eye"></i> ${video.view_count_text || '-'}</span>
            </div>
            <h3 class="text-sm font-bold text-white line-clamp-2 leading-snug group-hover:text-blue-300 transition-colors">
              ${escapeHtml(video.title)}
            </h3>
            ${hasSummary ? `
              <p class="mt-1.5 text-xs text-slate-300 line-clamp-2 leading-relaxed">
                ${escapeHtml(summary.one_line_summary || '')}
              </p>
            ` : `
              <p class="mt-1.5 text-xs text-amber-300/80 flex items-center gap-1">
                <i class="ph ph-sparkle"></i> 신규 감지됨 (요약 생성 대기중)
              </p>
            `}
          </div>
          <div class="mt-3 flex items-center gap-2 pt-2 border-t border-slate-700/50">
            ${hasSummary ? `
              <button onclick="openSummaryModal('${video.video_id}')" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5 shadow-md transition-all">
                <i class="ph-bold ph-file-text"></i> 상세 리포트 보기
              </button>
            ` : isVideoSummarizing(video.video_id) ? `
              <button disabled class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white flex items-center gap-1.5 shadow-md shadow-red-600/30 cursor-wait transition-all">
                <i class="ph-bold ph-spinner-gap animate-spin"></i> 생성중
              </button>
            ` : `
              <button onclick="generateSingleSummary('${video.video_id}')" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-slate-950 flex items-center gap-1.5 shadow-md transition-all">
                <i class="ph-bold ph-magic-wand"></i> 지금 즉시 AI 요약
              </button>
            `}
            <a href="${video.video_url}" target="_blank" class="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center gap-1 transition-all">
              <i class="ph ph-youtube-logo text-red-400"></i> 원본
            </a>
            <button type="button" onclick="deleteVideo('${video.video_id}')" 
                    class="ml-auto px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/50 inline-flex items-center gap-1 transition-all shadow-sm" 
                    title="이 동영상 목록에서 삭제">
              <i class="ph-bold ph-trash text-xs"></i>
              <span>삭제</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Render Summaries Feed
function renderSummariesFeed() {
  const container = document.getElementById('summariesFeed');
  if (allSummaries.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-400 bg-slate-800/30 rounded-2xl border border-slate-800">
        <i class="ph ph-article text-4xl text-slate-500 mb-2"></i>
        <p class="text-sm font-medium">아직 생성된 요약 리포트가 없습니다.</p>
        <p class="text-xs text-slate-500 mt-1">상단의 [지금 24h 조사 및 요약] 버튼을 누르거나 매일 아침 09:00 자동 실행을 기다려주세요.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = allSummaries.slice(0, 6).map(summary => renderSummaryCard(summary)).join('');
}

// --- Offline Viewer Export ---

async function exportOfflineViewer() {
  try {
    showToast("최신 요약 데이터로 오프라인 뷰어(offline_viewer.html)를 갱신하는 중...", "info");
    const res = await fetch('/api/export-offline');
    const data = await res.json();
    if (data.status === 'success') {
      showToast(data.message, "success");
      window.open('/offline-viewer', '_blank');
    } else {
      showToast(data.message || "오프라인 뷰어 갱신 실패", "error");
    }
  } catch (err) {
    showToast("오프라인 뷰어 요청 오류: " + err.message, "error");
  }
}

// Render Archive (All Summaries)
let archiveViewMode = localStorage.getItem('archiveViewMode') || 'grid';

function setArchiveViewMode(mode) {
  archiveViewMode = mode;
  localStorage.setItem('archiveViewMode', mode);
  updateArchiveViewButtons();
  renderArchive();
}

function updateArchiveViewButtons() {
  const btnGrid = document.getElementById('btnArchiveViewGrid');
  const btnList = document.getElementById('btnArchiveViewList');
  if (!btnGrid || !btnList) return;

  if (archiveViewMode === 'list') {
    btnList.className = "px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all text-white bg-blue-600 shadow-sm";
    btnGrid.className = "px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all text-slate-400 hover:text-white";
  } else {
    btnGrid.className = "px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all text-white bg-blue-600 shadow-sm";
    btnList.className = "px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all text-slate-400 hover:text-white";
  }
}

// --- Custom Category Filter Bar & Inline Category Selector ---

function getAvailableCategoryNames() {
  const namesSet = new Set();
  (allCustomCategories || []).forEach(c => {
    if (c.name && c.name.trim()) namesSet.add(c.name.trim());
  });
  (allVideos || []).forEach(v => {
    if (v.custom_category && v.custom_category.trim()) namesSet.add(v.custom_category.trim());
  });
  (allSummaries || []).forEach(s => {
    if (s.custom_category && s.custom_category.trim()) namesSet.add(s.custom_category.trim());
  });
  return Array.from(namesSet);
}

function selectCustomCategory(cat) {
  selectedCustomCategory = cat;
  renderCategoryFilterBars();
  renderArchive();
  renderVideosTable();
}

function renderCategoryFilterBars() {
  const archiveBar = document.getElementById('archiveCategoryFilterBar');
  const videosBar = document.getElementById('videosCategoryFilterBar');
  const isCustomCh = isCustomVideosChannelSelected();
  const hasAnyCustomVideo = allVideos.some(v => v.is_custom_added == 1 || (v.custom_category && v.custom_category.trim() !== ''));

  // Show filter bar when in '직접 등록 영상' channel (or if custom categories/videos are present in 'all' view)
  const shouldShow = isCustomCh || (selectedChannelId === 'all' && (hasAnyCustomVideo || allCustomCategories.length > 0));

  if (!shouldShow) {
    if (archiveBar) archiveBar.classList.add('hidden');
    if (videosBar) videosBar.classList.add('hidden');
    return;
  }

  const catNames = getAvailableCategoryNames();

  // If currently selected category no longer exists, reset to 'all'
  if (selectedCustomCategory !== 'all' && selectedCustomCategory !== '__uncategorized__' && !catNames.includes(selectedCustomCategory)) {
    selectedCustomCategory = 'all';
  }

  const buildBarHtml = (itemsList, isSummaryList) => {
    const totalCount = itemsList.length;
    const uncategorizedCount = itemsList.filter(item => {
      const vid = isSummaryList ? allVideos.find(v => v.video_id === item.video_id) : item;
      const cat = (item.custom_category || vid?.custom_category || '').trim();
      return !cat;
    }).length;

    const allBtnActive = selectedCustomCategory === 'all';
    const uncatBtnActive = selectedCustomCategory === '__uncategorized__';

    const catButtonsHtml = catNames.map(catName => {
      const count = itemsList.filter(item => {
        const vid = isSummaryList ? allVideos.find(v => v.video_id === item.video_id) : item;
        const cat = (item.custom_category || vid?.custom_category || '').trim();
        return cat === catName;
      }).length;
      const isActive = selectedCustomCategory === catName;
      const cls = isActive
        ? "bg-amber-500 text-slate-950 border-amber-400 font-bold shadow-sm"
        : "bg-slate-900/90 text-slate-300 hover:text-white border-slate-700 font-medium";
      const safeArg = catName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `
        <button type="button" onclick="selectCustomCategory('${safeArg}')"
                class="px-3 py-1 rounded-xl text-xs border transition-all flex items-center gap-1.5 whitespace-nowrap ${cls}">
          <i class="ph-bold ph-folder-Simple ${isActive ? 'text-slate-950' : 'text-amber-400'}"></i>
          <span>${escapeHtml(catName)}</span>
          <span class="text-[10px] opacity-80 font-mono">(${count})</span>
        </button>
      `;
    }).join('');

    return `
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs font-semibold text-amber-400 mr-1 flex items-center gap-1 whitespace-nowrap">
          <i class="ph-bold ph-folders text-sm"></i> 영상 분류:
        </span>
        <button type="button" onclick="selectCustomCategory('all')"
                class="px-3 py-1 rounded-xl text-xs border transition-all flex items-center gap-1.5 whitespace-nowrap ${allBtnActive ? 'bg-blue-600 text-white border-blue-500 font-bold shadow-sm' : 'bg-slate-900/90 text-slate-300 hover:text-white border-slate-700 font-medium'}">
          <span>전체</span>
          <span class="text-[10px] opacity-80 font-mono">(${totalCount})</span>
        </button>
        ${catButtonsHtml}
        <button type="button" onclick="selectCustomCategory('__uncategorized__')"
                class="px-3 py-1 rounded-xl text-xs border transition-all flex items-center gap-1.5 whitespace-nowrap ${uncatBtnActive ? 'bg-slate-600 text-white border-slate-400 font-bold shadow-sm' : 'bg-slate-900/90 text-slate-400 hover:text-white border-slate-700 font-medium'}">
          <span>미분류</span>
          <span class="text-[10px] opacity-80 font-mono">(${uncategorizedCount})</span>
        </button>
      </div>
      <div class="flex items-center gap-2 ml-auto">
        <button type="button" onclick="openCustomCategoryModal()"
                class="px-3 py-1 rounded-xl text-xs font-semibold bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 flex items-center gap-1.5 transition-all whitespace-nowrap shadow-sm">
          <i class="ph-bold ph-folder-plus text-sm"></i>
          <span>카테고리 추가 / 관리</span>
        </button>
      </div>
    `;
  };

  if (archiveBar) {
    archiveBar.classList.remove('hidden');
    archiveBar.innerHTML = buildBarHtml(allSummaries, true);
  }
  if (videosBar) {
    videosBar.classList.remove('hidden');
    videosBar.innerHTML = buildBarHtml(allVideos, false);
  }
}

function renderVideoCategorySelector(videoId, currentCategory, showSelector = true) {
  if (!showSelector) return '';
  const curCat = (currentCategory || '').trim();
  const catNames = getAvailableCategoryNames();
  const optionsHtml = catNames.map(cName => {
    const isSel = cName === curCat ? 'selected' : '';
    return `<option value="${escapeHtml(cName)}" class="bg-slate-900 text-white" ${isSel}>${escapeHtml(cName)}</option>`;
  }).join('');

  return `
    <select onchange="onInlineCategoryChange('${videoId}', this)" onclick="event.stopPropagation()"
            class="w-[78px] px-1.5 py-0.5 rounded-lg text-[10px] font-semibold ${curCat ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'bg-slate-800 text-slate-400 border-slate-700'} border hover:border-amber-400 focus:outline-none cursor-pointer transition-all truncate"
            title="${curCat ? '분류: ' + escapeHtml(curCat) + ' (클릭하여 변경)' : '클릭하여 동영상 분류(카테고리) 지정'}">
      <option value="" class="bg-slate-900 text-slate-400" ${!curCat ? 'selected' : ''}>미분류</option>
      ${optionsHtml}
      <option value="__add_new__" class="bg-slate-900 text-amber-400 font-bold">+ 새 분류...</option>
    </select>
  `;
}

async function onInlineCategoryChange(videoId, selectEl) {
  if (!selectEl) return;
  let chosen = selectEl.value;

  if (chosen === '__add_new__') {
    const newCat = prompt("새로 추가할 분류(카테고리) 이름을 입력하세요 (예: AI/CAD, 토목/검사, 업무참고):");
    if (!newCat || !newCat.trim()) {
      renderArchive();
      renderVideosTable();
      return;
    }
    chosen = newCat.trim();
  }

  try {
    const res = await fetch(`/api/videos/${videoId}/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_category: chosen })
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (data.custom_categories) {
        allCustomCategories = data.custom_categories;
      }
      // Update local state immediately
      const vObj = allVideos.find(v => v.video_id === videoId);
      if (vObj) vObj.custom_category = chosen;
      const sObj = allSummaries.find(s => s.video_id === videoId);
      if (sObj) sObj.custom_category = chosen;

      showToast(data.message, "success");
      renderCategoryFilterBars();
      renderArchive();
      renderVideosTable();
      renderSummariesFeed();
    } else {
      showToast(data.message || "분류 변경 실패", "error");
    }
  } catch (err) {
    showToast("분류 변경 요청 오류: " + err.message, "error");
  }
}

function renderVideoChannelSelector(videoId, currentChannelId, currentChannelName, showSelector = true) {
  const chName = currentChannelName || '채널';
  const chId = (currentChannelId !== undefined && currentChannelId !== null && currentChannelId !== '') ? Number(currentChannelId) : null;

  if (!showSelector) {
    return `<span class="px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[9px] font-semibold flex-shrink-0">${escapeHtml(chName)}</span>`;
  }

  const channels = (allChannels && allChannels.length > 0) ? allChannels : [
    { id: 1, name: 'YouTube 채널' },
    { id: 2, name: '직접 등록 영상' }
  ];

  let hasCurrentInList = channels.some(c => (chId !== null && Number(c.id) === chId) || (!chId && c.name === chName));
  let extraOption = '';
  if (!hasCurrentInList && chName) {
    extraOption = `<option value="${chId || ''}" class="bg-slate-900 text-amber-300" selected>📺 ${escapeHtml(chName)} (기존)</option>`;
  }

  const optionsHtml = channels.map(ch => {
    const isSel = (chId !== null && Number(ch.id) === chId) || (!chId && ch.name === chName);
    return `<option value="${ch.id}" class="bg-slate-900 text-white" ${isSel ? 'selected' : ''}>📺 ${escapeHtml(ch.name)}</option>`;
  }).join('');

  return `
    <div class="inline-flex items-center gap-1 flex-shrink-0 group/ch relative">
      <select onchange="onInlineChannelChange('${videoId}', this)" onclick="event.stopPropagation()"
              class="max-w-[130px] px-1.5 py-0.5 rounded-md text-[9px] font-semibold bg-indigo-950/70 text-indigo-300 border border-indigo-500/40 hover:border-indigo-400 hover:text-white focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer transition-all truncate"
              title="소속 채널: ${escapeHtml(chName)} (클릭하여 소속 채널 변경)">
        ${extraOption}
        ${optionsHtml}
        <option value="__modal__" class="bg-slate-900 text-indigo-300 font-bold">⚙️ 채널 변경 창 열기...</option>
      </select>
    </div>
  `;
}

async function onInlineChannelChange(videoId, selectEl) {
  if (!selectEl) return;
  const chosenVal = selectEl.value;

  if (chosenVal === '__modal__') {
    const vObj = allVideos.find(v => v.video_id === videoId);
    const sObj = allSummaries.find(s => s.video_id === videoId);
    const curChId = vObj?.channel_id || sObj?.channel_id || 1;
    selectEl.value = curChId;
    openChangeChannelModal(videoId);
    return;
  }

  const newChannelId = parseInt(chosenVal, 10);
  if (isNaN(newChannelId)) return;

  const targetCh = allChannels.find(c => c.id === newChannelId);
  const targetChName = targetCh ? targetCh.name : '선택 채널';

  try {
    const res = await fetch(`/api/videos/${videoId}/channel`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: newChannelId })
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (data.channels) {
        allChannels = data.channels;
      }
      const vObj = allVideos.find(v => v.video_id === videoId);
      if (vObj) {
        vObj.channel_id = newChannelId;
        vObj.channel_name = targetChName;
      }
      const sObj = allSummaries.find(s => s.video_id === videoId);
      if (sObj) {
        sObj.channel_id = newChannelId;
        sObj.channel_name = targetChName;
      }

      showToast(data.message || `소속 채널이 '${targetChName}'(으)로 변경되었습니다.`, "success");
      renderChannelSelector();
      renderArchive();
      renderVideosTable();
      renderSummariesFeed();
      renderSpotlight();
    } else {
      showToast(data.message || "소속 채널 변경 실패", "error");
      renderArchive();
      renderVideosTable();
    }
  } catch (err) {
    showToast("채널 변경 요청 오류: " + err.message, "error");
    renderArchive();
    renderVideosTable();
  }
}

let currentChannelChangeVideoId = null;

function openChangeChannelModal(videoId) {
  currentChannelChangeVideoId = videoId;
  const vid = allVideos.find(v => v.video_id === videoId);
  const sum = allSummaries.find(s => s.video_id === videoId);
  const title = vid?.title || sum?.title || videoId;
  const currentChId = vid?.channel_id || sum?.channel_id || 1;
  const currentChName = vid?.channel_name || sum?.channel_name || 'YouTube 채널';
  const thumb = vid?.thumbnail_url || sum?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const titleEl = document.getElementById('changeChannelVideoTitle');
  const thumbEl = document.getElementById('changeChannelVideoThumb');
  const curNameEl = document.getElementById('changeChannelCurrentName');
  const selectEl = document.getElementById('changeChannelTargetSelect');

  if (titleEl) titleEl.textContent = title;
  if (thumbEl) thumbEl.src = thumb;
  if (curNameEl) curNameEl.textContent = currentChName;

  if (selectEl) {
    selectEl.innerHTML = allChannels.map(ch => {
      const isSel = Number(ch.id) === Number(currentChId);
      return `<option value="${ch.id}" ${isSel ? 'selected' : ''}>📺 ${escapeHtml(ch.name)} (${escapeHtml(ch.handle || '')})</option>`;
    }).join('');
  }

  const modal = document.getElementById('changeChannelModal');
  if (modal) modal.classList.remove('hidden');
}

function closeChangeChannelModal() {
  const modal = document.getElementById('changeChannelModal');
  if (modal) modal.classList.add('hidden');
  currentChannelChangeVideoId = null;
}

async function submitChangeChannel(e) {
  if (e) e.preventDefault();
  if (!currentChannelChangeVideoId) return;

  const selectEl = document.getElementById('changeChannelTargetSelect');
  if (!selectEl) return;
  const newChannelId = parseInt(selectEl.value, 10);
  if (isNaN(newChannelId)) return;

  const btn = document.getElementById('btnSubmitChangeChannel');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/videos/${currentChannelChangeVideoId}/channel`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: newChannelId })
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (data.channels) {
        allChannels = data.channels;
      }
      const targetCh = allChannels.find(c => c.id === newChannelId);
      const chName = targetCh ? targetCh.name : '선택 채널';

      const vObj = allVideos.find(v => v.video_id === currentChannelChangeVideoId);
      if (vObj) {
        vObj.channel_id = newChannelId;
        vObj.channel_name = chName;
      }
      const sObj = allSummaries.find(s => s.video_id === currentChannelChangeVideoId);
      if (sObj) {
        sObj.channel_id = newChannelId;
        sObj.channel_name = chName;
      }

      showToast(data.message || `소속 채널이 '${chName}'(으)로 변경되었습니다.`, "success");
      closeChangeChannelModal();
      renderChannelSelector();
      renderArchive();
      renderVideosTable();
      renderSummariesFeed();
      renderSpotlight();
    } else {
      showToast(data.message || "소속 채널 변경 실패", "error");
    }
  } catch (err) {
    showToast("채널 변경 요청 실패: " + err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function parseDurationToSeconds(durationText) {
  if (!durationText || durationText === '-') return 0;
  const upper = String(durationText).trim().toUpperCase();
  if (upper === 'SHORTS') return 60;
  const parts = upper.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function toggleVideoSort(field) {
  if (videoSortField === field) {
    videoSortDirection = videoSortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    videoSortField = field;
    // Default direction: ascending for text (title, category), descending for dates/numbers/status
    videoSortDirection = (field === 'title' || field === 'custom_category') ? 'asc' : 'desc';
  }
  updateVideoSortHeaderIcons();
  renderVideosTable();
  if (archiveViewMode === 'list') {
    renderArchive();
  }
}

function getSortIconHtml(field) {
  if (videoSortField !== field) {
    return '↕';
  }
  return videoSortDirection === 'asc' ? '▲' : '▼';
}

function getSortIconClass(field) {
  if (videoSortField !== field) {
    return 'text-[10px] text-slate-600 group-hover:text-slate-300 font-mono';
  }
  return 'text-[10px] text-blue-400 font-bold font-mono';
}

function updateVideoSortHeaderIcons() {
  const fields = ['title', 'custom_category', 'published_date', 'discovered_at', 'duration', 'is_within_24h', 'has_summary'];
  fields.forEach(f => {
    const el = document.getElementById(`sortIcon-${f}`);
    if (el) {
      el.textContent = getSortIconHtml(f);
      el.className = getSortIconClass(f);
    }
  });
}

function sortVideoItems(items, isSummaryList = false) {
  if (!videoSortField) return items;
  const dir = videoSortDirection === 'asc' ? 1 : -1;

  return [...items].sort((a, b) => {
    const vidA = isSummaryList ? allVideos.find(v => v.video_id === a.video_id) : a;
    const vidB = isSummaryList ? allVideos.find(v => v.video_id === b.video_id) : b;

    if (videoSortField === 'title') {
      const tA = (a.title || vidA?.title || '').trim();
      const tB = (b.title || vidB?.title || '').trim();
      return tA.localeCompare(tB, 'ko') * dir;
    }

    if (videoSortField === 'custom_category') {
      const cA = (a.custom_category || vidA?.custom_category || '').trim();
      const cB = (b.custom_category || vidB?.custom_category || '').trim();
      // Keep uncategorized ('') at the bottom when sorting ascending, or top when descending
      if (!cA && cB) return 1;
      if (cA && !cB) return -1;
      if (!cA && !cB) {
        const dA = a.discovered_at || vidA?.discovered_at || '';
        const dB = b.discovered_at || vidB?.discovered_at || '';
        return dB.localeCompare(dA);
      }
      const cmp = cA.localeCompare(cB, 'ko') * dir;
      if (cmp !== 0) return cmp;
      const tA = (a.title || vidA?.title || '').trim();
      const tB = (b.title || vidB?.title || '').trim();
      return tA.localeCompare(tB, 'ko');
    }

    if (videoSortField === 'published_date') {
      const pA = a.published_date || vidA?.published_date || '';
      const pB = b.published_date || vidB?.published_date || '';
      if (pA !== pB) return pA.localeCompare(pB) * dir;
      const dA = a.discovered_at || vidA?.discovered_at || '';
      const dB = b.discovered_at || vidB?.discovered_at || '';
      return dA.localeCompare(dB) * dir;
    }

    if (videoSortField === 'discovered_at') {
      const dA = a.discovered_at || vidA?.discovered_at || a.created_at || '';
      const dB = b.discovered_at || vidB?.discovered_at || b.created_at || '';
      return dA.localeCompare(dB) * dir;
    }

    if (videoSortField === 'duration') {
      const secA = parseDurationToSeconds(a.duration_text || vidA?.duration_text);
      const secB = parseDurationToSeconds(b.duration_text || vidB?.duration_text);
      return (secA - secB) * dir;
    }

    if (videoSortField === 'is_within_24h') {
      const wA = (a.is_within_24h == 1 || vidA?.is_within_24h == 1) ? 1 : 0;
      const wB = (b.is_within_24h == 1 || vidB?.is_within_24h == 1) ? 1 : 0;
      if (wA !== wB) return (wA - wB) * dir;
      const pA = a.published_date || vidA?.published_date || '';
      const pB = b.published_date || vidB?.published_date || '';
      return pB.localeCompare(pA);
    }

    if (videoSortField === 'has_summary') {
      const sA = (isSummaryList || allSummaries.some(s => s.video_id === a.video_id) || a.has_summary == 1) ? 1 : 0;
      const sB = (isSummaryList || allSummaries.some(s => s.video_id === b.video_id) || b.has_summary == 1) ? 1 : 0;
      if (sA !== sB) return (sA - sB) * dir;
      const dA = a.discovered_at || vidA?.discovered_at || '';
      const dB = b.discovered_at || vidB?.discovered_at || '';
      return dB.localeCompare(dA);
    }

    return 0;
  });
}

function renderArchive() {
  updateArchiveViewButtons();
  renderCategoryFilterBars();
  const container = document.getElementById('archiveContainer');
  if (!container) return;

  const query = (document.getElementById('summarySearchInput')?.value || '').toLowerCase().trim();

  let filtered = allSummaries;
  if (selectedCustomCategory !== 'all') {
    filtered = filtered.filter(s => {
      const vid = allVideos.find(v => v.video_id === s.video_id);
      const cat = (s.custom_category || vid?.custom_category || '').trim();
      if (selectedCustomCategory === '__uncategorized__') return !cat;
      return cat === selectedCustomCategory;
    });
  }
  if (query) {
    filtered = filtered.filter(s => 
      (s.title && s.title.toLowerCase().includes(query)) ||
      (s.one_line_summary && s.one_line_summary.toLowerCase().includes(query)) ||
      (s.custom_category && s.custom_category.toLowerCase().includes(query))
    );
  }

  if (filtered.length === 0) {
    container.className = "w-full";
    container.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-400 bg-slate-800/30 rounded-2xl border border-slate-800">
        <i class="ph ph-magnifying-glass text-4xl text-slate-500 mb-2"></i>
        <p class="text-sm font-medium">검색 조건과 일치하는 요약 리포트가 없습니다.</p>
      </div>
    `;
    return;
  }

  if (archiveViewMode === 'list') {
    const sorted = sortVideoItems(filtered, true);
    container.className = "w-full";
    container.innerHTML = `
      <div class="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs table-fixed">
            <colgroup>
              <col class="w-auto">
              <col class="w-24">
              <col class="w-24">
              <col class="w-24">
              <col class="w-28">
              <col class="w-24">
              <col class="w-24">
              <col class="w-36">
            </colgroup>
            <thead class="bg-slate-900/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700/60 select-none">
              <tr>
                <th onclick="toggleVideoSort('title')" class="py-3 px-3 sm:px-4 text-left cursor-pointer hover:text-white hover:bg-slate-800/60 transition-colors group">
                  <div class="flex items-center gap-1">
                    <span>영상</span>
                    <span class="${getSortIconClass('title')}">${getSortIconHtml('title')}</span>
                  </div>
                </th>
                <th onclick="toggleVideoSort('custom_category')" class="py-3 px-2 whitespace-nowrap text-left cursor-pointer hover:text-white hover:bg-slate-800/60 transition-colors group">
                  <div class="flex items-center gap-1">
                    <span>분류</span>
                    <span class="${getSortIconClass('custom_category')}">${getSortIconHtml('custom_category')}</span>
                  </div>
                </th>
                <th onclick="toggleVideoSort('published_date')" class="py-3 px-2 whitespace-nowrap text-left cursor-pointer hover:text-white hover:bg-slate-800/60 transition-colors group">
                  <div class="flex items-center gap-1">
                    <span>게시 일자</span>
                    <span class="${getSortIconClass('published_date')}">${getSortIconHtml('published_date')}</span>
                  </div>
                </th>
                <th onclick="toggleVideoSort('discovered_at')" class="py-3 px-2 whitespace-nowrap text-left cursor-pointer hover:text-white hover:bg-slate-800/60 transition-colors group">
                  <div class="flex items-center gap-1">
                    <span>추가 일자</span>
                    <span class="${getSortIconClass('discovered_at')}">${getSortIconHtml('discovered_at')}</span>
                  </div>
                </th>
                <th onclick="toggleVideoSort('duration')" class="py-3 px-2 whitespace-nowrap text-left cursor-pointer hover:text-white hover:bg-slate-800/60 transition-colors group">
                  <div class="flex items-center gap-1">
                    <span>재생시간 / 조회수</span>
                    <span class="${getSortIconClass('duration')}">${getSortIconHtml('duration')}</span>
                  </div>
                </th>
                <th onclick="toggleVideoSort('is_within_24h')" class="py-3 px-2 whitespace-nowrap text-center cursor-pointer hover:text-white hover:bg-slate-800/60 transition-colors group">
                  <div class="flex items-center justify-center gap-1">
                    <span>24시간 여부</span>
                    <span class="${getSortIconClass('is_within_24h')}">${getSortIconHtml('is_within_24h')}</span>
                  </div>
                </th>
                <th onclick="toggleVideoSort('has_summary')" class="py-3 px-2 whitespace-nowrap text-center cursor-pointer hover:text-white hover:bg-slate-800/60 transition-colors group">
                  <div class="flex items-center justify-center gap-1">
                    <span>요약 상태</span>
                    <span class="${getSortIconClass('has_summary')}">${getSortIconHtml('has_summary')}</span>
                  </div>
                </th>
                <th class="py-3 px-3 sm:px-4 whitespace-nowrap text-right">작업</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800 text-slate-300">
              ${sorted.map(summary => renderSummaryListRow(summary)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else {
    container.className = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5";
    container.innerHTML = filtered.map(summary => renderSummaryCard(summary)).join('');
  }
}

function filterSummaries() {
  renderArchive();
}

function renderSummaryListRow(summary) {
  const vid = allVideos.find(v => v.video_id === summary.video_id);
  const is24h = (summary.is_within_24h == 1) || (vid && vid.is_within_24h == 1);
  const thumb = summary.thumbnail_url || vid?.thumbnail_url || `https://i.ytimg.com/vi/${summary.video_id}/hqdefault.jpg`;
  const pubDate = summary.published_date || vid?.published_date || '-';
  const pubTime = summary.published_time_text || vid?.published_time_text || '';
  const rawDiscovered = summary.discovered_at || vid?.discovered_at || summary.created_at || '';
  const discoveredDate = rawDiscovered ? rawDiscovered.split(' ')[0] : '-';
  const discoveredTime = rawDiscovered && rawDiscovered.split(' ')[1] ? rawDiscovered.split(' ')[1].slice(0, 5) : '';
  const duration = summary.duration_text || vid?.duration_text || '-';
  const viewCount = summary.view_count_text || vid?.view_count_text || '-';
  const videoUrl = summary.video_url || vid?.video_url || `https://www.youtube.com/watch?v=${summary.video_id}`;
  const chName = summary.channel_name || vid?.channel_name || 'YouTube 채널';
  const chId = summary.channel_id || vid?.channel_id || 1;
  const curCat = summary.custom_category || vid?.custom_category || '';

  return `
    <tr class="hover:bg-slate-800/40 transition-colors bg-emerald-950/15">
      <td class="py-3 px-3 sm:px-4">
        <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <img src="${thumb}" class="w-12 h-8 sm:w-14 sm:h-9 rounded object-cover flex-shrink-0 bg-slate-950">
          <div class="min-w-0 flex-1">
            <a href="${videoUrl}" target="_blank" class="font-semibold text-white hover:text-blue-400 transition-colors truncate block text-xs" title="${escapeHtml(summary.title)}">
              ${escapeHtml(summary.title)}
            </a>
            <div class="flex flex-wrap items-center gap-1.5 mt-0.5">
              ${renderVideoChannelSelector(summary.video_id, chId, chName, true)}
              ${(vid?.is_custom_added == 1 || summary.is_custom_added == 1) ? '<span class="px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[9px] font-semibold flex-shrink-0">URL 직접등록</span>' : ''}
              <span class="text-[10px] text-slate-500 font-mono truncate">ID: ${summary.video_id}</span>
            </div>
          </div>
        </div>
      </td>
      <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
        ${renderVideoCategorySelector(summary.video_id, curCat, true)}
      </td>
      <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
        <div class="font-mono text-xs font-semibold text-white truncate">${pubDate}</div>
        <div class="text-[10px] text-slate-400 truncate">${pubTime}</div>
      </td>
      <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
        <div class="font-mono text-xs font-semibold text-slate-200 truncate">${discoveredDate}</div>
        <div class="text-[10px] text-slate-500 font-mono truncate">${discoveredTime ? discoveredTime + ' 등록' : ''}</div>
      </td>
      <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
        <div class="text-xs text-slate-300 font-medium truncate">${duration}</div>
        <div class="text-[10px] text-slate-400 truncate">${viewCount}</div>
      </td>
      <td class="py-3 px-2 text-center whitespace-nowrap overflow-hidden">
        ${is24h ? `
          <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 whitespace-nowrap">
            24h 이내
          </span>
        ` : `
          <span class="text-slate-500 text-[11px]">-</span>
        `}
      </td>
      <td class="py-3 px-2 text-center whitespace-nowrap overflow-hidden">
        <div class="inline-flex flex-col items-center gap-0.5">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 whitespace-nowrap inline-flex items-center gap-1">
            <i class="ph-bold ph-seal-check"></i> 보관됨
          </span>
          <span class="text-[9px] text-emerald-400/80 font-mono truncate max-w-[80px]">${escapeHtml(summary.model_used || 'AI')}</span>
        </div>
      </td>
      <td class="py-3 px-3 sm:px-4 text-right whitespace-nowrap">
        <div class="flex items-center justify-end">
          <button onclick="openSummaryModal('${summary.video_id}')" class="px-4 py-2 rounded-xl text-xs sm:text-[13px] font-bold bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white transition-all inline-flex items-center gap-1.5 shadow-md hover:shadow-emerald-900/40 active:scale-95 whitespace-nowrap">
            <i class="ph-bold ph-book-open text-sm"></i>
            <span>리포트 열기</span>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function renderSummaryCard(summary) {
  const vid = allVideos.find(v => v.video_id === summary.video_id);
  const is24h = summary.is_within_24h == 1;
  const thumb = summary.thumbnail_url || `https://i.ytimg.com/vi/${summary.video_id}/hqdefault.jpg`;
  const chName = summary.channel_name || 'YouTube 채널';
  const isCustom = (vid?.is_custom_added == 1 || summary.is_custom_added == 1 || isCustomVideosChannelSelected());
  const curCat = summary.custom_category || vid?.custom_category || '';

  return `
    <div class="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden flex flex-col justify-between hover:border-blue-500/50 hover:shadow-xl transition-all group">
      <div>
        <div class="relative h-44 w-full bg-slate-950 overflow-hidden">
          <img src="${thumb}" alt="${escapeHtml(summary.title)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300">
          ${is24h ? `
            <span class="absolute top-3 left-3 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500 text-slate-950 shadow">
              🔥 24h 신규
            </span>
          ` : ''}
          <button type="button" onclick="event.stopPropagation(); openChangeChannelModal('${summary.video_id}')"
                  class="absolute bottom-2 left-2 px-2 py-0.5 rounded-lg bg-indigo-950/90 hover:bg-indigo-900 border border-indigo-500/40 hover:border-indigo-400 text-[10px] font-semibold text-indigo-200 hover:text-white shadow flex items-center gap-1 transition-all cursor-pointer"
                  title="소속 채널: ${escapeHtml(chName)} (클릭하여 채널 변경)">
            <span>📺 ${escapeHtml(chName)}</span>
            <i class="ph-bold ph-pencil-simple text-[9px] opacity-75"></i>
          </button>
          <span class="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-black/80 text-[11px] font-mono text-white">
            ${summary.duration_text || 'Video'}
          </span>
        </div>

        <div class="p-4 space-y-2.5">
          <div class="flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span class="flex items-center gap-1 whitespace-nowrap"><i class="ph ph-clock"></i> ${summary.published_time_text || '게시'}</span>
            <div class="flex items-center gap-1.5 min-w-0">
              ${renderVideoCategorySelector(summary.video_id, curCat, isCustom)}
              <span class="px-2 py-0.5 rounded bg-slate-700/60 text-slate-300 text-[10px] font-mono truncate max-w-[110px]">
                ${escapeHtml(summary.model_used || 'AI')}
              </span>
            </div>
          </div>

          <h3 class="text-sm font-bold text-white line-clamp-2 group-hover:text-blue-400 transition-colors">
            ${escapeHtml(summary.title)}
          </h3>

          <p class="text-xs text-slate-300 line-clamp-3 leading-relaxed">
            ${escapeHtml(summary.one_line_summary || '')}
          </p>
        </div>
      </div>

      <div class="p-4 pt-0 border-t border-slate-700/40 mt-3 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <a href="${summary.video_url}" target="_blank" class="text-xs text-slate-400 hover:text-red-400 flex items-center gap-1 transition-colors">
            <i class="ph-bold ph-youtube-logo text-base text-red-500"></i> 원본
          </a>
          <button type="button" onclick="deleteVideo('${summary.video_id}')" 
                  class="px-2 py-1 rounded-lg text-xs font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-400 hover:text-red-300 border border-red-500/30 flex items-center gap-1 transition-all" 
                  title="이 동영상 및 요약 리포트 삭제">
            <i class="ph-bold ph-trash text-xs"></i>
            <span>삭제</span>
          </button>
        </div>
        <button onclick="openSummaryModal('${summary.video_id}')" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-blue-600/90 hover:bg-blue-600 text-white flex items-center gap-1.5 shadow-sm transition-all">
          <span>디테일 요약 보기</span>
          <i class="ph-bold ph-arrow-right text-xs"></i>
        </button>
      </div>
    </div>
  `;
}

// Date Range Filtering State
let currentQuickFilter = 'all';

function onDateInputChange() {
  currentQuickFilter = 'custom';
  updateChipStyles();
}

function updateChipStyles() {
  const chips = ['all', 'today', '24h', '3d', '7d', '30d', '60d', '90d', '120d', 'summarized'];
  chips.forEach(c => {
    const el = document.getElementById(`chip-${c}`);
    if (!el) return;
    if (c === currentQuickFilter) {
      el.className = "px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white border border-blue-500 shadow-sm";
    } else {
      el.className = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:text-white border border-slate-700 transition-colors";
    }
  });
}

function setQuickDateRange(range) {
  currentQuickFilter = range;
  updateChipStyles();
  
  const startInput = document.getElementById('videoFilterStartDate');
  const endInput = document.getElementById('videoFilterEndDate');
  
  const today = new Date();
  const formatYMD = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  
  if (range === 'all' || range === 'summarized') {
    startInput.value = '';
    endInput.value = '';
  } else if (range === 'today') {
    startInput.value = formatYMD(today);
    endInput.value = formatYMD(today);
  } else if (range === '24h') {
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    startInput.value = formatYMD(yesterday);
    endInput.value = formatYMD(today);
  } else if (range === '3d') {
    const d3 = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    startInput.value = formatYMD(d3);
    endInput.value = formatYMD(today);
  } else if (range === '7d') {
    const d7 = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    startInput.value = formatYMD(d7);
    endInput.value = formatYMD(today);
  } else if (range === '30d') {
    const d30 = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    startInput.value = formatYMD(d30);
    endInput.value = formatYMD(today);
  } else if (range === '60d') {
    const d60 = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);
    startInput.value = formatYMD(d60);
    endInput.value = formatYMD(today);
  } else if (range === '90d') {
    const d90 = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    startInput.value = formatYMD(d90);
    endInput.value = formatYMD(today);
  } else if (range === '120d') {
    const d120 = new Date(today.getTime() - 120 * 24 * 60 * 60 * 1000);
    startInput.value = formatYMD(d120);
    endInput.value = formatYMD(today);
  }
  
  renderVideosTable();
}

function applyDateFilter() {
  renderVideosTable();
  const start = document.getElementById('videoFilterStartDate')?.value;
  const end = document.getElementById('videoFilterEndDate')?.value;
  if (start || end) {
    showToast(`날짜 필터 적용: ${start || '전체'} ~ ${end || '오늘'}`, "info");
  } else {
    showToast("전체 기간으로 조회합니다.", "info");
  }
}

function resetDateFilter() {
  const startInput = document.getElementById('videoFilterStartDate');
  const endInput = document.getElementById('videoFilterEndDate');
  if (startInput) startInput.value = '';
  if (endInput) endInput.value = '';
  currentQuickFilter = 'all';
  updateChipStyles();
  renderVideosTable();
  showToast("날짜 필터가 초기화되었습니다.", "info");
}

// Render Videos Table
function renderVideosTable() {
  renderCategoryFilterBars();
  const tbody = document.getElementById('videosTableBody');
  if (!tbody) return;

  const startVal = document.getElementById('videoFilterStartDate')?.value || '';
  const endVal = document.getElementById('videoFilterEndDate')?.value || '';
  const keepSummarized = document.getElementById('chkKeepSummarizedVideos')?.checked ?? true;

  // Count total summarized
  const totalSummarized = allVideos.filter(v => allSummaries.some(s => s.video_id === v.video_id)).length;
  const chipSumCount = document.getElementById('chipSummarizedCount');
  if (chipSumCount) chipSumCount.textContent = totalSummarized;

  let filtered = allVideos;

  // Filter by selected custom category if active
  if (selectedCustomCategory !== 'all') {
    filtered = filtered.filter(v => {
      const cat = (v.custom_category || '').trim();
      if (selectedCustomCategory === '__uncategorized__') return !cat;
      return cat === selectedCustomCategory;
    });
  }

  if (currentQuickFilter === 'summarized') {
    filtered = filtered.filter(v => allSummaries.some(s => s.video_id === v.video_id));
  } else if (startVal || endVal) {
    filtered = filtered.filter(v => {
      const hasSum = allSummaries.some(s => s.video_id === v.video_id);
      
      // CRITICAL: If keepSummarized is true, NEVER remove videos that have summaries!
      if (keepSummarized && hasSum) {
        return true;
      }
      
      const vDate = v.published_date || '';
      if (!vDate) return true; // Keep if date unknown
      
      if (startVal && vDate < startVal) return false;
      if (endVal && vDate > endVal) return false;
      return true;
    });
  }

  // Update counts
  const filteredCountEl = document.getElementById('filteredVideosCount');
  const filteredSumCountEl = document.getElementById('filteredSummarizedCount');
  if (filteredCountEl) filteredCountEl.textContent = filtered.length;
  if (filteredSumCountEl) {
    const inFilteredSummarized = filtered.filter(v => allSummaries.some(s => s.video_id === v.video_id)).length;
    filteredSumCountEl.textContent = inFilteredSummarized;
  }

  if (filtered.length === 0) {
    updateVideoSortHeaderIcons();
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="py-10 text-center text-slate-400">
          <i class="ph ph-calendar-blank text-3xl text-slate-500 mb-2"></i>
          <p class="font-medium text-sm">선택하신 조건에 해당하는 영상이 없습니다.</p>
          <button onclick="selectedCustomCategory='all'; resetDateFilter();" class="mt-2 text-xs text-blue-400 hover:underline">필터 조건 초기화</button>
        </td>
      </tr>
    `;
    return;
  }

  updateVideoSortHeaderIcons();
  const sorted = sortVideoItems(filtered, false);

  tbody.innerHTML = sorted.map(v => {
    const hasSum = allSummaries.some(s => s.video_id === v.video_id) || v.has_summary == 1;
    const chName = v.channel_name || 'YouTube 채널';
    const rawDiscovered = v.discovered_at || '';
    const discoveredDate = rawDiscovered ? rawDiscovered.split(' ')[0] : '-';
    const discoveredTime = rawDiscovered && rawDiscovered.split(' ')[1] ? rawDiscovered.split(' ')[1].slice(0, 5) : '';
    return `
      <tr class="hover:bg-slate-800/40 transition-colors ${hasSum ? 'bg-emerald-950/15' : ''}">
        <td class="py-3 px-3 sm:px-4">
          <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <img src="${v.thumbnail_url}" class="w-12 h-8 sm:w-14 sm:h-9 rounded object-cover flex-shrink-0 bg-slate-950">
            <div class="min-w-0 flex-1">
              <a href="${v.video_url}" target="_blank" class="font-semibold text-white hover:text-blue-400 transition-colors truncate block text-xs" title="${escapeHtml(v.title)}">
                ${escapeHtml(v.title)}
              </a>
              <div class="flex flex-wrap items-center gap-1.5 mt-0.5">
                ${renderVideoChannelSelector(v.video_id, v.channel_id, chName, true)}
                ${v.is_custom_added == 1 ? '<span class="px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[9px] font-semibold flex-shrink-0">URL 직접등록</span>' : ''}
                <span class="text-[10px] text-slate-500 font-mono truncate">ID: ${v.video_id}</span>
              </div>
            </div>
          </div>
        </td>
        <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
          ${renderVideoCategorySelector(v.video_id, v.custom_category, true)}
        </td>
        <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
          <div class="font-mono text-xs font-semibold text-white truncate">${v.published_date || '-'}</div>
          <div class="text-[10px] text-slate-400 truncate">${v.published_time_text || ''}</div>
        </td>
        <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
          <div class="font-mono text-xs font-semibold text-slate-200 truncate">${discoveredDate}</div>
          <div class="text-[10px] text-slate-500 font-mono truncate">${discoveredTime ? discoveredTime + ' 등록' : ''}</div>
        </td>
        <td class="py-3 px-2 whitespace-nowrap overflow-hidden">
          <div class="text-xs text-slate-300 font-medium truncate">${v.duration_text || '-'}</div>
          <div class="text-[10px] text-slate-400 truncate">${v.view_count_text || '-'}</div>
        </td>
        <td class="py-3 px-2 text-center whitespace-nowrap overflow-hidden">
          ${v.is_within_24h ? `
            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 whitespace-nowrap">
              24h 이내
            </span>
          ` : `
            <span class="text-slate-500 text-[11px]">-</span>
          `}
        </td>
        <td class="py-3 px-2 text-center whitespace-nowrap overflow-hidden">
          ${hasSum ? `
            <div class="inline-flex flex-col items-center gap-0.5">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 whitespace-nowrap inline-flex items-center gap-1">
                <i class="ph-bold ph-seal-check"></i> 보관됨
              </span>
              <span class="text-[9px] text-emerald-400/80 font-mono">영구 보존</span>
            </div>
          ` : isVideoSummarizing(v.video_id) ? `
            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-300 border border-red-500/30 whitespace-nowrap inline-flex items-center gap-1">
              <i class="ph-bold ph-spinner-gap animate-spin"></i> 요약중
            </span>
          ` : `
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-700/60 text-slate-400 whitespace-nowrap">
              미요약
            </span>
          `}
        </td>
        <td class="py-3 px-3 sm:px-4 text-right whitespace-nowrap">
          <div class="flex items-center justify-end">
            ${hasSum ? `
              <button onclick="openSummaryModal('${v.video_id}')" class="px-4 py-2 rounded-xl text-xs sm:text-[13px] font-bold bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white transition-all inline-flex items-center gap-1.5 shadow-md hover:shadow-emerald-900/40 active:scale-95 whitespace-nowrap">
                <i class="ph-bold ph-book-open text-sm"></i>
                <span>리포트 열기</span>
              </button>
            ` : isVideoSummarizing(v.video_id) ? `
              <button disabled class="px-3.5 py-2 rounded-xl text-xs font-semibold bg-red-600 text-white transition-all inline-flex items-center gap-1.5 shadow-sm shadow-red-600/30 cursor-wait whitespace-nowrap">
                <i class="ph-bold ph-spinner-gap animate-spin text-sm"></i>
                <span>생성중...</span>
              </button>
            ` : `
              <button onclick="generateSingleSummary('${v.video_id}')" class="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-white transition-all shadow-sm active:scale-95 whitespace-nowrap">
                <span>AI 요약 생성</span>
              </button>
            `}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Load and Render Run Logs
async function loadLogs() {
  try {
    const res = await fetch('/api/runs');
    const logs = await res.json();
    const tbody = document.getElementById('logsTableBody');

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400">실행 기록이 없습니다.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => {
      const isOk = l.status === 'success';
      const triggerBadge = l.triggered_by === 'schedule' 
        ? `<span class="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">아침 9시 스케줄</span>`
        : `<span class="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">수동 실행</span>`;

      return `
        <tr class="hover:bg-slate-800/40 transition-colors">
          <td class="py-3 px-4 font-mono text-slate-300 whitespace-nowrap">${l.run_at}</td>
          <td class="py-3 px-4 whitespace-nowrap">${triggerBadge}</td>
          <td class="py-3 px-4 whitespace-nowrap">${l.videos_found_total}개</td>
          <td class="py-3 px-4 whitespace-nowrap font-semibold text-amber-300">${l.videos_within_24h}개</td>
          <td class="py-3 px-4 whitespace-nowrap font-semibold text-emerald-300">${l.videos_summarized}개</td>
          <td class="py-3 px-4 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isOk ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}">
              ${l.status.toUpperCase()}
            </span>
          </td>
          <td class="py-3 px-4 text-slate-400 text-xs">${escapeHtml(l.message || '')}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error("Logs load error:", err);
  }
}

// Trigger Manual Run
async function triggerManualRun() {
  try {
    const q = selectedChannelId !== 'all' ? `?channel_id=${selectedChannelId}` : '';
    showToast("24시간 이내 신규 영상 조사 및 요약을 시작합니다...", "info");
    const res = await fetch('/api/run' + q, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'busy') {
      showToast(data.message, "warning");
    } else {
      showToast(data.message, "success");
      loadStatus();
    }
  } catch (err) {
    showToast("실행 요청 실패: " + err.message, "error");
  }
}

// --- Single Video URL Add Functions ---

function populateSingleVideoCategorySelect(selectedValue = null) {
  const catSelect = document.getElementById('singleVideoCustomCategory');
  if (!catSelect) return;
  const catNames = getAvailableCategoryNames();
  const targetVal = selectedValue !== null
    ? selectedValue
    : (selectedCustomCategory !== 'all' && selectedCustomCategory !== '__uncategorized__' ? selectedCustomCategory : '');

  catSelect.innerHTML = `<option value="">📁 미분류 (선택 안 함)</option>`;
  catNames.forEach(cName => {
    const opt = document.createElement('option');
    opt.value = cName;
    opt.textContent = `📁 ${cName}`;
    if (targetVal && targetVal === cName) {
      opt.selected = true;
    }
    catSelect.appendChild(opt);
  });
}

async function quickAddCategoryFromSingleModal() {
  const newCat = prompt("새로 추가할 분류(카테고리) 이름을 입력하세요 (예: AI/CAD, 토목/검사, 업무참고):");
  if (!newCat || !newCat.trim()) return;
  const cleanName = newCat.trim();
  try {
    const res = await fetch('/api/custom-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName })
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (data.custom_categories) {
        allCustomCategories = data.custom_categories;
      }
      populateSingleVideoCategorySelect(cleanName);
      renderCategoryFilterBars();
      showToast(data.message, "success");
    } else {
      showToast(data.message || "카테고리 추가 실패", "error");
    }
  } catch (err) {
    showToast("카테고리 추가 오류: " + err.message, "error");
  }
}

function openSingleVideoModal() {
  const modal = document.getElementById('singleVideoModal');
  if (!modal) return;

  const urlInput = document.getElementById('singleVideoUrl');
  const chSelect = document.getElementById('singleVideoChannelId');
  const styleSelect = document.getElementById('singleVideoPromptStyle');
  const genChk = document.getElementById('singleVideoGenerateNow');
  const statusMsg = document.getElementById('singleVideoStatusMsg');

  if (urlInput) urlInput.value = '';
  if (genChk) genChk.checked = true;
  if (statusMsg) {
    statusMsg.className = 'hidden';
    statusMsg.innerHTML = '';
  }

  // Populate channel dropdown
  if (chSelect) {
    chSelect.innerHTML = `<option value="">자동 감지 (실제 영상 채널명)</option>`;
    allChannels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `${ch.name} (${ch.handle || ''})`;
      if (selectedChannelId === ch.id) {
        opt.selected = true;
      }
      chSelect.appendChild(opt);
    });
  }

  // Populate custom category dropdown
  populateSingleVideoCategorySelect();

  // If a channel is selected, pre-select its prompt style
  if (styleSelect) {
    const activeCh = allChannels.find(c => c.id === selectedChannelId);
    if (activeCh && activeCh.prompt_style) {
      styleSelect.value = activeCh.prompt_style;
    } else {
      styleSelect.value = 'construction';
    }
  }

  modal.classList.remove('hidden');
  setTimeout(() => {
    if (urlInput) urlInput.focus();
  }, 100);
}

function closeSingleVideoModal() {
  const modal = document.getElementById('singleVideoModal');
  if (modal) modal.classList.add('hidden');
}

async function submitSingleVideo(e, withSummary = true) {
  if (e) e.preventDefault();
  const urlInput = document.getElementById('singleVideoUrl');
  const chSelect = document.getElementById('singleVideoChannelId');
  const styleSelect = document.getElementById('singleVideoPromptStyle');
  const catSelect = document.getElementById('singleVideoCustomCategory');
  const submitBtn = document.getElementById('btnSubmitSingleVideo');
  const submitIcon = document.getElementById('btnSubmitSingleVideoIcon');
  const submitText = document.getElementById('btnSubmitSingleVideoText');
  const submitOnlyBtn = document.getElementById('btnSubmitSingleVideoOnly');
  const submitOnlyIcon = document.getElementById('btnSubmitSingleVideoOnlyIcon');
  const submitOnlyText = document.getElementById('btnSubmitSingleVideoOnlyText');
  const statusMsg = document.getElementById('singleVideoStatusMsg');

  const url = urlInput ? urlInput.value.trim() : '';
  if (!url) {
    showToast("유튜브 동영상 링크(URL)를 입력해주세요.", "warning");
    if (urlInput) urlInput.focus();
    return;
  }

  const chId = chSelect && chSelect.value ? parseInt(chSelect.value) : null;
  const promptStyle = styleSelect ? styleSelect.value : 'construction';
  const customCategory = catSelect ? catSelect.value : '';

  // UI loading state while registering video metadata
  if (submitBtn) submitBtn.disabled = true;
  if (submitOnlyBtn) submitOnlyBtn.disabled = true;
  if (withSummary) {
    if (submitIcon) submitIcon.className = "ph-bold ph-spinner-gap animate-spin text-sm";
    if (submitText) submitText.textContent = "동영상 등록 중...";
  } else {
    if (submitOnlyIcon) submitOnlyIcon.className = "ph-bold ph-spinner-gap animate-spin text-sm";
    if (submitOnlyText) submitOnlyText.textContent = "동영상 등록 중...";
  }

  if (statusMsg) {
    statusMsg.className = "p-3 rounded-xl text-xs bg-blue-950/40 text-blue-200 border border-blue-500/30 flex items-center gap-2";
    statusMsg.innerHTML = `<i class="ph-bold ph-spinner-gap animate-spin text-blue-400 text-sm"></i> 유튜브 영상 메타데이터를 확인하고 목록에 등록하고 있습니다...`;
  }

  try {
    // Register video metadata without blocking on AI summary
    const res = await fetch('/api/videos/add-single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        channel_id: chId,
        prompt_style: promptStyle,
        custom_category: customCategory,
        generate_summary_now: false
      })
    });
    const data = await res.json();

    if (data.status === 'success' || data.status === 'partial_success') {
      const addedVideo = data.video;
      const videoId = addedVideo?.video_id;

      if (withSummary && videoId) {
        localSummarizingVideoIds.add(videoId);
      }

      closeSingleVideoModal();

      // Switch to the target channel if needed so the newly added video is visible
      if (selectedChannelId !== 'all' && addedVideo?.channel_id && selectedChannelId !== addedVideo.channel_id) {
        selectedChannelId = addedVideo.channel_id;
      }

      await Promise.all([
        loadStatus(),
        loadVideosAndSummaries()
      ]);
      // Switch to videos tab to see the newly added video at the top
      switchTab('videos');

      if (withSummary && videoId) {
        showToast(`'${addedVideo.title}' 등록 완료! 백그라운드에서 AI 요약을 진행합니다.`, "info");
        // Run AI summarization in the background using the user's configured detail_level
        generateSingleSummary(videoId, null, promptStyle, false);
      } else {
        showToast(data.message || "동영상이 목록에 등록되었습니다.", "success");
      }
    } else if (data.status === 'duplicate') {
      const dupTitle = data.video?.title || '';
      const dupChannel = data.video?.channel_name || '목록';
      if (statusMsg) {
        statusMsg.className = "p-3 rounded-xl text-xs bg-amber-950/50 text-amber-200 border border-amber-500/40 flex items-center gap-2";
        statusMsg.innerHTML = `<i class="ph-bold ph-warning text-amber-400 text-sm"></i> 이미 등록된 동영상입니다: <strong>${escapeHtml(dupTitle)}</strong> (${escapeHtml(dupChannel)})`;
      }
      showToast("이미 등록된 동영상 주소입니다.", "warning");
      alert(data.message || "이미 등록된 동영상 주소입니다.");
      if (urlInput) {
        urlInput.focus();
        urlInput.select();
      }
    } else {
      if (statusMsg) {
        statusMsg.className = "p-3 rounded-xl text-xs bg-red-950/40 text-red-200 border border-red-500/30 flex items-center gap-2";
        statusMsg.innerHTML = `<i class="ph-bold ph-x-circle text-red-400 text-sm"></i> ${escapeHtml(data.message || '등록 실패')}`;
      }
      showToast(data.message || "동영상 등록 실패", "error");
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.className = "p-3 rounded-xl text-xs bg-red-950/40 text-red-200 border border-red-500/30 flex items-center gap-2";
      statusMsg.innerHTML = `<i class="ph-bold ph-x-circle text-red-400 text-sm"></i> 요청 실패: ${escapeHtml(err.message)}`;
    }
    showToast("요청 중 오류가 발생했습니다: " + err.message, "error");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitIcon) submitIcon.className = "ph-bold ph-plus-circle text-sm";
    if (submitText) submitText.textContent = "동영상 등록 및 요약 시작";
    if (submitOnlyBtn) submitOnlyBtn.disabled = false;
    if (submitOnlyIcon) submitOnlyIcon.className = "ph-bold ph-bookmark-simple text-sm";
    if (submitOnlyText) submitOnlyText.textContent = "동영상 등록만";
  }
}

// --- Custom Category Manager Modal Functions ---

function openCustomCategoryModal() {
  const modal = document.getElementById('customCategoryModal');
  if (!modal) return;
  const input = document.getElementById('newCustomCategoryInput');
  if (input) input.value = '';
  renderCustomCategoryManagerList();
  modal.classList.remove('hidden');
  setTimeout(() => {
    if (input) input.focus();
  }, 100);
}

function closeCustomCategoryModal() {
  const modal = document.getElementById('customCategoryModal');
  if (modal) modal.classList.add('hidden');
}

function renderCustomCategoryManagerList() {
  const listEl = document.getElementById('customCategoryManagerList');
  const countEl = document.getElementById('customCategoryCount');
  if (!listEl) return;

  if (countEl) countEl.textContent = allCustomCategories.length;

  if (!allCustomCategories || allCustomCategories.length === 0) {
    listEl.innerHTML = `
      <div class="py-6 text-center text-slate-400 bg-slate-800/30 rounded-xl border border-slate-800 text-xs">
        아직 등록된 카테고리가 없습니다. 위 입력창에서 새 분류를 추가해보세요!
      </div>
    `;
    return;
  }

  listEl.innerHTML = allCustomCategories.map(cat => {
    const safeNameArg = (cat.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const vidCount = cat.video_count ?? allVideos.filter(v => (v.custom_category || '').trim() === cat.name).length;
    return `
      <div class="bg-slate-800/70 border border-slate-700/80 rounded-xl p-3 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <i class="ph-bold ph-folder-simple text-amber-400 text-base flex-shrink-0"></i>
          <span class="text-xs font-bold text-white truncate">${escapeHtml(cat.name)}</span>
          <span class="px-2 py-0.5 rounded-full bg-slate-900 text-slate-400 text-[10px] font-mono">영상 ${vidCount}개</span>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <button type="button" onclick="renameCustomCategory(${cat.id}, '${safeNameArg}')"
                  class="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center gap-1 transition-all">
            <i class="ph-bold ph-pencil-simple text-xs"></i>
            <span>이름 변경</span>
          </button>
          <button type="button" onclick="deleteCustomCategory(${cat.id}, '${safeNameArg}')"
                  class="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-500/15 hover:bg-red-500/30 text-red-400 border border-red-500/30 flex items-center gap-1 transition-all">
            <i class="ph-bold ph-trash text-xs"></i>
            <span>삭제</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function submitNewCustomCategory(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('newCustomCategoryInput');
  const name = input ? input.value.trim() : '';
  if (!name) {
    showToast("카테고리 이름을 입력해주세요.", "warning");
    return;
  }

  try {
    const res = await fetch('/api/custom-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (input) input.value = '';
      if (data.custom_categories) {
        allCustomCategories = data.custom_categories;
      }
      renderCustomCategoryManagerList();
      renderCategoryFilterBars();
      renderArchive();
      renderVideosTable();
      showToast(data.message, "success");
    } else {
      showToast(data.message || "카테고리 추가 실패", "error");
    }
  } catch (err) {
    showToast("카테고리 추가 오류: " + err.message, "error");
  }
}

async function renameCustomCategory(catId, oldName) {
  const newName = prompt(`'${oldName}' 카테고리의 새 이름을 입력하세요:`, oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;
  const cleanName = newName.trim();

  try {
    const res = await fetch(`/api/custom-categories/${catId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName })
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (data.custom_categories) {
        allCustomCategories = data.custom_categories;
      }
      if (selectedCustomCategory === oldName) {
        selectedCustomCategory = cleanName;
      }
      await loadVideosAndSummaries();
      renderCustomCategoryManagerList();
      showToast(data.message, "success");
    } else {
      showToast(data.message || "카테고리 수정 실패", "error");
    }
  } catch (err) {
    showToast("카테고리 수정 오류: " + err.message, "error");
  }
}

async function deleteCustomCategory(catId, catName) {
  if (!confirm(`'${catName}' 카테고리를 삭제하시겠습니까?\n(해당 카테고리에 속한 동영상은 삭제되지 않고 '미분류'로 전환됩니다.)`)) {
    return;
  }

  try {
    const res = await fetch(`/api/custom-categories/${catId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (data.custom_categories) {
        allCustomCategories = data.custom_categories;
      }
      if (selectedCustomCategory === catName) {
        selectedCustomCategory = 'all';
      }
      await loadVideosAndSummaries();
      renderCustomCategoryManagerList();
      showToast(data.message, "success");
    } else {
      showToast(data.message || "카테고리 삭제 실패", "error");
    }
  } catch (err) {
    showToast("카테고리 삭제 오류: " + err.message, "error");
  }
}

// --- Multi-Channel Manager Modal Functions ---

function openChannelManagerModal() {
  const modal = document.getElementById('channelManagerModal');
  if (!modal) return;
  renderChannelManagerList();
  modal.classList.remove('hidden');
}

function closeChannelManagerModal() {
  const modal = document.getElementById('channelManagerModal');
  if (modal) modal.classList.add('hidden');
}

function renderChannelManagerList() {
  const listEl = document.getElementById('channelManagerList');
  const countEl = document.getElementById('registeredChannelsCount');
  if (!listEl) return;

  if (countEl) countEl.textContent = allChannels.length;

  listEl.innerHTML = allChannels.map(ch => {
    const isDef = ch.is_default == 1;
    const isAuto = ch.auto_sync == 1;
    const isSelected = selectedChannelId === ch.id;
    const pStyle = ch.prompt_style || 'general';

    return `
      <div class="bg-slate-800/70 border ${isSelected ? 'border-blue-500/60' : 'border-slate-700/70'} rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all">
        <div class="space-y-1.5 min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-bold text-white flex items-center gap-1.5">
              <i class="ph-bold ${isDef ? 'ph-hard-hat text-amber-400' : 'ph-youtube-logo text-red-400'}"></i>
              ${escapeHtml(ch.name)}
            </span>
            <span class="text-xs font-mono text-slate-400">${escapeHtml(ch.handle || '')}</span>
            ${isDef ? `
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                기본 채널 (보호됨)
              </span>
            ` : ''}
            <select onchange="changeChannelPromptStyle(${ch.id}, this.value)"
                    class="bg-slate-900 border border-slate-700 rounded-lg px-2 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-blue-500"
                    title="이 채널의 AI 요약 스타일 변경">
              <option value="construction" ${pStyle === 'construction' ? 'selected' : ''}>🏗️ 건설/엔지니어링 & 적산 특화</option>
              <option value="tech" ${pStyle === 'tech' ? 'selected' : ''}>💻 IT / AI / 소프트웨어 기술 특화</option>
              <option value="business" ${pStyle === 'business' ? 'selected' : ''}>📈 비즈니스 / 경제 / 트렌드 인사이트</option>
              <option value="general" ${pStyle === 'general' ? 'selected' : ''}>🌐 범용 표준 심층 요약</option>
            </select>
          </div>
          <div class="flex flex-wrap items-center gap-3 text-[11px] text-slate-400 font-mono">
            <a href="${ch.channel_url}" target="_blank" class="text-blue-400 hover:underline truncate max-w-xs">${ch.channel_url}</a>
            <span>•</span>
            <span>수집 영상: <strong class="text-white">${ch.total_videos || 0}</strong>개</span>
            <span>•</span>
            <span>24h 신규: <strong class="text-amber-300">${ch.recent_24h_videos || 0}</strong>개</span>
            <span>•</span>
            <span>요약 완료: <strong class="text-emerald-300">${ch.summarized_videos || 0}</strong>개</span>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 self-end sm:self-center">
          <label class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900/80 border border-slate-700 text-[11px] text-slate-300 cursor-pointer select-none">
            <input type="checkbox" ${isAuto ? 'checked' : ''} onchange="toggleChannelAutoSync(${ch.id}, this.checked)"
                   class="rounded bg-slate-900 border-slate-600 text-emerald-500 focus:ring-0">
            <span>09:00 자동조사</span>
          </label>

          <button type="button" onclick="selectChannel(${ch.id}); closeChannelManagerModal();"
                  class="px-2.5 py-1 rounded-lg text-xs font-semibold ${isSelected ? 'bg-blue-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'} transition-all">
            ${isSelected ? '현재 선택됨' : '채널 전환'}
          </button>

          <button type="button" onclick="syncSpecificChannel(${ch.id})"
                  class="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center gap-1 transition-all"
                  title="이 채널의 최신 영상 동기화">
            <i class="ph-bold ph-arrows-clockwise"></i> 동기화
          </button>

          ${!isDef ? `
            <button type="button" onclick="setChannelAsDefault(${ch.id})"
                    class="px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 transition-all"
                    title="이 채널을 기본 채널로 설정">
              기본 지정
            </button>
            <button type="button" onclick="removeChannel(${ch.id}, '${escapeHtml(ch.name)}')"
                    class="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-950/30 border border-transparent hover:border-red-500/30 transition-all"
                    title="채널 삭제">
              <i class="ph-bold ph-trash"></i>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function changeChannelPromptStyle(channelId, newStyle) {
  try {
    const res = await fetch(`/api/channels/${channelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_style: newStyle })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(data.message, "success");
      await loadStatus();
      renderChannelManagerList();
    }
  } catch (err) {
    showToast("요약 옵션 변경 실패: " + err.message, "error");
  }
}

async function submitNewChannel() {
  const urlInput = document.getElementById('newChannelUrlInput');
  const nameInput = document.getElementById('newChannelNameInput');
  const styleSelect = document.getElementById('newChannelPromptStyle');
  const autoChk = document.getElementById('newChannelAutoSync');
  const btn = document.getElementById('btnAddChannel');
  const icon = document.getElementById('btnAddChannelIcon');
  const txt = document.getElementById('btnAddChannelText');

  const rawUrl = (urlInput?.value || '').trim();
  if (!rawUrl) {
    showToast("유튜브 채널 URL 또는 @핸들을 입력해주세요.", "warning");
    return;
  }

  if (btn) btn.disabled = true;
  if (icon) icon.className = "ph-bold ph-spinner-gap animate-spin";
  if (txt) txt.textContent = "채널 정보 확인 및 영상 수집 중...";

  showToast("새 유튜브 채널 정보를 조회하고 영상을 불러오는 중입니다 (약 5~10초 소요)...", "info");

  try {
    const res = await fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_url: rawUrl,
        name: (nameInput?.value || '').trim() || null,
        prompt_style: styleSelect?.value || 'general',
        auto_sync: autoChk?.checked ? 1 : 0
      })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(data.message, "success");
      if (urlInput) urlInput.value = '';
      if (nameInput) nameInput.value = '';
      if (data.channel && data.channel.id) {
        await selectChannel(data.channel.id);
      } else {
        await loadStatus();
        await loadVideosAndSummaries();
      }
      renderChannelManagerList();
    } else {
      showToast(data.message || "채널 추가 실패", "error");
    }
  } catch (err) {
    showToast("채널 등록 오류: " + err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
    if (icon) icon.className = "ph-bold ph-plus";
    if (txt) txt.textContent = "채널 등록 및 영상 동기화";
  }
}

async function toggleChannelAutoSync(channelId, enabled) {
  try {
    const res = await fetch(`/api/channels/${channelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_sync: enabled ? 1 : 0 })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(data.message, "success");
      await loadStatus();
      renderChannelManagerList();
    }
  } catch (err) {
    showToast("설정 변경 실패: " + err.message, "error");
  }
}

async function setChannelAsDefault(channelId) {
  try {
    const res = await fetch(`/api/channels/${channelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_default: 1 })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast("기본 채널이 변경되었습니다.", "success");
      await loadStatus();
      await loadSettings();
      renderChannelManagerList();
    }
  } catch (err) {
    showToast("기본 채널 변경 오류: " + err.message, "error");
  }
}

async function syncSpecificChannel(channelId) {
  showToast("선택한 채널의 최신 영상을 유튜브에서 동기화하는 중입니다...", "info");
  try {
    const res = await fetch(`/api/videos/sync?channel_id=${channelId}`, { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(data.message, "success");
      await loadStatus();
      await loadVideosAndSummaries();
      renderChannelManagerList();
    } else {
      showToast(data.message || "동기화 실패", "error");
    }
  } catch (err) {
    showToast("동기화 오류: " + err.message, "error");
  }
}

async function removeChannel(channelId, channelName) {
  if (!confirm(`'${channelName}' 채널을 목록에서 삭제하시겠습니까?\n(이미 작성된 요약 리포트는 삭제되지 않고 안전하게 보관됩니다)`)) {
    return;
  }
  try {
    const res = await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(data.message, "success");
      if (selectedChannelId === channelId) {
        const defCh = allChannels.find(c => c.is_default == 1 && c.id !== channelId);
        selectedChannelId = defCh ? defCh.id : 1;
      }
      await loadStatus();
      await loadVideosAndSummaries();
      renderChannelManagerList();
    } else {
      showToast(data.message || "삭제 실패", "error");
    }
  } catch (err) {
    showToast("삭제 요청 오류: " + err.message, "error");
  }
}

// Delete Single Video / Summary with 2-Step Confirmation Modal
let pendingDeleteVideoId = null;
let pendingDeleteMode = 'full'; // 'summary_only' or 'full'
let pendingDeleteHasSummary = false;

function deleteCurrentModalVideo() {
  if (currentViewingSummary && currentViewingSummary.video_id) {
    deleteVideo(currentViewingSummary.video_id);
  }
}

function deleteVideo(videoId) {
  const vid = allVideos.find(v => v.video_id === videoId);
  const sum = allSummaries.find(s => s.video_id === videoId);
  const title = vid?.title || sum?.title || videoId;
  const hasSum = (sum != null) || (vid?.has_summary == 1);

  pendingDeleteVideoId = videoId;
  pendingDeleteHasSummary = hasSum;
  pendingDeleteMode = 'full';

  const modal = document.getElementById('deleteConfirmModal');
  if (!modal) return;

  const titleEl = document.getElementById('deleteModalVideoTitle');
  const btnSumOnly = document.getElementById('btnDeleteOptionSummaryOnly');
  const fullTitleEl = document.getElementById('deleteOptionFullTitle');
  const fullDescEl = document.getElementById('deleteOptionFullDesc');

  if (titleEl) titleEl.textContent = title;

  if (hasSum) {
    if (btnSumOnly) btnSumOnly.classList.remove('hidden');
    if (fullTitleEl) fullTitleEl.innerHTML = `<span>목록도 같이 삭제 (전체 영구 삭제)</span><i class="ph-bold ph-caret-right text-xs"></i>`;
    if (fullDescEl) fullDescEl.textContent = "동영상 목록과 생성된 AI 요약 리포트를 모두 영구적으로 삭제합니다.";
  } else {
    if (btnSumOnly) btnSumOnly.classList.add('hidden');
    if (fullTitleEl) fullTitleEl.innerHTML = `<span>동영상 목록에서 영구 삭제</span><i class="ph-bold ph-caret-right text-xs"></i>`;
    if (fullDescEl) fullDescEl.textContent = "이 동영상을 채널 영상 목록에서 영구적으로 삭제합니다.";
  }

  backToDeleteStep1();
  modal.classList.remove('hidden');
}

function selectDeleteOption(mode) {
  pendingDeleteMode = mode; // 'summary_only' or 'full'
  const step1 = document.getElementById('deleteModalStep1');
  const step2 = document.getElementById('deleteModalStep2');
  const footer = document.getElementById('deleteModalFooter');
  const headerTitle = document.getElementById('deleteModalHeaderTitle');
  const headerSub = document.getElementById('deleteModalHeaderSub');
  const warnBox = document.getElementById('deleteStep2WarningBox');
  const actionLabel = document.getElementById('deleteStep2ActionLabel');
  const actionDesc = document.getElementById('deleteStep2ActionDesc');
  const confirmBtn = document.getElementById('btnConfirmFinalDelete');
  const confirmBtnText = document.getElementById('btnConfirmFinalDeleteText');

  if (step1) step1.classList.add('hidden');
  if (step2) step2.classList.remove('hidden');
  if (footer) footer.classList.add('hidden');

  if (headerTitle) headerTitle.textContent = "최종 삭제 확인";
  if (headerSub) headerSub.textContent = "실수로 삭제되지 않도록 한 번 더 확인합니다.";

  if (mode === 'summary_only') {
    if (warnBox) warnBox.className = "p-3.5 rounded-2xl bg-amber-950/40 border border-amber-500/40 text-xs space-y-1.5";
    if (actionLabel) {
      actionLabel.className = "font-bold text-amber-300 flex items-center gap-1.5";
      actionLabel.innerHTML = `<i class="ph-bold ph-warning-circle text-sm"></i><span>정말로 [요약 리포트만] 삭제하시겠습니까?</span>`;
    }
    if (actionDesc) {
      actionDesc.innerHTML = `생성된 AI 요약 리포트만 영구 삭제되며, 동영상은 <strong>미요약 상태</strong>로 목록에 그대로 유지됩니다.`;
    }
    if (confirmBtn) {
      confirmBtn.className = "px-4 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-lg shadow-amber-500/20 flex items-center gap-1.5 transition-all";
    }
    if (confirmBtnText) confirmBtnText.textContent = "네, 요약만 삭제합니다";
  } else {
    if (warnBox) warnBox.className = "p-3.5 rounded-2xl bg-red-950/40 border border-red-500/40 text-xs space-y-1.5";
    if (actionLabel) {
      actionLabel.className = "font-bold text-red-300 flex items-center gap-1.5";
      actionLabel.innerHTML = `<i class="ph-bold ph-warning-circle text-sm"></i><span>정말로 [목록까지 전체] 영구 삭제하시겠습니까?</span>`;
    }
    if (actionDesc) {
      actionDesc.innerHTML = pendingDeleteHasSummary
        ? `동영상 목록과 생성된 AI 요약 리포트가 <strong>모두 영구 삭제</strong>되며 복구할 수 없습니다.`
        : `이 동영상이 목록에서 <strong>영구 삭제</strong>되며 복구할 수 없습니다.`;
    }
    if (confirmBtn) {
      confirmBtn.className = "px-4 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/30 flex items-center gap-1.5 transition-all";
    }
    if (confirmBtnText) confirmBtnText.textContent = "네, 영구 삭제합니다";
  }
}

function backToDeleteStep1() {
  const step1 = document.getElementById('deleteModalStep1');
  const step2 = document.getElementById('deleteModalStep2');
  const footer = document.getElementById('deleteModalFooter');
  const headerTitle = document.getElementById('deleteModalHeaderTitle');
  const headerSub = document.getElementById('deleteModalHeaderSub');

  if (step1) step1.classList.remove('hidden');
  if (step2) step2.classList.add('hidden');
  if (footer) footer.classList.remove('hidden');
  if (headerTitle) headerTitle.textContent = "삭제 방식 선택";
  if (headerSub) headerSub.textContent = pendingDeleteHasSummary ? "요약만 지울지, 목록까지 함께 지울지 선택해주세요." : "원하시는 삭제 작업을 선택해주세요.";
}

function closeDeleteConfirmModal() {
  const modal = document.getElementById('deleteConfirmModal');
  if (modal) modal.classList.add('hidden');
  pendingDeleteVideoId = null;
}

async function executeConfirmedDelete() {
  const videoId = pendingDeleteVideoId;
  const isSummaryOnly = pendingDeleteMode === 'summary_only';
  if (!videoId) return;

  closeDeleteConfirmModal();

  try {
    showToast(isSummaryOnly ? "AI 요약 리포트를 삭제하는 중입니다..." : "동영상을 목록에서 삭제하는 중입니다...", "info");
    const q = isSummaryOnly ? '?summary_only=true' : '';
    const res = await fetch(`/api/videos/${encodeURIComponent(videoId)}${q}`, {
      method: 'DELETE'
    });
    const data = await res.json();

    if (data.status === 'success') {
      showToast(data.message || "삭제가 완료되었습니다.", "success");
      const summaryModal = document.getElementById('summaryModal');
      if (summaryModal && !summaryModal.classList.contains('hidden') && currentViewingSummary?.video_id === videoId) {
        closeSummaryModal();
      }
      await Promise.all([
        loadStatus(),
        loadVideosAndSummaries()
      ]);
    } else {
      showToast(data.message || "삭제 실패", "error");
    }
  } catch (err) {
    console.error("Delete video error:", err);
    showToast("삭제 요청 실패: " + err.message, "error");
  }
}

// Generate single summary
async function generateSingleSummary(videoId, detailLevel = null, promptStyle = null, showStartToast = true) {
  if (!videoId) return;
  if (localSummarizingVideoIds.has(videoId) && showStartToast) {
    return;
  }

  const effectiveDetailLevel = detailLevel || currentStatusData?.detail_level || "ultra_detailed";

  localSummarizingVideoIds.add(videoId);
  renderVideosTable();
  renderSpotlight();

  try {
    if (showStartToast) {
      showToast("AI 요약을 생성하는 중입니다...", "info");
    }
    const payload = { detail_level: effectiveDetailLevel };
    if (promptStyle) {
      payload.prompt_style = promptStyle;
    }

    const res = await fetch(`/api/summaries/generate/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.status === 'success') {
      localSummarizingVideoIds.delete(videoId);
      serverSummarizingVideoIds.delete(videoId);
      showToast("요약이 성공적으로 완료되었습니다!", "success");
      await Promise.all([
        loadStatus(),
        loadVideosAndSummaries()
      ]);
    } else {
      showToast("요약 생성 실패: " + (data.detail || "알 수 없는 오류"), "error");
    }
  } catch (err) {
    showToast("요약 요청 실패: " + err.message, "error");
  } finally {
    localSummarizingVideoIds.delete(videoId);
    serverSummarizingVideoIds.delete(videoId);
    renderVideosTable();
    renderSpotlight();
  }
}

// Resummarize video inside Modal with chosen detail level
async function resummarizeCurrentModalVideo() {
  if (!currentViewingSummary || !currentViewingSummary.video_id) return;
  const videoId = currentViewingSummary.video_id;
  const select = document.getElementById('modalDetailLevelSelect');
  const detailLevel = select ? select.value : 'ultra_detailed';

  const btn = document.getElementById('btnModalResummarize');
  const btnText = document.getElementById('modalResummarizeText');
  const btnIcon = document.getElementById('modalResummarizeIcon');

  btn.disabled = true;
  btn.classList.add('opacity-75');
  btnText.textContent = "AI 분석 생성 중...";
  btnIcon.className = "ph-bold ph-spinner-gap animate-spin";

  showToast(`선택하신 모드(${detailLevel})로 상세 AI 분석을 시작합니다...`, "info");

  try {
    const res = await fetch(`/api/summaries/generate/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail_level: detailLevel })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast("새로운 상세 분석 리포트가 생성되었습니다!", "success");
      await loadVideosAndSummaries();
      await openSummaryModal(videoId);
    } else {
      showToast("재요약 실패: " + (data.detail || "알 수 없는 오류"), "error");
    }
  } catch (err) {
    showToast("재요약 요청 실패: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove('opacity-75');
    btnText.textContent = "다시 요약하기";
    btnIcon.className = "ph-bold ph-arrows-clockwise";
  }
}

// Open Summary Detail Modal
async function openSummaryModal(videoId) {
  try {
    const res = await fetch(`/api/summaries/${videoId}`);
    if (!res.ok) throw new Error("요약 데이터를 찾을 수 없습니다.");
    const data = await res.json();
    currentViewingSummary = data;

    document.getElementById('modalTitle').textContent = data.title;
    document.getElementById('modalPubTime').textContent = data.published_time_text || '최근';
    document.getElementById('modalModelBadge').textContent = data.model_used || 'AI';
    const chContainer = document.getElementById('modalChannelContainer');
    if (chContainer) {
      chContainer.innerHTML = renderVideoChannelSelector(videoId, data.channel_id, data.channel_name, true);
    }
    document.getElementById('modalDuration').textContent = data.duration_text || '-';
    document.getElementById('modalViews').textContent = data.view_count_text || '-';
    document.getElementById('modalCreatedDate').textContent = `분석일시: ${data.created_at || '-'}`;
    document.getElementById('modalOneLinerHeader').textContent = data.one_line_summary || '';

    const thumb = data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    document.getElementById('modalThumbnail').src = thumb;
    document.getElementById('modalVideoLink').href = data.video_url || `https://www.youtube.com/watch?v=${videoId}`;

    // 24h Badge
    const badge = document.getElementById('modalBadge24h');
    if (data.is_within_24h == 1) {
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Render Markdown
    const mdContent = data.full_summary_md || `# ${data.title}\n\n${data.one_line_summary}`;
    document.getElementById('modalMarkdownContent').innerHTML = marked.parse(mdContent);

    // Render Bilingual Subtitles
    currentSubtitleMode = 'bilingual';
    renderBilingualSubtitles();
    document.getElementById('transcriptContentArea').classList.add('hidden');
    document.getElementById('transcriptControls').classList.add('hidden');
    document.getElementById('transcriptToggleIcon').className = "ph-bold ph-caret-down text-slate-400";

    // Show modal
    document.getElementById('summaryModal').classList.remove('hidden');
  } catch (err) {
    showToast("모달 열기 실패: " + err.message, "error");
  }
}

let currentSubtitleMode = 'bilingual';

function setSubtitleMode(mode) {
  currentSubtitleMode = mode;
  ['bilingual', 'ko', 'en'].forEach(m => {
    const btn = document.getElementById(`subBtn-${m}`);
    if (btn) {
      if (m === mode) {
        btn.className = "px-2 py-1 rounded font-medium bg-blue-600 text-white shadow-sm transition-all";
      } else {
        btn.className = "px-2 py-1 rounded font-medium text-slate-400 hover:text-white transition-all";
      }
    }
  });
  renderBilingualSubtitles();
}

function parseTimestampToSeconds(tsStr) {
  const parts = tsStr.replace(/[\[\]]/g, '').trim().split(':');
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  } else if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  }
  return 0;
}

function renderBilingualSubtitles() {
  const area = document.getElementById('transcriptContentArea');
  if (!area || !currentViewingSummary) return;

  const rawBilingual = currentViewingSummary.bilingual_transcript || "";
  const rawText = currentViewingSummary.transcript_raw || "";
  const videoId = currentViewingSummary.video_id;

  if (!rawBilingual && !rawText) {
    area.innerHTML = `<p class="py-4 text-center text-slate-500">등록된 자막 정보가 없습니다.</p>`;
    return;
  }

  // Parse bilingual format
  let blocks = [];
  if (rawBilingual && (rawBilingual.includes('(EN)') || rawBilingual.includes('(KO)'))) {
    const rawChunks = rawBilingual.split(/\n\s*\n/);
    for (const chunk of rawChunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      
      const tsMatch = trimmed.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
      const ts = tsMatch ? tsMatch[1] : "00:00";
      
      let en = "";
      let ko = "";
      
      const enMatch = trimmed.match(/\(EN\)\s*([\s\S]*?)(?=\(KO\)|\n\[|$)/);
      if (enMatch) en = enMatch[1].trim();
      
      const koMatch = trimmed.match(/\(KO\)\s*([\s\S]*?)(?=\(EN\)|\n\[|$)/);
      if (koMatch) ko = koMatch[1].trim();
      
      if (!en && !ko) {
        en = trimmed;
      }
      
      blocks.push({ ts, en, ko });
    }
  }

  // Fallback if blocks empty
  if (blocks.length === 0 && rawText) {
    const sentences = rawText.match(/[^.!?]+[.!?]+/g) || [rawText];
    blocks = sentences.map((s, idx) => ({
      ts: `00:${String(idx * 5).padStart(2, '0')}`,
      en: s.trim(),
      ko: "(한글 번역 생성 대기중 - 재요약 실행 시 완역 생성)"
    }));
  }

  // Render HTML based on currentSubtitleMode
  area.innerHTML = blocks.map(b => {
    const sec = parseTimestampToSeconds(b.ts);
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}&t=${sec}s`;

    let contentHtml = '';
    if (currentSubtitleMode === 'bilingual') {
      contentHtml = `
        ${b.en ? `<div class="text-slate-300 font-sans text-xs leading-relaxed flex items-start gap-2 mb-1.5"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30 flex-shrink-0">EN</span><span>${escapeHtml(b.en)}</span></div>` : ''}
        ${b.ko ? `<div class="text-emerald-300 font-sans text-xs leading-relaxed flex items-start gap-2"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex-shrink-0">KO</span><span>${escapeHtml(b.ko)}</span></div>` : ''}
      `;
    } else if (currentSubtitleMode === 'ko') {
      contentHtml = `
        <div class="text-slate-100 font-sans text-xs leading-relaxed flex items-start gap-2"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex-shrink-0">KO</span><span>${escapeHtml(b.ko || b.en)}</span></div>
      `;
    } else { // en
      contentHtml = `
        <div class="text-slate-300 font-sans text-xs leading-relaxed flex items-start gap-2"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30 flex-shrink-0">EN</span><span>${escapeHtml(b.en)}</span></div>
      `;
    }

    return `
      <div class="pt-3 first:pt-0 group hover:bg-slate-900/60 p-2 rounded-xl transition-colors">
        <div class="flex items-center gap-2 mb-1.5">
          <a href="${ytUrl}" target="_blank" title="유튜브 해당 시점으로 이동" class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-slate-800 text-blue-400 hover:bg-blue-600 hover:text-white border border-slate-700 transition-colors">
            <i class="ph ph-play-circle text-xs"></i> [${b.ts}]
          </a>
        </div>
        ${contentHtml}
      </div>
    `;
  }).join('');
}

function copyCurrentSubtitles() {
  if (!currentViewingSummary) return;
  const rawBilingual = currentViewingSummary.bilingual_transcript || currentViewingSummary.transcript_raw || "";
  navigator.clipboard.writeText(rawBilingual).then(() => {
    showToast("자막 전문이 클립보드에 복사되었습니다!", "success");
  });
}

function closeSummaryModal() {
  document.getElementById('summaryModal').classList.add('hidden');
  currentViewingSummary = null;
}

function toggleTranscriptView() {
  const area = document.getElementById('transcriptContentArea');
  const ctrl = document.getElementById('transcriptControls');
  const icon = document.getElementById('transcriptToggleIcon');
  if (area.classList.contains('hidden')) {
    area.classList.remove('hidden');
    if (ctrl) ctrl.classList.remove('hidden');
    icon.className = "ph-bold ph-caret-up text-slate-400";
    renderBilingualSubtitles();
  } else {
    area.classList.add('hidden');
    if (ctrl) ctrl.classList.add('hidden');
    icon.className = "ph-bold ph-caret-down text-slate-400";
  }
}

function copySummaryMarkdown() {
  if (!currentViewingSummary || !currentViewingSummary.full_summary_md) {
    showToast("복사할 마크다운이 없습니다.", "warning");
    return;
  }
  navigator.clipboard.writeText(currentViewingSummary.full_summary_md).then(() => {
    showToast("마크다운 전문이 클립보드에 복사되었습니다!", "success");
  });
}

function downloadSummaryMarkdown() {
  if (!currentViewingSummary || !currentViewingSummary.full_summary_md) {
    showToast("다운로드할 데이터가 없습니다.", "warning");
    return;
  }
  const blob = new Blob([currentViewingSummary.full_summary_md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const cleanTitle = (currentViewingSummary.title || "summary").replace(/[/\\?%*:|"<>]/g, '_');
  a.href = url;
  a.download = `ConstructIQ_${cleanTitle}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("마크다운 파일 다운로드가 시작되었습니다.", "success");
}

// Settings Load & Save
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    
    document.getElementById('settingScheduleTime').value = s.schedule_time || "09:00";
    document.getElementById('settingTimeFilter').value = s.time_filter_hours || "24";
    document.getElementById('settingChannelUrl').value = s.channel_url || "";
    document.getElementById('settingAutoEnabled').checked = (s.auto_run_enabled === 'true');
    
    const provRadios = document.getElementsByName('ai_provider');
    provRadios.forEach(r => {
      if (r.value === s.ai_provider) r.checked = true;
    });

    const detailRadios = document.getElementsByName('detail_level');
    const savedDetail = ['ultra_detailed', 'standard', 'brief'].includes(s.detail_level) ? s.detail_level : 'ultra_detailed';
    detailRadios.forEach(r => {
      if (r.value === savedDetail) r.checked = true;
    });
    const modalSelect = document.getElementById('modalDetailLevelSelect');
    if (modalSelect) {
      modalSelect.value = savedDetail;
    }

    if (s.gemini_api_key_masked) {
      document.getElementById('settingGeminiKey').placeholder = `저장됨 (${s.gemini_api_key_masked})`;
    }
    if (s.openai_api_key_masked) {
      document.getElementById('settingOpenaiKey').placeholder = `저장됨 (${s.openai_api_key_masked})`;
    }

    document.getElementById('settingGeminiModel').value = s.gemini_model || "gemini-3.8-flash";
    document.getElementById('settingOpenaiModel').value = s.openai_model || "gpt-4o-mini";
    document.getElementById('settingWebhookUrl').value = s.webhook_url || "";

    toggleAiInputs();
  } catch (err) {
    console.error("Settings load error:", err);
  }
}

function toggleAiInputs() {
  const selected = document.querySelector('input[name="ai_provider"]:checked')?.value || 'gemini';
  const gemBox = document.getElementById('geminiConfig');
  const oaiBox = document.getElementById('openaiConfig');

  if (selected === 'gemini') {
    gemBox.classList.remove('hidden');
    oaiBox.classList.add('hidden');
  } else if (selected === 'openai') {
    gemBox.classList.add('hidden');
    oaiBox.classList.remove('hidden');
  } else {
    gemBox.classList.add('hidden');
    oaiBox.classList.add('hidden');
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const provider = document.querySelector('input[name="ai_provider"]:checked')?.value || 'gemini';
  const detailLevel = document.querySelector('input[name="detail_level"]:checked')?.value || 'ultra_detailed';

  const payload = {
    schedule_time: document.getElementById('settingScheduleTime').value,
    time_filter_hours: document.getElementById('settingTimeFilter').value,
    channel_url: document.getElementById('settingChannelUrl').value,
    auto_run_enabled: document.getElementById('settingAutoEnabled').checked ? 'true' : 'false',
    ai_provider: provider,
    detail_level: detailLevel,
    gemini_model: document.getElementById('settingGeminiModel').value,
    openai_model: document.getElementById('settingOpenaiModel').value,
    webhook_url: document.getElementById('settingWebhookUrl').value
  };

  const gKey = document.getElementById('settingGeminiKey').value.trim();
  if (gKey) payload.gemini_api_key = gKey;

  const oKey = document.getElementById('settingOpenaiKey').value.trim();
  if (oKey) payload.openai_api_key = oKey;

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    showToast(data.message, "success");
    await loadStatus();
  } catch (err) {
    showToast("설정 저장 실패: " + err.message, "error");
  }
}

async function testAiKey(provider) {
  const keyInput = provider === 'gemini' ? document.getElementById('settingGeminiKey') : document.getElementById('settingOpenaiKey');
  const modelInput = provider === 'gemini' ? document.getElementById('settingGeminiModel') : document.getElementById('settingOpenaiModel');
  const key = keyInput.value.trim();

  const isSaved = keyInput.placeholder && keyInput.placeholder.includes("저장됨");
  if (!key && !isSaved) {
    showToast("테스트할 API Key를 입력해주세요.", "warning");
    return;
  }

  showToast(`${provider.toUpperCase()} API 연결 테스트 중...`, "info");
  try {
    const res = await fetch('/api/test_ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: provider,
        api_key: key || null,
        model: modelInput.value.trim()
      })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast(`연결 성공! 응답: ${data.response}`, "success");
    } else {
      showToast(`연결 실패: ${data.message}`, "error");
    }
  } catch (err) {
    showToast("테스트 요청 실패: " + err.message, "error");
  }
}

// Toast Notifications
function showToast(message, type = "info") {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  
  let bg = "bg-slate-800 border-slate-700 text-slate-200";
  let icon = "ph-info text-blue-400";
  if (type === "success") {
    bg = "bg-emerald-950 border-emerald-600 text-emerald-100";
    icon = "ph-check-circle text-emerald-400";
  } else if (type === "warning") {
    bg = "bg-amber-950 border-amber-600 text-amber-100";
    icon = "ph-warning text-amber-400";
  } else if (type === "error") {
    bg = "bg-red-950 border-red-600 text-red-100";
    icon = "ph-x-circle text-red-400";
  }

  toast.className = `flex items-center gap-2.5 px-4 py-3 rounded-2xl border shadow-xl text-xs pointer-events-auto transition-all duration-300 transform translate-y-2 opacity-0 ${bg}`;
  toast.innerHTML = `<i class="ph-bold ${icon} text-base flex-shrink-0"></i> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  // Animate in
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  // Animate out & remove
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
