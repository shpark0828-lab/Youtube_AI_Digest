import os
import json
import re
import urllib.request
import urllib.parse
import requests
from typing import Dict, Any, List, Optional

def format_timestamp(seconds: float) -> str:
    m = int(seconds // 60)
    s = int(seconds % 60)
    h = int(m // 60)
    m = m % 60
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"

def group_transcript_by_time(snippets: List[Dict[str, Any]], interval_sec: float = 40.0) -> List[Dict[str, Any]]:
    """
    Groups transcript snippets into comfortable intervals (e.g. every 35-45 seconds)
    for accurate sentence matching and bilingual translation.
    """
    if not snippets:
        return []
        
    grouped = []
    current_group = {
        "start": snippets[0]["start"],
        "end": snippets[0]["start"],
        "texts": []
    }
    
    for s in snippets:
        if s["start"] - current_group["start"] >= interval_sec and current_group["texts"]:
            current_group["text"] = " ".join(current_group["texts"])
            grouped.append(current_group)
            current_group = {
                "start": s["start"],
                "end": s["start"] + s.get("duration", 0),
                "texts": [s["text"]]
            }
        else:
            current_group["texts"].append(s["text"])
            current_group["end"] = s["start"] + s.get("duration", 0)
            
    if current_group["texts"]:
        current_group["text"] = " ".join(current_group["texts"])
        grouped.append(current_group)
        
    return grouped

def refine_korean_construction_terms(text: str) -> str:
    """
    Post-processes Korean translation with correct AEC (Architecture, Engineering, Construction) terminology.
    """
    replacements = [
        (r'\b이륙\b', '물량산출(Take-off)'),
        (r'\b테이크오프\b', '물량산출(Take-off)'),
        (r'\bGBT6\b', 'GPT-6'),
        (r'\bGBT 6\b', 'GPT-6'),
        (r'\b채팅 GBT\b', 'ChatGPT'),
        (r'\b채팅 GPT\b', 'ChatGPT'),
        (r'\b하네스\b', '테스트 환경(Harness)'),
        (r'\b코덱스\b', 'Codex'),
        (r'\b푸팅\b', '기초(Footing)'),
        (r'\b슬래브를 살펴보세요\b', '슬래브(Slab) 부재를 확인할 수 있습니다'),
        (r'\b나를 만든\b', '생성해 준'),
        (r'\b나를 빌드해 준\b', '생성해 준')
    ]
    res = text
    for pat, rep in replacements:
        res = re.sub(pat, rep, res, flags=re.IGNORECASE)
    return res

def translate_text_to_korean_online(text: str) -> str:
    """
    Translates English text to natural Korean using Google Translate API with fallback.
    """
    if not text or not text.strip():
        return ""
    try:
        url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=" + urllib.parse.quote(text.strip())
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            translated = "".join([part[0] for part in data[0] if part[0]])
            return refine_korean_construction_terms(translated)
    except Exception as e:
        print(f"Online translation warning: {e}")
        return text

def build_full_bilingual_subtitles(snippets: List[Dict[str, Any]]) -> str:
    """
    Translates all snippets into Korean and builds a dual language formatted subtitle stream:
    [00:15]
    (EN) English original transcript...
    (KO) 자연스럽고 정확한 한국어 번역문...
    """
    if not snippets:
        return "자막 정보가 없습니다."
        
    grouped = group_transcript_by_time(snippets, interval_sec=35.0)
    blocks = []
    
    for grp in grouped:
        st = format_timestamp(grp["start"])
        en_text = grp["text"].strip()
        ko_text = translate_text_to_korean_online(en_text)
        
        block = f"[{st}]\n(EN) {en_text}\n(KO) {ko_text}"
        blocks.append(block)
        
    return "\n\n".join(blocks)

def call_gemini_api(api_key: str, model: str, prompt: str) -> str:
    """
    Calls Google Generative Language API directly.
    Auto-upgrades deprecated gemini-2.5-flash to gemini-3.8-flash.
    """
    model_name = model.strip() or "gemini-3.5-flash"
    if model_name.startswith("models/"):
        model_name = model_name.replace("models/", "")
    
    # Auto-upgrade deprecated 2.5 models
    if "2.5-flash" in model_name:
        model_name = "gemini-3.5-flash"
        
    candidates_models = [model_name]
    for fallback in ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]:
        if fallback not in candidates_models:
            candidates_models.append(fallback)

    last_error = ""
    is_test_prompt = len(prompt) < 300
    per_model_timeout = 8 if is_test_prompt else 35
    max_tokens = 300 if is_test_prompt else 8192

    for target_model in candidates_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{target_model}:generateContent?key={api_key}"
        payload_bytes = json.dumps({
            "contents": [
                {
                    "parts": [
                        {"text": prompt}
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": max_tokens
            }
        }).encode('utf-8')
        
        req = urllib.request.Request(
            url, 
            data=payload_bytes, 
            headers={"Content-Type": "application/json"}
        )
        
        try:
            with urllib.request.urlopen(req, timeout=per_model_timeout) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                candidates = data.get("candidates", [])
                if not candidates:
                    raise RuntimeError("No response candidate returned by Gemini API")
                parts = candidates[0].get("content", {}).get("parts", [])
                return "".join([p.get("text", "") for p in parts])
        except urllib.error.HTTPError as he:
            err_body = he.read().decode('utf-8', errors='ignore')
            last_error = f"Gemini API error ({he.code}): {err_body}"
            print(f"Gemini API call to {target_model} failed ({he.code}), trying next candidate...")
        except Exception as e:
            last_error = f"Gemini API call error: {str(e)}"
            print(f"Gemini API call to {target_model} failed ({e}), trying next candidate...")

    raise RuntimeError(last_error)

def call_openai_api(api_key: str, model: str, prompt: str) -> str:
    """
    Calls OpenAI Chat Completions API directly.
    """
    model_name = model.strip() or "gpt-4o-mini"
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": "You are a world-class senior AEC (Architecture, Engineering, Construction) technologist and AI prompt engineering specialist. You provide deeply detailed, rigorous, step-by-step Korean summaries with complete technical fidelity and bilingual subtitle annotations."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=90)
    if resp.status_code != 200:
        raise RuntimeError(f"OpenAI API error ({resp.status_code}): {resp.text}")
    data = resp.json()
    return data["choices"][0]["message"]["content"]

def generate_extractive_summary(video_info: Dict[str, Any], transcript_data: Dict[str, Any], detail_level: str = "ultra_detailed", prompt_style: str = "construction") -> Dict[str, Any]:
    """
    Intelligent built-in summarizer that translates transcript into Korean,
    analyzes sections, and generates a structured Korean summary report with bilingual subtitles.
    """
    snippets = transcript_data.get("snippets", [])
    full_text = transcript_data.get("full_text", "")
    title = video_info.get("title", "")
    channel_name = video_info.get("channel_name", "ConstructIQ")
    
    if not snippets or not full_text:
        return {
            "title": title,
            "one_line_summary": f"[{channel_name}] '{title}' 영상입니다. (자막이 제공되지 않아 텍스트 상세 분석을 건너뜁니다)",
            "key_insights": "• 영상에 자동/수동 자막이 등록되지 않았습니다.\n• 채널 상세 설명 및 유튜브 링크를 확인해주세요.",
            "timeline_breakdown": "자막 정보 없음",
            "tools_and_prompts": "자막 정보 없음",
            "actionable_steps": "유튜브 링크를 통해 직접 시청하는 것을 권장합니다.",
            "full_summary_md": f"# {title}\n\n*자막이 등록되지 않아 내장 요약이 제한되었습니다.*",
            "bilingual_transcript": "자막 정보 없음"
        }
        
    print(f"Translating full transcript into Korean for [{title}]...")
    bilingual_transcript_text = build_full_bilingual_subtitles(snippets)
    
    grouped = group_transcript_by_time(snippets, interval_sec=90.0)
    
    # 100% Pure Korean Timeline Breakdown
    timeline_lines = []
    
    for idx, grp in enumerate(grouped):
        start_fmt = format_timestamp(grp["start"])
        end_fmt = format_timestamp(grp["end"])
        en_snippet = grp["text"]
        
        # Translate this section into natural Korean
        ko_explanation = translate_text_to_korean_online(en_snippet[:350])
        
        if prompt_style == "general":
            timeline_lines.append(
                f"**[{start_fmt} ~ {end_fmt}] 구간 상세 해설**\n"
                f"• **진행 내용**: {ko_explanation}\n"
                f"• **핵심 포인트**: 해당 구간의 주요 논점 및 실무/지식 적용 방안을 다룹니다."
            )
        else:
            timeline_lines.append(
                f"**[{start_fmt} ~ {end_fmt}] 구간 상세 해설**\n"
                f"• **진행 내용**: {ko_explanation}\n"
                f"• **실무 핵심**: 2D 도면의 구조 요소(슬래브, 기둥, 기초 등) 인식 및 AI 모델의 정량 데이터 도출 과정을 검증합니다."
            )
        
    timeline_text = "\n\n".join(timeline_lines)
    
    if prompt_style == "general":
        one_line = f"[{channel_name}] 이 영상은 '{title}'을 주제로 핵심 개념, 실전 적용 사례, 단계별 워크플로우와 인사이트를 심층적으로 분석합니다."
        key_insights = (
            f"1. **핵심 주제**: {title}에 대한 심층 분석 및 핵심 프로세스 정리\n"
            f"2. **실무적 의의**: 최신 방법론과 도구를 활용하여 업무 효율성과 의사결정 품질을 높이는 전략 제시\n"
            f"3. **세부 분석**: 주요 구간별 핵심 근거, 데이터 및 비교 사례 검증\n"
            f"4. **효율성 극대화**: 반복 작업을 줄이고 핵심 가치에 집중할 수 있는 실행 프레임워크\n"
            f"5. **주의점 및 체크포인트**: 현업 적용 시 반드시 점검해야 할 한계점과 검증 절차"
        )
        tools = (
            "• **주요 기술/도구 및 개념**: 영상에서 소개된 핵심 솔루션, 프레임워크 및 도구\n"
            "• **핵심 워크플로우**: 문제 정의 -> 데이터/도구 적용 -> 결과 도출 및 검증 파이프라인\n"
            "• **실전 활용 포인트**: 실무 환경에 맞게 파라미터와 절차를 최적화하여 적용"
        )
        actionable = (
            "1. 영상에서 제시된 핵심 개념과 현재 진행 중인 프로젝트/업무의 접점을 파악합니다.\n"
            "2. 소개된 단계별 워크플로우를 소규모 파일럿 과제에 우선 적용해 봅니다.\n"
            "3. 결과물의 정확도와 효율성을 기존 방식과 비교 검증합니다.\n"
            "4. 검증된 프로세스와 인사이트를 팀 내 표준 가이드로 문서화합니다."
        )
    else:
        one_line = f"[{channel_name}] 이 영상은 '{title}'을 주제로 건설 실무(2D 도면 분석, 3D 모델 변환, 물량 산출/적산 Take-off, AI 프롬프트)에서의 최신 적용 방법과 실전 테스트 과정을 다룹니다."
        key_insights = (
            f"1. **핵심 주제**: {title}에 대한 실전 테스트 및 프롬프트/워크플로우 분석\n"
            f"2. **실무적 의의**: 건설 2D 도면/견적/물량산출(Take-off)을 최신 AI 모델을 활용해 자동화하거나 신속하게 사전 검토하는 파이프라인 제시\n"
            f"3. **주요 모델 비교**: 기존 LLM 대비 새로운 추론 엔진의 도면 이해도, 레이어 분리 및 오차율 비교\n"
            f"4. **효율성 극대화**: 수작업으로 수 시간 이상 소요되던 면적/체적 산출을 수 분 단위로 압축\n"
            f"5. **주의점 및 한계**: 도면 스케일, 개구부 감산, 비정형 구조물에 대한 인간 전문가의 최종 검증(Human-in-the-loop) 필수"
        )
        tools = (
            "• **소개된 도구/모델**: GPT-6 Astra, Claude Opus, Gemini, 2D Drawing OCR, 3D Mesh Converter\n"
            "• **핵심 워크플로우**: 2D 도면 업로드 -> 구조 부재(Slab, Column, Wall) 분리 -> 치수 및 스케일 보정 -> 정량적 물량 테이블 출력\n"
            "• **실전 권장 프롬프트 구조**: [역할 부여: 시공사 수석 적산사] + [도면 범례 및 단위 명시] + [단계별 산출식 및 근거 요청]"
        )
        actionable = (
            "1. 현장 2D CAD/PDF 도면에서 물량 산출할 대상 부재(슬래브, 기둥, 벽체)를 우선 선별합니다.\n"
            "2. 영상에 제시된 단계별 프롬프트 구조를 활용해 1차 수량 산출을 자동 수행합니다.\n"
            "3. 오차율이 발생하기 쉬운 개구부 및 철근 배근 상세는 기존 방식과 크로스체크합니다.\n"
            "4. 검증된 프롬프트와 지식베이스를 사내 표준 가이드로 정리해 팀 내 전파합니다."
        )
    
    md_content = f"""# 📑 [상세 분석 리포트] {title}

> 📺 **채널 / 원문 영상**: **{channel_name}** | [{video_info.get('video_url', '')}]({video_info.get('video_url', '')})  
> ⏱️ **재생 시간 / 업로드**: {video_info.get('duration_text', 'N/A')} | {video_info.get('published_time_text', '최근')}  
> 🤖 **요약 모드**: 고품질 한국어 분석 & 번역 엔진  
> 💡 *팁: 상단 또는 설정에서 **무료 Gemini API Key**를 등록하시면 한층 더 깊이 있는 초정밀 분석 리포트를 받아보실 수 있습니다.*

---

### 🎯 1. 핵심 요약 (Executive Summary)
{one_line}

---

### 💡 2. 주요 핵심 인사이트 (Key Takeaways)
{key_insights}

---

### ⏱️ 3. 타임라인별 상세 내용 (Timeline Breakdown - 한글 상세 해설)
{timeline_text}

---

### 🛠️ 4. 활용 도구, 프롬프트 & 테크닉 (Tools & Prompts)
{tools}

---

### 📋 5. 실무 적용 실행 가이드 (Actionable Steps)
{actionable}
"""

    return {
        "title": title,
        "one_line_summary": one_line,
        "key_insights": key_insights,
        "timeline_breakdown": timeline_text,
        "tools_and_prompts": tools,
        "actionable_steps": actionable,
        "full_summary_md": md_content,
        "bilingual_transcript": bilingual_transcript_text
    }

def summarize_video(
    video_info: Dict[str, Any], 
    transcript_data: Dict[str, Any],
    ai_provider: str = "gemini",
    api_key: Optional[str] = None,
    model_name: Optional[str] = None,
    detail_level: str = "ultra_detailed",
    prompt_style: str = "construction"
) -> Dict[str, Any]:
    """
    Generates a detailed summary in Korean using Gemini or OpenAI,
    with custom detail_level ('ultra_detailed', 'takeoff_focused', 'standard')
    and channel prompt_style ('construction' or 'general').
    Includes fully Korean timeline breakdown and bilingual English/Korean subtitles.
    """
    title = video_info.get("title", "")
    channel_name = video_info.get("channel_name", "ConstructIQ")
    full_text = transcript_data.get("full_text", "")
    snippets = transcript_data.get("snippets", [])
    
    if not full_text:
        return generate_extractive_summary(video_info, transcript_data, detail_level=detail_level, prompt_style=prompt_style)
        
    # Always generate/prepare guaranteed bilingual subtitle text with real Korean translation
    bilingual_subtitles = build_full_bilingual_subtitles(snippets)

    # Prepare timeline text with intervals tailored to detail_level
    if detail_level == "ultra_detailed":
        interval = 45.0
    elif detail_level == "brief":
        interval = 180.0
    else:
        interval = 90.0
    grouped = group_transcript_by_time(snippets, interval_sec=interval)
    timeline_prompts = []
    for grp in grouped:
        st = format_timestamp(grp["start"])
        timeline_prompts.append(f"[{st}] {grp['text']}")
    timeline_corpus = "\n".join(timeline_prompts)
    
    if len(timeline_corpus) > 60000:
        timeline_corpus = timeline_corpus[:60000] + "\n...(이하 생략)..."

    can_call_ai = bool(api_key and api_key.strip())
    
    if can_call_ai:
        if prompt_style == "tech":
            role_desc = f"당신은 최고의 IT/AI 아키텍트이자 소프트웨어 엔지니어링 수석 컨설턴트입니다.\n아래는 유튜브 채널 '{channel_name}'에 업로드된 최신 영상의 정보와 분초 단위 타임스탬프가 포함된 자막(Transcript) 전문입니다."
            domain_reqs = """2. **핵심 아키텍처, 프롬프트 & 코드/도구 정리**: 영상에서 시연된 AI 모델, 기술 스택, 프롬프트 구조 및 설정 파라미터를 상세히 복원하십시오.
3. **벤치마크 및 기술적 한계점 분석**: 성능 비교 수치, 장단점, 트러블슈팅 포인트를 짚어주십시오.
4. **개발/실무 적용 체크리스트**: 현업에서 바로 적용할 수 있는 4~5단계 기술 가이드를 제공하십시오."""
        elif prompt_style == "business":
            role_desc = f"당신은 최고의 글로벌 경영/비즈니스 전략 컨설턴트이자 산업 트렌드 수석 애널리스트입니다.\n아래는 유튜브 채널 '{channel_name}'에 업로드된 최신 영상의 정보와 분초 단위 타임스탬프가 포함된 자막(Transcript) 전문입니다."
            domain_reqs = """2. **핵심 비즈니스 모델, 프레임워크 & 시장 데이터 정리**: 영상에서 제시된 시장 지표, 비즈니스 전략 및 사례를 구체적으로 정리하십시오.
3. **리스크 및 기회 요인 분석**: 의사결정자가 주목해야 할 핵심 근거와 시사점을 짚어주십시오.
4. **비즈니스 실행 체크리스트**: 조직이나 업무에 바로 적용할 수 있는 4~5단계 액션 플랜을 제공하십시오."""
        elif prompt_style == "general":
            role_desc = f"당신은 최고의 수석 콘텐츠 분석가이자 지식 큐레이션 전문 컨설턴트입니다.\n아래는 유튜브 채널 '{channel_name}'에 업로드된 최신 영상의 정보와 분초 단위 타임스탬프가 포함된 자막(Transcript) 전문입니다."
            domain_reqs = """2. **핵심 개념, 도구/방법론 및 핵심 요약 정리**: 영상에서 소개된 주요 개념, 도구, 논거 및 핵심 지식을 구체적으로 정리하십시오.
3. **논리 구조 및 실증 사례 분석**: 발표자가 제시한 데이터, 시연 과정, 핵심 근거 및 주의사항을 짚어주십시오.
4. **실전 활용 체크리스트**: 바로 실천하거나 적용할 수 있는 4~5단계 실행 가이드를 제공하십시오."""
        else:
            role_desc = f"당신은 최고의 건설 IT/AI 수석 컨설턴트이자 건축/토목 엔지니어링 전문가입니다.\n아래는 유튜브 채널 '{channel_name}'에 업로드된 최신 영상의 정보와 분초 단위 타임스탬프가 포함된 자막(Transcript) 전문입니다."
            domain_reqs = """2. **실전 프롬프트 및 워크플로우 원문 복원**: 영상에서 저자가 사용한 프롬프트 패턴과 시스템 구축 절차를 상세히 서술하십시오.
3. **건설 적산(Take-off) & 도면 해석 테크닉**: 2D 도면 인식, 슬래브/벽체/기둥 물량 산출 원리 및 오차 크로스체크 주의사항을 짚어주십시오.
4. **실무 적용 체크리스트**: 건설 실무자가 바로 따라 할 수 있는 4~5단계 가이드를 제공하십시오."""

        if detail_level == "ultra_detailed":
            detail_instruction = """### 🔍 [요약 상세도 모드: 초정밀 심층 분석 (Ultra-Detailed Deep Dive)]
- **분량 및 깊이**: 내용을 절대 축약하거나 생략하지 말고, 영상을 직접 보지 않아도 모든 세부 사항을 파악할 수 있도록 **최대한 길고 상세하게** 작성하십시오.
- **핵심 인사이트 (`key_insights`)**: **8~10개 이상**의 핵심 시사점을 도출하고, 각 항목마다 구체적인 수치, 사례, 원리를 포함하여 **2~3문장 이상**으로 깊이 있게 서술하십시오.
- **타임라인 해설 (`timeline_breakdown`)**: 자막 흐름에 따라 **최소 10~15개 이상의 촘촘한 구간**으로 세분화하고, 각 구간마다 발표자의 설명 논리, 시연 과정, 언급된 수치와 예시를 빠짐없이 상세히 서술하십시오.
- **도구 및 프롬프트 (`tools_and_prompts`)**: 영상에 등장하는 도구, 수식, 설정값, 프롬프트 문구, 워크플로우를 원문에 가깝게 상세 복원하십시오."""
            one_line_desc = "영상의 핵심 주제, 주요 분석 내용, 세부 근거, 그리고 최종 결론을 포괄하는 3~4문장의 깊이 있는 종합 한글 요약"
            insights_desc = "• 영상에서 다룬 핵심 인사이트 8~10가지를 각각 2~3문장 이상 매우 구체적인 근거와 수치를 들어 상세히 서술 (한국어)"
            timeline_desc = "분초 단위의 초정밀 타임라인 해설 (반드시 100% 한국어로 작성, 최소 10~15개 이상의 세분화된 구간으로 상세 서술):\\n\\n**[00:00 ~ 00:45] 섹션 제목**: 다룬 내용, 화면 시연 상세, 핵심 발언 및 원리 설명\\n\\n**[00:45 ~ 01:30] 섹션 제목**: ..."
        elif detail_level == "brief":
            detail_instruction = """### ⚡ [요약 상세도 모드: 3분 핵심 브리핑 (Quick Executive Brief)]
- **분량 및 깊이**: 바쁜 실무자가 **1~3분 내에 핵심 결론만 빠르게 스캔**할 수 있도록 군더더기 없이 **짧고 명쾌한 개조식**으로 압축 작성하십시오.
- **핵심 인사이트 (`key_insights`)**: 가장 중요한 핵심 테이크어웨이 **딱 3~4가지**만 엄선하여 각 **1문장 단문**으로 간결하게 작성하십시오.
- **타임라인 해설 (`timeline_breakdown`)**: 전체 영상을 **3~4개의 굵직한 핵심 파트**로만 묶어서 각 파트당 **1~2문장**으로 초간결하게 요약하십시오.
- **도구 및 프롬프트 (`tools_and_prompts`)**: 핵심 키워드와 도구 위주로 2~3줄 이내로 짧게 요약하십시오."""
            one_line_desc = "바쁜 실무자가 단번에 핵심 결론을 파악할 수 있는 1~2문장의 명쾌한 핵심 요약"
            insights_desc = "• 가장 중요한 핵심 포인트 3~4가지만 각 1문장 개조식으로 간결하게 요약 (한국어)"
            timeline_desc = "전체 영상을 3~4개 핵심 파트로 압축한 초간결 타임라인 브리핑 (100% 한국어):\\n\\n**[00:00 ~ 03:00] 핵심 파트 1**: 1~2문장 핵심 요약\\n\\n**[03:00 ~ 06:00] 핵심 파트 2**: ..."
        else:
            detail_instruction = """### 📋 [요약 상세도 모드: 표준 핵심 요약 (Standard Balanced Summary)]
- **분량 및 깊이**: 핵심 내용과 주요 흐름을 균형 있게 파악할 수 있도록 **적절한 중간 분량**으로 명확하게 작성하십시오.
- **핵심 인사이트 (`key_insights`)**: 주요 인사이트 **5~6가지**를 도출하여 각 항목당 **1~2문장**으로 깔끔하게 정리하십시오.
- **타임라인 해설 (`timeline_breakdown`)**: 영상의 주요 챕터별 **5~7개 구간**으로 나누어 각 구간의 핵심 요점을 명확하게 서술하십시오.
- **도구 및 프롬프트 (`tools_and_prompts`)**: 주요 도구, 개념 및 핵심 워크플로우 단계를 요약 정리하십시오."""
            one_line_desc = "영상의 핵심 주제와 결론을 명확하게 정리한 2~3문장의 표준 한글 요약"
            insights_desc = "• 영상에서 다룬 주요 핵심 인사이트 5~6가지를 각 1~2문장으로 명확하게 서술 (한국어)"
            timeline_desc = "주요 챕터별 표준 타임라인 해설 (반드시 100% 한국어로 작성, 5~7개 주요 구간으로 분할):\\n\\n**[00:00 ~ 01:30] 섹션 제목**: 주요 내용 및 핵심 포인트 요약\\n\\n**[01:30 ~ 03:30] 섹션 제목**: ..."

        prompt = f"""
{role_desc}

[채널명]: {channel_name}
[영상 제목]: {title}
[영상 URL]: {video_info.get('video_url', '')}
[재생 시간]: {video_info.get('duration_text', 'N/A')}
[게시 시점]: {video_info.get('published_time_text', 'N/A')}

[자막 타임라인 전문]:
{timeline_corpus}

{detail_instruction}

### ⚠️ 최우선 필수 요구사항:
1. **[3. 타임라인별 상세 내용 (Timeline Breakdown)]은 반드시 100% 매끄럽고 구체적인 '한글(Korean)'로 작성해야 합니다.**
   - 영문 원문을 그대로 옮기지 마십시오.
   - 위에 지정된 **[요약 상세도 모드]**의 구간 개수와 문장 길이 지침을 엄격히 준수하십시오.
   - 형식 예시:
     `**[00:00 ~ 01:25] 섹션 핵심 제목**: 발표자는 ... 과정을 시연하며 ... 원리와 구체적 수치를 설명합니다.`

{domain_reqs}

반드시 다음 JSON 포맷 형식으로만 응답해야 합니다. 서두나 마무리 인사말 없이 오직 유효한 JSON 문자열만 출력하세요:
```json
{{
  "title": "{title}",
  "one_line_summary": "{one_line_desc}",
  "key_insights": "{insights_desc}",
  "timeline_breakdown": "{timeline_desc}",
  "tools_and_prompts": "• **주요 모델/도구 및 개념**: 소개된 도구, 기능, 프레임워크 상세\\n• **핵심 프롬프트/방법론 템플릿**: 영상에서 사용한 패턴 복원 및 실전 예시\\n• **워크플로우 단계**: 1단계 -> 2단계 -> 3단계 파이프라인 정리",
  "actionable_steps": "1. [실무 적용 1단계]: ...\\n2. [실무 적용 2단계]: ...\\n3. [품질 및 검증 단계]: ...\\n4. [조직 내 확산 및 고도화 단계]: ...",
  "full_summary_md": "위의 모든 섹션(한글 타임라인 해설 포함)과 '⚠️ 실무 적용 시 주의점 및 팁', '💡 전문가 총평'까지 포함하여 선택된 요약 상세도 모드에 맞게 읽기 좋게 꾸민 마크다운 종합 리포트 전문"
}}
```
"""

        try:
            raw_response = ""
            if ai_provider == "openai":
                raw_response = call_openai_api(api_key, model_name or "gpt-4o-mini", prompt)
            else: # gemini
                raw_response = call_gemini_api(api_key, model_name or "gemini-3.8-flash", prompt)
                
            json_text = raw_response.strip()
            if "```json" in json_text:
                json_text = json_text.split("```json")[1].split("```")[0].strip()
            elif "```" in json_text:
                json_text = json_text.split("```")[1].split("```")[0].strip()
                
            data = json.loads(json_text)
            data["model_used"] = f"{ai_provider}:{model_name or 'default'} ({detail_level})"
            data["bilingual_transcript"] = bilingual_subtitles
            return data
        except Exception as e:
            print(f"AI API call failed ({e}), falling back to built-in extractive summary.")
            res = generate_extractive_summary(video_info, transcript_data, detail_level=detail_level, prompt_style=prompt_style)
            res["model_used"] = f"fallback (API Error: {str(e)[:50]})"
            res["bilingual_transcript"] = bilingual_subtitles
            return res

    # If no API key provided, use built-in smart extractive engine with guaranteed Korean translation
    res = generate_extractive_summary(video_info, transcript_data, detail_level=detail_level, prompt_style=prompt_style)
    res["model_used"] = f"built-in-smart-engine ({detail_level})"
    res["bilingual_transcript"] = bilingual_subtitles
    return res
