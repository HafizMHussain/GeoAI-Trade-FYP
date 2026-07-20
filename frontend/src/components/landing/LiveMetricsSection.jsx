import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, AlertTriangle, Anchor, BarChart3 } from 'lucide-react';

const LiveMetricsSection = () => {
  const [m, setM] = useState({ triggeredAssets: 142, topRiskTier: 'HIGH', portStressIndex: 73.4, monteCarloP90: 12.8 });

  useEffect(() => {
    const id = setInterval(() => {
      setM(prev => ({
        triggeredAssets: prev.triggeredAssets + Math.floor(Math.random() * 3) - 1,
        topRiskTier: ['HIGH', 'MEDIUM', 'CRITICAL'][Math.floor(Math.random() * 3)],
        portStressIndex: Math.max(0, Math.min(100, prev.portStressIndex + (Math.random() - 0.5) * 2)),
        monteCarloP90: Math.max(0, prev.monteCarloP90 + (Math.random() - 0.5) * 0.5),
      }));
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const tierConf = {
    CRITICAL: { text: 'text-red-600',    bg: 'bg-red-50 border-red-100',   bar: 'from-red-400 to-red-500' },
    HIGH:     { text: 'text-orange-600', bg: 'bg-orange-50 border-orange-100', bar: 'from-orange-400 to-orange-500' },
    MEDIUM:   { text: 'text-amber-600',  bg: 'bg-amber-50 border-amber-100',  bar: 'from-amber-400 to-amber-500' },
    LOW:      { text: 'text-green-600',  bg: 'bg-green-50 border-green-100',  bar: 'from-green-400 to-green-500' },
  };
  const tc = tierConf[m.topRiskTier] || tierConf.HIGH;

  const card = (delay) => ({
    initial: { opacity: 0, y: 16 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true },
    transition: { duration: 0.4, delay },
  });

  return (
    <section className="bg-white px-6 py-16 border-t border-gray-100">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <span className="inline-block px-3 py-1 rounded-full bg-cyan-50 border border-cyan-100 text-cyan-600 text-xs font-mono font-semibold uppercase tracking-wider mb-3">
            Real-Time Intelligence
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
            Live Risk <span className="text-gradient">Metrics</span>
          </h2>
          <p className="text-gray-500 text-base max-w-xl mx-auto">
            Real-time monitoring of Pakistan's port infrastructure and supply chain risk indicators.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5 mb-6">
          {/* Triggered Assets */}
          <motion.div {...card(0)}>
            <div className="bg-orange-50 border border-orange-100 rounded-2xl p-6 h-full hover:shadow-md transition-all">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-orange-100 border border-orange-200 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-orange-500" />
                </div>
                <span className="text-xs font-semibold text-orange-400 uppercase tracking-wider font-mono">Triggered</span>
              </div>
              <div className="text-4xl font-black text-orange-600 font-mono mb-1 tabular-nums">{m.triggeredAssets}</div>
              <div className="text-xs text-orange-400 font-medium">assets at risk</div>
              <div className="mt-3 text-xs text-orange-300 bg-orange-100/50 rounded-lg px-2.5 py-1.5 inline-block">+3 in last hour</div>
            </div>
          </motion.div>

          {/* Top Risk Tier */}
          <motion.div {...card(0.08)}>
            <div className={`${tc.bg} border rounded-2xl p-6 h-full hover:shadow-md transition-all`}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-white/60 border border-white/80 flex items-center justify-center">
                  <Anchor className={`w-5 h-5 ${tc.text}`} />
                </div>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider font-mono">Risk Tier</span>
              </div>
              <div className={`text-3xl font-black font-mono mb-1 ${tc.text} tabular-nums`}>{m.topRiskTier}</div>
              <div className="text-xs text-gray-400 font-medium">Karachi Port Zone</div>
            </div>
          </motion.div>

          {/* Port Stress */}
          <motion.div {...card(0.16)}>
            <div className="bg-teal-50 border border-teal-100 rounded-2xl p-6 h-full hover:shadow-md transition-all">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-teal-100 border border-teal-200 flex items-center justify-center">
                  <BarChart3 className="w-5 h-5 text-teal-500" />
                </div>
                <span className="text-xs font-semibold text-teal-400 uppercase tracking-wider font-mono">Port Stress</span>
              </div>
              <div className="flex items-end gap-1.5 mb-3">
                <span className="text-3xl font-black text-teal-600 font-mono tabular-nums">{Math.round(m.portStressIndex)}</span>
                <span className="text-sm text-teal-300 mb-0.5">/100</span>
              </div>
              <div className="w-full h-2.5 bg-teal-100 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-teal-400 to-teal-500 rounded-full transition-all duration-700" style={{ width: `${m.portStressIndex}%` }} />
              </div>
            </div>
          </motion.div>

          {/* Monte Carlo P90 */}
          <motion.div {...card(0.24)}>
            <div className="bg-violet-50 border border-violet-100 rounded-2xl p-6 h-full hover:shadow-md transition-all">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-violet-100 border border-violet-200 flex items-center justify-center">
                  <Activity className="w-5 h-5 text-violet-500" />
                </div>
                <span className="text-xs font-semibold text-violet-400 uppercase tracking-wider font-mono">Monte Carlo</span>
              </div>
              <div className="text-3xl font-black text-violet-600 font-mono mb-1 tabular-nums">{m.monteCarloP90.toFixed(1)}%</div>
              <div className="text-xs text-violet-400 font-medium">supply drop — P90</div>
            </div>
          </motion.div>
        </div>

        {/* Risk trend bar chart */}
        <motion.div {...card(0.3)}>
          <div className="bg-slate-50 rounded-2xl border border-slate-100 p-7">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-bold text-gray-800">Risk Trend (24h)</h3>
                <p className="text-sm text-gray-400 mt-0.5">Portfolio risk movement over the last 24 hours</p>
              </div>
              <span className="text-orange-500 font-mono font-semibold text-sm bg-orange-50 border border-orange-100 px-3 py-1 rounded-full">↑ 12.4%</span>
            </div>
            <div className="flex items-end gap-1 h-14">
              {[40,55,45,60,50,70,65,80,75,85,70,90,85,95,88,92,85,90,95,88].map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm transition-colors cursor-pointer bg-cyan-200 hover:bg-cyan-400"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-2">
              <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>Now</span>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default LiveMetricsSection;
