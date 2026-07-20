import React from 'react';
import { motion } from 'framer-motion';
import { Map, LayoutDashboard, FlaskConical, Ship, Clock, MessageSquare } from 'lucide-react';
import { Link } from 'react-router-dom';

const modules = [
  {
    icon: Map,
    title: 'Live Map',
    description: "Interactive geospatial visualization with hazard overlays, risk heatmaps, and real-time vessel positions across Pakistan's maritime zones.",
    badge: 'Real-time',
    badgeColor: 'bg-teal-50 text-teal-600 border-teal-100',
    topBorder: 'border-t-teal-400',
    iconColor: 'text-teal-500',
    iconBg: 'bg-teal-50 border-teal-100',
    to: '/map',
  },
  {
    icon: LayoutDashboard,
    title: 'KPI Dashboard',
    description: 'Executive summary view with key risk indicators, port stress metrics, and supply chain health scores updated continuously.',
    badge: 'Analytics',
    badgeColor: 'bg-cyan-50 text-cyan-600 border-cyan-100',
    topBorder: 'border-t-cyan-400',
    iconColor: 'text-cyan-500',
    iconBg: 'bg-cyan-50 border-cyan-100',
    to: '/dashboard',
  },
  {
    icon: FlaskConical,
    title: 'Scenario Simulator',
    description: 'Configure custom disruption scenarios, run Monte Carlo simulations, and compare impact forecasts across multiple parameters.',
    badge: 'Simulation',
    badgeColor: 'bg-orange-50 text-orange-500 border-orange-100',
    topBorder: 'border-t-orange-400',
    iconColor: 'text-orange-500',
    iconBg: 'bg-orange-50 border-orange-100',
    to: '/scenario',
  },
  {
    icon: Ship,
    title: 'AIS Port Monitor',
    description: 'Real-time Automatic Identification System tracking with berth occupancy, anchorage analysis, and vessel queue management.',
    badge: 'Real-time',
    badgeColor: 'bg-teal-50 text-teal-600 border-teal-100',
    topBorder: 'border-t-teal-400',
    iconColor: 'text-teal-500',
    iconBg: 'bg-teal-50 border-teal-100',
    to: '/map',
  },
  {
    icon: Clock,
    title: 'Time Slider / History',
    description: 'Temporal analysis with historical risk playback, trend comparison, and time-series visualization of port and corridor events.',
    badge: 'Historical',
    badgeColor: 'bg-violet-50 text-violet-500 border-violet-100',
    topBorder: 'border-t-violet-400',
    iconColor: 'text-violet-500',
    iconBg: 'bg-violet-50 border-violet-100',
    to: '/map',
  },
  {
    icon: MessageSquare,
    title: 'AI Risk Assistant',
    description: 'Conversational interface powered by Claude for natural language risk queries, scenario execution, and automated report generation.',
    badge: 'AI-powered',
    badgeColor: 'bg-cyan-50 text-cyan-600 border-cyan-100',
    topBorder: 'border-t-cyan-400',
    iconColor: 'text-cyan-500',
    iconBg: 'bg-cyan-50 border-cyan-100',
    to: '/map',
  },
];

const ModulesGrid = () => (
  <section id="modules" className="bg-slate-50 px-6 py-16 border-t border-gray-100">
    <div className="max-w-7xl mx-auto">
      <div className="text-center mb-12">
        <span className="inline-block px-3 py-1 rounded-full bg-white border border-gray-200 text-gray-500 text-xs font-mono font-semibold uppercase tracking-wider mb-3">
          Modules
        </span>
        <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
          Platform <span className="text-gradient">Modules</span>
        </h2>
        <p className="text-gray-500 text-base max-w-xl mx-auto">
          Six integrated modules providing comprehensive coverage of risk intelligence, monitoring, and simulation.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {modules.map((m, i) => (
          <motion.div
            key={m.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.07 }}
          >
            <Link
              to={m.to}
              className={`group block bg-white rounded-2xl border-t-4 ${m.topBorder} border border-gray-100 shadow-sm p-6 h-full hover:shadow-md transition-all duration-300`}
            >
              <div className="flex items-start justify-between mb-4">
                <div className={`w-11 h-11 rounded-xl ${m.iconBg} border flex items-center justify-center group-hover:scale-110 transition-transform duration-300`}>
                  <m.icon className={`w-5 h-5 ${m.iconColor}`} />
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${m.badgeColor}`}>{m.badge}</span>
              </div>
              <h3 className="text-base font-bold text-gray-900 mb-2 group-hover:text-geo-cyan transition-colors">{m.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{m.description}</p>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

export default ModulesGrid;
