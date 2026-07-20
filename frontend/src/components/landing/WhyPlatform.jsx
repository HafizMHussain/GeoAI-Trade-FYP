import React from 'react';
import { motion } from 'framer-motion';
import { Waves, Ship, FlaskConical, Brain } from 'lucide-react';

const features = [
  {
    icon: Waves,
    title: 'Multi-Hazard Intelligence',
    description: "Integrated flood, cyclone, labor strike, and accident risk modeling across Pakistan's port network and inland corridors.",
    iconBg: 'bg-cyan-50 border-cyan-100',
    iconColor: 'text-cyan-600',
    accent: 'hover:border-cyan-200 hover:shadow-cyan-50',
  },
  {
    icon: Ship,
    title: 'Real-Time AIS Port Stress',
    description: 'Live vessel tracking, berth congestion analysis, and port capacity stress indicators updated every 30 minutes.',
    iconBg: 'bg-teal-50 border-teal-100',
    iconColor: 'text-teal-600',
    accent: 'hover:border-teal-200 hover:shadow-teal-50',
  },
  {
    icon: FlaskConical,
    title: 'Scenario & Monte Carlo Simulation',
    description: 'Run 10,000+ stochastic simulations to model supply chain disruption probabilities and recovery timelines.',
    iconBg: 'bg-orange-50 border-orange-100',
    iconColor: 'text-orange-500',
    accent: 'hover:border-orange-200 hover:shadow-orange-50',
  },
  {
    icon: Brain,
    title: 'AI Risk Assistant',
    description: 'Claude-powered conversational interface for risk Q&A, scenario execution, and intelligent report generation.',
    iconBg: 'bg-violet-50 border-violet-100',
    iconColor: 'text-violet-500',
    accent: 'hover:border-violet-200 hover:shadow-violet-50',
  },
];

const WhyPlatform = () => (
  <section id="features" className="bg-white px-6 py-16">
    <div className="max-w-7xl mx-auto">
      <div className="text-center mb-12">
        <span className="inline-block px-3 py-1 rounded-full bg-cyan-50 border border-cyan-100 text-cyan-600 text-xs font-mono font-semibold uppercase tracking-wider mb-3">
          Capabilities
        </span>
        <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
          Why This <span className="text-gradient">Platform</span>
        </h2>
        <p className="text-gray-500 text-base max-w-xl mx-auto">
          Four core pillars delivering enterprise-grade risk intelligence for Pakistan's critical logistics infrastructure.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {features.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: i * 0.08 }}
          >
            <div className={`group bg-white rounded-2xl border border-gray-100 shadow-sm p-6 h-full transition-all duration-300 hover:shadow-md ${f.accent}`}>
              <div className={`w-11 h-11 rounded-xl ${f.iconBg} border flex items-center justify-center mb-5 group-hover:scale-110 transition-transform duration-300`}>
                <f.icon className={`w-5 h-5 ${f.iconColor}`} />
              </div>
              <h3 className="text-base font-bold text-gray-900 mb-2 leading-snug">{f.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{f.description}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

export default WhyPlatform;
