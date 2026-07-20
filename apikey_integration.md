# Pakistan TradeLink — AI Chatbot Integration Plan
## Groq (Llama 3.3 70B) · Floating Panel · Full Map Control
### April 2026

---

## Overview

The chatbot is not a simple Q&A box. It is a **command interface** for the entire platform. A user can type in plain English and the bot will:

- Answer risk and hazard questions using live DB data
- **Fly the map** to any asset
- **Plot a route** between facilities on the map
- **Run a scenario simulation** and display results
- **Show historical hazard state** by moving the time slider
- Explain what it's doing step by step

---

## Technology Choice: Groq

| Option | Model | Speed | Free Tier | Best For |
|--------|-------|-------|-----------|----------|
| **Groq** ✅ | Llama 3.3 70B | 500–800 tok/s | 14,400 req/day | This project |
| Gemini Flash | Gemini 1.5 Flash | 200–400 tok/s | $300 credit | Backup |
| OpenRouter | Any | Varies | Pay-as-go | Multi-model |

**Why Groq for this project:**
- Llama 3.3 70B follows structured JSON instructions reliably (critical for map commands)
- Response feels instant to users — no waiting for the bot to "think"
- Free tier covers all FYP demo usage comfortably
- API is OpenAI-compatible — simple to call from Django

**Get your API key:** https://console.groq.com → Create API key → add to `.env`

```
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Architecture: How It All Connects

```
User types: "Show me the safest route from Lahore Dryport to Karachi Port"
                                    │
                                    ▼
                         React Frontend (ChatPanel.jsx)
                         Sends: { message, conversation_history }
                                    │
                                    ▼
                    Django Backend  POST /api/chat/
                         1. Fetch live context from DB:
                            - kpis_latest.json
                            - hazard summary (flood CRITICAL, 919 triggered)
                            - risk distribution (240 CRITICAL nodes)
                            - top 5 chokepoints
                            - relevant scenario results
                         2. Build system prompt with context
                         3. Call Groq API (Llama 3.3 70B)
                         4. Parse JSON response
                         5. Return: { text, action }
                                    │
                                    ▼
                         React Frontend receives response
                         - Display text in chat bubble
                         - Execute action:
                           • flyTo(asset)         → map flies to asset
                           • showRoute(from, to)  → calls route API + draws on map
                           • runScenario(targets) → calls scenario API + shows results
                           • moveSlider(ts)       → moves time slider to timestamp
                           • highlightAssets(ids) → pulses named assets on map
```

---

## Backend: Django Endpoint

### File: `backend/config/api_views.py` — add this function

```python
import os
import json
import requests
from django.views.decorators.http import require_http_methods
from django.views.decorators.csrf import csrf_exempt

GROQ_API_KEY = os.environ.get('GROQ_API_KEY')
GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
GROQ_MODEL = 'llama-3.3-70b-versatile'

def build_system_prompt(context: dict) -> str:
    """Build the system prompt with live data injected."""
    
    kpis = context.get('kpis', {})
    hazard = context.get('hazard', {})
    risk = context.get('risk', {})
    facilities = context.get('facilities', [])
    chokepoints = context.get('chokepoints', [])
    
    facility_list = '\n'.join([
        f"  - {f['asset_id']}: {f['display_name']} ({f['node_type']}) — risk: {f.get('risk_tier','?')}"
        for f in facilities[:42]
    ])
    
    chokepoint_list = '\n'.join([
        f"  - {c['asset_id']}: {c['display_name']} (betweenness: {c.get('betweenness_centrality',0):.4f})"
        for c in chokepoints[:5]
    ])
    
    flood = hazard.get('flood', {})
    cyclone = hazard.get('cyclone', {})
    strike = hazard.get('strike', {})
    accident = hazard.get('accident', {})
    
    nodes = risk.get('nodes', {})
    
    return f"""You are the Pakistan TradeLink Risk Assistant — an AI that helps investors, 
logistics managers, and truck drivers understand Pakistan's freight network risk in real time.

## YOUR CAPABILITIES
You can answer questions AND trigger map actions. Always respond in JSON with this exact structure:
{{
  "text": "Your conversational response here",
  "action": null  OR one of the action objects below
}}

## ACTION TYPES (use when appropriate)
Fly to an asset:
  {{"type": "flyTo", "asset_id": "port_1", "name": "Karachi Port"}}

Show a route on the map:
  {{"type": "showRoute", "from": "dryport_5", "to": "port_1", "mode": "safest"}}
  mode options: "fastest" | "safest" | "balanced"

Run a scenario simulation:
  {{"type": "runScenario", "targets": ["port_1"], "scenario_type": "node_removal", "severity": 1.0}}
  scenario_type options: "node_removal" | "edge_closure" | "capacity_reduction" | "flood_scenario" | "cyclone_scenario" | "strike_scenario" | "accident_scenario"

Move the time slider:
  {{"type": "moveSlider", "timestamp": "20260421_0600"}}

Highlight specific assets:
  {{"type": "highlightAssets", "asset_ids": ["port_1", "port_2"], "color": "CRITICAL"}}

No action needed (pure Q&A):
  "action": null

## LIVE SYSTEM DATA (as of last pipeline run)
**Network:** {kpis.get('total_nodes', 0):,} nodes · {kpis.get('total_edges', 0):,} edges · 40,000 km · 861 trade corridors · 42 facilities

**Current Hazard Status:**
- Flood:    {flood.get('status','OK')} — {flood.get('triggered',0)} nodes triggered — max {round(float(flood.get('max_score',0))*100)}%
- Cyclone:  {cyclone.get('status','OK')} — {cyclone.get('triggered',0)} nodes triggered
- Strike:   {strike.get('status','OK')} — {strike.get('triggered',0)} nodes triggered
- Accident: {accident.get('status','OK')} — {accident.get('triggered',0)} nodes triggered

**Current Risk Distribution (nodes):**
- CRITICAL: {nodes.get('critical', 0):,}
- HIGH:     {nodes.get('high', 0):,}
- MEDIUM:   {nodes.get('medium', 0):,}
- LOW:      {nodes.get('low', 0):,}

**Top Chokepoints (by network criticality):**
{chokepoint_list}

**All 42 Facilities:**
{facility_list}

## RULES
- Always respond in valid JSON with "text" and "action" keys
- Be direct and practical — users need actionable information
- For route questions: always trigger showRoute action
- For "what if X closes": always trigger runScenario action  
- For "show me X": always trigger flyTo action
- For risk questions: cite current numbers from the live data above
- For truckers: recommend "safest" route when any CRITICAL/HIGH hazard is active
- Never make up asset_ids — only use the facilities listed above
- If you don't know something, say so and suggest what the user can do
"""

@csrf_exempt
@require_http_methods(['POST'])
def chat_view(request):
    """
    POST /api/chat/
    Body: { "message": str, "history": list[{role, content}] }
    Returns: { "text": str, "action": dict|null }
    """
    try:
        body = json.loads(request.body)
        user_message = body.get('message', '').strip()
        history = body.get('history', [])[-10:]  # keep last 10 turns
        
        if not user_message:
            return JsonResponse({'error': 'No message provided'}, status=400)
        
        # ── Build live context from DB ───────────────────────────────────
        context = _build_live_context()
        
        # ── Build messages array ─────────────────────────────────────────
        messages = [
            {'role': 'system', 'content': build_system_prompt(context)}
        ]
        
        # Add conversation history
        for turn in history:
            messages.append({'role': turn['role'], 'content': turn['content']})
        
        # Add current user message
        messages.append({'role': 'user', 'content': user_message})
        
        # ── Call Groq ────────────────────────────────────────────────────
        response = requests.post(
            GROQ_URL,
            headers={
                'Authorization': f'Bearer {GROQ_API_KEY}',
                'Content-Type': 'application/json',
            },
            json={
                'model': GROQ_MODEL,
                'messages': messages,
                'temperature': 0.3,      # lower = more consistent JSON output
                'max_tokens': 1024,
                'response_format': {'type': 'json_object'},  # force JSON
            },
            timeout=30
        )
        response.raise_for_status()
        
        raw = response.json()
        content = raw['choices'][0]['message']['content']
        
        # ── Parse the JSON response ──────────────────────────────────────
        try:
            parsed = json.loads(content)
            text = parsed.get('text', content)
            action = parsed.get('action', None)
        except json.JSONDecodeError:
            # Fallback: treat entire response as text
            text = content
            action = None
        
        return JsonResponse({'text': text, 'action': action})
    
    except requests.Timeout:
        return JsonResponse({'text': 'The AI took too long to respond. Please try again.', 'action': None})
    except Exception as e:
        return JsonResponse({'text': f'Error: {str(e)}', 'action': None}, status=500)


def _build_live_context() -> dict:
    """Pull live data from DB/files for the system prompt."""
    from django.db import connection
    import os
    
    context = {
        'kpis': {},
        'hazard': {},
        'risk': {'nodes': {}},
        'facilities': [],
        'chokepoints': [],
    }
    
    # Load KPIs from latest JSON file
    kpis_path = os.path.join(settings.BASE_DIR.parent, 'pipelines', 'outputs', 'kpis_latest.json')
    if os.path.exists(kpis_path):
        with open(kpis_path) as f:
            kpis_data = json.load(f)
        context['kpis'] = kpis_data
        
        # Parse hazard summary from KPIs
        context['hazard'] = {
            'flood':    {'status': kpis_data.get('hazard_flood_status', 'OK'),
                         'triggered': kpis_data.get('flood_triggered_nodes', 0),
                         'max_score': kpis_data.get('max_composite_hazard', 0)},
            'cyclone':  {'status': kpis_data.get('hazard_cyclone_status', 'OK'),
                         'triggered': kpis_data.get('cyclone_triggered_nodes', 0)},
            'strike':   {'status': kpis_data.get('hazard_strike_status', 'OK'),
                         'triggered': kpis_data.get('strike_triggered_nodes', 0)},
            'accident': {'status': kpis_data.get('hazard_accident_status', 'OK'),
                         'triggered': kpis_data.get('accident_triggered_nodes', 0)},
        }
    
    # Load risk summary
    risk_path = os.path.join(settings.BASE_DIR.parent, 'pipelines', 'outputs', 'risk_summary.json')
    if os.path.exists(risk_path):
        with open(risk_path) as f:
            risk_data = json.load(f)
        dist = risk_data.get('risk_distribution', {}).get('nodes', {})
        context['risk']['nodes'] = {
            'critical': dist.get('CRITICAL', 0),
            'high':     dist.get('HIGH', 0),
            'medium':   dist.get('MEDIUM', 0),
            'low':      dist.get('LOW', 0),
        }
    
    # Load facility list from DB
    with connection.cursor() as cur:
        cur.execute("""
            SELECT n.asset_id, 
                   COALESCE(n.display_name, n.name, n.asset_id) as display_name,
                   n.node_type,
                   r.risk_tier,
                   r.composite_risk
            FROM network_nodes n
            LEFT JOIN risk_nodes_latest r ON r.asset_id = n.asset_id
            WHERE n.node_type IN ('port', 'dryport', 'station', 'rail_station')
            ORDER BY r.composite_risk DESC NULLS LAST
            LIMIT 42
        """)
        rows = cur.fetchall()
        context['facilities'] = [
            {'asset_id': r[0], 'display_name': r[1], 'node_type': r[2],
             'risk_tier': r[3], 'composite_risk': float(r[4]) if r[4] else 0}
            for r in rows
        ]
    
    # Load top chokepoints
    with connection.cursor() as cur:
        cur.execute("""
            SELECT n.asset_id,
                   COALESCE(n.display_name, n.name, n.asset_id) as display_name,
                   n.betweenness_centrality,
                   r.risk_tier
            FROM network_nodes n
            LEFT JOIN risk_nodes_latest r ON r.asset_id = n.asset_id
            WHERE r.is_chokepoint = true
            ORDER BY n.betweenness_centrality DESC NULLS LAST
            LIMIT 5
        """)
        rows = cur.fetchall()
        context['chokepoints'] = [
            {'asset_id': r[0], 'display_name': r[1], 
             'betweenness_centrality': float(r[2]) if r[2] else 0, 'risk_tier': r[3]}
            for r in rows
        ]
    
    return context
```

### Add to `urls.py`

```python
from .api_views import chat_view

urlpatterns = [
    # ... existing routes ...
    path('api/chat/', chat_view, name='chat'),
]
```

---

## Frontend: ChatPanel Component

### File: `frontend/src/components/chat/ChatPanel.jsx`

```jsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ── Types of actions the bot can trigger ─────────────────────────────────────
// { type: 'flyTo',         asset_id, name }
// { type: 'showRoute',     from, to, mode }
// { type: 'runScenario',   targets[], scenario_type, severity }
// { type: 'moveSlider',    timestamp }
// { type: 'highlightAssets', asset_ids[], color }

// ── Suggested prompts shown before user types ─────────────────────────────────
const SUGGESTIONS = [
  "What's the current flood situation?",
  "Show me the safest route from Lahore Dryport to Karachi Port",
  "Which assets are CRITICAL risk right now?",
  "What happens if Karachi Port closes?",
  "Fly me to the top chokepoint",
  "Show yesterday's hazard state",
];

// ── Action chip shown in chat message after a map action ──────────────────────
function ActionChip({ action }) {
  if (!action) return null;
  
  const labels = {
    flyTo:           `📍 Flying to ${action.name || action.asset_id}`,
    showRoute:       `🛣 Showing route on map`,
    runScenario:     `⚠️ Running scenario simulation`,
    moveSlider:      `⏱ Moving time slider to ${action.timestamp}`,
    highlightAssets: `✨ Highlighting ${action.asset_ids?.length} assets`,
  };
  
  return (
    <div className="mt-2 inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 
                    rounded-full px-3 py-1 text-xs text-blue-700 font-semibold">
      {labels[action.type] || `Action: ${action.type}`}
    </div>
  );
}

// ── Single chat message ────────────────────────────────────────────────────────
function ChatMessage({ msg }) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  
  if (isSystem) return (
    <div className="text-center text-xs text-gray-400 py-2 italic">{msg.content}</div>
  );
  
  return (
    <div className={`flex gap-2.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center 
                        flex-shrink-0 mt-0.5 text-xs">
          🤖
        </div>
      )}
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
          isUser 
            ? 'bg-slate-900 text-white rounded-br-sm' 
            : 'bg-gray-100 text-slate-800 rounded-bl-sm'
        }`}>
          {msg.content}
        </div>
        {msg.action && <ActionChip action={msg.action} />}
        <div className="text-xs text-gray-400 mt-1 px-1">
          {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-full bg-amber-500 flex items-center justify-center 
                        flex-shrink-0 mt-0.5 text-xs text-white font-bold">
          U
        </div>
      )}
    </div>
  );
}

// ── Main ChatPanel ─────────────────────────────────────────────────────────────
export default function ChatPanel({ isOpen, onClose, onAction }) {
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [showSuggestions, setShowSuggestions] = useState(true);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 300);
  }, [isOpen]);

  const sendMutation = useMutation({
    mutationFn: async (message) => {
      const history = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));
      
      const res = await axios.post(`${API_URL}/api/chat/`, { message, history });
      return res.data;
    },
    onSuccess: (data, message) => {
      const botMsg = {
        role: 'assistant',
        content: data.text,
        action: data.action || null,
        ts: Date.now(),
      };
      setMessages(prev => [...prev, botMsg]);
      
      // Execute map action if present
      if (data.action) {
        onAction(data.action);
      }
    },
    onError: () => {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble connecting. Please try again.',
        ts: Date.now(),
      }]);
    }
  });

  const handleSend = useCallback((text) => {
    const message = (text || input).trim();
    if (!message || sendMutation.isPending) return;
    
    setShowSuggestions(false);
    setMessages(prev => [...prev, { role: 'user', content: message, ts: Date.now() }]);
    setInput('');
    sendMutation.mutate(message);
  }, [input, sendMutation]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 w-96 h-[560px] bg-white rounded-2xl 
                    shadow-2xl border border-gray-200 flex flex-col overflow-hidden
                    animate-in slide-in-from-bottom-4 duration-200">
      
      {/* Header */}
      <div className="bg-slate-900 px-4 py-3.5 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <div>
            <div className="text-white font-bold text-sm">Risk Assistant</div>
            <div className="text-white/50 text-xs">Powered by Groq · Llama 3.3 70B</div>
          </div>
        </div>
        <button onClick={onClose} 
                className="text-white/60 hover:text-white text-xl leading-none transition">
          ×
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
        
        {/* Welcome state */}
        {messages.length === 0 && (
          <div className="text-center py-4">
            <div className="text-3xl mb-3">🤖</div>
            <div className="font-bold text-slate-900 text-sm mb-1">Pakistan TradeLink Assistant</div>
            <div className="text-gray-500 text-xs leading-relaxed">
              Ask me about hazards, routes, and risk. I can control the map for you.
            </div>
          </div>
        )}

        {/* Suggestions */}
        {showSuggestions && messages.length === 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Try asking:
            </div>
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => handleSend(s)}
                      className="w-full text-left text-xs px-3 py-2.5 rounded-xl border 
                                 border-gray-200 text-slate-700 hover:bg-gray-50 hover:border-gray-300 
                                 transition leading-relaxed">
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Chat messages */}
        {messages.map((msg, i) => (
          <ChatMessage key={i} msg={msg} />
        ))}

        {/* Typing indicator */}
        {sendMutation.isPending && (
          <div className="flex gap-2.5 justify-start">
            <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center 
                            flex-shrink-0 text-xs">🤖</div>
            <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1.5 items-center">
                <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" 
                     style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" 
                     style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" 
                     style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-gray-100 flex-shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about risk, routes, or scenarios..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-200 px-3.5 py-2.5 
                       text-sm text-slate-800 placeholder-gray-400 focus:outline-none 
                       focus:border-slate-400 focus:ring-1 focus:ring-slate-200 
                       max-h-24 leading-relaxed"
            style={{ minHeight: '40px' }}
            onInput={e => {
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px';
            }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || sendMutation.isPending}
            className="w-10 h-10 bg-slate-900 hover:bg-slate-700 disabled:bg-gray-200 
                       disabled:text-gray-400 text-white rounded-xl flex items-center 
                       justify-center transition flex-shrink-0"
          >
            {sendMutation.isPending ? (
              <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            )}
          </button>
        </div>
        <div className="text-xs text-gray-400 mt-1.5 text-center">
          Enter to send · Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}
```

---

## Frontend: Floating Toggle Button

### File: `frontend/src/components/chat/ChatButton.jsx`

```jsx
export default function ChatButton({ isOpen, onClick, hasUnread }) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-4 right-4 z-50 w-14 h-14 bg-slate-900 hover:bg-slate-700 
                 text-white rounded-full shadow-2xl flex items-center justify-center 
                 transition-all duration-200 hover:scale-105"
    >
      {isOpen ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      ) : (
        <span className="text-2xl">🤖</span>
      )}
      
      {/* Unread dot */}
      {hasUnread && !isOpen && (
        <span className="absolute top-0 right-0 w-3.5 h-3.5 bg-red-500 rounded-full 
                         border-2 border-white animate-pulse" />
      )}
    </button>
  );
}
```

---

## Frontend: Wiring the Action Handler in Dashboard.jsx

This is the most important part. The `onAction` callback from `ChatPanel` must be connected to your map instance and existing state.

```jsx
// In Dashboard.jsx — add this handler
const handleChatAction = useCallback(async (action) => {
  if (!action || !mapRef.current) return;
  
  switch (action.type) {
    
    // ── Fly map to an asset ──────────────────────────────────────────────
    case 'flyTo': {
      // Find the facility's coordinates from already-loaded facilityNodes
      const feat = facilityNodes?.features?.find(
        f => f.properties.asset_id === action.asset_id
      );
      if (feat) {
        const [lon, lat] = feat.geometry.coordinates;
        mapRef.current.flyTo({ center: [lon, lat], zoom: 12, duration: 1500 });
        setSelectedNode(feat.properties);  // open node detail panel
      }
      break;
    }
    
    // ── Show a route on the map ──────────────────────────────────────────
    case 'showRoute': {
      // Call your existing route API
      try {
        const res = await networkApi.getAdvancedRoutes(
          action.from, 
          action.to, 
          action.mode || 'any'
        );
        // Set route result state — this triggers your existing route rendering
        setActiveRoute({ from: action.from, to: action.to, result: res.data });
        // Navigate to route planner page with pre-filled params
        // OR draw route inline on the dashboard map
        navigate(`/routes?from=${action.from}&to=${action.to}&mode=${action.mode}`);
      } catch (e) {
        console.error('Route action failed', e);
      }
      break;
    }
    
    // ── Run a scenario simulation ────────────────────────────────────────
    case 'runScenario': {
      // Navigate to scenario page with pre-filled targets
      navigate(`/scenario?targets=${action.targets.join(',')}&type=${action.scenario_type}`);
      break;
    }
    
    // ── Move the time slider ─────────────────────────────────────────────
    case 'moveSlider': {
      setHistoryMode(true);
      const idx = (timestamps || []).indexOf(action.timestamp);
      if (idx >= 0) setHistoryIdx(idx);
      break;
    }
    
    // ── Highlight specific assets ────────────────────────────────────────
    case 'highlightAssets': {
      setHighlightedAssets(action.asset_ids || []);
      // Add a temporary highlight layer on the map
      if (mapRef.current.getSource('chat-highlight')) {
        const highlighted = facilityNodes?.features?.filter(
          f => action.asset_ids.includes(f.properties.asset_id)
        );
        mapRef.current.getSource('chat-highlight').setData({
          type: 'FeatureCollection',
          features: highlighted || []
        });
      }
      // Auto-clear after 8 seconds
      setTimeout(() => setHighlightedAssets([]), 8000);
      break;
    }
  }
}, [mapRef, facilityNodes, timestamps, navigate]);

// Add highlight layer to map (in your map init useEffect, after 'load'):
mapRef.current.addSource('chat-highlight', { 
  type: 'geojson', 
  data: { type: 'FeatureCollection', features: [] } 
});
mapRef.current.addLayer({
  id: 'chat-highlight-layer',
  type: 'circle',
  source: 'chat-highlight',
  paint: {
    'circle-radius': 20,
    'circle-color': '#FCD34D',
    'circle-opacity': 0,
    'circle-stroke-width': 3,
    'circle-stroke-color': '#F59E0B',
    'circle-stroke-opacity': 0.9,
  }
});
// Animate the highlight ring
// Use CSS animation via opacity cycling or MapLibre camera
```

### Mounting ChatPanel and ChatButton in Dashboard.jsx

```jsx
// Add to Dashboard.jsx state
const [chatOpen, setChatOpen] = useState(false);

// Add to Dashboard.jsx JSX return, just before closing </div>:
<>
  <ChatPanel
    isOpen={chatOpen}
    onClose={() => setChatOpen(false)}
    onAction={handleChatAction}
  />
  <ChatButton
    isOpen={chatOpen}
    onClick={() => setChatOpen(p => !p)}
  />
</>
```

---

## Example Conversations

### Trucker asking for a route

```
User:   I need to go from Lahore Dryport to Karachi Port, what's safe right now?

Bot:    Right now there's a CRITICAL flood alert active — 919 nodes triggered and 
        the M-9 (Karachi-Hyderabad Motorway) is in a high-risk zone at 88% 
        hazard intensity.

        For today's conditions, I recommend the Safest route which avoids the 
        flood-affected corridor. It adds about 3.5 hours but keeps you clear of 
        the M-9 risk zone.

        Showing it on the map now.
        
        [action: showRoute from=dryport_5 to=port_1 mode=safest]
        [🛣 Showing route on map]
```

### Investor asking about risk

```
User:   What's the overall risk situation?

Bot:    The network is under active stress today:

        🔴 CRITICAL: 240 nodes — primarily from flood exposure
        🟠 HIGH: 2,677 nodes
        🌊 Flood is CRITICAL at 88% max intensity — 919 nodes triggered
        
        All other hazards (cyclone, strike, accident) are currently OK.
        
        The top chokepoint is Karachi Port — highest betweenness centrality 
        in the network. A closure there would affect 38 of 861 trade corridors.
        
        Want me to show you the most at-risk facilities on the map?
```

### Manager simulating a closure

```
User:   What happens if Port Qasim closes?

Bot:    Running a node removal simulation for Port Qasim (port_2)...

        [action: runScenario targets=[port_2] scenario_type=node_removal severity=1.0]
        [⚠️ Running scenario simulation]

        Taking you to the Scenario Simulator now with Port Qasim selected.
        The simulation will show which corridors lose access and the estimated 
        economic impact in USD.
```

---

## Environment Setup Checklist

### Backend `.env`

```bash
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Optional backup:
# GEMINI_API_KEY=AIzaxxx
```

### Install dependencies

```bash
# Backend (Django side)
pip install requests  # already installed in most setups
# No Groq SDK needed — we use raw HTTP with requests

# Frontend
npm install @tanstack/react-query  # already installed
# No extra packages needed for the chat UI
```

### Verify Groq access

```bash
curl -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b-versatile",
    "messages": [{"role": "user", "content": "Say hello in JSON: {\"text\": \"...\"}"}],
    "response_format": {"type": "json_object"}
  }'
# Should return valid JSON within 1-2 seconds
```

---

## Fallback: If Groq is Down

Add this to `api_views.py`:

```python
FALLBACK_RESPONSES = {
    'route':    "I'd suggest using the Route Planner page to find the safest route given current conditions.",
    'risk':     "Check the Risk Map — the KPI panel on the right shows current hazard levels.",
    'scenario': "Use the Scenario Simulator page — select your target facility and click Run.",
    'default':  "I'm having trouble connecting right now. Please try again in a moment.",
}

def _get_fallback_response(message: str) -> str:
    msg = message.lower()
    if any(w in msg for w in ['route', 'path', 'travel', 'from', 'to']):
        return FALLBACK_RESPONSES['route']
    if any(w in msg for w in ['risk', 'hazard', 'flood', 'safe', 'critical']):
        return FALLBACK_RESPONSES['risk']
    if any(w in msg for w in ['close', 'scenario', 'what if', 'simulate']):
        return FALLBACK_RESPONSES['scenario']
    return FALLBACK_RESPONSES['default']
```

---

## What the Bot Does NOT Do

To keep the scope manageable for the FYP demo:

- Does NOT query the DB live per-message (context is built once per request from cached JSON files)
- Does NOT stream responses token-by-token (full response returns at once — still fast with Groq)
- Does NOT remember conversations between page refreshes (history is in React state only)
- Does NOT generate charts or visualizations (it triggers the existing map tools)
- Does NOT handle voice input (text only for now)

---

*Pakistan TradeLink · Chatbot Integration Plan v1.0 · April 2026*
*Stack: Groq Llama 3.3 70B · Django backend · React frontend · Full map control*