import os
import sys
from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Dict, Any, Optional, List

from backend.database import (
    init_db, get_settings, update_settings, sync_videos_to_db,
    get_filtered_videos, get_recent_summaries, get_summary_by_video_id,
    get_recent_runs, save_summary, get_db,
    get_channels, get_channel_by_id, get_default_channel,
    add_channel, update_channel, delete_channel,
    save_custom_video, get_video_by_id, delete_video, delete_summary_only,
    get_custom_categories, add_custom_category, update_custom_category,
    delete_custom_category, update_video_category,
    update_video_channel, batch_update_videos_channel
)
from backend.youtube_scraper import (
    fetch_channel_videos, fetch_channel_info_and_videos, fetch_video_transcript,
    extract_video_id, fetch_single_video_metadata
)
from backend.ai_summarizer import summarize_video, call_gemini_api, call_openai_api
from backend.scheduler import (
    init_scheduler, apply_schedule, run_investigation_and_summary,
    get_scheduler_status, _is_running_job
)
import threading

app = FastAPI(title="Youtube AI Digest")

# Track video IDs currently undergoing single-video AI summarization
_summarizing_videos = set()

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

def sync_channel_videos_now(channel_id: Optional[int] = None) -> List[Dict[str, Any]]:
    settings = get_settings()
    time_filter_hours = float(settings.get("time_filter_hours", "24"))
    
    if channel_id is not None:
        ch = get_channel_by_id(channel_id)
        if not ch:
            raise ValueError(f"Channel ID {channel_id} not found.")
        target_channels = [ch]
    else:
        target_channels = get_channels()
        if not target_channels:
            target_channels = []

    all_synced_videos = []
    for ch in target_channels:
        vids = fetch_channel_videos(channel_url=ch["channel_url"], max_hours=time_filter_hours)
        sync_videos_to_db(vids, channel_id=ch["id"], channel_name=ch["name"])
        all_synced_videos.extend(vids)
    return all_synced_videos

# Initialize database and scheduler on startup
@app.on_event("startup")
def startup_event():
    init_db()
    init_scheduler()
    print("[App] Backend initialized successfully.")
    # Background initial channel video sync
    def initial_sync():
        try:
            chs = get_channels()
            if not chs:
                print("[App] 등록된 유튜브 채널이 없습니다. 대시보드에서 채널을 추가해 주세요.")
                return
            print("[App] Running initial YouTube channel videos sync...")
            vids = sync_channel_videos_now()
            print(f"[App] Initial sync complete. Cached {len(vids)} videos.")
        except Exception as e:
            print(f"[App] Initial sync warning: {e}")
    threading.Thread(target=initial_sync, daemon=True).start()

# Pydantic models
class SettingsUpdate(BaseModel):
    channel_url: Optional[str] = None
    schedule_time: Optional[str] = None
    time_filter_hours: Optional[str] = None
    ai_provider: Optional[str] = None
    gemini_api_key: Optional[str] = None
    gemini_model: Optional[str] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None
    detail_level: Optional[str] = None
    webhook_url: Optional[str] = None
    auto_run_enabled: Optional[str] = None

class ChannelCreateRequest(BaseModel):
    channel_url: str
    name: Optional[str] = None
    prompt_style: Optional[str] = "general"
    auto_sync: Optional[int] = 1

class ChannelUpdateRequest(BaseModel):
    name: Optional[str] = None
    channel_url: Optional[str] = None
    prompt_style: Optional[str] = None
    auto_sync: Optional[int] = None
    is_default: Optional[int] = None

class QuickGeminiKeyUpdate(BaseModel):
    gemini_api_key: str
    detail_level: Optional[str] = "ultra_detailed"
    gemini_model: Optional[str] = "gemini-3.8-flash"

class GenerateSummaryRequest(BaseModel):
    provider: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    detail_level: Optional[str] = None
    prompt_style: Optional[str] = None

class AddSingleVideoRequest(BaseModel):
    url: str
    channel_id: Optional[int] = None
    prompt_style: Optional[str] = "construction"
    custom_category: Optional[str] = ""
    generate_summary_now: Optional[bool] = True

class CustomCategoryRequest(BaseModel):
    name: str

class VideoCategoryUpdateRequest(BaseModel):
    custom_category: Optional[str] = ""

class VideoChannelUpdateRequest(BaseModel):
    channel_id: int

class VideoBatchChannelUpdateRequest(BaseModel):
    video_ids: List[str]
    channel_id: int


class TestAIRequest(BaseModel):
    provider: str
    api_key: Optional[str] = None
    model: Optional[str] = None

# Channel Management Endpoints
@app.get("/api/channels")
def api_get_channels():
    return get_channels()

@app.post("/api/channels")
def api_add_channel(req: ChannelCreateRequest):
    try:
        settings = get_settings()
        time_filter_hours = float(settings.get("time_filter_hours", "24"))
        info = fetch_channel_info_and_videos(
            channel_url=req.channel_url.strip(),
            max_hours=time_filter_hours,
            max_pages=5
        )
        final_name = (req.name or "").strip() or info["name"]
        ch = add_channel(
            name=final_name,
            handle=info["handle"],
            channel_url=info["channel_url"],
            prompt_style=req.prompt_style or "general",
            auto_sync=1 if req.auto_sync is None else int(req.auto_sync)
        )
        sync_videos_to_db(info["videos"], channel_id=ch["id"], channel_name=final_name)
        updated_ch = get_channel_by_id(ch["id"])
        return {
            "status": "success",
            "channel": updated_ch,
            "videos_synced": len(info["videos"]),
            "message": f"'{final_name}' ({info['handle']}) 채널이 등록되었으며 최신 영상 {len(info['videos'])}개를 동기화했습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"채널 등록 및 영상 수집 실패: {str(e)}"}

@app.put("/api/channels/{channel_id}")
def api_update_channel(channel_id: int, req: ChannelUpdateRequest):
    try:
        updates = {k: v for k, v in req.dict().items() if v is not None}
        updated = update_channel(channel_id, updates)
        if not updated:
            raise HTTPException(status_code=404, detail="채널을 찾을 수 없습니다.")
        return {"status": "success", "channel": updated, "message": f"'{updated['name']}' 채널 설정이 업데이트되었습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.delete("/api/channels/{channel_id}")
def api_delete_channel(channel_id: int):
    try:
        delete_channel(channel_id)
        return {"status": "success", "message": "채널이 삭제되었습니다 (작성된 요약 리포트는 안전하게 보관됩니다)."}
    except ValueError as ve:
        return {"status": "error", "message": str(ve)}
    except Exception as e:
        return {"status": "error", "message": f"채널 삭제 실패: {str(e)}"}

# API Endpoints
@app.get("/api/status")
def api_status(channel_id: Optional[int] = None):
    status = get_scheduler_status()
    settings = get_settings()
    channels = get_channels()
    default_ch = get_default_channel() or {}
    
    with get_db() as conn:
        cursor = conn.cursor()
        if channel_id is not None:
            cursor.execute("""
            SELECT COUNT(*) as cnt FROM summaries s 
            JOIN videos v ON s.video_id = v.video_id 
            WHERE s.status = 'completed' AND v.channel_id = ?
            """, (channel_id,))
            completed_count = cursor.fetchone()["cnt"]
            cursor.execute("SELECT COUNT(*) as cnt FROM videos WHERE is_within_24h = 1 AND channel_id = ?", (channel_id,))
            recent_count = cursor.fetchone()["cnt"]
        else:
            cursor.execute("SELECT COUNT(*) as cnt FROM summaries WHERE status = 'completed'")
            completed_count = cursor.fetchone()["cnt"]
            cursor.execute("SELECT COUNT(*) as cnt FROM videos WHERE is_within_24h = 1")
            recent_count = cursor.fetchone()["cnt"]
        
    return {
        "scheduler": status,
        "channels": channels,
        "default_channel": default_ch,
        "channel_url": default_ch.get("channel_url", "") or settings.get("channel_url", ""),
        "time_filter_hours": settings.get("time_filter_hours", "24"),
        "ai_provider": settings.get("ai_provider", "gemini"),
        "detail_level": settings.get("detail_level", "ultra_detailed"),
        "gemini_model": settings.get("gemini_model", "gemini-3.8-flash"),
        "has_gemini_key": bool(settings.get("gemini_api_key")),
        "has_openai_key": bool(settings.get("openai_api_key")),
        "completed_summaries_count": completed_count,
        "recent_videos_count": recent_count,
        "summarizing_video_ids": list(_summarizing_videos),
        "custom_categories": get_custom_categories()
    }

@app.post("/api/save_gemini_key")
def api_save_gemini_key(req: QuickGeminiKeyUpdate):
    updates = {
        "gemini_api_key": req.gemini_api_key.strip(),
        "ai_provider": "gemini",
        "detail_level": req.detail_level or "ultra_detailed",
        "gemini_model": req.gemini_model or "gemini-3.8-flash"
    }
    update_settings(updates)
    return {"status": "success", "message": "Gemini API Key와 초정밀 분석 설정이 성공적으로 저장되었습니다."}

@app.get("/api/videos")
def api_videos(
    refresh: bool = False,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    only_summarized: bool = False,
    include_all_summarized: bool = True,
    channel_id: Optional[int] = None
):
    if refresh:
        try:
            sync_channel_videos_now(channel_id=channel_id)
        except Exception as e:
            print(f"[API] Video refresh failed: {e}")

    rows = get_filtered_videos(
        start_date=start_date,
        end_date=end_date,
        only_summarized=only_summarized,
        include_all_summarized=include_all_summarized,
        channel_id=channel_id,
        limit=1000
    )
    
    # If DB is completely empty and no filters were given, auto sync once
    if not rows and not start_date and not end_date:
        try:
            sync_channel_videos_now(channel_id=channel_id)
            rows = get_filtered_videos(
                start_date=start_date,
                end_date=end_date,
                only_summarized=only_summarized,
                include_all_summarized=include_all_summarized,
                channel_id=channel_id,
                limit=1000
            )
        except Exception as e:
            print(f"[API] Auto initial sync failed: {e}")
            
    return rows

@app.post("/api/videos/sync")
def api_sync_videos(channel_id: Optional[int] = None):
    try:
        ch_name = "전체 등록 채널"
        if channel_id is not None:
            ch = get_channel_by_id(channel_id)
            if ch:
                ch_name = ch["name"]
        videos = sync_channel_videos_now(channel_id=channel_id)
        recent_count = len([v for v in videos if v.get("is_within_24h")])
        return {
            "status": "success",
            "message": f"[{ch_name}] 최신 {len(videos)}개 영상을 동기화했습니다 (24시간 이내 신규: {recent_count}개).",
            "total": len(videos),
            "within_24h": recent_count,
            "videos": videos
        }
    except Exception as e:
        return {"status": "error", "message": f"유튜브 동영상 목록 동기화 실패: {str(e)}"}

@app.post("/api/videos/add-single")
def api_add_single_video(req: AddSingleVideoRequest):
    try:
        raw_url = req.url.strip()
        vid = extract_video_id(raw_url)
        if not vid:
            return {"status": "error", "message": "유효한 유튜브 영상 링크(URL) 또는 11자리 비디오 ID가 아닙니다."}
            
        # Check if already registered in DB
        existing_video = get_video_by_id(vid)
        if existing_video:
            ch_label = existing_video.get("channel_name") or "목록"
            return {
                "status": "duplicate",
                "video": existing_video,
                "message": f"이미 등록된 동영상입니다!\n\n- 제목: {existing_video.get('title')}\n- 소속 채널: {ch_label}"
            }

        # 1. Fetch metadata
        meta = fetch_single_video_metadata(vid)
        
        # 2. Determine prompt_style and target channel
        target_ch_id = req.channel_id
        selected_style = req.prompt_style
        
        if target_ch_id is not None:
            ch_info = get_channel_by_id(target_ch_id)
            if ch_info and not selected_style:
                selected_style = ch_info.get("prompt_style") or "general"
                
        # 3. Save into DB
        saved_video = save_custom_video(
            video=meta,
            target_channel_id=target_ch_id,
            prompt_style=selected_style or "general",
            custom_category=req.custom_category
        )
        
        # 4. Optional immediate AI summary generation
        summary_result = None
        if req.generate_summary_now:
            settings = get_settings()
            style_to_use = selected_style or "general"
            ai_provider = settings.get("ai_provider", "gemini")
            api_key = settings.get("gemini_api_key", "") if ai_provider == "gemini" else settings.get("openai_api_key", "")
            model_name = settings.get("gemini_model", "gemini-3.8-flash") if ai_provider == "gemini" else settings.get("openai_model", "gpt-4o-mini")
            detail_level = settings.get("detail_level", "ultra_detailed")
            
            try:
                transcript_data = fetch_video_transcript(vid)
                summary_result = summarize_video(
                    video_info=saved_video,
                    transcript_data=transcript_data,
                    ai_provider=ai_provider,
                    api_key=api_key,
                    model_name=model_name,
                    detail_level=detail_level,
                    prompt_style=style_to_use
                )
                summary_result["video_id"] = vid
                summary_result["transcript_raw"] = transcript_data.get("full_text", "")
                save_summary(summary_result)
            except Exception as sum_err:
                print(f"[API] Error summarizing video {vid}: {sum_err}")
                return {
                    "status": "partial_success",
                    "video": saved_video,
                    "message": f"동영상 '{saved_video.get('title')}'이(가) 등록되었으나 요약 생성 중 오류가 발생했습니다: {str(sum_err)}"
                }
                
        return {
            "status": "success",
            "video": saved_video,
            "has_summary": bool(summary_result),
            "summary": summary_result,
            "message": f"동영상 '{saved_video.get('title')}'이(가) 성공적으로 등록{' 및 AI 상세 요약 완료' if summary_result else ''}되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"개별 동영상 등록 실패: {str(e)}"}

@app.delete("/api/videos/{video_id}")
def api_delete_video(video_id: str, summary_only: Optional[bool] = False):
    try:
        vid_info = get_video_by_id(video_id)
        title = vid_info.get("title") if vid_info else video_id
        if summary_only:
            delete_summary_only(video_id)
            return {
                "status": "success",
                "summary_only": True,
                "message": f"'{title}'의 AI 요약 리포트만 삭제되었습니다. (영상 목록은 유지됨)"
            }
        else:
            delete_video(video_id)
            return {
                "status": "success",
                "summary_only": False,
                "message": f"동영상 '{title}'이(가) 목록 및 요약에서 영구 삭제되었습니다."
            }
    except Exception as e:
        return {"status": "error", "message": f"삭제 실패: {str(e)}"}

@app.put("/api/videos/{video_id}/category")
def api_update_video_category(video_id: str, req: VideoCategoryUpdateRequest):
    try:
        updated = update_video_category(video_id, req.custom_category or "")
        if not updated:
            return {"status": "error", "message": "해당 동영상을 찾을 수 없습니다."}
        cat_label = updated.get("custom_category") or "미분류"
        return {
            "status": "success",
            "video": updated,
            "custom_categories": get_custom_categories(),
            "message": f"분류가 '{cat_label}'(으)로 변경되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"분류 변경 실패: {str(e)}"}

@app.put("/api/videos/{video_id}/channel")
def api_update_video_channel(video_id: str, req: VideoChannelUpdateRequest):
    try:
        updated = update_video_channel(video_id, req.channel_id)
        if not updated:
            return {"status": "error", "message": "해당 동영상을 찾을 수 없습니다."}
        ch_label = updated.get("channel_name") or "소속 채널"
        return {
            "status": "success",
            "video": updated,
            "channels": get_channels(),
            "message": f"소속 채널이 '{ch_label}'(으)로 변경되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"채널 변경 실패: {str(e)}"}

@app.put("/api/videos/batch/channel")
def api_batch_update_video_channel(req: VideoBatchChannelUpdateRequest):
    try:
        count = batch_update_videos_channel(req.video_ids, req.channel_id)
        return {
            "status": "success",
            "updated_count": count,
            "channels": get_channels(),
            "message": f"{count}개 동영상의 소속 채널이 변경되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"일괄 채널 변경 실패: {str(e)}"}


@app.get("/api/custom-categories")
def api_get_custom_categories():
    return get_custom_categories()

@app.post("/api/custom-categories")
def api_add_custom_category(req: CustomCategoryRequest):
    try:
        cat = add_custom_category(req.name)
        return {
            "status": "success",
            "category": cat,
            "custom_categories": get_custom_categories(),
            "message": f"'{cat['name']}' 분류 카테고리가 추가되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.put("/api/custom-categories/{cat_id}")
def api_update_custom_category(cat_id: int, req: CustomCategoryRequest):
    try:
        updated = update_custom_category(cat_id, req.name)
        if not updated:
            return {"status": "error", "message": "해당 카테고리를 찾을 수 없습니다."}
        return {
            "status": "success",
            "category": updated,
            "custom_categories": get_custom_categories(),
            "message": f"카테고리 이름이 '{updated['name']}'(으)로 변경되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.delete("/api/custom-categories/{cat_id}")
def api_delete_custom_category(cat_id: int):
    try:
        ok = delete_custom_category(cat_id)
        if not ok:
            return {"status": "error", "message": "해당 카테고리를 찾을 수 없습니다."}
        return {
            "status": "success",
            "custom_categories": get_custom_categories(),
            "message": "카테고리가 삭제되었습니다 (해당 분류의 영상은 '미분류'로 전환되었습니다)."
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/summaries")
def api_summaries(limit: int = 100, channel_id: Optional[int] = None):
    return get_recent_summaries(limit=limit, channel_id=channel_id)

@app.get("/api/summaries/{video_id}")
def api_summary_detail(video_id: str):
    res = get_summary_by_video_id(video_id)
    if not res:
        raise HTTPException(status_code=404, detail="Summary not found for this video")
    return res

@app.post("/api/summaries/generate/{video_id}")
def api_generate_single_summary(video_id: str, req: Optional[GenerateSummaryRequest] = None):
    """
    Forces immediate summarization of a specific video with custom detail_level and provider.
    """
    _summarizing_videos.add(video_id)
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT v.*, COALESCE(c.name, v.channel_name, 'YouTube 채널') as channel_name,
                   COALESCE(c.prompt_style, 'construction') as prompt_style
            FROM videos v
            LEFT JOIN channels c ON v.channel_id = c.id
            WHERE v.video_id = ?
            """, (video_id,))
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Video metadata not found")
            video = dict(row)
            
        settings = get_settings()
        
        ai_provider = (req and req.provider) or settings.get("ai_provider", "gemini")
        detail_level = (req and req.detail_level) or settings.get("detail_level", "ultra_detailed")
        prompt_style = (req and req.prompt_style) or video.get("prompt_style", "construction")
        
        gemini_key = (req and req.api_key) if ai_provider == "gemini" else settings.get("gemini_api_key", "")
        openai_key = (req and req.api_key) if ai_provider == "openai" else settings.get("openai_api_key", "")
        
        # If req didn't specify api_key, use saved key
        if not gemini_key:
            gemini_key = settings.get("gemini_api_key", "")
        if not openai_key:
            openai_key = settings.get("openai_api_key", "")
            
        gemini_model = (req and req.model) or settings.get("gemini_model", "gemini-3.8-flash")
        openai_model = (req and req.model) or settings.get("openai_model", "gpt-4o-mini")
        
        api_key = gemini_key if ai_provider == "gemini" else openai_key
        model_name = gemini_model if ai_provider == "gemini" else openai_model
        
        transcript_data = fetch_video_transcript(video_id)
        summary_result = summarize_video(
            video_info=video,
            transcript_data=transcript_data,
            ai_provider=ai_provider,
            api_key=api_key,
            model_name=model_name,
            detail_level=detail_level,
            prompt_style=prompt_style
        )
        summary_result["video_id"] = video_id
        summary_result["transcript_raw"] = transcript_data.get("full_text", "")
        save_summary(summary_result)
        
        return {"status": "success", "summary": summary_result}
    finally:
        _summarizing_videos.discard(video_id)

@app.post("/api/run")
def api_run_now(background_tasks: BackgroundTasks, channel_id: Optional[int] = None):
    global _is_running_job
    if _is_running_job:
        return {"status": "busy", "message": "작업이 이미 백그라운드에서 실행 중입니다."}
        
    background_tasks.add_task(run_investigation_and_summary, triggered_by="manual", channel_id=channel_id)
    if channel_id is not None:
        ch = get_channel_by_id(channel_id)
        ch_label = ch["name"] if ch else "선택 채널"
        return {"status": "started", "message": f"[{ch_label}] 채널 조사 및 24시간 이내 영상 요약 작업이 시작되었습니다."}
    return {"status": "started", "message": "등록된 모든 활성 채널 조사 및 24시간 이내 영상 요약 작업이 시작되었습니다."}

@app.get("/api/settings")
def api_get_settings():
    s = get_settings()
    # Mask API keys for safety in UI
    masked = dict(s)
    if masked.get("gemini_api_key"):
        key = masked["gemini_api_key"]
        masked["gemini_api_key_masked"] = key[:6] + "..." + key[-4:] if len(key) > 10 else "***"
    if masked.get("openai_api_key"):
        key = masked["openai_api_key"]
        masked["openai_api_key_masked"] = key[:6] + "..." + key[-4:] if len(key) > 10 else "***"
    return masked

@app.post("/api/settings")
def api_update_settings(updates: SettingsUpdate):
    data = {k: v for k, v in updates.dict().items() if v is not None}
    update_settings(data)
    apply_schedule()
    return {"status": "success", "message": "설정이 성공적으로 저장되었으며 스케줄이 갱신되었습니다."}

@app.get("/api/runs")
def api_runs(limit: int = 20):
    return get_recent_runs(limit=limit)

@app.post("/api/test_ai")
def api_test_ai(req: TestAIRequest):
    try:
        settings = get_settings()
        api_key = req.api_key.strip() if req.api_key else ""
        if not api_key:
            api_key = settings.get(f"{req.provider}_api_key") or ""
        
        if not api_key:
            return {"status": "error", "message": f"{req.provider.upper()} API 키가 입력되거나 저장되어 있지 않습니다."}

        if req.provider == "gemini":
            model_to_use = req.model or settings.get("gemini_model") or "gemini-3.8-flash"
            res = call_gemini_api(api_key, model_to_use, "Say 'Gemini API connection successful!' in Korean.")
            return {"status": "success", "response": res.strip()}
        elif req.provider == "openai":
            model_to_use = req.model or settings.get("openai_model") or "gpt-4o-mini"
            res = call_openai_api(api_key, model_to_use, "Say 'OpenAI API connection successful!' in Korean.")
            return {"status": "success", "response": res.strip()}
        else:
            return {"status": "error", "message": "Unknown provider"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/export-offline")
def api_export_offline():
    try:
        from backend.offline_exporter import export_offline_viewer, get_offline_data
        export_offline_viewer()
        data = get_offline_data()
        cnt = len(data.get("summaries", []))
        return {
            "status": "success",
            "count": cnt,
            "file": "offline_viewer.html",
            "exported_at": data.get("exported_at"),
            "message": f"오프라인 뷰어(offline_viewer.html)가 최신 {cnt}개 요약 리포트로 갱신되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"오프라인 뷰어 내보내기 실패: {str(e)}"}

@app.get("/offline-viewer")
def serve_offline_viewer():
    from backend.offline_exporter import OUTPUT_HTML_PATH, export_offline_viewer
    if not os.path.exists(OUTPUT_HTML_PATH):
        export_offline_viewer()
    return FileResponse(OUTPUT_HTML_PATH, media_type="text/html")

# Serve frontend static files
frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

@app.get("/")
def serve_index():
    return FileResponse(os.path.join(frontend_dir, "index.html"))

if __name__ == "__main__":
    import uvicorn
    import argparse
    import socket

    def find_available_port(preferred_port: int, max_tries: int = 50) -> int:
        for p in range(preferred_port, preferred_port + max_tries):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(("127.0.0.1", p))
                    return p
            except OSError:
                continue
        return preferred_port

    parser = argparse.ArgumentParser(description="Youtube AI Digest")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8070)), help="Port to run the server on")
    args, _ = parser.parse_known_args()

    port = find_available_port(args.port)
    if port != args.port:
        print(f"[App] 포트 {args.port}이(가) 이미 사용 중입니다. 사용 가능한 포트 {port}번으로 전환하여 시작합니다.")
    else:
        print(f"[App] 포트 {port}번으로 서버를 시작합니다.")

    os.environ["PORT"] = str(port)
    uvicorn.run("app:app", host="127.0.0.1", port=port, reload=False)
