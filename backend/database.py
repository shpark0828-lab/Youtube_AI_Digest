import sqlite3
import json
import os
from datetime import datetime
from typing import Optional, Dict, Any, List

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "app.sqlite")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Videos table
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS videos (
            video_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            published_time_text TEXT,
            view_count_text TEXT,
            duration_text TEXT,
            thumbnail_url TEXT,
            video_url TEXT,
            discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_within_24h BOOLEAN DEFAULT 0
        )
        """)
        
        # Summaries table
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id TEXT UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            model_used TEXT,
            title TEXT,
            one_line_summary TEXT,
            key_insights TEXT,
            timeline_breakdown TEXT,
            tools_and_prompts TEXT,
            actionable_steps TEXT,
            full_summary_md TEXT,
            transcript_raw TEXT,
            bilingual_transcript TEXT,
            status TEXT DEFAULT 'completed',
            FOREIGN KEY (video_id) REFERENCES videos(video_id)
        )
        """)
        
        # Channels table (Multi-channel support)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            handle TEXT UNIQUE,
            channel_url TEXT NOT NULL,
            prompt_style TEXT DEFAULT 'construction',
            is_default BOOLEAN DEFAULT 0,
            auto_sync BOOLEAN DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # No default channel seeded (starts empty)
        pass
        cursor.execute("SELECT COUNT(*) as cnt FROM channels WHERE is_default = 1")
        if cursor.fetchone()["cnt"] == 0:
            cursor.execute("UPDATE channels SET is_default = 1 WHERE id = 1")

        # Deleted videos table to prevent re-syncing removed items
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS deleted_videos (
            video_id TEXT PRIMARY KEY,
            title TEXT,
            deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Migration for existing DB
        try:
            cursor.execute("ALTER TABLE summaries ADD COLUMN bilingual_transcript TEXT")
        except sqlite3.OperationalError:
            pass  # Column already exists

        try:
            cursor.execute("ALTER TABLE videos ADD COLUMN sort_order INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute("ALTER TABLE videos ADD COLUMN published_date TEXT")
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute("ALTER TABLE videos ADD COLUMN channel_id INTEGER DEFAULT 1")
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute("ALTER TABLE videos ADD COLUMN channel_name TEXT DEFAULT 'YouTube 채널'")
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute("ALTER TABLE videos ADD COLUMN is_custom_added BOOLEAN DEFAULT 0")
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute("ALTER TABLE videos ADD COLUMN custom_category TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass

        # Custom categories table for user-registered videos
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS custom_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            sort_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        cursor.execute("UPDATE videos SET channel_id = 1 WHERE channel_id IS NULL")
        cursor.execute("UPDATE videos SET channel_name = 'YouTube 채널' WHERE channel_name IS NULL OR channel_name = ''")
            
        # Backfill published_date for any rows missing it
        try:
            from backend.youtube_scraper import estimate_published_date
            cursor.execute("SELECT video_id, published_time_text FROM videos WHERE published_date IS NULL OR published_date = ''")
            to_backfill = cursor.fetchall()
            for row in to_backfill:
                p_text = row["published_time_text"] or ""
                p_date = estimate_published_date(p_text)
                cursor.execute("UPDATE videos SET published_date = ? WHERE video_id = ?", (p_date, row["video_id"]))
        except Exception as e:
            print(f"[DB] Backfill published_date warning: {e}")
        
        # Runs log table
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            triggered_by TEXT,
            videos_found_total INTEGER DEFAULT 0,
            videos_within_24h INTEGER DEFAULT 0,
            videos_summarized INTEGER DEFAULT 0,
            status TEXT DEFAULT 'success',
            message TEXT
        )
        """)

        try:
            cursor.execute("ALTER TABLE runs ADD COLUMN channel_id INTEGER")
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute("ALTER TABLE runs ADD COLUMN channel_name TEXT DEFAULT 'YouTube 채널'")
        except sqlite3.OperationalError:
            pass
        
        # Settings table
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """)
        
        # Default settings
        defaults = {
            "channel_url": "",
            "schedule_time": "09:00",
            "time_filter_hours": "24",
            "ai_provider": "gemini",
            "gemini_api_key": "",
            "gemini_model": "gemini-3.8-flash",
            "openai_api_key": "",
            "openai_model": "gpt-4o-mini",
            "detail_level": "ultra_detailed",
            "webhook_url": "",
            "auto_run_enabled": "true"
        }
        for k, v in defaults.items():
            cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))
            
        # Migrate deprecated gemini-2.5-flash to gemini-3.8-flash
        cursor.execute("UPDATE settings SET value = 'gemini-3.8-flash' WHERE key = 'gemini_model' AND (value = 'gemini-2.5-flash' OR value = 'models/gemini-2.5-flash')")
            
        conn.commit()

def get_settings() -> Dict[str, str]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM settings")
        rows = cursor.fetchall()
        return {r["key"]: r["value"] for r in rows}

def update_settings(updates: Dict[str, str]):
    with get_db() as conn:
        cursor = conn.cursor()
        for k, v in updates.items():
            cursor.execute("""
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """, (k, str(v)))
        conn.commit()

# --- Channel CRUD Functions ---

def get_channels() -> List[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        SELECT c.*,
               (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id) as total_videos,
               (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.is_within_24h = 1) as recent_24h_videos,
               (SELECT COUNT(*) FROM summaries s JOIN videos v ON s.video_id = v.video_id WHERE v.channel_id = c.id AND s.status = 'completed') as summarized_videos
        FROM channels c
        ORDER BY c.is_default DESC, c.id ASC
        """)
        return [dict(r) for r in cursor.fetchall()]

def get_channel_by_id(channel_id: int) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        SELECT c.*,
               (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id) as total_videos,
               (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.is_within_24h = 1) as recent_24h_videos,
               (SELECT COUNT(*) FROM summaries s JOIN videos v ON s.video_id = v.video_id WHERE v.channel_id = c.id AND s.status = 'completed') as summarized_videos
        FROM channels c
        WHERE c.id = ?
        """, (channel_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def get_default_channel() -> Dict[str, Any]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM channels WHERE is_default = 1 ORDER BY id ASC LIMIT 1")
        row = cursor.fetchone()
        if row:
            return dict(row)
        cursor.execute("SELECT * FROM channels ORDER BY id ASC LIMIT 1")
        row = cursor.fetchone()
        if row:
            return dict(row)
        return {
            "id": 1,
            "name": "ConstructIQ",
            "handle": "@ConstructIQ",
            "channel_url": "",
            "prompt_style": "construction",
            "is_default": 1,
            "auto_sync": 1
        }

def add_channel(
    name: str,
    handle: str,
    channel_url: str,
    prompt_style: str = "general",
    auto_sync: int = 1
) -> Dict[str, Any]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM channels WHERE LOWER(handle) = LOWER(?) OR LOWER(channel_url) = LOWER(?)",
            (handle, channel_url)
        )
        existing = cursor.fetchone()
        if existing:
            ch_id = existing["id"]
            cursor.execute("""
            UPDATE channels SET name = ?, channel_url = ?, prompt_style = ?, auto_sync = ?
            WHERE id = ?
            """, (name, channel_url, prompt_style, auto_sync, ch_id))
            conn.commit()
            return get_channel_by_id(ch_id)

        cursor.execute("""
        INSERT INTO channels (name, handle, channel_url, prompt_style, is_default, auto_sync)
        VALUES (?, ?, ?, ?, 0, ?)
        """, (name, handle, channel_url, prompt_style, auto_sync))
        ch_id = cursor.lastrowid
        conn.commit()
        return get_channel_by_id(ch_id)

def update_channel(channel_id: int, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM channels WHERE id = ?", (channel_id,))
        row = cursor.fetchone()
        if not row:
            return None

        if updates.get("is_default") in (1, True, "1", "true"):
            cursor.execute("UPDATE channels SET is_default = 0")
            cursor.execute("UPDATE channels SET is_default = 1 WHERE id = ?", (channel_id,))
            cursor.execute("UPDATE settings SET value = ? WHERE key = 'channel_url'", (row["channel_url"],))

        allowed_fields = ["name", "handle", "channel_url", "prompt_style", "auto_sync"]
        for field in allowed_fields:
            if field in updates and updates[field] is not None:
                val = updates[field]
                if field == "auto_sync":
                    val = 1 if val in (1, True, "1", "true") else 0
                cursor.execute(f"UPDATE channels SET {field} = ? WHERE id = ?", (val, channel_id))
                if field == "name":
                    cursor.execute("UPDATE videos SET channel_name = ? WHERE channel_id = ?", (val, channel_id))

        conn.commit()
    return get_channel_by_id(channel_id)

def delete_channel(channel_id: int) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM channels WHERE id = ?", (channel_id,))
        row = cursor.fetchone()
        if not row:
            return False
        if row["is_default"] == 1:
            raise ValueError("기본 채널은 삭제할 수 없습니다. 다른 채널을 기본 채널로 먼저 변경해주세요.")

        # Delete only unsummarized videos for this channel; preserve videos that have summaries
        cursor.execute("""
        DELETE FROM videos 
        WHERE channel_id = ? 
          AND video_id NOT IN (SELECT video_id FROM summaries)
        """, (channel_id,))
        cursor.execute("DELETE FROM channels WHERE id = ?", (channel_id,))
        conn.commit()
        return True

def save_video(video: Dict[str, Any], sort_order: int = 0, channel_id: int = 1, channel_name: str = "ConstructIQ"):
    pub_date = video.get("published_date")
    if not pub_date and video.get("published_time_text"):
        from backend.youtube_scraper import estimate_published_date
        pub_date = estimate_published_date(video.get("published_time_text"))
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        INSERT INTO videos (video_id, title, published_time_text, view_count_text, duration_text, thumbnail_url, video_url, is_within_24h, sort_order, published_date, channel_id, channel_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
            title=excluded.title,
            published_time_text=excluded.published_time_text,
            view_count_text=excluded.view_count_text,
            duration_text=excluded.duration_text,
            thumbnail_url=excluded.thumbnail_url,
            is_within_24h=excluded.is_within_24h,
            sort_order=excluded.sort_order,
            published_date=COALESCE(excluded.published_date, videos.published_date),
            channel_id=excluded.channel_id,
            channel_name=excluded.channel_name
        """, (
            video.get("video_id"),
            video.get("title"),
            video.get("published_time_text"),
            video.get("view_count_text"),
            video.get("duration_text"),
            video.get("thumbnail_url"),
            video.get("video_url"),
            1 if video.get("is_within_24h") else 0,
            sort_order,
            pub_date,
            channel_id,
            channel_name
        ))
        conn.commit()

def sync_videos_to_db(videos: List[Dict[str, Any]], channel_id: int = 1, channel_name: str = "ConstructIQ"):
    """
    Atomically updates the channel's video list, resets obsolete 24h flags for that channel,
    and preserves exact YouTube reverse-chronological sort order.
    NEVER deletes any videos, especially those with existing summaries or custom-added videos.
    Skips videos that were explicitly deleted by the user.
    """
    from backend.youtube_scraper import estimate_published_date
    with get_db() as conn:
        cursor = conn.cursor()
        
        cursor.execute("SELECT video_id FROM deleted_videos")
        deleted_ids = set(r["video_id"] for r in cursor.fetchall())
        
        cursor.execute(
            "UPDATE videos SET is_within_24h = 0, sort_order = 999999 WHERE channel_id = ? AND (is_custom_added IS NULL OR is_custom_added = 0)",
            (channel_id,)
        )
        for idx, video in enumerate(videos):
            vid = video.get("video_id")
            if not vid or vid in deleted_ids:
                continue
            pub_date = video.get("published_date") or estimate_published_date(video.get("published_time_text") or "")
            cursor.execute("""
            INSERT INTO videos (video_id, title, published_time_text, view_count_text, duration_text, thumbnail_url, video_url, is_within_24h, sort_order, published_date, channel_id, channel_name, is_custom_added)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(video_id) DO UPDATE SET
                title=excluded.title,
                published_time_text=excluded.published_time_text,
                view_count_text=excluded.view_count_text,
                duration_text=excluded.duration_text,
                thumbnail_url=excluded.thumbnail_url,
                is_within_24h=excluded.is_within_24h,
                sort_order=CASE WHEN videos.is_custom_added = 1 THEN videos.sort_order ELSE excluded.sort_order END,
                published_date=COALESCE(excluded.published_date, videos.published_date),
                channel_id=excluded.channel_id,
                channel_name=excluded.channel_name
            """, (
                vid,
                video.get("title"),
                video.get("published_time_text"),
                video.get("view_count_text"),
                video.get("duration_text"),
                video.get("thumbnail_url"),
                video.get("video_url"),
                1 if video.get("is_within_24h") else 0,
                idx,
                pub_date,
                channel_id,
                channel_name
            ))
        conn.commit()

def delete_video(video_id: str) -> bool:
    """
    Permanently deletes a video from 'videos' and its summary from 'summaries'.
    Records the video_id in 'deleted_videos' so it won't be re-imported by auto-sync.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT title FROM videos WHERE video_id = ?", (video_id,))
        row = cursor.fetchone()
        title = row["title"] if row else ""
        
        cursor.execute("""
        INSERT OR REPLACE INTO deleted_videos (video_id, title)
        VALUES (?, ?)
        """, (video_id, title))
        
        cursor.execute("DELETE FROM summaries WHERE video_id = ?", (video_id,))
        cursor.execute("DELETE FROM videos WHERE video_id = ?", (video_id,))
        conn.commit()
        return True

def delete_summary_only(video_id: str) -> bool:
    """
    Deletes only the AI summary report for a video, keeping the video itself in the list (as 미요약).
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM summaries WHERE video_id = ?", (video_id,))
        conn.commit()
        return cursor.rowcount > 0

def get_video_by_id(video_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        SELECT v.*, 
               COALESCE(c.name, v.channel_name, 'YouTube 채널') as channel_name,
               COALESCE(c.handle, '@ConstructIQ') as channel_handle,
               (s.id IS NOT NULL) as has_summary, 
               s.created_at as summarized_at, 
               s.model_used as summary_model
        FROM videos v
        LEFT JOIN summaries s ON v.video_id = s.video_id
        LEFT JOIN channels c ON v.channel_id = c.id
        WHERE v.video_id = ?
        """, (video_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def save_custom_video(
    video: Dict[str, Any],
    target_channel_id: Optional[int] = None,
    prompt_style: Optional[str] = None,
    custom_category: Optional[str] = None
) -> Dict[str, Any]:
    """
    Saves an individually added custom video.
    If target_channel_id is not given:
      - Searches channels table for a matching channel name.
      - If none found, attaches to or creates the '직접 등록 영상' (@custom_videos) channel.
    Sets is_custom_added = 1 and sort_order = -1 (placed at top).
    """
    cat_val = (custom_category or "").strip()
    with get_db() as conn:
        cursor = conn.cursor()
        
        if cat_val:
            cursor.execute("INSERT OR IGNORE INTO custom_categories (name) VALUES (?)", (cat_val,))
        
        ch_id = target_channel_id
        ch_name = video.get("channel_name") or "직접 등록 영상"
        
        if ch_id is None:
            # Check if matching channel exists
            cursor.execute("SELECT id, name FROM channels WHERE LOWER(name) = LOWER(?)", (ch_name,))
            matched = cursor.fetchone()
            if matched:
                ch_id = matched["id"]
                ch_name = matched["name"]
            else:
                # Find or create @custom_videos channel
                cursor.execute("SELECT id, name FROM channels WHERE handle = '@custom_videos'")
                custom_ch = cursor.fetchone()
                if custom_ch:
                    ch_id = custom_ch["id"]
                else:
                    cursor.execute("""
                    INSERT INTO channels (name, handle, channel_url, prompt_style, is_default, auto_sync)
                    VALUES ('직접 등록 영상', '@custom_videos', 'custom', ?, 0, 0)
                    """, (prompt_style or 'general',))
                    ch_id = cursor.lastrowid
        else:
            cursor.execute("SELECT name FROM channels WHERE id = ?", (ch_id,))
            row = cursor.fetchone()
            if row:
                ch_name = row["name"]
                    
        pub_date = video.get("published_date")
        if not pub_date and video.get("published_time_text"):
            from backend.youtube_scraper import estimate_published_date
            pub_date = estimate_published_date(video.get("published_time_text"))
        if not pub_date:
            pub_date = datetime.now().strftime("%Y-%m-%d")

        # Clear from deleted_videos if user explicitly re-adds it
        cursor.execute("DELETE FROM deleted_videos WHERE video_id = ?", (video.get("video_id"),))
            
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute("""
        INSERT INTO videos (video_id, title, published_time_text, view_count_text, duration_text, thumbnail_url, video_url, is_within_24h, sort_order, published_date, channel_id, channel_name, is_custom_added, custom_category, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, -1, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
            title=excluded.title,
            published_time_text=excluded.published_time_text,
            view_count_text=excluded.view_count_text,
            duration_text=excluded.duration_text,
            thumbnail_url=excluded.thumbnail_url,
            published_date=COALESCE(excluded.published_date, videos.published_date),
            channel_id=excluded.channel_id,
            channel_name=excluded.channel_name,
            is_custom_added=1,
            custom_category=CASE WHEN excluded.custom_category != '' THEN excluded.custom_category ELSE COALESCE(videos.custom_category, '') END
        """, (
            video.get("video_id"),
            video.get("title"),
            video.get("published_time_text") or "직접 등록",
            video.get("view_count_text") or "",
            video.get("duration_text") or "Video",
            video.get("thumbnail_url"),
            video.get("video_url") or f"https://www.youtube.com/watch?v={video.get('video_id')}",
            pub_date,
            ch_id,
            ch_name,
            cat_val,
            now_str
        ))
        conn.commit()
        
    return get_video_by_id(video.get("video_id"))

def get_filtered_videos(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    only_summarized: bool = False,
    include_all_summarized: bool = True,
    channel_id: Optional[int] = None,
    limit: int = 1000
) -> List[Dict[str, Any]]:
    """
    Retrieves videos with date-range and channel filtering.
    CRITICAL: Videos that have summaries or are custom-added are NEVER removed from the list.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        
        date_parts = []
        date_params = []
        
        if start_date:
            date_parts.append("v.published_date >= ?")
            date_params.append(start_date)
        if end_date:
            date_parts.append("v.published_date <= ?")
            date_params.append(end_date)
        if only_summarized:
            date_parts.append("s.id IS NOT NULL")
            
        conditions = []
        params = []
        
        if channel_id is not None:
            conditions.append("v.channel_id = ?")
            params.append(channel_id)
            
        if date_parts:
            date_filter = " AND ".join(date_parts)
            if include_all_summarized and not only_summarized:
                conditions.append(f"(({date_filter}) OR (s.id IS NOT NULL) OR (v.is_custom_added = 1))")
            else:
                conditions.append(f"({date_filter})")
            params.extend(date_params)
            
        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
                
        query = f"""
        SELECT v.*, 
               COALESCE(c.name, v.channel_name, 'YouTube 채널') as channel_name,
               COALESCE(c.handle, '@ConstructIQ') as channel_handle,
               (s.id IS NOT NULL) as has_summary, 
               s.created_at as summarized_at, 
               s.model_used as summary_model
        FROM videos v
        LEFT JOIN summaries s ON v.video_id = s.video_id
        LEFT JOIN channels c ON v.channel_id = c.id
        {where_clause}
        ORDER BY 
            CASE WHEN v.is_custom_added = 1 THEN 0 ELSE 1 END ASC,
            v.published_date DESC,
            v.sort_order ASC, 
            v.discovered_at DESC
        LIMIT ?
        """
        params.append(limit)
        cursor.execute(query, tuple(params))
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

def save_summary(summary_data: Dict[str, Any]):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        INSERT INTO summaries (
            video_id, model_used, title, one_line_summary, 
            key_insights, timeline_breakdown, tools_and_prompts, 
            actionable_steps, full_summary_md, transcript_raw, bilingual_transcript, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
            model_used=excluded.model_used,
            title=excluded.title,
            one_line_summary=excluded.one_line_summary,
            key_insights=excluded.key_insights,
            timeline_breakdown=excluded.timeline_breakdown,
            tools_and_prompts=excluded.tools_and_prompts,
            actionable_steps=excluded.actionable_steps,
            full_summary_md=excluded.full_summary_md,
            transcript_raw=excluded.transcript_raw,
            bilingual_transcript=excluded.bilingual_transcript,
            status=excluded.status
        """, (
            summary_data.get("video_id"),
            summary_data.get("model_used"),
            summary_data.get("title"),
            summary_data.get("one_line_summary"),
            summary_data.get("key_insights"),
            summary_data.get("timeline_breakdown"),
            summary_data.get("tools_and_prompts"),
            summary_data.get("actionable_steps"),
            summary_data.get("full_summary_md"),
            summary_data.get("transcript_raw"),
            summary_data.get("bilingual_transcript"),
            summary_data.get("status", "completed")
        ))
        conn.commit()

    # Automatically refresh offline viewer file in background
    try:
        import threading
        from backend.offline_exporter import export_offline_viewer
        threading.Thread(target=export_offline_viewer, daemon=True).start()
    except Exception as e:
        print(f"[DB] Auto offline export warning: {e}")

def get_recent_summaries(limit: int = 100, channel_id: Optional[int] = None) -> List[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        where_sql = "WHERE v.channel_id = ?" if channel_id is not None else ""
        params = (channel_id, limit) if channel_id is not None else (limit,)
        cursor.execute(f"""
        SELECT s.*, 
               v.published_time_text, v.view_count_text, v.duration_text, 
               v.thumbnail_url, v.video_url, v.is_within_24h, v.published_date,
               v.discovered_at, v.channel_id, v.is_custom_added,
               COALESCE(v.custom_category, '') as custom_category,
               COALESCE(c.name, v.channel_name, 'YouTube 채널') as channel_name,
               COALESCE(c.handle, '@ConstructIQ') as channel_handle
        FROM summaries s
        JOIN videos v ON s.video_id = v.video_id
        LEFT JOIN channels c ON v.channel_id = c.id
        {where_sql}
        ORDER BY s.created_at DESC
        LIMIT ?
        """, params)
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

def get_summary_by_video_id(video_id: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        SELECT s.*, 
               v.published_time_text, v.view_count_text, v.duration_text, 
               v.thumbnail_url, v.video_url, v.is_within_24h, v.published_date,
               v.discovered_at, v.channel_id, v.is_custom_added,
               COALESCE(v.custom_category, '') as custom_category,
               COALESCE(c.name, v.channel_name, 'YouTube 채널') as channel_name,
               COALESCE(c.handle, '@ConstructIQ') as channel_handle
        FROM summaries s
        JOIN videos v ON s.video_id = v.video_id
        LEFT JOIN channels c ON v.channel_id = c.id
        WHERE s.video_id = ?
        """, (video_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def get_custom_categories() -> List[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        SELECT cc.id, cc.name, cc.sort_order, cc.created_at,
               (SELECT COUNT(*) FROM videos v WHERE v.custom_category = cc.name) as video_count
        FROM custom_categories cc
        ORDER BY cc.sort_order ASC, cc.id ASC
        """)
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

def add_custom_category(name: str) -> Dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("카테고리 이름을 입력해주세요.")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR IGNORE INTO custom_categories (name) VALUES (?)", (clean_name,))
        conn.commit()
        cursor.execute("""
        SELECT cc.id, cc.name, cc.sort_order, cc.created_at,
               (SELECT COUNT(*) FROM videos v WHERE v.custom_category = cc.name) as video_count
        FROM custom_categories cc
        WHERE cc.name = ?
        """, (clean_name,))
        row = cursor.fetchone()
        return dict(row) if row else {"name": clean_name, "video_count": 0}

def update_custom_category(cat_id: int, new_name: str) -> Optional[Dict[str, Any]]:
    clean_name = new_name.strip()
    if not clean_name:
        raise ValueError("새 카테고리 이름을 입력해주세요.")
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM custom_categories WHERE id = ?", (cat_id,))
        old_row = cursor.fetchone()
        if not old_row:
            return None
        old_name = old_row["name"]
        if old_name != clean_name:
            cursor.execute("UPDATE custom_categories SET name = ? WHERE id = ?", (clean_name, cat_id))
            cursor.execute("UPDATE videos SET custom_category = ? WHERE custom_category = ?", (clean_name, old_name))
            conn.commit()
        cursor.execute("""
        SELECT cc.id, cc.name, cc.sort_order, cc.created_at,
               (SELECT COUNT(*) FROM videos v WHERE v.custom_category = cc.name) as video_count
        FROM custom_categories cc
        WHERE cc.id = ?
        """, (cat_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def delete_custom_category(cat_id: int) -> bool:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM custom_categories WHERE id = ?", (cat_id,))
        row = cursor.fetchone()
        if not row:
            return False
        cat_name = row["name"]
        cursor.execute("UPDATE videos SET custom_category = '' WHERE custom_category = ?", (cat_name,))
        cursor.execute("DELETE FROM custom_categories WHERE id = ?", (cat_id,))
        conn.commit()
        return True

def update_video_category(video_id: str, category_name: str) -> Optional[Dict[str, Any]]:
    clean_cat = (category_name or "").strip()
    with get_db() as conn:
        cursor = conn.cursor()
        if clean_cat:
            cursor.execute("INSERT OR IGNORE INTO custom_categories (name) VALUES (?)", (clean_cat,))
        cursor.execute("UPDATE videos SET custom_category = ? WHERE video_id = ?", (clean_cat, video_id))
        conn.commit()
    return get_video_by_id(video_id)

def update_video_channel(video_id: str, channel_id: int) -> Optional[Dict[str, Any]]:
    """
    Updates the channel assignment for a given video.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name FROM channels WHERE id = ?", (channel_id,))
        ch_row = cursor.fetchone()
        if not ch_row:
            raise ValueError(f"채널 ID {channel_id}를 찾을 수 없습니다.")
        ch_name = ch_row["name"]
        
        cursor.execute("""
            UPDATE videos
            SET channel_id = ?, channel_name = ?
            WHERE video_id = ?
        """, (channel_id, ch_name, video_id))
        conn.commit()
    return get_video_by_id(video_id)

def batch_update_videos_channel(video_ids: List[str], channel_id: int) -> int:
    """
    Updates the channel assignment for multiple videos.
    """
    if not video_ids:
        return 0
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name FROM channels WHERE id = ?", (channel_id,))
        ch_row = cursor.fetchone()
        if not ch_row:
            raise ValueError(f"채널 ID {channel_id}를 찾을 수 없습니다.")
        ch_name = ch_row["name"]
        
        placeholders = ",".join("?" for _ in video_ids)
        params = [channel_id, ch_name] + list(video_ids)
        cursor.execute(f"""
            UPDATE videos
            SET channel_id = ?, channel_name = ?
            WHERE video_id IN ({placeholders})
        """, tuple(params))
        conn.commit()
        return cursor.rowcount


def log_run(run_data: Dict[str, Any]):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
        INSERT INTO runs (triggered_by, videos_found_total, videos_within_24h, videos_summarized, status, message, channel_id, channel_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            run_data.get("triggered_by", "manual"),
            run_data.get("videos_found_total", 0),
            run_data.get("videos_within_24h", 0),
            run_data.get("videos_summarized", 0),
            run_data.get("status", "success"),
            run_data.get("message", ""),
            run_data.get("channel_id"),
            run_data.get("channel_name", "ConstructIQ")
        ))
        conn.commit()

def get_recent_runs(limit: int = 20) -> List[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM runs ORDER BY run_at DESC LIMIT ?", (limit,))
        rows = cursor.fetchall()
        return [dict(r) for r in rows]
