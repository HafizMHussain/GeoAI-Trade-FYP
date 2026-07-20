import React from 'react';
import { motion } from 'framer-motion';
import { Server, Database, Globe, Clock, Wifi, Layers, Code, Shield, Cpu, HardDrive, Ship, Waves, ArrowRight, Map } from 'lucide-react';

const architecture = [
  {
    category: 'Backend',
    icon: Server,
    iconBg: 'bg-cyan-50 border-cyan-100',
    iconColor: 'text-cyan-600',
    topColor: 'border-t-cyan-400',
    items: [
      { icon: Code,     label: 'FastAPI',    desc: 'High-performance async API framework' },
      { icon: Database, label: 'PostGIS',    desc: 'Spatial database with geospatial extensions' },
      { icon: Cpu,      label: 'Python 3.11', desc: 'Core processing engine' },
    ],
  },
  {
    category: 'Frontend',
    icon: Globe,
    iconBg: 'bg-teal-50 border-teal-100',
    iconColor: 'text-teal-600',
    topColor: 'border-t-teal-400',
    items: [
      { icon: Code,   label: 'React 18',    desc: 'Component-based UI with hooks' },
      { icon: Map,    label: 'MapLibre GL', desc: 'Vector tile map rendering' },
      { icon: Layers, label: 'deck.gl',     desc: 'Large-scale geospatial visualization' },
    ],
  },
  {
    category: 'Infrastructure',
    icon: HardDrive,
    iconBg: 'bg-orange-50 border-orange-100',
    iconColor: 'text-orange-500',
    topColor: 'border-t-orange-400',
    items: [
      { icon: Clock,  label: 'Scheduler', desc: '30/60 min automated job cycles' },
      { icon: Wifi,   label: 'WebSocket', desc: 'Real-time live data push' },
      { icon: Shield, label: 'Auth',      desc: 'JWT-based API security' },
    ],
  },
];

const DeploymentSection = () => (
  <section id="architecture" className="bg-slate-50 px-6 py-16 border-t border-gray-100">
    <div className="max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="text-center mb-12"
      >
        <span className="inline-block px-3 py-1 rounded-full bg-white border border-gray-200 text-gray-500 text-xs font-mono font-semibold uppercase tracking-wider mb-3">
          Deployment
        </span>
        <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
          Architecture &amp; <span className="text-gradient">Integration</span>
        </h2>
        <p className="text-gray-500 text-base max-w-xl mx-auto">
          Modern, scalable stack designed for real-time geospatial intelligence and enterprise reliability.
        </p>
      </motion.div>

      <div className="grid md:grid-cols-3 gap-5 mb-6">
        {architecture.map((sec, i) => (
          <motion.div
            key={sec.category}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.1 }}
          >
            <div className={`bg-white rounded-2xl border-t-4 ${sec.topColor} border border-gray-100 shadow-sm p-6 h-full hover:shadow-md transition-all`}>
              <div className="flex items-center gap-3 mb-5">
                <div className={`w-10 h-10 rounded-xl ${sec.iconBg} border flex items-center justify-center`}>
                  <sec.icon className={`w-5 h-5 ${sec.iconColor}`} />
                </div>
                <h3 className="text-base font-bold text-gray-800">{sec.category}</h3>
              </div>
              <div className="space-y-3">
                {sec.items.map(item => (
                  <div key={item.label} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 hover:bg-slate-100 transition-colors">
                    <item.icon className={`w-4 h-4 ${sec.iconColor} mt-0.5 flex-shrink-0`} />
                    <div>
                      <div className="text-sm font-semibold text-gray-800">{item.label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Data flow */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8">
          <h3 className="text-base font-bold text-gray-800 mb-7 text-center">Data Flow Architecture</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-7">
            {[
              { label: 'AIS Feed',    sub: 'MarineTraffic / Orbcomm', icon: Ship,  color: 'text-teal-500',  bg: 'bg-teal-50 border-teal-100' },
              { label: 'Hazard Data', sub: 'GDACS / PMD / EM-DAT',    icon: Waves, color: 'text-cyan-500',  bg: 'bg-cyan-50 border-cyan-100' },
              { label: 'Processing',  sub: 'FastAPI + PostGIS',         icon: Cpu,   color: 'text-violet-500', bg: 'bg-violet-50 border-violet-100' },
              { label: 'Frontend',    sub: 'React + MapLibre',          icon: Globe, color: 'text-orange-500', bg: 'bg-orange-50 border-orange-100' },
            ].map((step, i) => (
              <div key={step.label} className="relative">
                <div className={`${step.bg} border rounded-xl p-4 text-center hover:shadow-sm transition-all`}>
                  <step.icon className={`w-5 h-5 ${step.color} mx-auto mb-2`} />
                  <div className="text-sm font-semibold text-gray-800">{step.label}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{step.sub}</div>
                </div>
                {i < 3 && (
                  <div className="hidden md:flex absolute top-1/2 -right-3 -translate-y-1/2 z-10">
                    <motion.div animate={{ x: [0, 4, 0] }} transition={{ duration: 1.5, repeat: Infinity }}>
                      <ArrowRight className="w-4 h-4 text-gray-300" />
                    </motion.div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            {[
              { icon: Clock, color: 'text-teal-500',  bg: 'bg-teal-50 border-teal-100',  label: '30-min AIS refresh' },
              { icon: Clock, color: 'text-orange-500', bg: 'bg-orange-50 border-orange-100', label: '60-min hazard update' },
              { icon: Wifi,  color: 'text-cyan-500',  bg: 'bg-cyan-50 border-cyan-100',  label: 'WebSocket live push' },
            ].map(({ icon: Icon, color, bg, label }) => (
              <div key={label} className={`flex items-center gap-2 px-4 py-2 rounded-lg ${bg} border`}>
                <Icon className={`w-3.5 h-3.5 ${color}`} />
                <span className="text-xs text-gray-600 font-medium">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  </section>
);

export default DeploymentSection;
