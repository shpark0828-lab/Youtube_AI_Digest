import threading
import time
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from backend.database import (
    get_settings, update_settings, save_video, sync_videos_to_db,
    save_summary, log_run, get_summary_by_video_id, get_recent_runs,
    get_channels, get_channel_by_id
)
from backend.youtube_scraper import fetch_channel_videos, fetch_video_transcript
from backend.ai_summarizer import summarize_video
from backend.notification import send_webhook_notification

_scheduler: Optional[BackgroundScheduler] = None
_is_running_job = False
_lock = threading.Lock()

def run_investigation_and_summary(triggered_by: str = "schedule", channel_id: Optional[int] = None) -> Dict[str, Any]:
    """
    Main job that:
    1. Reads settings and target channel(s)
    2. Fetches channel videos
    3. Filters videos uploaded within time_filter_hours (default 24h)
    4. For each recent video, fetches transcript and generates detailed summary
    5. Saves to DB and sends notifications
    """
    global _is_running_job
    with _lock:
        if _is_running_job:
            return {"status": "busy", "message": "Job is already running."}
        _is_running_job = True

    try:
        settings = get_settings()
        time_filter_hours = float(settings.get("time_filter_hours", "24"))
        ai_provider = settings.get("ai_provider", "gemini")
        gemini_api_key = settings.get("gemini_api_key", "")
        gemini_model = settings.get("gemini_model", "gemini-3.8-flash")
        openai_api_key = settings.get("openai_api_key", "")
        openai_model = settings.get("openai_model", "gpt-4o-mini")
        webhook_url = settings.get("webhook_url", "")
        detail_level = settings.get("detail_level", "ultra_detailed")
        
        api_key = gemini_api_key if ai_provider == "gemini" else openai_api_key
        model_name = gemini_model if ai_provider == "gemini" else openai_model

        # Determine target channels
        if channel_id is not None:
            ch = get_channel_by_id(channel_id)
            target_channels = [ch] if ch else []
        else:
            all_ch = get_channels()
            if triggered_by == "schedule":
                target_channels = [c for c in all_ch if c.get("auto_sync", 1) == 1]
            else:
                target_channels = all_ch

        if not target_channels:
            target_channels = [{
                "id": 1,
                "name": "ConstructIQ",
                "handle": "@ConstructIQ",
                "channel_url": settings.get("channel_url", "https://www.youtube.com/@ConstructIQ/videos"),
                "prompt_style": "construction"
            }]

        grand_total_found = 0
        grand_within_24h = 0
        grand_summarized = 0
        newly_summarized = []
        channel_names = []

        for ch in target_channels:
            ch_id = ch["id"]
            ch_name = ch["name"]
            ch_url = ch["channel_url"]
            ch_prompt_style = ch.get("prompt_style", "construction")
            channel_names.append(ch_name)

            print(f"[{datetime.now()}] Starting YouTube investigation for [{ch_name}] ({ch_url}, filter <= {time_filter_hours}h)...")
            videos = fetch_channel_videos(channel_url=ch_url, max_hours=time_filter_hours)
            total_found = len(videos)
            grand_total_found += total_found

            # Save and synchronize all found videos for this channel
            sync_videos_to_db(videos, channel_id=ch_id, channel_name=ch_name)

            recent_videos = [v for v in videos if v["is_within_24h"]]
            within_24h_count = len(recent_videos)
            grand_within_24h += within_24h_count

            print(f"[{ch_name}] Found {total_found} videos, {within_24h_count} within {time_filter_hours}h.")

            for video in recent_videos:
                vid = video["video_id"]
                video["channel_id"] = ch_id
                video["channel_name"] = ch_name
                video["prompt_style"] = ch_prompt_style
                existing = get_summary_by_video_id(vid)

                # If not yet summarized or status not completed
                if not existing or existing.get("status") != "completed":
                    print(f"[{ch_name}] Summarizing new video: [{vid}] {video['title']}")
                    transcript_data = fetch_video_transcript(vid)
                    summary_result = summarize_video(
                        video_info=video,
                        transcript_data=transcript_data,
                        ai_provider=ai_provider,
                        api_key=api_key,
                        model_name=model_name,
                        detail_level=detail_level,
                        prompt_style=ch_prompt_style
                    )
                    summary_result["video_id"] = vid
                    summary_result["transcript_raw"] = transcript_data.get("full_text", "")
                    save_summary(summary_result)
                    grand_summarized += 1
                    newly_summarized.append(summary_result)

                    # Send webhook notification if configured
                    if webhook_url:
                        send_webhook_notification(webhook_url, summary_result, video)
                else:
                    print(f"[{ch_name}] Video [{vid}] already summarized. Skipping.")

        ch_label = ", ".join(channel_names)
        msg = f"[{ch_label}] 검사 완료: 총 {grand_total_found}개 영상 탐지, {grand_within_24h}개 {int(time_filter_hours)}시간 이내 영상, {grand_summarized}개 신규 요약 생성됨."
        if grand_within_24h == 0:
            msg += " (최근 24시간 이내 새 영상이 없습니다)"

        log_run({
            "triggered_by": triggered_by,
            "videos_found_total": grand_total_found,
            "videos_within_24h": grand_within_24h,
            "videos_summarized": grand_summarized,
            "status": "success",
            "message": msg,
            "channel_id": channel_id,
            "channel_name": ch_label
        })

        return {
            "status": "success",
            "message": msg,
            "total_found": grand_total_found,
            "within_24h_count": grand_within_24h,
            "summarized_count": grand_summarized,
            "newly_summarized": newly_summarized
        }
    except Exception as e:
        error_msg = f"조사 및 요약 중 오류 발생: {str(e)}"
        print(error_msg)
        log_run({
            "triggered_by": triggered_by,
            "videos_found_total": 0,
            "videos_within_24h": 0,
            "videos_summarized": 0,
            "status": "failed",
            "message": error_msg,
            "channel_id": channel_id,
            "channel_name": "오류"
        })
        return {
            "status": "failed",
            "message": error_msg
        }
    finally:
        with _lock:
            _is_running_job = False

def init_scheduler():
    """
    Initializes and starts the background scheduler according to saved settings.
    Default: Daily at 09:00 AM.
    """
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        return _scheduler
        
    _scheduler = BackgroundScheduler()
    apply_schedule()
    _scheduler.start()
    print("[Scheduler] APScheduler started.")
    return _scheduler

def apply_schedule():
    """
    Reads schedule_time from DB settings and applies or updates the cron job.
    """
    global _scheduler
    if _scheduler is None:
        return
        
    settings = get_settings()
    sched_time = settings.get("schedule_time", "09:00")
    auto_enabled = settings.get("auto_run_enabled", "true").lower() == "true"
    
    try:
        parts = sched_time.strip().split(":")
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    except Exception:
        hour, minute = 9, 0
        
    # Remove existing job if present
    if _scheduler.get_job("daily_youtube_summary"):
        _scheduler.remove_job("daily_youtube_summary")
        
    if auto_enabled:
        _scheduler.add_job(
            run_investigation_and_summary,
            trigger=CronTrigger(hour=hour, minute=minute),
            id="daily_youtube_summary",
            name=f"Daily YouTube Summary at {hour:02d}:{minute:02d}",
            replace_existing=True,
            kwargs={"triggered_by": "schedule"}
        )
        print(f"[Scheduler] Daily job scheduled for {hour:02d}:{minute:02d} every day.")
    else:
        print("[Scheduler] Auto-run is disabled.")

def get_scheduler_status() -> Dict[str, Any]:
    global _scheduler, _is_running_job
    settings = get_settings()
    sched_time = settings.get("schedule_time", "09:00")
    auto_enabled = settings.get("auto_run_enabled", "true").lower() == "true"
    
    next_run = None
    if _scheduler and _scheduler.running:
        job = _scheduler.get_job("daily_youtube_summary")
        if job and job.next_run_time:
            next_run = job.next_run_time.strftime("%Y-%m-%d %H:%M:%S")
            
    recent_runs = get_recent_runs(1)
    last_run = recent_runs[0] if recent_runs else None
    
    return {
        "scheduler_running": _scheduler.running if _scheduler else False,
        "is_busy": _is_running_job,
        "auto_enabled": auto_enabled,
        "schedule_time": sched_time,
        "next_run_time": next_run,
        "last_run": last_run
    }
