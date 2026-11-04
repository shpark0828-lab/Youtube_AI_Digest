import re
import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from youtube_transcript_api import YouTubeTranscriptApi

DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def parse_relative_time_to_hours(time_str: str) -> Optional[float]:
    """
    Parses strings like '23 hours ago', '1 day ago', '35 minutes ago', '5시간 전', etc.
    Returns estimated hours ago.
    """
    if not time_str:
        return None
    
    text = time_str.lower().strip()
    
    # Just now / Premiered / Live
    if "just now" in text or "방금" in text:
        return 0.1
    if "second" in text or "초" in text:
        return 0.1
    
    # Minutes
    m_match = re.search(r'(\d+)\s*(?:minute|min|분)', text)
    if m_match:
        return float(m_match.group(1)) / 60.0
        
    # Hours
    h_match = re.search(r'(\d+)\s*(?:hour|hr|h|시간)', text)
    if h_match:
        return float(h_match.group(1))
        
    # Days
    d_match = re.search(r'(\d+)\s*(?:day|d|일)', text)
    if d_match:
        return float(d_match.group(1)) * 24.0
        
    # Weeks
    w_match = re.search(r'(\d+)\s*(?:week|w|주)', text)
    if w_match:
        return float(w_match.group(1)) * 24.0 * 7.0
        
    # Months
    mo_match = re.search(r'(\d+)\s*(?:month|개월|달)', text)
    if mo_match:
        return float(mo_match.group(1)) * 24.0 * 30.0
        
    # Years
    y_match = re.search(r'(\d+)\s*(?:year|년)', text)
    if y_match:
        return float(y_match.group(1)) * 24.0 * 365.0
        
    return None

def is_within_hours(time_str: str, max_hours: float = 24.0) -> bool:
    hours = parse_relative_time_to_hours(time_str)
    if hours is None:
        return False
    return hours <= max_hours

def estimate_published_date(time_str: str) -> str:
    """
    Estimates YYYY-MM-DD from relative time string like '38 minutes ago', '1 day ago', etc.
    """
    hours = parse_relative_time_to_hours(time_str)
    if hours is not None:
        dt = datetime.now() - timedelta(hours=hours)
        return dt.strftime("%Y-%m-%d")
    return datetime.now().strftime("%Y-%m-%d")

def clean_channel_videos_url(channel_url: str) -> str:
    url = (channel_url or "").strip()
    if not url:
        return "https://www.youtube.com/@ConstructIQ/videos"
    
    # Handle raw @handle or channel name input
    if not url.startswith("http://") and not url.startswith("https://"):
        if url.startswith("youtube.com/") or url.startswith("www.youtube.com/"):
            url = "https://" + url
        elif url.startswith("UC") and len(url) == 24 and "/" not in url:
            url = f"https://www.youtube.com/channel/{url}/videos"
        else:
            handle = url.lstrip("/").lstrip("@")
            url = f"https://www.youtube.com/@{handle}/videos"

    # Strip query parameters or fragments
    url = url.split("?")[0].split("#")[0]
    url = re.sub(r'/(featured|streams|shorts|playlists|community|about|releases|podcasts)/?$', '', url, flags=re.IGNORECASE)
    url = url.rstrip('/')
    if not url.endswith('/videos'):
        url += '/videos'
    return url

def extract_handle_from_url(channel_url: str) -> str:
    m = re.search(r'/@([^/]+)', channel_url)
    if m:
        return f"@{m.group(1)}"
    m_ch = re.search(r'/channel/([^/]+)', channel_url)
    if m_ch:
        return m_ch.group(1)
    m_c = re.search(r'/(?:c|user)/([^/]+)', channel_url)
    if m_c:
        return f"@{m_c.group(1)}"
    return "@Channel"

def _parse_video_item(it: Dict[str, Any], max_hours: float) -> Optional[Dict[str, Any]]:
    # it can be richItemRenderer or direct content dict
    rich_content = it.get('richItemRenderer', {}).get('content', it)
    
    # Check lockupViewModel (modern YouTube structure)
    if 'lockupViewModel' in rich_content:
        vm = rich_content['lockupViewModel']
        vid = vm.get('contentId')
        if not vid:
            return None
            
        meta = vm.get('metadata', {}).get('lockupMetadataViewModel', {})
        title = meta.get('title', {}).get('content', '')
        
        rows = meta.get('metadata', {}).get('contentMetadataViewModel', {}).get('metadataRows', [])
        view_text = ""
        pub_text = ""
        
        for r in rows:
            parts = r.get('metadataParts', [])
            for p in parts:
                text = p.get('text', {}).get('content', '')
                acc = p.get('accessibilityLabel', '')
                if "view" in text.lower() or "view" in acc.lower() or "조회수" in text or "조회수" in acc:
                    view_text = acc or text
                elif "ago" in text.lower() or "ago" in acc.lower() or "전" in text or "전" in acc:
                    pub_text = acc or text
        
        # If pub_text not found via keywords, check second part
        if not pub_text and len(rows) > 0:
            parts = rows[0].get('metadataParts', [])
            if len(parts) >= 2:
                pub_text = parts[1].get('text', {}).get('content', '')
                
        thumb_url = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        
        duration_text = ""
        renderer_ctx = vm.get('rendererContext', {})
        acc_label = renderer_ctx.get('accessibilityContext', {}).get('label', '')
        dur_match = re.search(r'(\d+\s*(?:minute|min|분|hour|시간|second|초).*)$', acc_label, re.IGNORECASE)
        if dur_match:
            duration_text = dur_match.group(1)
            
        is_recent = is_within_hours(pub_text, max_hours=max_hours)
        pub_date = estimate_published_date(pub_text)
        
        return {
            "video_id": vid,
            "title": title,
            "published_time_text": pub_text,
            "published_date": pub_date,
            "view_count_text": view_text,
            "duration_text": duration_text,
            "thumbnail_url": thumb_url,
            "video_url": f"https://www.youtube.com/watch?v={vid}",
            "is_within_24h": is_recent
        }
        
    # Fallback for classic videoRenderer
    elif 'videoRenderer' in rich_content:
        vr = rich_content['videoRenderer']
        vid = vr.get('videoId')
        if not vid:
            return None
        title = vr.get('title', {}).get('runs', [{}])[0].get('text', '')
        pub_text = vr.get('publishedTimeText', {}).get('simpleText', '')
        view_text = vr.get('viewCountText', {}).get('simpleText', '')
        duration_text = vr.get('lengthText', {}).get('simpleText', '')
        thumb_url = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        is_recent = is_within_hours(pub_text, max_hours=max_hours)
        pub_date = estimate_published_date(pub_text)
        
        return {
            "video_id": vid,
            "title": title,
            "published_time_text": pub_text,
            "published_date": pub_date,
            "view_count_text": view_text,
            "duration_text": duration_text,
            "thumbnail_url": thumb_url,
            "video_url": f"https://www.youtube.com/watch?v={vid}",
            "is_within_24h": is_recent
        }
        
    return None

def fetch_channel_info_and_videos(
    channel_url: str = "https://www.youtube.com/@ConstructIQ/videos",
    max_hours: float = 24.0,
    max_pages: int = 5
) -> Dict[str, Any]:
    """
    Fetches channel metadata (name, handle, normalized URL) AND the videos list.
    """
    target_url = clean_channel_videos_url(channel_url)
        
    req = urllib.request.Request(
        target_url,
        headers={
            'User-Agent': DEFAULT_USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
    )
    
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode('utf-8', errors='ignore')
        
    match = re.search(r'var ytInitialData = ({.*?});</script>', html)
    if not match:
        match = re.search(r'ytInitialData\s*=\s*({.+?});', html)
    if not match:
        match = re.search(r'window\["ytInitialData"\]\s*=\s*({.+?});', html)
    if not match:
        raise ValueError("유튜브 채널 데이터를 추출할 수 없습니다. 채널 URL 또는 @핸들을 확인해주세요.")
        
    data = json.loads(match.group(1))
    
    # Extract Channel Metadata
    meta = data.get("metadata", {}).get("channelMetadataRenderer", {})
    channel_name = meta.get("title", "").strip()
    vanity_url = meta.get("vanityChannelUrl", "").strip()
    handle = extract_handle_from_url(vanity_url or target_url)
    if not channel_name:
        og_match = re.search(r'<meta property="og:title" content="([^"]+)"', html)
        if og_match:
            channel_name = og_match.group(1).strip()
        else:
            channel_name = handle.lstrip("@")
            
    # Extract Innertube API key for subsequent continuation calls
    api_key_match = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
    api_key = api_key_match.group(1) if api_key_match else ""

    tabs = data.get('contents', {}).get('twoColumnBrowseResultsRenderer', {}).get('tabs', [])
    
    videos = []
    seen_ids = set()
    continuation_token = None
    
    for tab in tabs:
        content = tab.get('tabRenderer', {}).get('content', {})
        grid = content.get('richGridRenderer', {})
        items = grid.get('contents', [])
        
        # Fallback to sectionListRenderer if richGridRenderer is empty
        if not items and 'sectionListRenderer' in content:
            sections = content['sectionListRenderer'].get('contents', [])
            for sec in sections:
                item_section = sec.get('itemSectionRenderer', {}).get('contents', [])
                for isec in item_section:
                    grid_r = isec.get('gridRenderer', {})
                    if grid_r:
                        items.extend(grid_r.get('items', []))
        
        if not items:
            continue
            
        for it in items:
            if 'continuationItemRenderer' in it:
                continuation_token = it['continuationItemRenderer'].get('continuationEndpoint', {}).get('continuationCommand', {}).get('token')
                continue
            parsed = _parse_video_item(it, max_hours)
            if parsed and parsed["video_id"] not in seen_ids:
                seen_ids.add(parsed["video_id"])
                videos.append(parsed)
                
        # If we got videos from this tab, no need to inspect further tabs
        if videos:
            break

    # Follow continuations to get older videos (up to 120+ days / max_pages)
    page_count = 1
    while continuation_token and api_key and page_count < max_pages:
        page_count += 1
        post_data = json.dumps({
            "context": {"client": {"clientName": "WEB", "clientVersion": "2.20240101.00.00"}},
            "continuation": continuation_token
        }).encode('utf-8')
        
        cont_req = urllib.request.Request(
            f"https://www.youtube.com/youtubei/v1/browse?key={api_key}",
            data=post_data,
            headers={
                'Content-Type': 'application/json',
                'User-Agent': DEFAULT_USER_AGENT,
                'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8'
            }
        )
        try:
            with urllib.request.urlopen(cont_req, timeout=12) as resp:
                cont_data = json.loads(resp.read().decode('utf-8'))
                actions = cont_data.get('onResponseReceivedActions', [])
                if not actions:
                    break
                appended_items = actions[0].get('appendContinuationItemsAction', {}).get('continuationItems', [])
                continuation_token = None
                for it in appended_items:
                    if 'continuationItemRenderer' in it:
                        continuation_token = it['continuationItemRenderer'].get('continuationEndpoint', {}).get('continuationCommand', {}).get('token')
                        continue
                    parsed = _parse_video_item(it, max_hours)
                    if parsed and parsed["video_id"] not in seen_ids:
                        seen_ids.add(parsed["video_id"])
                        videos.append(parsed)
        except Exception as e:
            print(f"[YouTube Scraper] Continuation error on page {page_count}: {e}")
            break
            
    return {
        "name": channel_name,
        "handle": handle,
        "channel_url": target_url,
        "videos": videos
    }

def fetch_channel_videos(
    channel_url: str = "https://www.youtube.com/@ConstructIQ/videos", 
    max_hours: float = 24.0,
    max_pages: int = 5
) -> List[Dict[str, Any]]:
    """
    Fetches the videos tab of the YouTube channel and returns parsed video information.
    """
    res = fetch_channel_info_and_videos(channel_url=channel_url, max_hours=max_hours, max_pages=max_pages)
    return res["videos"]

def fetch_video_transcript(video_id: str) -> Dict[str, Any]:
    """
    Extracts transcript snippets and full text for a given video ID.
    Returns:
    {
        "success": bool,
        "full_text": str,
        "snippets": [{"start": float, "duration": float, "text": str}],
        "error": Optional[str]
    }
    """
    try:
        yta = YouTubeTranscriptApi()
        transcript = yta.fetch(video_id, languages=['en', 'en-US', 'ko'])
        
        snippets = []
        text_parts = []
        for s in transcript:
            item = {
                "start": round(s.start, 2),
                "duration": round(s.duration, 2),
                "text": s.text.strip()
            }
            snippets.append(item)
            text_parts.append(s.text.strip())
            
        full_text = " ".join(text_parts)
        return {
            "success": True,
            "full_text": full_text,
            "snippets": snippets,
            "error": None
        }
    except Exception as e:
        # Fallback to list() and find any available
        try:
            transcript_list = YouTubeTranscriptApi().list(video_id)
            # Try to find any transcript
            for t in transcript_list:
                fetched = t.fetch()
                snippets = [{"start": round(s.start, 2), "duration": round(s.duration, 2), "text": s.text.strip()} for s in fetched]
                full_text = " ".join([s.text.strip() for s in fetched])
                return {
                    "success": True,
                    "full_text": full_text,
                    "snippets": snippets,
                    "error": None
                }
        except Exception as inner_e:
            pass
            
        return {
            "success": False,
            "full_text": "",
            "snippets": [],
            "error": str(e)
        }

def extract_video_id(url_or_id: str) -> Optional[str]:
    """
    Extracts 11-character YouTube video ID from various URL formats or raw ID.
    Supports watch?v=, youtu.be/, shorts/, embed/, v/, or raw ID.
    """
    text = (url_or_id or "").strip()
    if not text:
        return None
    
    # Direct 11-char ID
    if re.fullmatch(r'[A-Za-z0-9_-]{11}', text):
        return text
    
    # youtu.be/ID
    m = re.search(r'youtu\.be/([A-Za-z0-9_-]{11})', text)
    if m:
        return m.group(1)
        
    # shorts/ID or embed/ID or v/ID
    m = re.search(r'/(?:shorts|embed|v)/([A-Za-z0-9_-]{11})', text)
    if m:
        return m.group(1)
        
    # watch?v=ID
    m = re.search(r'[?&]v=([A-Za-z0-9_-]{11})', text)
    if m:
        return m.group(1)
        
    # fallback: any 11 chars after / or =
    m = re.search(r'[/=]([A-Za-z0-9_-]{11})(?:[&/?#]|$)', text)
    if m:
        return m.group(1)
        
    return None

def fetch_single_video_metadata(video_id: str) -> Dict[str, Any]:
    """
    Fetches title, channel name, thumbnail, duration, and publish date for a single video.
    Uses official YouTube oEmbed endpoint + HTML metadata extraction. No API key needed.
    """
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    thumbnail_url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    title = f"YouTube Video ({video_id})"
    channel_name = "직접 등록 영상"
    duration_text = "Video"
    view_count_text = ""
    published_date = datetime.now().strftime("%Y-%m-%d")
    published_time_text = "직접 등록"
    
    # 1. Fetch via oEmbed
    try:
        oembed_url = f"https://www.youtube.com/oembed?url={urllib.parse.quote(video_url)}&format=json"
        req = urllib.request.Request(oembed_url, headers={"User-Agent": DEFAULT_USER_AGENT})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            title = data.get("title") or title
            if data.get("author_name"):
                channel_name = data.get("author_name")
            thumbnail_url = data.get("thumbnail_url") or thumbnail_url
    except Exception as e:
        print(f"[YouTube Scraper] oEmbed error for {video_id}: {e}")

    # 2. Fetch HTML for duration, publishDate, viewCount
    try:
        req = urllib.request.Request(
            video_url, 
            headers={
                "User-Agent": DEFAULT_USER_AGENT,
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
            }
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
            
            # Duration
            m_len = re.search(r'"lengthSeconds":\s*"(\d+)"', html)
            if m_len:
                sec = int(m_len.group(1))
                mins = sec // 60
                secs = sec % 60
                duration_text = f"{mins} minutes, {secs} seconds" if mins > 0 else f"{secs} seconds"
            
            # Publish Date
            m_date = re.search(r'"publishDate":\s*"([^"]+)"', html)
            if m_date:
                raw_d = m_date.group(1)
                published_date = raw_d.split('T')[0]
                published_time_text = published_date
            elif not published_date:
                m_date2 = re.search(r'"uploadDate":\s*"([^"]+)"', html)
                if m_date2:
                    published_date = m_date2.group(1).split('T')[0]
                    published_time_text = published_date
                    
            # View Count
            m_views = re.search(r'"viewCount":\s*"(\d+)"', html)
            if m_views:
                v_num = int(m_views.group(1))
                view_count_text = f"{v_num:,} views"
                
            # Fallback title/channel from HTML if oEmbed failed
            if title.startswith("YouTube Video"):
                m_t = re.search(r'<meta name="title" content="([^"]+)"', html) or re.search(r'<title>(.*?)(?: - YouTube)?</title>', html)
                if m_t:
                    title = m_t.group(1).replace(" - YouTube", "").strip()
            if channel_name == "직접 등록 영상":
                m_ch = re.search(r'"ownerChannelName":\s*"([^"]+)"', html) or re.search(r'<link itemprop="name" content="([^"]+)"', html)
                if m_ch:
                    channel_name = m_ch.group(1).strip()
    except Exception as e:
        print(f"[YouTube Scraper] HTML fetch error for {video_id}: {e}")

    return {
        "video_id": video_id,
        "title": title,
        "channel_name": channel_name,
        "published_date": published_date,
        "published_time_text": published_time_text,
        "duration_text": duration_text,
        "view_count_text": view_count_text,
        "thumbnail_url": thumbnail_url,
        "video_url": video_url,
        "is_within_24h": 0,
        "is_custom_added": 1
    }
