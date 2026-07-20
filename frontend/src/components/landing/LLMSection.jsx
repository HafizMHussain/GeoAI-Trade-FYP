import React from 'react';
import { motion } from 'framer-motion';
import { Bot, User, Sparkles, ChevronRight, Send } from 'lucide-react';

const SAMPLE_QUESTIONS = [
  'What if Karachi Port closes?',
  'Which corridors are critical?',
  'Compare flood vs cyclone risk.',
  'Show port stress forecast.',
  'Run Monte Carlo for Gwadar.',
];

/* Static demo conversation shown in the preview */
const DEMO_MESSAGES = [
  {
    role: 'assistant',
    content: 'I am GeoResilience AI. Ask me about port risks, supply chain scenarios, or hazard analysis for Pakistan.',
  },
  {
    role: 'user',
    content: 'What if Karachi Port closes?',
  },
  {
    role: 'assistant',
    content: 'If Karachi Port closes, 47 trade routes would be affected — 12 rendered completely unreachable. Container throughput redirects primarily to Port Qasim (+38% load) and Gwadar (+22%). Estimated economic impact: $4.2M/day in delayed freight.\n\nRecommendation: activate contingency corridors via N-25 Highway and shift rail capacity through Lahore Dry Port.',
  },
];

const LLMSection = () => {
  return (
    <section id="ai-assistant" className="bg-[#0f172a] px-6 py-16 border-t border-gray-800">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <span className="inline-block px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-cyan-400 text-xs font-mono font-semibold uppercase tracking-wider mb-3">
            AI Assistant
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">
            Intelligent <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-teal-400">Risk Q&amp;A</span>
          </h2>
          <p className="text-slate-400 text-base max-w-xl mx-auto">
            Natural language interface for risk intelligence queries, scenario execution, and automated report generation.
          </p>
        </div>

        <div className="grid lg:grid-cols-5 gap-6">
          {/* Left explanation */}
          <div className="lg:col-span-2 space-y-5">
            <div className="bg-slate-800/50 rounded-2xl border border-slate-700/50 shadow-sm p-6 backdrop-blur-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-cyan-400" />
                </div>
                <h3 className="text-base font-bold text-white">Intelligent Risk Analysis</h3>
              </div>
              <p className="text-sm text-slate-400 leading-relaxed mb-4">
                Combines advanced reasoning with structured geospatial data to provide contextual,
                actionable insights about Pakistan's supply chain risks.
              </p>
              <ul className="space-y-2.5">
                {[
                  'Natural language query parsing',
                  'Context-aware scenario execution',
                  'Multi-source data synthesis',
                  'Automated report generation',
                  'Risk comparison and ranking',
                ].map(item => (
                  <li key={item} className="flex items-center gap-2 text-sm text-slate-300">
                    <ChevronRight className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Sample questions — decorative only, not clickable */}
            <div className="bg-slate-800/50 rounded-2xl border border-slate-700/50 shadow-sm p-6 backdrop-blur-sm">
              <h3 className="text-base font-bold text-white mb-4">Sample Questions</h3>
              <div className="space-y-2 pointer-events-none select-none">
                {SAMPLE_QUESTIONS.map(q => (
                  <div
                    key={q}
                    className="w-full text-left px-4 py-2.5 rounded-xl bg-slate-900/50 border border-slate-700 text-sm text-slate-300"
                  >
                    {q}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right — static chat preview */}
          <div className="lg:col-span-3">
            <div className="bg-gray-900 rounded-2xl h-[560px] flex flex-col overflow-hidden border border-gray-800 shadow-xl">
              {/* Chat header */}
              <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10 bg-gray-800/50">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-geo-cyan to-geo-teal flex items-center justify-center flex-shrink-0">
                  <Bot className="w-4 h-4 text-gray-900" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">GeoResilience AI</h4>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
                    <span className="text-xs text-gray-500">Online · Risk Intelligence Mode</span>
                  </div>
                </div>
              </div>

              {/* Static messages */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {DEMO_MESSAGES.map((msg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 8 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.15 }}
                    className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${msg.role === 'assistant' ? 'bg-gradient-to-br from-geo-cyan to-geo-teal' : 'bg-gray-700'}`}>
                      {msg.role === 'assistant' ? <Bot className="w-3.5 h-3.5 text-gray-900" /> : <User className="w-3.5 h-3.5 text-gray-300" />}
                    </div>
                    <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                      msg.role === 'assistant'
                        ? 'bg-gray-800 text-gray-200 rounded-tl-sm'
                        : 'bg-cyan-500/20 text-cyan-50 rounded-tr-sm border border-cyan-500/30'
                    }`}>
                      {msg.content.split('\n').map((line, j, arr) => (
                        <span key={j}>{line}{j < arr.length - 1 && <br />}</span>
                      ))}
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Decorative input — disabled, not functional */}
              <div className="px-5 py-4 border-t border-white/10 bg-gray-800/30 pointer-events-none select-none">
                <div className="flex gap-2.5">
                  <div className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-500 text-sm">
                    Ask about risks, scenarios, or port conditions...
                  </div>
                  <div className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-400 to-teal-400 text-slate-900 flex-shrink-0 opacity-50">
                    <Send className="w-4 h-4" />
                  </div>
                </div>
                <div className="text-center mt-2 text-xs text-gray-600">
                  Try the full AI assistant from the chatbot on any page
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default LLMSection;
