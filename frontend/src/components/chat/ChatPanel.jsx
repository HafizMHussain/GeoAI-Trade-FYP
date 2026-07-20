/**
 * ChatPanel — floating AI assistant powered by Groq Llama 3.3 70B.
 *
 * Capabilities triggered via onAction callback:
 *   flyTo         → navigate to /map?flyTo=asset_id
 *   showRoute     → navigate to /routes?from=X&to=Y&mode=Z
 *   runScenario   → navigate to /scenario?target=X&type=T
 *   highlightAssets → navigate to /map?highlight=id1,id2
 *   moveSlider    → navigate to /map?slider=timestamp
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { chatApi } from '../../api/networkApi';

// ── Suggested starter prompts ─────────────────────────────────────────────────
const SUGGESTIONS = [
  "What's the current flood situation?",
  "Safest route from Lahore ICD to Karachi Port",
  "How much does it cost to ship from Karachi to Lahore?",
  "What if Karachi Port closes? Run a scenario",
  "Which facilities are at highest risk right now?",
  "Fastest route from Islamabad ICD to Karachi Port",
];

// ── Action chip + journey card ────────────────────────────────────────────────

// Map asset_id to a human name using the enriched action fields
function resolveLabel(id, name) {
  if (name && name !== id) return name;
  // Friendly fallback from known patterns
  const map = {
    port_1: 'Bin Qasim Port', port_2: 'Gwadar Port', port_3: 'Karachi Port',
    dryport_1: 'Faisalabad ICD', dryport_2: 'Gilgit ICD', dryport_3: 'Islamabad ICD',
    dryport_4: 'Karachi ICD',   dryport_5: 'Lahore ICD', dryport_6: 'Peshawar ICD',
    dryport_7: 'Raiwind ICD',   dryport_8: 'Sialkot ICD', dryport_9: 'Multan ICD',
  };
  return map[id] || id;
}

function ActionChip({ action }) {
  if (!action) return null;
  const fromName = resolveLabel(action.from, action.from_name);
  const toName   = resolveLabel(action.to,   action.to_name);
  const flyName  = resolveLabel(action.asset_id, action.name);
  const scenarioTargets = (action.target_names || action.targets || []).map((n, i) =>
    resolveLabel(action.targets?.[i], n)).join(', ');

  const LABELS = {
    flyTo:           `📍 Flying to ${flyName}`,
    showRoute:       `🛣 ${fromName} → ${toName}`,
    runScenario:     `⚡ Scenario: ${scenarioTargets || 'selected targets'}`,
    moveSlider:      `⏱ Time slider → ${action.timestamp}`,
    highlightAssets: `✨ Highlighting ${(action.asset_ids || []).length} assets`,
  };
  return (
    <div className="mt-2 inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200
                    rounded-full px-3 py-1 text-xs text-blue-700 font-semibold">
      <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
      {LABELS[action.type] || `⚙ ${action.type}`}
    </div>
  );
}

// Mode config
const MODE_META_CHAT = {
  safest:   { icon: '🛡', label: 'Safest Route',   color: '#16a34a', bg: 'bg-green-50  border-green-200' },
  fastest:  { icon: '⚡', label: 'Fastest Route',  color: '#d97706', bg: 'bg-amber-50  border-amber-200' },
  balanced: { icon: '⚖️', label: 'Balanced Route', color: '#2563eb', bg: 'bg-blue-50   border-blue-200'  },
  road:     { icon: '🛣️', label: 'Road Route',     color: '#7c3aed', bg: 'bg-violet-50 border-violet-200' },
  rail:     { icon: '🚂', label: 'Rail Route',     color: '#0f766e', bg: 'bg-teal-50   border-teal-200'  },
  any:      { icon: '🚚', label: 'Best Route',     color: '#475569', bg: 'bg-slate-50  border-slate-200' },
};

// Route preview card shown after showRoute action (uses proper resolved names)
function RoutePreviewCard({ action }) {
  if (action?.type !== 'showRoute' || !action.from || !action.to) return null;
  const fromName = resolveLabel(action.from, action.from_name);
  const toName   = resolveLabel(action.to,   action.to_name);
  const meta     = MODE_META_CHAT[action.mode] || MODE_META_CHAT.any;
  return (
    <div className={`mt-2 border rounded-xl px-3 py-2.5 text-xs ${meta.bg}`}>
      <div className="flex items-center gap-1.5 font-bold mb-1.5" style={{ color: meta.color }}>
        <span>{meta.icon}</span>
        <span>{meta.label}</span>
      </div>
      <div className="flex items-center gap-2 text-slate-700 font-medium">
        <span className="bg-white border border-gray-200 rounded-lg px-2 py-0.5">{fromName}</span>
        <span className="text-gray-400">→</span>
        <span className="bg-white border border-gray-200 rounded-lg px-2 py-0.5">{toName}</span>
      </div>
      <div className="text-gray-400 mt-1.5 flex items-center gap-1">
        <div className="w-1 h-1 rounded-full bg-gray-400 animate-pulse" />
        Route Planner is calculating alternatives…
      </div>
    </div>
  );
}

// Scenario preview card
function ScenarioPreviewCard({ action }) {
  if (action?.type !== 'runScenario') return null;
  const targets = (action.target_names || action.targets || []);
  const names   = targets.map((n, i) => resolveLabel(action.targets?.[i], n));
  const typeLabels = {
    node_removal: 'Terminal Closure', edge_closure: 'Road Blockage',
    capacity_reduction: 'Capacity Drop', flood: 'Flood Event',
    cyclone: 'Cyclone', strike: 'Labor Action', accident: 'Accident',
  };
  return (
    <div className="mt-2 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-bold text-red-700 mb-1.5">
        <span>⚡</span>
        <span>{typeLabels[action.scenario_type] || 'Scenario'} Simulation</span>
        {action.severity != null && (
          <span className="ml-auto text-red-500 font-normal">{Math.round(action.severity * 100)}% severity</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {names.slice(0, 3).map((n, i) => (
          <span key={i} className="bg-white border border-red-200 text-red-700 rounded-lg px-2 py-0.5 font-medium">{n}</span>
        ))}
      </div>
      <div className="text-gray-400 mt-1.5 flex items-center gap-1">
        <div className="w-1 h-1 rounded-full bg-red-400 animate-pulse" />
        Scenario Simulator is running…
      </div>
    </div>
  );
}

// ── Single message bubble ────────────────────────────────────────────────────
function ChatMessage({ msg }) {
  const isUser   = msg.role === 'user';
  const isSystem = msg.role === 'system';

  if (isSystem) {
    return <div className="text-center text-xs text-gray-400 py-1 italic select-none">{msg.content}</div>;
  }

  return (
    <div className={`flex gap-2.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center
                        flex-shrink-0 mt-0.5 text-sm select-none">🤖</div>
      )}
      <div className={`max-w-[84%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-slate-900 text-white rounded-br-sm'
            : 'bg-gray-100 text-slate-800 rounded-bl-sm'
        }`}>
          {msg.content}
        </div>
        {msg.action && <ActionChip action={msg.action} />}
        {msg.action && <RoutePreviewCard action={msg.action} />}
        {msg.action && <ScenarioPreviewCard action={msg.action} />}
        <div className="text-[10px] text-gray-400 mt-1 px-1">
          {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-full bg-amber-500 flex items-center justify-center
                        flex-shrink-0 mt-0.5 text-xs text-white font-black select-none">U</div>
      )}
    </div>
  );
}

// ── Typing indicator ──────────────────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div className="flex gap-2.5 justify-start">
      <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0 text-sm">🤖</div>
      <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1.5 items-center h-4">
          {[0, 150, 300].map(d => (
            <div key={d} className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                 style={{ animationDelay: `${d}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
// ── Off-topic hard filter (saves tokens — never reach the LLM) ───────────────
const OFF_TOPIC_PATTERNS = [
  /^should\s+i\s+(sleep|eat|drink|go\s+out|buy|wear|quit|rest|wake|take\s+a\s+break|study|watch)/i,
  /^(write|generate|create|make)\s+(a\s+)?(poem|story|essay|song|joke|code\s+for|function\s+for|program\s+for|script)/i,
  /^tell\s+me\s+(a\s+)?(joke|bedtime\s+story|fun\s+fact(?!\s+about\s+pakistan))/i,
  /^(recipe|how\s+to\s+(cook|bake|make(?!\s+(a\s+)?route)))\s+/i,
  /^(good\s+night|good\s+bye|goodbye|take\s+care|see\s+you\s+(later|tomorrow))\b/i,
  /^i\s+(am|feel|am\s+feeling)\s+(bored|tired|sad|happy|lonely|depressed|stressed|angry)/i,
  /^(translate|how\s+do\s+you\s+say)\s+/i,
  /^who\s+(invented|discovered|wrote|founded|created|was\s+the\s+first)\s+/i,
  /^(help\s+me\s+(with\s+)?(my\s+)?(homework|essay|assignment|maths?|physics|chemistry|biology|history\s+of(?!\s+pakistan)))/i,
  /^(what\s+is\s+)?\d+\s*[\+\-\*\/]\s*\d+/,  // pure arithmetic: "2+2", "what is 5*3"
  /^(weather|temperature|forecast)\s+(in|of|at|for)\s+(?!.*(karachi|lahore|islamabad|pakistan|gwadar|peshawar|quetta|multan))/i,
];

function isOffTopic(message) {
  const m = message.trim();
  if (m.length < 3) return true;
  return OFF_TOPIC_PATTERNS.some(re => re.test(m));
}

const OFF_TOPIC_REPLY = "I'm focused on Pakistan's freight network. I can help with:\n• Routes between ports, ICDs, and rail stations\n• Live hazard & flood alerts\n• Disruption scenarios (what if a terminal closes?)\n• Risk levels across the trade network\n\nTry: \"Safest route from Lahore ICD to Karachi Port\"";

// Returns true when message explicitly mentions 3D globe
function wants3d(message) {
  return /\b(3d|globe|3-d|three[\s-]d|3d\s+globe|show\s+3d|open\s+3d)\b/i.test(message);
}

// Remap action type to globe variant when user asked for 3D
function maybe3dAction(action, is3d) {
  if (!action || !is3d) return action;
  const remap = { flyTo:'flyTo3d', showRoute:'showRoute3d', highlightAssets:'highlightAssets3d' };
  return remap[action.type] ? { ...action, type: remap[action.type] } : action;
}

export default function ChatPanel({ isOpen, onClose, onAction }) {
  const [messages,        setMessages]        = useState([]);
  const [input,           setInput]           = useState('');
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [error,           setError]           = useState(null);
  const bottomRef   = useRef(null);
  const inputRef    = useRef(null);
  const textareaRef = useRef(null);
  const is3dRef     = useRef(false); // tracks if current request asked for 3D view

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 250);
    }
  }, [isOpen]);

  const sendMutation = useMutation({
    mutationFn: async (message) => {
      const history = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));
      const res = await chatApi.send(message, history);
      return res.data;
    },
    onSuccess: (data) => {
      setError(null);
      const action = maybe3dAction(data.action || null, is3dRef.current);
      const botMsg = {
        role:    'assistant',
        content: data.text || '(no response)',
        action,
        ts:      Date.now(),
      };
      setMessages(prev => [...prev, botMsg]);
      if (action) onAction?.(action);
    },
    onError: (err) => {
      const msg = err?.response?.status === 429
        ? 'Too many requests — please wait a moment.'
        : 'Could not reach the AI. Please check your connection.';
      setError(msg);
      setMessages(prev => [...prev, { role: 'assistant', content: msg, ts: Date.now() }]);
    },
  });

  const handleSend = useCallback((text) => {
    const message = (text ?? input).trim();
    if (!message || sendMutation.isPending) return;

    setShowSuggestions(false);
    setError(null);
    setMessages(prev => [...prev, { role: 'user', content: message, ts: Date.now() }]);
    setInput('');
    if (textareaRef.current) { textareaRef.current.style.height = 'auto'; }

    // Hard off-topic guard — reject before hitting the LLM (saves tokens)
    if (isOffTopic(message)) {
      setMessages(prev => [...prev, { role: 'assistant', content: OFF_TOPIC_REPLY, ts: Date.now() }]);
      return;
    }

    is3dRef.current = wants3d(message);
    sendMutation.mutate(message);
  }, [input, sendMutation]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleClear = () => {
    setMessages([]);
    setShowSuggestions(true);
    setError(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 w-[22rem] sm:w-96"
         style={{ height: 560 }}>
      <div className="w-full h-full bg-white rounded-2xl shadow-2xl border border-gray-200
                      flex flex-col overflow-hidden">

        {/* ── Header ── */}
        <div className="bg-slate-900 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
            <div>
              <div className="text-white font-bold text-sm">Risk Assistant</div>
              <div className="text-white/50 text-xs">Groq · Llama 3.3 70B · Live DB</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button onClick={handleClear}
                      className="text-white/40 hover:text-white/70 text-xs transition px-1.5">
                Clear
              </button>
            )}
            <button onClick={onClose}
                    className="text-white/60 hover:text-white text-xl leading-none transition px-1">
              ×
            </button>
          </div>
        </div>

        {/* ── Messages ── */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">

          {/* Welcome */}
          {messages.length === 0 && (
            <div className="text-center py-2">
              <div className="text-3xl mb-2 select-none">🤖</div>
              <div className="font-bold text-slate-900 text-sm mb-1">Pakistan TradeLink Assistant</div>
              <div className="text-gray-500 text-xs leading-relaxed">
                Ask about hazards, routes & risk. I can fly the map, plot routes, and run simulations for you.
              </div>
            </div>
          )}

          {/* Suggestions */}
          {showSuggestions && messages.length === 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Try asking:</div>
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => handleSend(s)}
                        className="w-full text-left text-xs px-3 py-2 rounded-xl border border-gray-200
                                   text-slate-700 hover:bg-gray-50 hover:border-gray-300 transition leading-relaxed">
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Message list */}
          {messages.map((msg, i) => <ChatMessage key={i} msg={msg} />)}

          {/* Typing indicator */}
          {sendMutation.isPending && <TypingIndicator />}

          <div ref={bottomRef} />
        </div>

        {/* ── Input ── */}
        <div className="px-4 py-3 border-t border-gray-100 flex-shrink-0 bg-white">
          {error && (
            <div className="mb-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
              {error}
            </div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              ref={(el) => { inputRef.current = el; textareaRef.current = el; }}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about risk, routes, or scenarios…"
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-200 px-3.5 py-2.5
                         text-sm text-slate-800 placeholder-gray-400 focus:outline-none
                         focus:border-slate-400 focus:ring-1 focus:ring-slate-100 leading-relaxed"
              style={{ minHeight: 40, maxHeight: 96 }}
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
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              )}
            </button>
          </div>
          <div className="text-[10px] text-gray-400 mt-1.5 text-center select-none">
            Enter to send · Shift+Enter for new line
          </div>
        </div>
      </div>
    </div>
  );
}
