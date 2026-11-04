import json
import requests
from typing import Dict, Any, Optional

def send_webhook_notification(webhook_url: str, summary_data: Dict[str, Any], video_data: Dict[str, Any]) -> bool:
    """
    Sends notification to Discord or Slack webhook when a new video is summarized.
    """
    if not webhook_url or not webhook_url.strip():
        return False
        
    url = webhook_url.strip()
    title = summary_data.get("title", "New Video Summary")
    one_liner = summary_data.get("one_line_summary", "")
    video_url = video_data.get("video_url", "")
    thumb = video_data.get("thumbnail_url", "")
    
    # Discord format
    if "discord.com" in url or "discordapp.com" in url:
        payload = {
            "content": f"📢 **[ConstructIQ 모니터링] 24시간 이내 신규 영상 요약 리포트 도착!**",
            "embeds": [
                {
                    "title": f"🏗️ {title}",
                    "url": video_url,
                    "description": one_liner[:500],
                    "color": 3447003, # Blue
                    "thumbnail": {"url": thumb} if thumb else None,
                    "fields": [
                        {"name": "📺 재생 시간", "value": video_data.get("duration_text", "N/A"), "inline": True},
                        {"name": "⏰ 게시 시점", "value": video_data.get("published_time_text", "N/A"), "inline": True},
                        {"name": "🤖 요약 모델", "value": summary_data.get("model_used", "AI"), "inline": True}
                    ],
                    "footer": {"text": "ConstructIQ Daily Summary Bot"}
                }
            ]
        }
    # Slack or generic webhook format
    else:
        payload = {
            "text": f"*[ConstructIQ 신규 영상 요약]*\n*{title}*\n{one_liner}\n영상 링크: {video_url}"
        }
        
    try:
        resp = requests.post(url, json=payload, timeout=10)
        return resp.status_code in [200, 204]
    except Exception as e:
        print(f"Error sending webhook notification: {e}")
        return False
